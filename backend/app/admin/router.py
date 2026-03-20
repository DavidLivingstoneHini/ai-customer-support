import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated

import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentAdmin
from app.database.models import Document, QueryLog, QueryStatus
from app.database.session import get_db
from app.rag.ingestion import SUPPORTED_TYPES, delete_document_vectors, ingest_document

logger = structlog.get_logger()

router = APIRouter(prefix="/admin", tags=["admin"])

UPLOAD_DIR = Path("/app/uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB


# ── Schemas ───────────────────────────────────────────────────

class DocumentResponse(BaseModel):
    id: uuid.UUID
    original_name: str
    file_type: str
    file_size: int
    chunk_count: int
    is_indexed: bool
    created_at: str

    class Config:
        from_attributes = True


class AnalyticsResponse(BaseModel):
    total_queries: int
    answered_queries: int
    escalated_queries: int
    resolution_rate: float
    avg_response_time_ms: float
    queries_today: int
    queries_this_week: int
    queries_this_month: int
    top_queries: list[dict]
    daily_volume: list[dict]


# ── Endpoints ─────────────────────────────────────────────────

@router.post("/documents", response_model=DocumentResponse, status_code=201)
async def upload_document(
    file: Annotated[UploadFile, File(...)],
    current_admin: CurrentAdmin,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if file.content_type not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type. Allowed: PDF, DOCX, TXT",
        )

    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File exceeds 50MB limit",
        )

    doc_id = str(uuid.uuid4())
    file_ext = SUPPORTED_TYPES[file.content_type]
    saved_filename = f"{doc_id}.{file_ext}"
    save_path = UPLOAD_DIR / saved_filename

    save_path.write_bytes(contents)

    doc = Document(
        id=uuid.UUID(doc_id),
        filename=saved_filename,
        original_name=file.filename,
        file_type=file_ext,
        file_size=len(contents),
        uploaded_by=current_admin.id,
        is_indexed=False,
    )
    db.add(doc)
    await db.commit()

    try:
        chunk_count = await ingest_document(save_path, doc_id, file.filename, file_ext)
        doc.chunk_count = chunk_count
        doc.is_indexed = True
        await db.commit()
        await db.refresh(doc)
    except Exception as e:
        logger.error("Ingestion failed", doc_id=doc_id, error=str(e))
        raise HTTPException(status_code=500, detail=f"Document indexing failed: {str(e)}")

    return DocumentResponse(
        id=doc.id,
        original_name=doc.original_name,
        file_type=doc.file_type,
        file_size=doc.file_size,
        chunk_count=doc.chunk_count,
        is_indexed=doc.is_indexed,
        created_at=doc.created_at.isoformat(),
    )


@router.get("/documents", response_model=list[DocumentResponse])
async def list_documents(
    current_admin: CurrentAdmin,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(Document).order_by(Document.created_at.desc())
    )
    docs = result.scalars().all()
    return [
        DocumentResponse(
            id=d.id,
            original_name=d.original_name,
            file_type=d.file_type,
            file_size=d.file_size,
            chunk_count=d.chunk_count,
            is_indexed=d.is_indexed,
            created_at=d.created_at.isoformat(),
        )
        for d in docs
    ]


@router.delete("/documents/{doc_id}", status_code=204)
async def delete_document(
    doc_id: uuid.UUID,
    current_admin: CurrentAdmin,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    await delete_document_vectors(str(doc_id))

    file_path = UPLOAD_DIR / doc.filename
    if file_path.exists():
        file_path.unlink()

    await db.delete(doc)
    await db.commit()


@router.get("/analytics", response_model=AnalyticsResponse)
async def get_analytics(
    current_admin: CurrentAdmin,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = now - timedelta(days=7)
    month_start = now - timedelta(days=30)

    total_result = await db.execute(select(func.count(QueryLog.id)))
    total = total_result.scalar() or 0

    answered_result = await db.execute(
        select(func.count(QueryLog.id)).where(QueryLog.status == QueryStatus.ANSWERED)
    )
    answered = answered_result.scalar() or 0

    escalated_result = await db.execute(
        select(func.count(QueryLog.id)).where(QueryLog.status == QueryStatus.ESCALATED)
    )
    escalated = escalated_result.scalar() or 0

    avg_rt_result = await db.execute(
        select(func.avg(QueryLog.response_time_ms)).where(
            QueryLog.response_time_ms.isnot(None)
        )
    )
    avg_rt = avg_rt_result.scalar() or 0

    today_result = await db.execute(
        select(func.count(QueryLog.id)).where(QueryLog.created_at >= today_start)
    )
    queries_today = today_result.scalar() or 0

    week_result = await db.execute(
        select(func.count(QueryLog.id)).where(QueryLog.created_at >= week_start)
    )
    queries_week = week_result.scalar() or 0

    month_result = await db.execute(
        select(func.count(QueryLog.id)).where(QueryLog.created_at >= month_start)
    )
    queries_month = month_result.scalar() or 0

    # Top 10 queries
    top_result = await db.execute(
        select(QueryLog.query_text, func.count(QueryLog.id).label("count"))
        .group_by(QueryLog.query_text)
        .order_by(func.count(QueryLog.id).desc())
        .limit(10)
    )
    top_queries = [{"query": row[0], "count": row[1]} for row in top_result.all()]

    # Daily volume last 14 days
    daily_volume = []
    for days_ago in range(13, -1, -1):
        day = now - timedelta(days=days_ago)
        day_start = day.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        count_result = await db.execute(
            select(func.count(QueryLog.id)).where(
                QueryLog.created_at >= day_start,
                QueryLog.created_at < day_end,
            )
        )
        daily_volume.append({
            "date": day_start.strftime("%b %d"),
            "queries": count_result.scalar() or 0,
        })

    return AnalyticsResponse(
        total_queries=total,
        answered_queries=answered,
        escalated_queries=escalated,
        resolution_rate=round(answered / total * 100, 1) if total > 0 else 0,
        avg_response_time_ms=round(float(avg_rt), 1),
        queries_today=queries_today,
        queries_this_week=queries_week,
        queries_this_month=queries_month,
        top_queries=top_queries,
        daily_volume=daily_volume,
    )

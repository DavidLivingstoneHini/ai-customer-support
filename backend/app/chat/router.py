import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.dependencies import CurrentUser
from app.database.models import (
    ConversationSession, Message, QueryLog, QueryStatus
)
from app.database.session import get_db
from app.rag.pipeline import stream_rag_response

router = APIRouter(prefix="/chat", tags=["chat"])


# ── Schemas ───────────────────────────────────────────────────

class SessionResponse(BaseModel):
    id: uuid.UUID
    title: str | None
    created_at: str
    message_count: int = 0

    class Config:
        from_attributes = True


class MessageResponse(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    created_at: str

    class Config:
        from_attributes = True


class ChatRequest(BaseModel):
    message: str
    session_id: uuid.UUID | None = None


# ── Endpoints ─────────────────────────────────────────────────

@router.post("/sessions", response_model=SessionResponse, status_code=201)
async def create_session(
    current_user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    session = ConversationSession(user_id=current_user.id)
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return SessionResponse(
        id=session.id,
        title=session.title,
        created_at=session.created_at.isoformat(),
    )


@router.get("/sessions", response_model=list[SessionResponse])
async def list_sessions(
    current_user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(ConversationSession)
        .where(ConversationSession.user_id == current_user.id)
        .order_by(ConversationSession.updated_at.desc())
        .limit(50)
    )
    sessions = result.scalars().all()

    out = []
    for s in sessions:
        msg_result = await db.execute(
            select(Message).where(Message.session_id == s.id)
        )
        count = len(msg_result.scalars().all())
        out.append(SessionResponse(
            id=s.id,
            title=s.title,
            created_at=s.created_at.isoformat(),
            message_count=count,
        ))
    return out


@router.get("/sessions/{session_id}/messages", response_model=list[MessageResponse])
async def get_session_messages(
    session_id: uuid.UUID,
    current_user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    result = await db.execute(
        select(ConversationSession).where(
            ConversationSession.id == session_id,
            ConversationSession.user_id == current_user.id,
        )
    )
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    msg_result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id)
        .order_by(Message.created_at.asc())
    )
    messages = msg_result.scalars().all()

    return [
        MessageResponse(
            id=m.id,
            role=m.role,
            content=m.content,
            created_at=m.created_at.isoformat(),
        )
        for m in messages
    ]


@router.post("/stream")
async def chat_stream(
    payload: ChatRequest,
    current_user: CurrentUser,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    if not payload.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Get or create session
    if payload.session_id:
        result = await db.execute(
            select(ConversationSession).where(
                ConversationSession.id == payload.session_id,
                ConversationSession.user_id == current_user.id,
            )
        )
        session = result.scalar_one_or_none()
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        session = ConversationSession(
            user_id=current_user.id,
            title=payload.message[:60] + ("..." if len(payload.message) > 60 else ""),
        )
        db.add(session)
        await db.flush()

    # Store user message
    user_message = Message(
        session_id=session.id,
        role="user",
        content=payload.message,
    )
    db.add(user_message)
    await db.flush()

    # Load history
    history_result = await db.execute(
        select(Message)
        .where(Message.session_id == session.id)
        .order_by(Message.created_at.desc())
        .limit(10)
    )
    history = [
        {"role": m.role, "content": m.content}
        for m in reversed(history_result.scalars().all())
    ]

    await db.commit()

    # Streaming generator that also persists the response
    async def event_stream():
        full_response = []
        sources = []
        response_time_ms = 0
        top_score = 0.0
        status = QueryStatus.ANSWERED
        escalated = False

        async for chunk in stream_rag_response(payload.message, history):
            if chunk.startswith("data: [SOURCES]"):
                sources_json = chunk.replace("data: [SOURCES]", "").strip()
                sources = json.loads(sources_json)
                yield chunk
            elif chunk.startswith("data: [ESCALATE]"):
                escalated = True
                status = QueryStatus.ESCALATED
                yield "data: [ESCALATE]\n\n"
            elif chunk.startswith("data: [INJECTION_DETECTED]"):
                status = QueryStatus.FAILED
                yield "data: [INJECTION_DETECTED]\n\n"
            elif chunk.startswith("data: [DONE]"):
                meta = chunk.replace("data: [DONE]", "").strip()
                parts = meta.split("|")
                response_time_ms = int(parts[0]) if parts else 0
                top_score = float(parts[1]) if len(parts) > 1 else 0.0
                yield chunk
            else:
                text = chunk.replace("data: ", "").replace("\\n", "\n").strip()
                if text:
                    full_response.append(text)
                yield chunk

        # Persist assistant message + query log
        async with db.begin():
            assistant_content = "".join(full_response) if full_response else (
                "I'm connecting you to a human agent who can better assist you."
                if escalated else "Unable to process your request."
            )

            assistant_message = Message(
                session_id=session.id,
                role="assistant",
                content=assistant_content,
            )
            db.add(assistant_message)
            await db.flush()

            db.add(QueryLog(
                message_id=assistant_message.id,
                user_id=current_user.id,
                query_text=payload.message,
                status=status,
                top_similarity_score=top_score,
                response_time_ms=response_time_ms,
                source_documents=json.dumps(sources) if sources else None,
            ))

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

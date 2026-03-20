import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import CurrentUser
from app.database.models import (
    ConversationSession,
    Message,
    QueryLog,
    QueryStatus,
)
from app.database.session import get_db
from app.rag.pipeline import stream_rag_response

router = APIRouter(prefix="/chat", tags=["chat"])


class SessionResponse(BaseModel):
    id: uuid.UUID
    title: str | None
    created_at: str
    message_count: int = 0


class MessageResponse(BaseModel):
    id: uuid.UUID
    role: str
    content: str
    created_at: str


class ChatRequest(BaseModel):
    message: str
    session_id: uuid.UUID | None = None


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

    output = []
    for s in sessions:
        count_result = await db.execute(
            select(Message).where(Message.session_id == s.id)
        )
        count = len(count_result.scalars().all())
        output.append(
            SessionResponse(
                id=s.id,
                title=s.title,
                created_at=s.created_at.isoformat(),
                message_count=count,
            )
        )
    return output


@router.get("/sessions/{session_id}/messages", response_model=list[MessageResponse])
async def get_messages(
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

    # Resolve or create session
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
        title = payload.message[:60] + ("..." if len(payload.message) > 60 else "")
        session = ConversationSession(user_id=current_user.id, title=title)
        db.add(session)
        await db.flush()

    # Store user message
    user_msg = Message(
        session_id=session.id,
        role="user",
        content=payload.message,
    )
    db.add(user_msg)
    await db.flush()

    # Load recent history for context
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

    # Capture IDs needed inside the generator
    session_id = session.id
    user_id = current_user.id

    async def event_stream():
        full_response: list[str] = []
        sources: list[dict] = []
        response_time_ms = 0
        top_score = 0.0
        query_status = QueryStatus.ANSWERED
        escalated = False

        async for chunk in stream_rag_response(payload.message, history):
            if chunk.startswith("data: [SOURCES]"):
                raw = chunk.replace("data: [SOURCES]", "").strip()
                sources = json.loads(raw)
                yield chunk

            elif chunk.startswith("data: [ESCALATE]"):
                escalated = True
                query_status = QueryStatus.ESCALATED
                yield chunk

            elif chunk.startswith("data: [INJECTION_DETECTED]"):
                query_status = QueryStatus.FAILED
                yield chunk

            elif chunk.startswith("data: [DONE]"):
                meta = chunk.replace("data: [DONE]", "").strip()
                parts = meta.split("|")
                response_time_ms = int(parts[0]) if parts else 0
                top_score = float(parts[1]) if len(parts) > 1 else 0.0
                yield chunk

            else:
                # Regular text token
                token = chunk.replace("data: ", "").replace("<br>", "\n")
                if token:
                    full_response.append(token)
                yield chunk

        # Persist assistant message and query log after stream ends
        from app.database.session import AsyncSessionLocal

        async with AsyncSessionLocal() as persist_db:
            async with persist_db.begin():
                if escalated:
                    assistant_content = (
                        "I wasn't able to find a confident answer in our knowledge base. "
                        "I'm connecting you to a human agent who can better assist you."
                    )
                elif query_status == QueryStatus.FAILED:
                    assistant_content = (
                        "I detected potentially unsafe content in your message. "
                        "Please rephrase your question."
                    )
                else:
                    assistant_content = "".join(full_response)

                asst_msg = Message(
                    session_id=session_id,
                    role="assistant",
                    content=assistant_content,
                )
                persist_db.add(asst_msg)
                await persist_db.flush()

                persist_db.add(
                    QueryLog(
                        message_id=asst_msg.id,
                        user_id=user_id,
                        query_text=payload.message,
                        status=query_status,
                        top_similarity_score=top_score,
                        response_time_ms=response_time_ms,
                        source_documents=json.dumps(sources) if sources else None,
                    )
                )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )

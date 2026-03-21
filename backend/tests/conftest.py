"""
Shared test fixtures for the AI Customer Support API.

All tests run without Docker:
- SQLite in-memory database (no PostgreSQL needed)
- Pinecone, OpenAI, Redis are mocked
- JWT auth uses real implementation against SQLite
"""
import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

# ── Env vars must be set before any app import ────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

os.environ.setdefault("DATABASE_URL",        "sqlite+aiosqlite:///./test_acs.db")
os.environ.setdefault("REDIS_URL",           "redis://localhost:6379/0")
os.environ.setdefault("REDIS_PASSWORD",      "testpass")
os.environ.setdefault("JWT_SECRET",          "test-jwt-secret-32-chars-minimum-ok!")
os.environ.setdefault("JWT_REFRESH_SECRET",  "test-refresh-secret-32-chars-min-ok!")
os.environ.setdefault("POSTGRES_USER",       "test")
os.environ.setdefault("POSTGRES_PASSWORD",   "test")
os.environ.setdefault("POSTGRES_DB",         "test")
os.environ.setdefault("OPENAI_API_KEY",      "sk-test-fake-key")
os.environ.setdefault("PINECONE_API_KEY",    "test-pinecone-key")
os.environ.setdefault("PINECONE_INDEX_NAME", "ai-support-index")
os.environ.setdefault("ALLOWED_ORIGINS",     "http://localhost:3000")

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# ── Test database ─────────────────────────────────────────────────────────────

TEST_DB_URL = "sqlite+aiosqlite:///./test_acs.db"

test_engine = create_async_engine(TEST_DB_URL, echo=False)
TestSessionLocal = async_sessionmaker(
    test_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)

# ── Create tables at import time ──────────────────────────────────────────────

def _setup_db():
    import app.database.models  # noqa: F401 — registers all models with Base
    from app.database.session import Base

    async def _run():
        async with test_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_run())


_setup_db()

# ── Pytest fixtures ───────────────────────────────────────────────────────────

@pytest.fixture(scope="session", autouse=True)
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session", autouse=True)
def cleanup_db():
    yield
    Path("./test_acs.db").unlink(missing_ok=True)


@pytest.fixture(scope="session")
def app():
    """FastAPI app with DB and external-service dependencies overridden."""
    from app.main import app as _app
    from app.database.session import get_db

    async def override_get_db():
        async with TestSessionLocal() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    _app.dependency_overrides[get_db] = override_get_db
    return _app


@pytest.fixture(scope="session")
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def registered_user(client):
    resp = client.post("/api/v1/auth/register", json={
        "email":     "testuser@example.com",
        "full_name": "Test User",
        "password":  "testpassword123",
    })
    assert resp.status_code == 201, f"Registration failed: {resp.text}"
    return {
        "email":    "testuser@example.com",
        "password": "testpassword123",
        "tokens":   resp.json(),
    }


@pytest.fixture(scope="session")
def auth_headers(registered_user):
    return {"Authorization": f"Bearer {registered_user['tokens']['access_token']}"}


@pytest.fixture(scope="session")
def admin_user(client):
    """Register a user then manually promote to admin via DB."""
    resp = client.post("/api/v1/auth/register", json={
        "email":     "admin@example.com",
        "full_name": "Admin User",
        "password":  "adminpassword123",
    })
    assert resp.status_code == 201

    # Promote to admin directly in test DB
    async def _promote():
        from sqlalchemy import text
        async with TestSessionLocal() as session:
            await session.execute(
                text("UPDATE users SET role='ADMIN' WHERE email='admin@example.com'")
            )
            await session.commit()

    asyncio.run(_promote())

    # Log in again to get a fresh token with admin role
    login = client.post("/api/v1/auth/login", json={
        "email":    "admin@example.com",
        "password": "adminpassword123",
    })
    return {
        "email":   "admin@example.com",
        "password": "adminpassword123",
        "tokens":  login.json(),
    }


@pytest.fixture(scope="session")
def admin_headers(admin_user):
    return {"Authorization": f"Bearer {admin_user['tokens']['access_token']}"}

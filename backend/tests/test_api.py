"""
HTTP integration tests for chat and admin endpoints.
Pinecone and OpenAI calls are mocked so no real API keys are needed.
"""
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


# ── Health ────────────────────────────────────────────────────────────────────

def test_health(client: TestClient):
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "version" in data


# ── Chat sessions ─────────────────────────────────────────────────────────────

class TestChatSessions:

    def test_create_session_requires_auth(self, client: TestClient):
        resp = client.post("/api/v1/chat/sessions")
        assert resp.status_code == 403

    def test_create_session_success(self, client: TestClient, auth_headers: dict):
        resp = client.post("/api/v1/chat/sessions", headers=auth_headers)
        assert resp.status_code == 201
        data = resp.json()
        assert "id" in data
        assert "created_at" in data

    def test_list_sessions_requires_auth(self, client: TestClient):
        resp = client.get("/api/v1/chat/sessions")
        assert resp.status_code == 403

    def test_list_sessions_returns_list(self, client: TestClient, auth_headers: dict):
        # Create one first
        client.post("/api/v1/chat/sessions", headers=auth_headers)
        resp = client.get("/api/v1/chat/sessions", headers=auth_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_get_messages_requires_auth(self, client: TestClient, auth_headers: dict):
        create = client.post("/api/v1/chat/sessions", headers=auth_headers)
        session_id = create.json()["id"]
        resp = client.get(f"/api/v1/chat/sessions/{session_id}/messages")
        assert resp.status_code == 403

    def test_get_messages_empty_session(self, client: TestClient, auth_headers: dict):
        create = client.post("/api/v1/chat/sessions", headers=auth_headers)
        session_id = create.json()["id"]
        resp = client.get(
            f"/api/v1/chat/sessions/{session_id}/messages",
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert resp.json() == []

    def test_get_messages_wrong_user(self, client: TestClient, auth_headers: dict):
        # Create session with auth_headers user
        create = client.post("/api/v1/chat/sessions", headers=auth_headers)
        session_id = create.json()["id"]

        # Try to access with admin user
        other_tokens = client.post("/api/v1/auth/register", json={
            "email":     "other2@example.com",
            "full_name": "Other User",
            "password":  "password12345",
        }).json()
        other_headers = {"Authorization": f"Bearer {other_tokens['access_token']}"}

        resp = client.get(
            f"/api/v1/chat/sessions/{session_id}/messages",
            headers=other_headers,
        )
        assert resp.status_code == 404

    def test_get_messages_nonexistent_session(self, client: TestClient, auth_headers: dict):
        fake_id = str(uuid.uuid4())
        resp = client.get(
            f"/api/v1/chat/sessions/{fake_id}/messages",
            headers=auth_headers,
        )
        assert resp.status_code == 404


# ── Chat stream ───────────────────────────────────────────────────────────────

class TestChatStream:

    def test_stream_requires_auth(self, client: TestClient):
        resp = client.post("/api/v1/chat/stream",
                           json={"message": "hello"})
        assert resp.status_code == 403

    def test_stream_empty_message_rejected(self, client: TestClient, auth_headers: dict):
        with patch("app.chat.router.stream_rag_response") as mock_stream:
            mock_stream.return_value = AsyncMock()
            resp = client.post(
                "/api/v1/chat/stream",
                json={"message": "   "},
                headers=auth_headers,
            )
            assert resp.status_code == 400

    def test_stream_returns_streaming_response(self, client: TestClient, auth_headers: dict):
        """Mock the RAG pipeline and verify SSE stream is returned."""

        async def fake_stream(query, history=None):
            yield "data: [SOURCES][]\n\n"
            yield "data: Hello there!\n\n"
            yield "data: [DONE]150|0.85\n\n"

        with patch("app.chat.router.stream_rag_response", side_effect=fake_stream):
            resp = client.post(
                "/api/v1/chat/stream",
                json={"message": "What is your return policy?"},
                headers=auth_headers,
            )
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")

    def test_stream_with_existing_session(self, client: TestClient, auth_headers: dict):
        create = client.post("/api/v1/chat/sessions", headers=auth_headers)
        session_id = create.json()["id"]

        async def fake_stream(query, history=None):
            yield "data: [SOURCES][]\n\n"
            yield "data: Response text\n\n"
            yield "data: [DONE]100|0.9\n\n"

        with patch("app.chat.router.stream_rag_response", side_effect=fake_stream):
            resp = client.post(
                "/api/v1/chat/stream",
                json={"message": "hello", "session_id": session_id},
                headers=auth_headers,
            )
        assert resp.status_code == 200

    def test_stream_invalid_session_id(self, client: TestClient, auth_headers: dict):
        fake_id = str(uuid.uuid4())
        resp = client.post(
            "/api/v1/chat/stream",
            json={"message": "hello", "session_id": fake_id},
            headers=auth_headers,
        )
        assert resp.status_code == 404


# ── Admin documents ───────────────────────────────────────────────────────────

class TestAdminDocuments:

    def test_upload_requires_admin(self, client: TestClient, auth_headers: dict):
        """Regular user cannot upload documents."""
        csv_content = b"col1,col2\n1,2"
        resp = client.post(
            "/api/v1/admin/documents",
            files={"file": ("test.pdf", csv_content, "application/pdf")},
            headers=auth_headers,
        )
        assert resp.status_code == 403

    def test_list_documents_requires_admin(self, client: TestClient, auth_headers: dict):
        resp = client.get("/api/v1/admin/documents", headers=auth_headers)
        assert resp.status_code == 403

    def test_list_documents_as_admin(self, client: TestClient, admin_headers: dict):
        resp = client.get("/api/v1/admin/documents", headers=admin_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_upload_unsupported_type_rejected(self, client: TestClient, admin_headers: dict):
        resp = client.post(
            "/api/v1/admin/documents",
            files={"file": ("test.csv", b"a,b\n1,2", "text/csv")},
            headers=admin_headers,
        )
        assert resp.status_code == 415

    def test_upload_txt_document(self, client: TestClient, admin_headers: dict):
        """Upload a plain text file — mocks out the Pinecone ingestion."""
        txt_content = b"This is a test document with some content about our policies."

        async def fake_ingest(*args, **kwargs):
            return 3  # 3 chunks

        with patch("app.admin.router.ingest_document", side_effect=fake_ingest):
            resp = client.post(
                "/api/v1/admin/documents",
                files={"file": ("policy.txt", txt_content, "text/plain")},
                headers=admin_headers,
            )

        assert resp.status_code == 201
        data = resp.json()
        assert data["original_name"] == "policy.txt"
        assert data["file_type"]     == "txt"
        assert data["is_indexed"]    is True
        assert data["chunk_count"]   == 3

    def test_delete_nonexistent_document(self, client: TestClient, admin_headers: dict):
        fake_id = str(uuid.uuid4())
        resp = client.delete(
            f"/api/v1/admin/documents/{fake_id}",
            headers=admin_headers,
        )
        assert resp.status_code == 404

    def test_delete_requires_admin(self, client: TestClient, auth_headers: dict):
        fake_id = str(uuid.uuid4())
        resp = client.delete(
            f"/api/v1/admin/documents/{fake_id}",
            headers=auth_headers,
        )
        assert resp.status_code == 403


# ── Admin analytics ───────────────────────────────────────────────────────────

class TestAdminAnalytics:

    def test_analytics_requires_admin(self, client: TestClient, auth_headers: dict):
        resp = client.get("/api/v1/admin/analytics", headers=auth_headers)
        assert resp.status_code == 403

    def test_analytics_returns_data(self, client: TestClient, admin_headers: dict):
        resp = client.get("/api/v1/admin/analytics", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total_queries"      in data
        assert "answered_queries"   in data
        assert "escalated_queries"  in data
        assert "resolution_rate"    in data
        assert "daily_volume"       in data

    def test_analytics_daily_volume_is_list(self, client: TestClient, admin_headers: dict):
        resp = client.get("/api/v1/admin/analytics", headers=admin_headers)
        assert isinstance(resp.json()["daily_volume"], list)

    def test_analytics_resolution_rate_in_range(self, client: TestClient, admin_headers: dict):
        resp = client.get("/api/v1/admin/analytics", headers=admin_headers)
        rate = resp.json()["resolution_rate"]
        assert 0.0 <= rate <= 100.0


# ── Security ──────────────────────────────────────────────────────────────────

class TestSecurity:

    def test_invalid_bearer_rejected(self, client: TestClient):
        resp = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer invalid.token.here"},
        )
        assert resp.status_code == 401

    def test_no_auth_header(self, client: TestClient):
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 403

    def test_admin_endpoint_blocks_regular_user(self, client: TestClient, auth_headers: dict):
        resp = client.get("/api/v1/admin/analytics", headers=auth_headers)
        assert resp.status_code == 403

    def test_chat_endpoints_blocked_without_auth(self, client: TestClient):
        endpoints = [
            ("POST", "/api/v1/chat/sessions"),
            ("GET",  "/api/v1/chat/sessions"),
            ("POST", "/api/v1/chat/stream"),
        ]
        for method, path in endpoints:
            resp = client.request(method, path)
            assert resp.status_code in (403, 422), f"{method} {path} should require auth"

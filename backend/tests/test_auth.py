"""
Auth endpoint tests — register, login, refresh, logout, /me.
All run against SQLite; no external services needed.
"""
import pytest
from fastapi.testclient import TestClient


class TestRegister:

    def test_register_success(self, client: TestClient):
        resp = client.post("/api/v1/auth/register", json={
            "email":     "newreg@example.com",
            "full_name": "New Reg",
            "password":  "strongpassword123",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert "access_token"  in data
        assert "refresh_token" in data
        assert data["token_type"] == "bearer"

    def test_register_duplicate_email(self, client: TestClient):
        payload = {
            "email":     "dup@example.com",
            "full_name": "Dup User",
            "password":  "strongpassword123",
        }
        r1 = client.post("/api/v1/auth/register", json=payload)
        assert r1.status_code == 201
        r2 = client.post("/api/v1/auth/register", json=payload)
        assert r2.status_code == 409

    def test_register_short_password(self, client: TestClient):
        resp = client.post("/api/v1/auth/register", json={
            "email":     "short@example.com",
            "full_name": "Short",
            "password":  "abc",
        })
        assert resp.status_code == 422

    def test_register_invalid_email(self, client: TestClient):
        resp = client.post("/api/v1/auth/register", json={
            "email":     "not-an-email",
            "full_name": "Bad Email",
            "password":  "strongpassword123",
        })
        assert resp.status_code == 422

    def test_register_missing_fields(self, client: TestClient):
        resp = client.post("/api/v1/auth/register", json={
            "email": "missing@example.com",
        })
        assert resp.status_code == 422


class TestLogin:

    def test_login_success(self, client: TestClient, registered_user: dict):
        resp = client.post("/api/v1/auth/login", json={
            "email":    registered_user["email"],
            "password": registered_user["password"],
        })
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_login_wrong_password(self, client: TestClient, registered_user: dict):
        resp = client.post("/api/v1/auth/login", json={
            "email":    registered_user["email"],
            "password": "wrongpassword",
        })
        assert resp.status_code == 401

    def test_login_unknown_email(self, client: TestClient):
        resp = client.post("/api/v1/auth/login", json={
            "email":    "nobody@example.com",
            "password": "doesntmatter",
        })
        assert resp.status_code == 401

    def test_login_returns_both_tokens(self, client: TestClient, registered_user: dict):
        resp = client.post("/api/v1/auth/login", json={
            "email":    registered_user["email"],
            "password": registered_user["password"],
        })
        data = resp.json()
        assert "access_token"  in data
        assert "refresh_token" in data


class TestMe:

    def test_me_returns_user(self, client: TestClient, auth_headers: dict):
        resp = client.get("/api/v1/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"]    == "testuser@example.com"
        assert data["role"]     == "user"
        assert "full_name" in data

    def test_me_requires_auth(self, client: TestClient):
        resp = client.get("/api/v1/auth/me")
        assert resp.status_code == 403

    def test_me_invalid_token(self, client: TestClient):
        resp = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": "Bearer totally.fake.token"},
        )
        assert resp.status_code == 401


class TestRefreshAndLogout:

    def test_refresh_produces_new_tokens(self, client: TestClient, registered_user: dict):
        login = client.post("/api/v1/auth/login", json={
            "email":    registered_user["email"],
            "password": registered_user["password"],
        })
        refresh_token = login.json()["refresh_token"]
        resp = client.post("/api/v1/auth/refresh",
                           json={"refresh_token": refresh_token})
        assert resp.status_code == 200
        data = resp.json()
        assert "access_token"  in data
        assert "refresh_token" in data

    def test_refresh_invalid_token(self, client: TestClient):
        resp = client.post("/api/v1/auth/refresh",
                           json={"refresh_token": "bad.token.here"})
        assert resp.status_code == 401

    def test_logout_revokes_token(self, client: TestClient, registered_user: dict):
        login = client.post("/api/v1/auth/login", json={
            "email":    registered_user["email"],
            "password": registered_user["password"],
        })
        refresh_token = login.json()["refresh_token"]
        resp = client.post("/api/v1/auth/logout",
                           json={"refresh_token": refresh_token})
        assert resp.status_code == 204

    def test_used_refresh_token_rejected(self, client: TestClient, registered_user: dict):
        login = client.post("/api/v1/auth/login", json={
            "email":    registered_user["email"],
            "password": registered_user["password"],
        })
        refresh_token = login.json()["refresh_token"]

        # Use it once — should succeed
        r1 = client.post("/api/v1/auth/refresh",
                         json={"refresh_token": refresh_token})
        assert r1.status_code == 200

        # Use again — should be rejected (rotation)
        r2 = client.post("/api/v1/auth/refresh",
                         json={"refresh_token": refresh_token})
        assert r2.status_code == 401


class TestAuthSecurity:

    def test_bearer_required(self, client: TestClient):
        resp = client.get("/api/v1/auth/me",
                          headers={"Authorization": "Basic dXNlcjpwYXNz"})
        assert resp.status_code == 403

    def test_expired_looking_token(self, client: TestClient):
        # Well-formed JWT but wrong secret
        fake = (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiJ1c2VyLWlkIiwiZXhwIjo5OTk5OTk5OTk5fQ."
            "bad_signature_here"
        )
        resp = client.get("/api/v1/auth/me",
                          headers={"Authorization": f"Bearer {fake}"})
        assert resp.status_code == 401

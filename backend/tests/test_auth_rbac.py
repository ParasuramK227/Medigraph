"""RBAC integration tests: authentication and the per-role permission matrix.

Covers login/register/me, token expiry/tampering, and that every protected
endpoint enforces exactly the documented role policy:

  /api/graph/cypher                  -> admin only
  /api/graph/explore                 -> admin + researcher
  /api/graph/patients POST/PUT       -> admin + doctor
  /api/graph/patients DELETE         -> admin only
  /api/scribe/*                      -> admin + doctor
  /api/auth/users + role management  -> admin only
  everything else                    -> any authenticated user
"""

import uuid

import jwt
import pytest

from backend.auth_utils import create_token, get_secret_key
from backend.neo4j_connection import get_session

from backend.tests.conftest import DEMO, _auth


def _expired_token():
    payload = {
        "sub": "user-admin",
        "username": "admin",
        "role": "admin",
        "iat": 0,
        "exp": 1,
        "type": "access",
    }
    return jwt.encode(payload, get_secret_key(), algorithm="HS256")


class TestLogin:
    def test_missing_credentials(self, client):
        resp = client.post("/api/auth/login", json={})
        assert resp.status_code == 400

    def test_invalid_password(self, client):
        resp = client.post("/api/auth/login", json={"username": "admin", "password": "nope-nope"})
        assert resp.status_code == 401

    def test_each_role_logs_in(self, client):
        for role, (username, password) in DEMO.items():
            resp = client.post("/api/auth/login", json={"username": username, "password": password})
            assert resp.status_code == 200, resp.get_json()
            body = resp.get_json()
            assert body["token"]
            assert body["user"]["role"] == role
            assert "password_hash" not in body["user"]


class TestRegister:
    def test_client_cannot_choose_role(self, client):
        resp = client.post(
            "/api/auth/register",
            json={"username": "rbac-user-1", "email": "rbac-user-1@test.com",
                  "password": "Passw0rd!123", "role": "admin"},
        )
        assert resp.status_code == 400
        assert "administrator" in resp.get_json()["error"]

    def test_short_password_rejected(self, client):
        resp = client.post(
            "/api/auth/register",
            json={"username": "rbac-user-2", "email": "rbac-user-2@test.com", "password": "short"},
        )
        assert resp.status_code == 400

    def test_registration_is_researcher_and_can_login(self, client):
        suffix = uuid.uuid4().hex[:10]
        username = f"rbac-user-{suffix}"
        email = f"{username}@test.com"
        resp = client.post(
            "/api/auth/register",
            json={"username": username, "email": email, "password": "Passw0rd!123"},
        )
        assert resp.status_code == 201, resp.get_json()
        assert resp.get_json()["user"]["role"] == "researcher"

        login = client.post("/api/auth/login", json={"username": username, "password": "Passw0rd!123"})
        assert login.status_code == 200
        assert login.get_json()["user"]["role"] == "researcher"


class TestMe:
    def test_requires_token(self, client):
        assert client.get("/api/auth/me").status_code == 401

    def test_each_role(self, client, login):
        for role in DEMO:
            resp = client.get("/api/auth/me", headers=_auth(login(role)))
            assert resp.status_code == 200
            body = resp.get_json()
            assert body["role"] == role
            assert "password_hash" not in body

    def test_garbage_token(self, client):
        resp = client.get("/api/auth/me", headers=_auth("not.a.valid.jwt"))
        assert resp.status_code == 401

    def test_tampered_signature(self, client):
        good = create_token({"id": "user-admin", "username": "admin", "role": "admin"})
        tampered = good[:-4] + ("abcd" if not good.endswith("abcd") else "efgh")
        resp = client.get("/api/auth/me", headers=_auth(tampered))
        assert resp.status_code == 401

    def test_expired_token(self, client):
        tok = _expired_token()
        resp = client.get("/api/auth/me", headers=_auth(tok))
        assert resp.status_code == 401

    def test_deleted_user_token_rejected(self, client, login):
        """A token issued to a user removed from the DB must not authenticate."""
        tok = login("researcher")
        with get_session() as s:
            s.run("MATCH (u:User {username: $un}) DETACH DELETE u", un="researcher")
        try:
            resp = client.get("/api/auth/me", headers=_auth(tok))
            assert resp.status_code == 401
        finally:
            from backend import user_store

            user_store.bootstrap_demo_users()


class TestUserManagement:
    def test_list_users_admin_only(self, client, login):
        ok = client.get("/api/auth/users", headers=_auth(login("admin")))
        assert ok.status_code == 200
        assert isinstance(ok.get_json(), list)

        denied = client.get("/api/auth/users", headers=_auth(login("doctor")))
        assert denied.status_code == 403

        assert client.get("/api/auth/users").status_code == 401

    def test_admin_cannot_change_own_role(self, client, login):
        ident = login("admin")
        me = client.get("/api/auth/me", headers=_auth(ident)).get_json()
        resp = client.put(f"/api/auth/users/{me['id']}/role", json={"role": "doctor"}, headers=_auth(ident))
        assert resp.status_code == 400

    def test_role_reassignment_admin_only(self, client, login, clean_rbac_data):
        admin_tok = login("admin")
        suffix = uuid.uuid4().hex[:10]
        uname = f"rbac-user-{suffix}"
        client.post("/api/auth/register", json={
            "username": uname, "email": f"{uname}@test.com", "password": "Passw0rd!123",
        })
        users = client.get("/api/auth/users", headers=_auth(admin_tok)).get_json()
        target = next(u for u in users if u["username"] == uname)
        assert target["role"] == "researcher"

        promoted = client.put(
            f"/api/auth/users/{target['id']}/role", json={"role": "doctor"},
            headers=_auth(admin_tok),
        )
        assert promoted.status_code == 200
        assert promoted.get_json()["role"] == "doctor"

        doctor_denied = client.put(
            f"/api/auth/users/{target['id']}/role", json={"role": "admin"},
            headers=_auth(login("doctor")),
        )
        assert doctor_denied.status_code == 403

        bad_role = client.put(
            f"/api/auth/users/{target['id']}/role", json={"role": "superuser"},
            headers=_auth(admin_tok),
        )
        assert bad_role.status_code == 400


class TestCypherMatrix:
    QUERY = {"query": "MATCH (n) RETURN n LIMIT 1"}

    def test_admin_only(self, client, login):
        roles = {"admin": 200, "doctor": 403, "researcher": 403}
        for role, expected in roles.items():
            resp = client.post("/api/graph/cypher", json=self.QUERY, headers=_auth(login(role)))
            assert resp.status_code == expected, (role, resp.get_json())

        none = client.post("/api/graph/cypher", json=self.QUERY)
        assert none.status_code == 401


class TestExploreMatrix:
    BODY = {"preset": "all_connected"}

    def test_roles(self, client, login):
        roles = {"admin": 200, "researcher": 200, "doctor": 403}
        for role, expected in roles.items():
            resp = client.post("/api/graph/explore", json=self.BODY, headers=_auth(login(role)))
            assert resp.status_code == expected, (role, resp.get_json())

    def test_unauthenticated(self, client):
        assert client.post("/api/graph/explore", json=self.BODY).status_code == 401


class TestPatientMutationMatrix:
    def _create(self, client, token, pid):
        return client.post("/api/graph/patients", json={"id": pid, "first_name": "RBAC", "last_name": "Test"}, headers=_auth(token))

    def test_admin_create_delete(self, client, login):
        admin_tok = login("admin")
        pid = f"rbac-patient-{uuid.uuid4().hex[:10]}"
        created = self._create(client, admin_tok, pid)
        assert created.status_code == 201

        updated = client.put(f"/api/graph/patients/{pid}", json={"first_name": "Updated"}, headers=_auth(admin_tok))
        assert updated.status_code == 200

        deleted = client.delete(f"/api/graph/patients/{pid}", headers=_auth(admin_tok))
        assert deleted.status_code == 200

    def test_doctor_can_create_not_delete(self, client, login):
        doctor_tok = login("doctor")
        pid = f"rbac-patient-{uuid.uuid4().hex[:10]}"
        created = self._create(client, doctor_tok, pid)
        assert created.status_code == 201

        deny_del = client.delete(f"/api/graph/patients/{pid}", headers=_auth(doctor_tok))
        assert deny_del.status_code == 403

        client.delete(f"/api/graph/patients/{pid}", headers=_auth(login("admin")))

    def test_researcher_read_only(self, client, login):
        res_tok = login("researcher")
        pid = f"rbac-patient-{uuid.uuid4().hex[:10]}"
        deny_create = self._create(client, res_tok, pid)
        assert deny_create.status_code == 403

        admin_tok = login("admin")
        pid2 = f"rbac-patient-{uuid.uuid4().hex[:10]}"
        self._create(client, admin_tok, pid2)
        deny_update = client.put(f"/api/graph/patients/{pid2}", json={"first_name": "No"}, headers=_auth(res_tok))
        assert deny_update.status_code == 403
        client.delete(f"/api/graph/patients/{pid2}", headers=_auth(admin_tok))


class TestScribeMatrix:
    def test_clinical_roles_only(self, client, login):
        roles = {"admin": 200, "doctor": 200, "researcher": 403}
        for role, expected in roles.items():
            resp = client.post("/api/scribe/start", headers=_auth(login(role)))
            assert resp.status_code == expected, (role, resp.get_json())

        assert client.post("/api/scribe/start").status_code == 401


class TestReadEndpointsMatrix:
    def test_any_authenticated(self, client, login):
        authed_paths = [
            ("GET", "/api/graph/sectors"),
            ("GET", "/api/graph/patient-summaries"),
            ("GET", "/api/graph/dashboard/top-sectors"),
            ("GET", "/api/graph/schema"),
            ("GET", "/api/chat/suggestions"),
        ]
        for role in ("admin", "doctor", "researcher"):
            tok = login(role)
            for method, path in authed_paths:
                resp = client.open(path, method=method, headers=_auth(tok))
                assert resp.status_code == 200, (role, method, path, resp.get_json())

    def test_unauthenticated_denied(self, client):
        for path in (
            "/api/graph/sectors",
            "/api/graph/patient-summaries",
            "/api/graph/dashboard/top-sectors",
            "/api/graph/schema",
            "/api/chat/suggestions",
        ):
            assert client.get(path).status_code == 401


class TestDeactivatedUser:
    def test_deactivated_user_forbidden(self, client, login):
        admin_tok = login("admin")
        with get_session() as s:
            s.run("MATCH (u:User {username: 'researcher'}) SET u.active = false")
        try:
            resp = client.post("/api/auth/login", json={"username": "researcher", "password": "ResearcherPassword123!"})
            assert resp.status_code == 401
        finally:
            with get_session() as s:
                s.run("MATCH (u:User {username: 'researcher'}) SET u.active = true")
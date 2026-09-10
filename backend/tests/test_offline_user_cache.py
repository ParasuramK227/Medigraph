"""Offline user-cache fallback tests — NO Neo4j required.

These verify that demo login, RBAC, and scribe session creation keep working
when the cloud Neo4j database is unreachable (offline), backed only by the
file-based user cache in ``backend/user_store``.

The autouse ``clean_rbac_data`` fixture from conftest.py is intentionally
shadowed here: every Neo4j call in this module is forced to fail so the tests
exercise the offline fallback path headlessly.
"""

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import dotenv  # noqa: E402

dotenv.load_dotenv(ROOT_ENV)

from backend import user_store  # noqa: E402
from backend.app import create_app  # noqa: E402

DEMO = {
    "admin": ("admin", "AdminPassword123!"),
    "doctor": ("dr.smith", "DoctorPassword123!"),
    "researcher": ("researcher", "ResearcherPassword123!"),
}


class _OfflineError(RuntimeError):
    """Raised any time code tries to reach Neo4j in the offline tests."""


def _offline_unreachable(*_args, **_kwargs):
    raise _OfflineError("Neo4j unreachable: simulating offline mode")


@pytest.fixture()
def clean_rbac_data():
    """Override conftest's autouse DB cleanup: offline tests never touch Neo4j."""
    return None


@pytest.fixture()
def offline_client(tmp_path, monkeypatch):
    """Flask test client whose user store is backed only by a temp JSON cache."""
    monkeypatch.setenv("USER_CACHE_PATH", str(tmp_path / "user_cache.json"))
    monkeypatch.setattr(user_store, "get_session", _offline_unreachable)
    monkeypatch.setattr(user_store, "get_driver", _offline_unreachable)
    user_store._seed_cache_from_demo_users()

    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def test_demo_login_and_scribe_start_work_offline(offline_client):
    resp = offline_client.post("/api/auth/login", json={
        "username": DEMO["admin"][0],
        "password": DEMO["admin"][1],
    })
    assert resp.status_code == 200, resp.get_json()
    token = resp.get_json()["token"]

    start = offline_client.post("/api/scribe/start", headers={"Authorization": f"Bearer {token}"})
    assert start.status_code == 200, start.get_json()
    assert isinstance(start.get_json()["session_id"], str)


def test_offline_login_rejects_bad_password(offline_client):
    resp = offline_client.post("/api/auth/login", json={
        "username": DEMO["admin"][0],
        "password": "wrong-password-xyz",
    })
    assert resp.status_code == 401


def test_offline_rbac_blocks_wrong_role(offline_client):
    resp = offline_client.post("/api/auth/login", json={
        "username": DEMO["researcher"][0],
        "password": DEMO["researcher"][1],
    })
    token = resp.get_json()["token"]

    start = offline_client.post("/api/scribe/start", headers={"Authorization": f"Bearer {token}"})
    assert start.status_code == 403


def test_offline_rejects_tampered_token(offline_client):
    resp = offline_client.post(
        "/api/scribe/start",
        headers={"Authorization": "Bearer not.a.valid.jwt"},
    )
    assert resp.status_code in (401,)
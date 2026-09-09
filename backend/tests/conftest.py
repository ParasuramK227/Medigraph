"""Shared pytest fixtures for the MediGraph RBAC test suite.

Tests run against the live Neo4j database with the demo accounts seeded by
``user_store.bootstrap_demo_users``. Any data created under the ``rbac-``
prefix is deleted both before and after each test, so the suite stays
idempotent and never pollutes the real dataset.
"""

import os
import sys
from pathlib import Path

import pytest
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[1]
ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"

sys.path.insert(0, str(REPO_ROOT))

load_dotenv(ROOT_ENV)

from backend.app import create_app  # noqa: E402
from backend.neo4j_connection import get_session  # noqa: E402

DEMO = {
    "admin": ("admin", "AdminPassword123!"),
    "doctor": ("dr.smith", "DoctorPassword123!"),
    "researcher": ("researcher", "ResearcherPassword123!"),
}


def _auth(token=None):
    return {"Authorization": f"Bearer {token}"} if token else {}


def _cleanup_rbac_data():
    with get_session() as s:
        s.run("MATCH (u:User) WHERE u.username STARTS WITH 'rbac-' DETACH DELETE u")
        s.run("MATCH (p:Patient) WHERE p.id STARTS WITH 'rbac-patient-' DETACH DELETE p")


@pytest.fixture(scope="session")
def app():
    flask_app = create_app()
    flask_app.config["TESTING"] = True
    return flask_app


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def clean_rbac_data():
    _cleanup_rbac_data()
    yield
    _cleanup_rbac_data()


@pytest.fixture()
def login(client):
    """Log in a demo account by role and cache the JWT per test."""
    cache = {}

    def _login(role):
        if role not in cache:
            username, password = DEMO[role]
            resp = client.post("/api/auth/login", json={"username": username, "password": password})
            assert resp.status_code == 200, resp.get_json()
            cache[role] = resp.get_json()["token"]
        return cache[role]

    return _login
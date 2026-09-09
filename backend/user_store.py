"""Neo4j-backed User storage: User nodes, uniqueness constraints, demo users.

A User has: id, username, email, password_hash, role, active, created_at.
Passwords are stored only as Werkzeug PBKDF2 hashes (see auth_utils.hash_password).
"""

import uuid
from datetime import datetime, timezone

from backend.auth_utils import hash_password
from backend.neo4j_connection import get_driver, get_session

DEMO_USERS = [
    {
        "id": "user-admin",
        "username": "admin",
        "email": "admin@medigraph.demo",
        "password": "AdminPassword123!",
        "role": "admin",
    },
    {
        "id": "user-dr-smith",
        "username": "dr.smith",
        "email": "dr.smith@medigraph.demo",
        "password": "DoctorPassword123!",
        "role": "doctor",
    },
    {
        "id": "user-researcher",
        "username": "researcher",
        "email": "researcher@medigraph.demo",
        "password": "ResearcherPassword123!",
        "role": "researcher",
    },
]


def _get(node, key, default=None):
    return node[key] if node is not None and key in node else default


def _row_to_user(rec) -> dict | None:
    if rec is None or rec.get("u") is None:
        return None
    u = rec["u"]
    return {
        "id": _get(u, "id"),
        "username": _get(u, "username"),
        "email": _get(u, "email"),
        "password_hash": _get(u, "password_hash"),
        "role": _get(u, "role"),
        "active": bool(_get(u, "active", True)),
        "created_at": _get(u, "created_at"),
    }


def ensure_user_constraints() -> None:
    """Idempotent unique constraints (Neo4j 5.x syntax)."""
    statements = [
        "CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
        "CREATE CONSTRAINT user_username_unique IF NOT EXISTS FOR (u:User) REQUIRE u.username IS UNIQUE",
        "CREATE CONSTRAINT user_email_unique IF NOT EXISTS FOR (u:User) REQUIRE u.email IS UNIQUE",
    ]
    with get_driver().session() as session:
        for stmt in statements:
            session.run(stmt)


def get_user_by_id(user_id: str) -> dict | None:
    with get_session() as s:
        rec = s.run("MATCH (u:User {id: $id}) RETURN u", id=user_id).single()
    return _row_to_user(rec)


def get_user_by_username(username: str) -> dict | None:
    with get_session() as s:
        rec = s.run(
            "MATCH (u:User) WHERE toLower(u.username) = toLower($n) RETURN u",
            n=username,
        ).single()
    return _row_to_user(rec)


def get_user_by_email(email: str) -> dict | None:
    if not email:
        return None
    with get_session() as s:
        rec = s.run(
            "MATCH (u:User) WHERE u.email IS NOT NULL AND toLower(u.email) = toLower($e) RETURN u",
            e=email,
        ).single()
    return _row_to_user(rec)


def get_user_by_username_or_email(identifier: str) -> dict | None:
    with get_session() as s:
        rec = s.run(
            """
            MATCH (u:User)
            WHERE toLower(u.username) = toLower($id)
               OR (u.email IS NOT NULL AND toLower(u.email) = toLower($id))
            RETURN u
            LIMIT 1
            """,
            id=identifier,
        ).single()
    return _row_to_user(rec)


def list_users() -> list[dict]:
    with get_session() as s:
        result = s.run("MATCH (u:User) RETURN u ORDER BY toLower(u.username)")
        rows = [_row_to_user(rec) for rec in result if rec is not None]
    return rows


def create_user(username: str, email: str, password_hash: str, role: str) -> dict | None:
    user_id = f"u-{uuid.uuid4()}"
    created = datetime.now(timezone.utc).isoformat()
    with get_session() as s:
        result = s.run(
            """
            CREATE (u:User {id: $id, username: $username, email: $email,
                            password_hash: $ph, role: $role, active: true,
                            created_at: $created})
            RETURN u
            """,
            id=user_id,
            username=username,
            email=email,
            ph=password_hash,
            role=role,
            created=created,
        )
        rec = result.single()
    return _row_to_user(rec)


def set_user_role(user_id: str, role: str) -> dict | None:
    with get_session() as s:
        rec = s.run(
            "MATCH (u:User {id: $id}) SET u.role = $role RETURN u",
            id=user_id,
            role=role,
        ).single()
    return _row_to_user(rec)


def bootstrap_demo_users() -> None:
    """Idempotently create (or repair defaults for) the demo accounts.

    Never overwrites an existing account's password; only backfills missing
    role / active / email so a user can change their own credentials safely.
    """
    ensure_user_constraints()
    for demo in DEMO_USERS:
        ph = hash_password(demo["password"])
        with get_session() as s:
            existing = s.run(
                "MATCH (u:User {username: $n}) RETURN u",
                n=demo["username"],
            ).single()
            if existing:
                s.run(
                    """
                    MATCH (u:User {username: $n})
                    SET u.role = coalesce(u.role, $role),
                        u.active = coalesce(u.active, true),
                        u.email = coalesce(u.email, $email),
                        u.id = coalesce(u.id, $id)
                    """,
                    n=demo["username"],
                    id=demo["id"],
                    email=demo["email"],
                    role=demo["role"],
                )
            else:
                s.run(
                    """
                    CREATE (u:User {id: $id, username: $username, email: $email,
                                    password_hash: $ph, role: $role, active: true,
                                    created_at: $created})
                    """,
                    id=demo["id"],
                    username=demo["username"],
                    email=demo["email"],
                    ph=ph,
                    role=demo["role"],
                    created=datetime.now(timezone.utc).isoformat(),
                )
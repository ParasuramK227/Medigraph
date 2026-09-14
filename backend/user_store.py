"""Neo4j-backed User storage: User nodes, uniqueness constraints, demo users.

A User has: id, username, email, password_hash, role, active, created_at.
Passwords are stored only as Werkzeug PBKDF2 hashes (see auth_utils.hash_password).

Offline resilience: Neo4j (AuraDB cloud) is the source of truth, but every read
and write also mirrors into a local JSON cache (``backend/user_cache.json``,
path overridable via ``USER_CACHE_PATH``). When the database is unreachable
(e.g. no internet), auth and RBAC keep working against the cached users so the
on-device Moonshine scribe can run fully offline. Demo accounts are always
seeded into the cache so ``admin`` / ``dr.smith`` / ``researcher`` can log in
even before the first successful cloud connection.
"""

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from backend.auth_utils import hash_password
from backend.neo4j_connection import get_driver, get_session

logger = logging.getLogger(__name__)

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

_CACHE_LOCK = threading.Lock()


def _cache_path() -> Path:
    override = os.environ.get("USER_CACHE_PATH", "").strip()
    if override:
        return Path(override)
    return Path(__file__).resolve().with_name("user_cache.json")


def _seed_cache_from_demo_users() -> None:
    """Idempotently mirror the demo accounts into the local cache."""
    data = _read_cache()
    now = datetime.now(timezone.utc).isoformat()
    changed = False
    for demo in DEMO_USERS:
        if demo["id"] in data:
            continue
        data[demo["id"]] = {
            "id": demo["id"],
            "username": demo["username"],
            "email": demo["email"],
            "password_hash": hash_password(demo["password"]),
            "role": demo["role"],
            "active": True,
            "created_at": now,
        }
        changed = True
    if changed:
        _write_cache(data)


def _read_cache() -> dict:
    path = _cache_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_cache(data: dict) -> None:
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _CACHE_LOCK:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, sort_keys=True)
                f.write("\n")
    except OSError as e:
        logger.warning("Could not write offline user cache: %s", e)


def _cache_put(user: dict | None) -> None:
    if not user or not user.get("id"):
        return
    data = _read_cache()
    data[user["id"]] = user
    _write_cache(data)


def _cache_get_by_id(user_id: str) -> dict | None:
    return _read_cache().get(user_id)


def _cache_get_by_username(username: str) -> dict | None:
    low = username.lower()
    for u in _read_cache().values():
        if (u.get("username") or "").lower() == low:
            return u
    return None


def _cache_get_by_email(email: str) -> dict | None:
    low = email.lower()
    for u in _read_cache().values():
        if (u.get("email") or "").lower() == low:
            return u
    return None


def _cache_get_by_username_or_email(identifier: str) -> dict | None:
    low = identifier.lower()
    for u in _read_cache().values():
        if (u.get("username") or "").lower() == low or (u.get("email") or "").lower() == low:
            return u
    return None


def _cache_list() -> list[dict]:
    users = list(_read_cache().values())
    return sorted(users, key=lambda u: (u.get("username") or "").lower())


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
    try:
        with get_session() as s:
            rec = s.run("MATCH (u:User {id: $id}) RETURN u", id=user_id).single()
        user = _row_to_user(rec)
    except Exception as e:
        logger.warning("get_user_by_id: Neo4j unavailable (%s); using offline cache", e)
        user = _cache_get_by_id(user_id)
    if user:
        _cache_put(user)
    return user


def get_user_by_username(username: str) -> dict | None:
    try:
        with get_session() as s:
            rec = s.run(
                "MATCH (u:User) WHERE toLower(u.username) = toLower($n) RETURN u",
                n=username,
            ).single()
        user = _row_to_user(rec)
    except Exception as e:
        logger.warning("get_user_by_username: Neo4j unavailable (%s); using offline cache", e)
        user = _cache_get_by_username(username)
    if user:
        _cache_put(user)
    return user


def get_user_by_email(email: str) -> dict | None:
    if not email:
        return None
    try:
        with get_session() as s:
            rec = s.run(
                "MATCH (u:User) WHERE u.email IS NOT NULL AND toLower(u.email) = toLower($e) RETURN u",
                e=email,
            ).single()
        user = _row_to_user(rec)
    except Exception as e:
        logger.warning("get_user_by_email: Neo4j unavailable (%s); using offline cache", e)
        user = _cache_get_by_email(email)
    if user:
        _cache_put(user)
    return user


def get_user_by_username_or_email(identifier: str) -> dict | None:
    try:
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
        user = _row_to_user(rec)
    except Exception as e:
        logger.warning(
            "get_user_by_username_or_email: Neo4j unavailable (%s); using offline cache", e
        )
        user = _cache_get_by_username_or_email(identifier)
    if user:
        _cache_put(user)
    return user


def list_users() -> list[dict]:
    try:
        with get_session() as s:
            result = s.run("MATCH (u:User) RETURN u ORDER BY toLower(u.username)")
            users = [_row_to_user(rec) for rec in result if rec is not None]
    except Exception as e:
        logger.warning("list_users: Neo4j unavailable (%s); using offline cache", e)
        return _cache_list()
    for u in users:
        _cache_put(u)
    return users


def create_user(username: str, email: str, password_hash: str, role: str) -> dict | None:
    user_id = f"u-{uuid.uuid4()}"
    created = datetime.now(timezone.utc).isoformat()
    local_user = {
        "id": user_id,
        "username": username,
        "email": email,
        "password_hash": password_hash,
        "role": role,
        "active": True,
        "created_at": created,
    }
    try:
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
        user = _row_to_user(rec) or local_user
        _cache_put(user)
        return user
    except Exception as e:
        logger.warning("create_user: Neo4j unavailable (%s); creating local user", e)
        _cache_put(local_user)
        return local_user


def set_user_role(user_id: str, role: str) -> dict | None:
    try:
        with get_session() as s:
            rec = s.run(
                "MATCH (u:User {id: $id}) SET u.role = $role RETURN u",
                id=user_id,
                role=role,
            ).single()
        user = _row_to_user(rec)
    except Exception as e:
        logger.warning("set_user_role: Neo4j unavailable (%s); using offline cache", e)
        user = _cache_get_by_id(user_id)
        if user:
            user = dict(user)
            user["role"] = role
            _cache_put(user)
        return user
    if user:
        _cache_put(user)
    return user


def bootstrap_demo_users() -> None:
    """Idempotently create (or repair defaults for) the demo accounts.

    Always seeds the offline cache first so demo login works even when Neo4j
    is unreachable. Never overwrites an existing account's password; only
    backfills missing role / active / email so a user can change their own
    credentials safely.
    """
    _seed_cache_from_demo_users()
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
            rec = s.run(
                "MATCH (u:User {username: $n}) RETURN u",
                n=demo["username"],
            ).single()
            _cache_put(_row_to_user(rec))


_seed_cache_from_demo_users()
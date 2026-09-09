"""Centralized RBAC primitives for MediGraph.

Roles, password hashing (Werkzeug), JWT creation/validation (PyJWT, HMAC-SHA256)
and the Flask decorators used to protect every API route:

    @require_auth                       -> 401 when missing/invalid/expired token
    @require_role("admin", "doctor")    -> 401 when unauthenticated, 403 on wrong role

JWT payload intentionally carries no sensitive data (only sub / username / role
+ timestamps); password hashes never cross the API boundary.
"""

import os
import time

import jwt
from functools import wraps
from flask import g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

ROLES = ("admin", "doctor", "researcher")

_FALLBACK_SECRET = (
    "medigraph-dev-only-change-me-7f3a94b2c1d0e5f6879a0b1c2d3e4f5a"
)

_ALGORITHM = "HS256"


def get_secret_key() -> str:
    """JWT signing secret. A strong env value is preferred; a dev fallback
    keeps local demos running without configuration."""
    secret = (os.environ.get("JWT_SECRET_KEY") or "").strip()
    if len(secret) >= 32:
        return secret
    return _FALLBACK_SECRET


def get_expiration_seconds() -> int:
    try:
        return max(1, int(os.environ.get("JWT_EXPIRATION_MINUTES", "60"))) * 60
    except (TypeError, ValueError):
        return 60 * 60


# --- Passwords ---------------------------------------------------------------

def hash_password(password: str) -> str:
    return generate_password_hash(password)


def check_password(password: str, password_hash: str) -> bool:
    try:
        return check_password_hash(password_hash, password)
    except Exception:
        return False


# --- JWT ---------------------------------------------------------------------

def create_token(user: dict) -> str:
    now = int(time.time())
    payload = {
        "sub": user["id"],
        "username": user["username"],
        "role": user["role"],
        "iat": now,
        "exp": now + get_expiration_seconds(),
        "type": "access",
    }
    return jwt.encode(payload, get_secret_key(), algorithm=_ALGORITHM)


def decode_token(token: str) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(
            token,
            get_secret_key(),
            algorithms=[_ALGORITHM],
            options={"require": ["sub", "exp", "role"]},
        )
        return payload
    except (jwt.InvalidTokenError, ValueError, TypeError):
        return None
    except Exception:
        return None


# --- Auth helpers ------------------------------------------------------------

def _authenticate():
    """Resolve the Authorization: Bearer token into a User dict.

    Returns (user, error_response). On success error_response is None and the
    caller should set g.user; otherwise error_response is the Flask 401 payload.
    """
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None, (jsonify({"error": "authentication required"}), 401)

    token = auth[len("Bearer "):].strip()
    payload = decode_token(token)
    if payload is None:
        return None, (jsonify({"error": "invalid or expired token"}), 401)

    from backend import user_store
    user = user_store.get_user_by_id(payload["sub"])
    if user is None or not user.get("active", True):
        return None, (jsonify({"error": "user account unavailable"}), 401)

    return user, None


def require_auth(view_func):
    """Any authenticated user may access the wrapped view."""
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        user, err = _authenticate()
        if err:
            return err
        g.user = user
        return view_func(*args, **kwargs)
    return wrapper


def require_role(*roles):
    """Only users with one of the given roles may access the wrapped view."""
    if not roles or any(r not in ROLES for r in roles):
        raise ValueError(f"invalid role(s): {roles}; allowed={ROLES}")

    def decorator(view_func):
        @wraps(view_func)
        def wrapper(*args, **kwargs):
            user, err = _authenticate()
            if err:
                return err
            if user["role"] not in roles:
                return jsonify({
                    "error": f"forbidden: requires role(s) {', '.join(roles)}",
                }), 403
            g.user = user
            return view_func(*args, **kwargs)
        return wrapper
    return decorator
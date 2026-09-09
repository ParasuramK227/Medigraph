"""Authentication & user-management endpoints under /api/auth.

Public:       POST /login, POST /register
Requires auth: GET /me
Admin only:    GET /users, PUT /users/<user_id>/role

Role assignment is ALWAYS backend-controlled: registration can only ever
produce a `researcher` account, and clients cannot assign any role for
themselves. Password hashes are never returned.
"""

import re

from flask import Blueprint, g, jsonify, request

from backend import user_store
from backend.auth_utils import (
    ROLES,
    check_password,
    create_token,
    hash_password,
    require_auth,
    require_role,
)

auth_bp = Blueprint("auth", __name__)

_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _safe_user(user: dict) -> dict:
    """Public-safe projection — never exposes password hashes."""
    return {
        "id": user.get("id"),
        "username": user.get("username"),
        "email": user.get("email"),
        "role": user.get("role"),
        "active": bool(user.get("active", True)),
        "created_at": user.get("created_at"),
    }


@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    identifier = (data.get("username") or data.get("email") or "").strip()
    password = data.get("password") or ""

    if not identifier or not password:
        return jsonify({"error": "username/email and password are required"}), 400

    user = user_store.get_user_by_username_or_email(identifier)
    if user is None or not check_password(password, user.get("password_hash") or ""):
        return jsonify({"error": "invalid credentials"}), 401
    if not user.get("active", True):
        return jsonify({"error": "account is disabled"}), 401

    token = create_token(user)
    return jsonify({"token": token, "user": _safe_user(user)}), 200


@auth_bp.route("/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""

    # Role assignment is managed by the backend / admins only.
    if "role" in data and str(data.get("role")) not in ("", "researcher"):
        return jsonify({"error": "role assignment is managed by an administrator"}), 400

    if not username or not _USERNAME_RE.match(username):
        return jsonify({
            "error": "username must be 3-32 characters (letters, digits, . _ -)",
        }), 400
    if email and not _EMAIL_RE.match(email):
        return jsonify({"error": "a valid email address is required"}), 400
    if not password or len(password) < 8:
        return jsonify({"error": "password must be at least 8 characters"}), 400

    if user_store.get_user_by_username(username):
        return jsonify({"error": "username is already taken"}), 409
    if email and user_store.get_user_by_email(email):
        return jsonify({"error": "an account with this email already exists"}), 409

    user = user_store.create_user(
        username=username,
        email=email or None,
        password_hash=hash_password(password),
        role="researcher",
    )
    if user is None:
        return jsonify({"error": "could not create account"}), 500

    token = create_token(user)
    return jsonify({"token": token, "user": _safe_user(user)}), 201


@auth_bp.route("/me", methods=["GET"])
@require_auth
def me():
    return jsonify(_safe_user(g.user)), 200


@auth_bp.route("/users", methods=["GET"])
@require_role("admin")
def list_users():
    users = user_store.list_users()
    return jsonify([_safe_user(u) for u in users]), 200


@auth_bp.route("/users/<user_id>/role", methods=["PUT"])
@require_role("admin")
def update_user_role(user_id: str):
    data = request.get_json(silent=True) or {}
    role = (data.get("role") or "").strip()
    if role not in ROLES:
        return jsonify({"error": f"role must be one of: {', '.join(ROLES)}"}), 400
    if g.user["id"] == user_id:
        return jsonify({"error": "you cannot change your own role"}), 400

    user = user_store.set_user_role(user_id, role)
    if user is None:
        return jsonify({"error": "user not found"}), 404
    return jsonify(_safe_user(user)), 200
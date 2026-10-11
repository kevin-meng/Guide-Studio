"""Password hashing and signed HttpOnly session cookies without JWT dependencies."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from fastapi import HTTPException, Request

COOKIE = "gs_session"
TTL = 60 * 60 * 24 * 14


def secret():
    value = os.getenv("SESSION_SECRET", "")
    if len(value) < 32:
        raise RuntimeError("SESSION_SECRET must contain at least 32 characters")
    return value.encode()


def hash_password(password):
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${key.hex()}"


def verify_password(password, digest):
    try:
        _, salt, expected = digest.split("$")
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
        return hmac.compare_digest(actual, bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


def make_session(user_id):
    data = base64.urlsafe_b64encode(json.dumps({"sub": user_id, "exp": int(time.time()) + TTL}, separators=(",", ":")).encode()).rstrip(b"=").decode()
    mac = hmac.new(secret(), data.encode(), hashlib.sha256).hexdigest()
    return data + "." + mac


def read_session(token):
    try:
        data, mac = token.rsplit(".", 1)
        if not hmac.compare_digest(hmac.new(secret(), data.encode(), hashlib.sha256).hexdigest(), mac):
            return None
        payload = json.loads(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)))
        return payload["sub"] if payload["exp"] >= time.time() else None
    except (ValueError, KeyError, TypeError):
        return None


def require_user(request: Request, db):
    from server.db import User
    uid = read_session(request.cookies.get(COOKIE, ""))
    user = db.get(User, uid) if uid else None
    if not user:
        raise HTTPException(status_code=401, detail="请登录后继续")
    return user


def check_origin(request: Request):
    """Block cross-origin cookie-authenticated writes. Configure a same-origin reverse proxy."""
    from urllib.parse import urlsplit
    origin = request.headers.get("origin")
    if origin and urlsplit(origin).netloc != request.headers.get("host"):
        raise HTTPException(status_code=403, detail="请求来源不受信任")

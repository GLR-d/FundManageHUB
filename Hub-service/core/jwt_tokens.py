"""JWT 的签发、验证及中间件确认后的登录身份。"""

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4

import jwt

from core.config import Settings


@dataclass(frozen=True)
class SessionIdentity:
    user_id: int
    token_hash: str


def create_access_token(user_id: int, settings: Settings, *, issued_at: datetime) -> str:
    timestamp = int(issued_at.replace(tzinfo=timezone.utc).timestamp())
    return jwt.encode(
        {
            "sub": str(user_id),
            "jti": uuid4().hex,
            "iat": timestamp,
            "nbf": timestamp,
            "exp": timestamp + settings.session_ttl,
            "iss": settings.jwt_issuer,
            "aud": settings.jwt_audience,
        },
        settings.jwt_secret_key,
        algorithm="HS256",
    )


def decode_access_token(token: str, settings: Settings) -> dict:
    claims = jwt.decode(
        token,
        settings.jwt_secret_key,
        algorithms=["HS256"],
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        options={
            "require": ["sub", "jti", "iat", "nbf", "exp", "iss", "aud"],
            "strict_aud": True,
        },
    )
    subject = claims["sub"]
    if (
        not subject.isascii() or not subject.isdigit() or len(subject) > 20
        or not 1 <= int(subject) <= 18446744073709551615
    ):
        raise jwt.InvalidTokenError("Invalid user ID")
    if any(type(claims[field]) is not int for field in ("iat", "nbf", "exp")):
        raise jwt.InvalidTokenError("Invalid token timestamp")
    if claims["exp"] <= max(claims["iat"], claims["nbf"]) or not claims["jti"]:
        raise jwt.InvalidTokenError("Invalid token claims")
    return claims

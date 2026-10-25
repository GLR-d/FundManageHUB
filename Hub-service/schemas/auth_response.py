"""登录、注册与用户资料接口的响应数据模型。"""

from datetime import datetime, timezone

from pydantic import BaseModel, field_validator


class CaptchaData(BaseModel):
    uuid: str
    image: str


class PublicUser(BaseModel):
    id: int
    name: str
    avatar: str
    phone: str
    email: str
    email_verified: bool = False
    created_at: datetime
    updated_at: datetime
    last_login_at: datetime | None = None

    @field_validator("created_at", "updated_at", "last_login_at")
    @classmethod
    def as_utc(cls, value: datetime | None):
        return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


class LoginData(PublicUser):
    token: str


class EmailVerificationGrant(BaseModel):
    verificationToken: str
    expiresIn: int

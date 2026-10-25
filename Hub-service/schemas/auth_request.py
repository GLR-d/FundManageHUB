"""邮箱注册、密码登录和资料修改的请求模型。"""

import re
from email.errors import HeaderParseError
from email.headerregistry import Address
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from core.messages import Messages


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("name", "avatar", "phone", "email", mode="before", check_fields=False)
    @classmethod
    def trim_strings(cls, value: Any):
        return value.strip() if isinstance(value, str) else value


class EmailRequest(RequestModel):
    email: str = Field(min_length=1, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str):
        try:
            address = Address(addr_spec=value)
            if (
                not value.isascii() or not address.username or "." not in address.domain
                or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value)
            ):
                raise ValueError
        except (ValueError, IndexError, HeaderParseError):
            raise ValueError(Messages.INVALID_EMAIL) from None
        return value.lower()


class EmailCodeRequest(EmailRequest):
    code: SecretStr = Field(min_length=6, max_length=6)

    @field_validator("code")
    @classmethod
    def valid_code(cls, value: SecretStr):
        if not re.fullmatch(r"[0-9]{6}", value.get_secret_value()):
            raise ValueError(Messages.EMAIL_CODE_INVALID)
        return value


class PasswordResetRequest(EmailCodeRequest):
    password: SecretStr = Field(min_length=8, max_length=128)

    @field_validator("password")
    @classmethod
    def nonblank_password(cls, value: SecretStr):
        if not value.get_secret_value().strip():
            raise ValueError(Messages.PASSWORD_BLANK)
        return value


class BindingEmailRequest(EmailRequest):
    verificationToken: SecretStr | None = Field(default=None, min_length=32, max_length=128)


class BindingEmailCodeRequest(EmailCodeRequest):
    verificationToken: SecretStr | None = Field(default=None, min_length=32, max_length=128)


class VerifiedPasswordChangeRequest(RequestModel):
    verificationToken: SecretStr = Field(min_length=32, max_length=128)
    password: SecretStr = Field(min_length=8, max_length=128)

    @field_validator("password")
    @classmethod
    def nonblank_password(cls, value: SecretStr):
        if not value.get_secret_value().strip():
            raise ValueError(Messages.PASSWORD_BLANK)
        return value


class RegisterRequest(PasswordResetRequest):
    name: str = Field(default="用户", max_length=50)

    @field_validator("name")
    @classmethod
    def default_name(cls, value: str):
        return value or "用户"


class LoginRequest(EmailRequest):
    password: SecretStr = Field(min_length=1, max_length=128)
    captcha: str = Field(min_length=5, max_length=5)

    @field_validator("captcha", mode="before")
    @classmethod
    def normalize_captcha(cls, value: Any):
        return value.strip().upper() if isinstance(value, str) else value


class CaptchaVerifyRequest(RequestModel):
    uuid: UUID
    code: str = Field(min_length=5, max_length=5)

    @field_validator("code", mode="before")
    @classmethod
    def normalize_code(cls, value: Any):
        return value.strip().upper() if isinstance(value, str) else value


class UserUpdateRequest(RequestModel):
    name: str | None = Field(default=None, min_length=1, max_length=50)
    avatar: str | None = Field(default=None, max_length=1024)
    phone: str | None = Field(default=None, max_length=20)

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value: str | None):
        # 加号只允许位于开头；去掉展示分隔符后检查数字位数，返回时保留展示格式。
        phone_digits = value.removeprefix("+").replace(" ", "").replace("-", "") if value else ""
        if value and not re.fullmatch(r"[0-9]{7,20}", phone_digits):
            raise ValueError(Messages.INVALID_PHONE)
        return value

    @field_validator("avatar")
    @classmethod
    def valid_avatar(cls, value: str | None):
        if value:
            # OSS 暂缺配置时，资料响应仍保留永久标识，修改其他资料不应被它拦住。
            if re.fullmatch(r"oss://[a-z0-9][a-z0-9-]{1,61}[a-z0-9]/images/[1-9][0-9]*/[a-f0-9]{32}\.(?:jpg|png)", value):
                return value
            url = urlsplit(value)
            if value.startswith("/") and not value.startswith("//"):
                return value
            if url.scheme not in ("http", "https") or not url.hostname:
                raise ValueError(Messages.INVALID_AVATAR_URL)
        return value

    @model_validator(mode="after")
    def valid_update(self):
        if not self.model_fields_set:
            raise ValueError(Messages.USER_UPDATE_REQUIRED)
        if any(getattr(self, field) is None for field in self.model_fields_set):
            raise ValueError(Messages.UPDATE_FIELD_NULL)
        return self

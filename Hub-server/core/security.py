"""密码哈希、验证码图片、秘密值摘要及 UTC 时间。"""

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError

password_hasher = PasswordHash.recommended()
DUMMY_PASSWORD_HASH = password_hasher.hash(secrets.token_urlsafe(32))
CAPTCHA_COOKIE = "hub_captcha"
MAX_CAPTCHA_ATTEMPTS = 5
CAPTCHA_VERIFICATION_SECONDS = 120
MAX_LOGIN_FAILURES = 5
LOCK_SECONDS = 900


def utcnow() -> datetime:
    """返回不带时区标记的 UTC 时间，供会话和验证码计算有效期。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hash_secret(value: str) -> str:
    """生成 token 等随机秘密值的摘要，数据库无需保存其原文。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    """使用密码专用哈希算法生成可存入数据库的密码摘要。"""
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """校验明文密码与摘要是否匹配，无法识别的摘要视为不匹配。"""
    try:
        return password_hasher.verify(password, password_hash)
    except (UnknownHashError, ValueError):
        return False


def next_password_failure(
    failures: int, locked_until: datetime | None, now: datetime,
) -> tuple[int, datetime | None]:
    """计算本次失败后的次数与锁定时间；调用前需先排除仍在锁定中的账号。"""
    if locked_until is not None and locked_until <= now:
        # 锁定已过期，重新累计本轮失败次数。
        failures = 0
    failures += 1
    next_locked_until = None
    if failures >= MAX_LOGIN_FAILURES:
        next_locked_until = now + timedelta(seconds=LOCK_SECONDS)
    return failures, next_locked_until


def hash_captcha(uuid: str, code: str) -> str:
    """把验证码编号与统一大写的内容一起生成摘要。"""
    return hash_secret(f"{uuid}:{code.upper()}")


def generate_captcha_code() -> str:
    """生成五位验证码，排除容易混淆的字符。"""
    return "".join(secrets.choice("23456789ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(5))


def render_captcha(code: str) -> str:
    """绘制带干扰的验证码图片，返回前端可直接展示的 Base64 图片地址。"""
    image = Image.new("RGB", (160, 60), "#f3f6fb")
    draw = ImageDraw.Draw(image)
    font_path = Path("C:/Windows/Fonts/arialbd.ttf")
    try:
        font = ImageFont.truetype(str(font_path) if font_path.exists() else "DejaVuSans.ttf", 32)
    except OSError:
        font = ImageFont.load_default(size=32)
    for _ in range(5):
        draw.line(
            [(secrets.randbelow(160), secrets.randbelow(60)) for _ in range(2)],
            fill="#b7c4dc", width=1,
        )
    for index, character in enumerate(code):
        draw.text(
            (8 + index * 29, 9 + secrets.randbelow(7)), character,
            font=font, fill=(25 + secrets.randbelow(70), 35 + secrets.randbelow(70), 70 + secrets.randbelow(80)),
        )
    for _ in range(60):
        draw.point((secrets.randbelow(160), secrets.randbelow(60)), fill="#9caacc")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

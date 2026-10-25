"""用户资料和密码的数据访问。"""

from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from models.user import User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_id(self, user_id: int, *, for_update=False) -> dict[str, Any] | None:
        statement = select(*User.__table__.c, User.email_verified_at.is_not(None).label("email_verified")).where(User.id == user_id)
        if for_update:
            statement = statement.with_for_update()
        result = await self.session.execute(statement)
        row = result.mappings().first()
        return dict(row) if row is not None else None

    async def update_profile(self, user_id: int, values: dict) -> None:
        profile_values = {
            field: values[field]
            for field in ("name", "avatar", "phone", "email", "email_verified_at") if field in values
        }
        if profile_values:
            await self.session.execute(update(User).where(User.id == user_id).values(**profile_values))

    async def get_by_email(self, email: str, *, for_update=False) -> dict[str, Any] | None:
        statement = select(*User.__table__.c).where(User.email == email)
        if for_update:
            statement = statement.with_for_update()
        row = (await self.session.execute(statement)).mappings().first()
        return dict(row) if row is not None else None

    async def update_password(self, user_id: int, password_hash: str) -> None:
        statement = (
            update(User).where(User.id == user_id)
            .values(password_hash=password_hash, login_failures=0, locked_until=None)
        )
        await self.session.execute(statement)

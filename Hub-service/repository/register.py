"""注册数据访问。"""

from sqlalchemy.ext.asyncio import AsyncSession

from core.security import utcnow
from models.user import User


class RegisterRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(self, email: str, name: str, password_hash: str) -> int:
        user = User(email=email, email_verified_at=utcnow(), name=name, password_hash=password_hash)
        self.session.add(user)
        # 立即执行 INSERT，取得自增编号；是否提交仍由 service 决定。
        await self.session.flush()
        return user.id

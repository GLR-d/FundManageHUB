"""注册数据访问。"""

from sqlalchemy.ext.asyncio import AsyncSession

from utils.security import utcnow
from models.user import User


class RegisterRepository:
    # 保存注册写入使用的数据库会话
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # 创建已验证邮箱的用户并返回自增编号
    async def create(self, email: str, name: str, password_hash: str) -> int:
        user = User(email=email, email_verified_at=utcnow(), name=name, password_hash=password_hash)
        self.session.add(user)
        # 立即执行 INSERT，取得自增编号；是否提交仍由 service 决定。
        await self.session.flush()
        return user.id

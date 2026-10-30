"""账号写入共用的用户与登录会话锁校验。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.errors import BusinessError
from core.jwt_tokens import SessionIdentity
from core.messages import Messages
from core.security import utcnow
from repository.login import LoginRepository
from repository.user import UserRepository


# 锁定用户和登录会话并复核身份
async def lock_user_and_session(session: AsyncSession, identity: SessionIdentity) -> dict[str, Any]:
    """先锁用户再锁会话；写入前确认身份仍有效，事务由调用方提交。"""
    user = await UserRepository(session).get_by_id(identity.user_id, for_update=True)
    current_session = await LoginRepository(session).get_session(identity.token_hash, for_update=True)
    if (
        not user or not user["is_active"] or not current_session
        or current_session["user_id"] != identity.user_id
        or current_session["expires_at"] <= utcnow()
    ):
        raise BusinessError(Messages.SESSION_EXPIRED, 401)
    return user

"""当前用户的资料查询与修改；邮箱和密码通过独立验证码接口修改。"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from core.config import Settings
from core.errors import BusinessError
from core.jwt_tokens import SessionIdentity
from core.messages import Messages
from core.security import utcnow
from repository.login import LoginRepository
from repository.user import UserRepository
from schemas.auth_request import UserUpdateRequest
from schemas.auth_response import PublicUser
from service.image_asset import ImageAssetService
from service.image_urls import ImageUrls


class UserService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.settings = settings
        self.repository = UserRepository(session)
        self.login_repository = LoginRepository(session)

    async def get_user(self, identity: SessionIdentity) -> PublicUser:
        user = await self.repository.get_by_id(identity.user_id)
        if not user or not user["is_active"]:
            raise BusinessError(Messages.SESSION_EXPIRED, 401)
        user["avatar"] = await ImageUrls(self.settings, identity.user_id).display(user["avatar"])
        return PublicUser.model_validate(user)

    async def _lock_user_and_session(
        self, identity: SessionIdentity,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        # 所有账号修改先锁用户再锁会话，保持一致的加锁顺序。
        user = await self.repository.get_by_id(identity.user_id, for_update=True)
        session = await self.login_repository.get_session(identity.token_hash, for_update=True)
        if not user or not user["is_active"] or not session:
            raise BusinessError(Messages.SESSION_EXPIRED, 401)
        if session["user_id"] != identity.user_id or session["expires_at"] <= utcnow():
            raise BusinessError(Messages.SESSION_EXPIRED, 401)
        return user, session

    async def update_user(self, identity: SessionIdentity, data: UserUpdateRequest) -> PublicUser:
        user, _ = await self._lock_user_and_session(identity)
        values = data.model_dump(exclude_unset=True)
        if "avatar" in values:
            values["avatar"] = ImageUrls(self.settings, identity.user_id).stored(values["avatar"])
            await ImageAssetService(self.session, self.settings, identity.user_id).change_references(
                [user["avatar"]], [values["avatar"]],
            )
        await self.repository.update_profile(user["id"], values)
        updated_user = await self.repository.get_by_id(user["id"])
        await self.session.commit()
        updated_user["avatar"] = await ImageUrls(self.settings, identity.user_id).display(updated_user["avatar"])
        return PublicUser.model_validate(updated_user)

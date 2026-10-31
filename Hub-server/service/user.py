"""当前用户的资料查询与修改；邮箱和密码通过独立验证码接口修改。"""

from sqlalchemy.ext.asyncio import AsyncSession

from config.settings import Settings
from core.exception_handlers import BusinessError
from utils.jwt_tokens import SessionIdentity
from core.messages import Messages
from repository.user import UserRepository
from schemas.request.auth_request import UserUpdateRequest
from schemas.response.auth_response import PublicUser
from service.account import lock_user_and_session
from service.image_asset import ImageAssetService
from service.image_urls import ImageUrls


class UserService:
    # 保存用户业务配置并初始化用户仓储
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.settings = settings
        self.repository = UserRepository(session)

    # 读取有效用户资料并生成头像访问链接
    async def get_user(self, identity: SessionIdentity) -> PublicUser:
        user = await self.repository.get_by_id(identity.user_id)
        if not user or not user["is_active"]:
            raise BusinessError(Messages.SESSION_EXPIRED, 401)
        user["avatar"] = await ImageUrls(self.settings, identity.user_id).display(user["avatar"])
        return PublicUser.model_validate(user)

    # 复核登录身份后更新资料并同步头像引用
    async def update_user(self, identity: SessionIdentity, data: UserUpdateRequest) -> PublicUser:
        user = await lock_user_and_session(self.session, identity)
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

"""聊天请求；用户身份仅从后端认证信息获取。"""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from core.messages import Messages

ConversationId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
ConversationTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
Timestamp = Annotated[int, Field(ge=0, le=9_007_199_254_740_991)]


class ChatRequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ChatRequest(ChatRequestModel):
    conversation_id: ConversationId = Field(alias="conversationId")
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)]
    message_id: ConversationId | None = Field(None, alias="messageId")
    reply_id: ConversationId | None = Field(None, alias="replyId")

    @model_validator(mode="after")
    def distinct_ids(self) -> Self:
        if self.message_id is not None and self.message_id == self.reply_id:
            raise ValueError("messageId 和 replyId 不能相同")
        return self


class ConversationCreateRequest(ChatRequestModel):
    id: ConversationId
    title: ConversationTitle
    created_at: Timestamp | None = Field(None, alias="createdAt")


class ConversationUpdateRequest(ChatRequestModel):
    title: ConversationTitle | None = None
    pinned: bool | None = None

    @model_validator(mode="after")
    def require_update(self) -> Self:
        if not self.model_fields_set or any(getattr(self, name) is None for name in self.model_fields_set):
            raise ValueError(Messages.CHAT_UPDATE_REQUIRED)
        return self


class ChatMessageImport(ChatRequestModel):
    id: ConversationId
    role: Literal["user", "ai"]
    content: str = Field(max_length=100_000)
    created_at: Timestamp = Field(alias="createdAt")
    updated_at: Timestamp = Field(alias="updatedAt")
    expires_at: Timestamp | None = Field(None, alias="expiresAt")
    pending: bool = False
    failed: bool = False
    interrupted: bool = False
    conversation_id: ConversationId | None = Field(None, alias="conversationId")


class ConversationImportRequest(ChatRequestModel):
    id: ConversationId
    title: ConversationTitle
    created_at: Timestamp = Field(alias="createdAt")
    pinned: bool = False
    metadata_updated_at: Timestamp | None = Field(None, alias="metadataUpdatedAt")
    messages: list[ChatMessageImport] = Field(max_length=100)

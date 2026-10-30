"""页面展示的会话与消息；不包含模型工具调用和内部检查点。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ChatQuestion(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    interrupt_id: str = Field(alias="interruptId")
    question: str
    options: list[str] = Field(default_factory=list)
    allow_custom_answer: bool = Field(True, alias="allowCustomAnswer")


class ChatMessage(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    role: Literal["user", "ai"]
    content: str
    created_at: int = Field(alias="createdAt")
    updated_at: int = Field(alias="updatedAt")
    expires_at: int | None = Field(None, alias="expiresAt")
    pending: bool = False
    failed: bool = False
    interrupted: bool = False
    conversation_id: str | None = Field(None, alias="conversationId")
    questions: list[ChatQuestion] = Field(default_factory=list)


class ChatConversation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    title: str
    created_at: int = Field(alias="createdAt")
    pinned: bool = False
    metadata_updated_at: int = Field(alias="metadataUpdatedAt")
    messages: list[ChatMessage] = Field(default_factory=list)
    pending_questions: list[ChatQuestion] = Field(default_factory=list, alias="pendingQuestions")

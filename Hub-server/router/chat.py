"""SSE 流式聊天接口，复用应用启动时创建的聊天图。"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, Path, Request
from fastapi.sse import EventSourceResponse, ServerSentEvent

from core.messages import Messages
from core.errors import BusinessError
from schemas.request.chat_request import (
    ChatResumeRequest, ChatStreamRequest, ConversationCreateRequest, ConversationId, ConversationImportRequest, ConversationUpdateRequest,
)
from schemas.response.chat_response import ChatConversation
from schemas.response.result import Result
from service.chat import ChatService
from service.chat_conversation import ChatConversationService, ChatReply

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/chat", tags=["聊天"])


# 创建复用 Redis 资源的会话服务
def _conversation_service(request: Request) -> ChatConversationService:
    return ChatConversationService(request.app.state.redis_client, request.app.state.chat_checkpointer)


# 保存已有回复并释放会话锁
async def _close_reply(
    service: ChatConversationService, reply: ChatReply, content: str, *, failed: bool = False, interrupted: bool = False,
    chat: ChatService | None = None,
) -> None:
    # 断开连接时仍尝试保存部分回复；存储故障不能遮住原来的 SSE 错误。
    with anyio.CancelScope(shield=True):
        with anyio.move_on_after(35):
            try:
                questions = None
                if chat is not None:
                    try:
                        questions = await chat.pending_questions(reply.user_id, reply.conversation_id)
                    except Exception as error:
                        # 检查点暂时不可用时，仍保存部分正文并保留上次待回答记录。
                        logger.warning("聊天等待状态读取失败：%s", type(error).__name__)
                await service.finish_reply(reply, content, failed=failed, interrupted=interrupted, pending_questions=questions)
            except Exception as error:
                logger.error("聊天回复收尾失败：%s", type(error).__name__)


# 返回当前用户的会话列表
@router.get("/conversations", response_model=Result[list[ChatConversation]], summary="获取当前用户会话列表")
async def list_conversations(request: Request) -> Result[list[ChatConversation]]:
    return Result.success(await _conversation_service(request).list(request.state.identity.user_id))


# 创建当前用户的聊天会话
@router.post("/conversations", response_model=Result[ChatConversation], summary="创建会话")
async def create_conversation(data: ConversationCreateRequest, request: Request) -> Result[ChatConversation]:
    return Result.success(await _conversation_service(request).create(request.state.identity.user_id, data))


# 迁移浏览器中的旧会话记录
@router.post("/conversations/import", response_model=Result[None], summary="分批迁移当前账号的浏览器聊天记录")
async def import_conversation(data: ConversationImportRequest, request: Request) -> Result[None]:
    await _conversation_service(request).import_conversation(request.state.identity.user_id, data)
    return Result.success()


# 返回指定会话及消息记录
@router.get("/conversations/{conversation_id:path}", response_model=Result[ChatConversation], summary="获取会话消息")
async def get_conversation(request: Request, conversation_id: ConversationId = Path()) -> Result[ChatConversation]:
    return Result.success(await _conversation_service(request).get(request.state.identity.user_id, conversation_id))


# 修改会话标题或置顶状态
@router.patch("/conversations/{conversation_id:path}", response_model=Result[ChatConversation], summary="重命名或置顶会话")
async def update_conversation(
    data: ConversationUpdateRequest, request: Request, conversation_id: ConversationId = Path(),
) -> Result[ChatConversation]:
    return Result.success(await _conversation_service(request).update(request.state.identity.user_id, conversation_id, data))


# 删除会话、消息及模型记忆
@router.delete("/conversations/{conversation_id:path}", response_model=Result[None], summary="删除会话及对应模型记忆")
async def delete_conversation(request: Request, conversation_id: ConversationId = Path()) -> Result[None]:
    await _conversation_service(request).delete(request.state.identity.user_id, conversation_id)
    return Result.success()


# 锁定会话并预写入本轮消息
async def prepare_reply(data: ChatStreamRequest, request: Request) -> AsyncIterator[ChatReply]:
    service = _conversation_service(request)
    chat = ChatService(request.app.state.chat_graph)
    if isinstance(data, ChatResumeRequest):
        questions = await chat.pending_questions(request.state.identity.user_id, data.conversation_id)
        if not any(item["interruptId"] == data.interrupt_id for item in questions):
            raise BusinessError(Messages.CHAT_QUESTION_EXPIRED, 409)
    # 依赖在发送 SSE 响应头之前执行，404/409/503 仍使用统一 Result 返回。
    reply = await service.begin_reply(request.state.identity.user_id, data)
    try:
        yield reply
    finally:
        if not reply.finished:
            # 响应尚未开始便断开时也释放锁；取消域不能打断最后的记录清理。
            await _close_reply(service, reply, "", interrupted=True, chat=chat)


# 流式返回回复并处理生成中断
@router.post("/stream", response_class=EventSourceResponse, summary="流式聊天或提交答案继续回复")
async def stream_chat(
    data: ChatStreamRequest, request: Request,
    reply: Annotated[ChatReply, Depends(prepare_reply, scope="request")],
) -> AsyncIterator[ServerSentEvent]:
    service = ChatService(request.app.state.chat_graph)
    conversations = _conversation_service(request)
    user_id = request.state.identity.user_id
    parts: list[str] = []
    try:
        # 有界生成时间短于 Redis 锁期限，避免过期锁下的迟到写入。
        async with asyncio.timeout_at(reply.deadline):
            async with aclosing(service.stream_reply(user_id, data)) as stream:
                async for event, value in stream:
                    if event == "token":
                        parts.append(value)
                        yield ServerSentEvent(event="token", data={"content": value})
                    else:
                        # 等待用户不占用连接或会话锁，也不标记为生成失败。
                        await conversations.pause_reply(reply, "".join(parts), value)
                        yield ServerSentEvent(event="question", data={
                            "conversationId": data.conversation_id,
                            "messageId": reply.message["id"],
                            "questions": value,
                        })
                        return
        await conversations.finish_reply(reply, "".join(parts))
    except Exception as error:
        # 响应已开始，只发送公开错误；取消异常不在 Exception 中，仍会向上传播。
        logger.error("聊天流生成失败：%s", type(error).__name__)
        await _close_reply(conversations, reply, "".join(parts), failed=True, chat=service)
        yield ServerSentEvent(event="error", data={"message": Messages.CHAT_REPLY_FAILED})
    else:
        # 完整迭代结束后，图的本次运行及检查点保存才已完成。
        yield ServerSentEvent(event="done", data={"conversationId": data.conversation_id})
    finally:
        if not reply.finished:
            await _close_reply(conversations, reply, "".join(parts), interrupted=True, chat=service)



"""运行共享聊天图；Redis 连接由应用生命周期管理。"""

from collections.abc import AsyncIterator
from contextlib import aclosing
from hashlib import sha256
import json

from langchain.messages import AIMessage
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command, Interrupt

from agents.tools.common import AgentContext
from schemas.request.chat_request import ChatResumeRequest, ChatStreamRequest
from schemas.response.chat_response import ChatQuestion


class ChatService:
    # 保存应用共享的聊天流程图
    def __init__(self, graph: CompiledStateGraph):
        self.graph = graph

    # 生成按用户和会话隔离的运行配置
    @staticmethod
    def _config(user_id: int, conversation_id: str) -> dict:
        # 同一用户、同一会话恢复历史；不同用户使用独立的检查点。
        return {
            "configurable": {"thread_id": f"{user_id}:{conversation_id}"},
            "recursion_limit": 20,
        }

    # 转换检查点中的提问内容
    @staticmethod
    def _questions(interrupts: tuple[Interrupt, ...]) -> list[dict]:
        questions = []
        for item in interrupts:
            # 同一工具节点可能复用原生中断编号，再按工具调用区分问题阶段。
            stage = item.value.get("toolCallId") or json.dumps(item.value, ensure_ascii=False, sort_keys=True)
            suffix = sha256(stage.encode()).hexdigest()[:16]
            questions.append(ChatQuestion.model_validate({
                **item.value, "interruptId": f"{item.id}:{suffix}",
            }).model_dump(by_alias=True))
        return questions

    # 读取当前会话仍在等待的提问
    async def pending_questions(self, user_id: int, conversation_id: str) -> list[dict]:
        state = await self.graph.aget_state(self._config(user_id, conversation_id))
        return self._questions(tuple(item for task in state.tasks for item in task.interrupts))

    # 流式返回正文或需要用户回答的问题
    async def stream_reply(self, user_id: int, data: ChatStreamRequest) -> AsyncIterator[tuple[str, str | list[dict]]]:
        # 恢复时只提交工具答案，不将它重复追加为模型的用户消息。
        graph_input = Command(resume={data.interrupt_id.rsplit(":", 1)[0]: data.answer}) if isinstance(data, ChatResumeRequest) else {
            "messages": [("user", data.message)],
        }
        questions: dict[str, dict] = {}
        async with aclosing(self.graph.astream(
            graph_input,
            config=self._config(user_id, data.conversation_id),
            context=AgentContext(user_id=user_id),
            stream_mode=["messages", "updates"],
        )) as stream:
            async for mode, value in stream:
                if mode == "messages":
                    chunk, metadata = value
                    # 只发送聊天节点正文，不发送工具参数、工具结果或推理内容。
                    if metadata.get("langgraph_node") == "chat" and isinstance(chunk, AIMessage):
                        if text := chunk.text:
                            yield "token", text
                elif mode == "updates" and "__interrupt__" in value:
                    for question in self._questions(value["__interrupt__"]):
                        questions[question["interruptId"]] = question
        # 排空执行流后检查点才已保存，前端此时才能安全提交答案。
        if questions:
            yield "question", list(questions.values())

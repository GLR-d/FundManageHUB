"""运行共享聊天图；Redis 连接由应用生命周期管理。"""

from collections.abc import AsyncIterator
from contextlib import aclosing

from langchain.messages import AIMessage
from langgraph.graph.state import CompiledStateGraph

from agents.tools.common import AgentContext
from schemas.chat_request import ChatRequest


class ChatService:
    def __init__(self, graph: CompiledStateGraph):
        self.graph = graph

    @staticmethod
    def _config(user_id: int, conversation_id: str) -> dict:
        # 同一用户、同一会话恢复历史；不同用户使用独立的检查点。
        return {
            "configurable": {"thread_id": f"{user_id}:{conversation_id}"},
            "recursion_limit": 20,
        }

    async def stream_reply(self, user_id: int, data: ChatRequest) -> AsyncIterator[str]:
        # 每次只追加新消息，历史消息由 checkpointer 自动恢复。
        async with aclosing(self.graph.astream(
            {"messages": [("user", data.message)]},
            config=self._config(user_id, data.conversation_id),
            context=AgentContext(user_id=user_id),
            stream_mode="messages",
        )) as stream:
            async for chunk, metadata in stream:
                # 只发送聊天节点的正文，不发送工具结果、参数或推理内容块。
                if metadata.get("langgraph_node") == "chat" and isinstance(chunk, AIMessage):
                    if text := chunk.text:
                        yield text

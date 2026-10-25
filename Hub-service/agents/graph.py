from langchain.messages import SystemMessage
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from agents.llm import model
from agents.prompts import SYSTEM_PROMPT
from agents.tools import tools
from agents.tools.common import AgentContext


# 告诉模型有哪些工具可以请求调用
model_with_tools = model.bind_tools(tools)


async def chat_node(state: MessagesState) -> dict:
    """调用模型，得到直接回复或工具调用请求。"""
    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        *state["messages"],
    ]

    response = await model_with_tools.ainvoke(messages)

    # MessagesState 会把新消息合并到已有消息中
    return {"messages": [response]}


builder = StateGraph(MessagesState, context_schema=AgentContext)

builder.add_node("chat", chat_node)
builder.add_node("tools", ToolNode(tools))

builder.add_edge(START, "chat")

# 自动判断：有工具调用就进入 tools，否则结束
builder.add_conditional_edges("chat", tools_condition)

builder.add_edge("tools", "chat")


def build_graph(checkpointer):
    """使用应用启动时创建的 checkpointer 编译图。"""
    return builder.compile(checkpointer=checkpointer)

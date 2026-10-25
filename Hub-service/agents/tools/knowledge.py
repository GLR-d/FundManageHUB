from langchain_core.tools import create_retriever_tool
from agents.rag import retriever

search_knowledge = create_retriever_tool(
    retriever=retriever,
    name="search_knowledge",
    description="查询 ManageHub 使用说明、账单操作、图片上传限制和密码修改规则。",
)
from langchain.chat_models import init_chat_model
import os
from dotenv import load_dotenv

load_dotenv()

model = init_chat_model(
    model=os.getenv("LLM_MODEL"),
    # 使用配置的 OpenAI 兼容接口，避免根据模型名选择其他适配器。
    model_provider="openai",
    base_url=os.getenv("LLM_BASE_URL"),
    api_key=os.getenv("LLM_API_KEY")
)


import os
from pathlib import Path

from dotenv import load_dotenv
from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma

BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv()

embeddings=OpenAIEmbeddings(
    model=os.getenv("EMBEDDING_MODEL"),
    base_url=os.getenv("EMBEDDING_BASE_URL"),
    api_key=os.getenv("EMBEDDING_API_KEY"),
    check_embedding_ctx_length=False,
)

vectorstore=Chroma(
    collection_name="managehub_knowledge_api",
    embedding_function=embeddings,
    persist_directory=str(BASE_DIR / "chroma_data"),
)

retriever = vectorstore.as_retriever(search_kwargs={"k": 2})
"""手动导入本地文档：读取、切块、查重，再写入向量库。"""

from hashlib import sha256
from pathlib import Path

from langchain_community.document_loaders import (
    Docx2txtLoader,
    PyPDFLoader,
    TextLoader,
)
from langchain_text_splitters import RecursiveCharacterTextSplitter


# 读取本地文档并将新增文本片段写入向量库
def import_document(file_path: str | Path) -> dict[str, int]:
    """导入单个文件，跳过已有片段；修改文件后不会删除旧片段。"""
    path = Path(file_path).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError("请输入文件路径，不能是文件夹")

    # 根据文件类型选择读取方式；TXT、MD 需要使用 UTF-8 编码。
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md"}:
        loader = TextLoader(str(path), encoding="utf-8-sig")
    elif suffix == ".pdf":
        loader = PyPDFLoader(str(path))
    elif suffix == ".docx":
        loader = Docx2txtLoader(str(path))
    else:
        raise ValueError("目前只支持 TXT、MD、PDF、DOCX 文件")

    documents = loader.load()
    chunks = RecursiveCharacterTextSplitter(
        chunk_size=500,
        chunk_overlap=80,
    ).split_documents(documents)
    if not chunks:
        raise ValueError("未读取到文字；扫描版 PDF 需要先识别文字")

    # 同一文件中的相同内容得到相同 ID，也去掉本次导入中的重复片段。
    candidates = {}
    for chunk in chunks:
        content = f"{path}\0{chunk.page_content}"
        chunk_id = sha256(content.encode("utf-8")).hexdigest()
        candidates.setdefault(chunk_id, chunk)

    # 文件读取成功后，再初始化现有 RAG 配置中的向量库。
    from agents.rag import vectorstore

    ids = list(candidates)
    added = 0
    for start in range(0, len(ids), 100):
        batch = ids[start:start + 100]
        # 只查询 ID，不生成向量；仅对缺失的片段调用 Embedding API。
        existing = set(vectorstore.get(ids=batch, include=[])["ids"])
        missing = [chunk_id for chunk_id in batch if chunk_id not in existing]
        if missing:
            vectorstore.add_documents(
                documents=[candidates[chunk_id] for chunk_id in missing],
                ids=missing,
            )
            added += len(missing)

    return {"total": len(chunks), "added": added, "skipped": len(chunks) - added}


if __name__ == "__main__":
    file_path = input("请输入文档完整路径：").strip().strip('"')
    result = import_document(file_path)
    print(f"共 {result['total']} 个片段，新增 {result['added']} 个，跳过 {result['skipped']} 个")

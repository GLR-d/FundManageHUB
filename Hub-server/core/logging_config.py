"""统一业务与 Uvicorn 日志，控制台和文件共用格式。"""

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from core.config import PROJECT_ROOT

_OWNED = "_managehub_logging_handler"


class _AccessLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        # Uvicorn 的路径参数包含查询串；日志只保留路径，避免记录查询参数。
        if isinstance(record.args, tuple) and len(record.args) == 5:
            client, method, path, version, status = record.args
            if isinstance(path, str):
                record.args = (client, method, path.split("?", 1)[0], version, status)
        return True


def configure_logging(log_dir: Path | None = None) -> None:
    """启动时调用；重复调用复用处理器，保留测试或宿主已添加的 root 处理器。"""
    directory = (log_dir if log_dir is not None else PROJECT_ROOT / "logs").resolve()
    directory.mkdir(parents=True, exist_ok=True)
    log_file = directory / "app.log"
    root = logging.getLogger()
    owned = [handler for handler in root.handlers if getattr(handler, _OWNED, False)]
    # 使用原始控制台流，避免保存 pytest 等临时捕获流导致后续写入已关闭对象。
    console_stream = sys.__stderr__ or sys.stderr
    console = next((handler for handler in owned if not isinstance(handler, logging.FileHandler)
                    and getattr(handler, "stream", None) is console_stream), None)
    file_handler = next((handler for handler in owned if isinstance(handler, RotatingFileHandler)
                         and Path(handler.baseFilename) == log_file and handler.stream is not None
                         and not handler.stream.closed), None)
    if file_handler is None:
        file_handler = RotatingFileHandler(
            log_file, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8",
        )
    if console is None:
        console = logging.StreamHandler(console_stream)

    handlers = (console, file_handler)
    for handler in owned:
        if handler not in handlers:
            root.removeHandler(handler)
            handler.close()
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S",
    )
    for handler in handlers:
        setattr(handler, _OWNED, True)
        handler.setLevel(logging.INFO)
        handler.setFormatter(formatter)
        if handler not in root.handlers:
            root.addHandler(handler)
    root.setLevel(logging.INFO)

    # Uvicorn 自带处理器不再重复输出，由 root 统一写控制台和文件。
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        for handler in logger.handlers[:]:
            logger.removeHandler(handler)
            if handler not in root.handlers:
                handler.close()
        logger.setLevel(logging.INFO)
        logger.propagate = True
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(item, _AccessLogFilter) for item in access.filters):
        access.addFilter(_AccessLogFilter())

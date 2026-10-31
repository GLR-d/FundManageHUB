"""在子进程验证日志输出，避免改变 pytest 的捕获处理器或真实服务。"""

import subprocess
import sys
import textwrap
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def run_logging_script(tmp_path: Path, source: str) -> subprocess.CompletedProcess[str]:
    bootstrap = """
import io
import logging
import re
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from config.logging_config import configure_logging

log_dir = Path(sys.argv[2])

def flush_handlers():
    for handler in logging.getLogger().handlers:
        handler.flush()
"""
    script = textwrap.dedent(bootstrap) + "\ntry:\n" + textwrap.indent(textwrap.dedent(source), "    ")
    script += "\nfinally:\n    logging.shutdown()\n"
    result = subprocess.run(
        [sys.executable, "-I", "-B", "-X", "utf8", "-c", script, str(PROJECT_ROOT), str(tmp_path)],
        capture_output=True, text=True, encoding="utf-8", timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result


def test_business_levels_unicode_and_exception_trace_reach_console_and_file(tmp_path):
    result = run_logging_script(tmp_path, r"""
configure_logging(log_dir)
logger = logging.getLogger("service.logging_demo")
logger.debug("hidden-debug-marker")
logger.info("中文业务信息")
logger.warning("中文警告信息")
try:
    raise ValueError("synthetic failure detail")
except ValueError:
    logger.exception("处理请求失败")
flush_handlers()
content = (log_dir / "app.log").read_text(encoding="utf-8")
assert re.search(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}", content)
assert "service.logging_demo" in content
assert "INFO" in content and "WARNING" in content and "ERROR" in content
assert "Traceback (most recent call last)" in content
assert "ValueError: synthetic failure detail" in content
assert "hidden-debug-marker" not in content
""")
    console = result.stdout + result.stderr
    for text in ("中文业务信息", "中文警告信息", "处理请求失败", "ValueError: synthetic failure detail"):
        assert text in console
        assert text in (tmp_path / "app.log").read_text(encoding="utf-8")
    assert "hidden-debug-marker" not in console


def test_repeated_setup_preserves_external_handlers_and_unifies_uvicorn_once(tmp_path):
    result = run_logging_script(tmp_path, """
root = logging.getLogger()
external_stream = io.StringIO()
external_handler = logging.StreamHandler(external_stream)
root.addHandler(external_handler)
# 模拟 Uvicorn 已经装好的独立输出，统一配置应替换它们而不是重复输出。
for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
    logger = logging.getLogger(name)
    logger.addHandler(logging.StreamHandler(sys.stderr))
    logger.propagate = False
configure_logging(log_dir)
configure_logging(log_dir)
assert external_handler in root.handlers
logging.getLogger("service.logging_demo").info("business-once-marker")
logging.getLogger("uvicorn.error").info("server-once-marker")
logging.getLogger("uvicorn.access").info(
    '%s - "%s %s HTTP/%s" %d', "127.0.0.1:1234", "GET",
    "/fund/search?token=private-token&email=private-email", "1.1", 200,
)
flush_handlers()
content = (log_dir / "app.log").read_text(encoding="utf-8")
for marker in ("business-once-marker", "server-once-marker", "/fund/search"):
    assert content.count(marker) == 1, content
    assert external_stream.getvalue().count(marker) == 1
assert "GET" in content and "200" in content
for private in ("private-token", "private-email", "?token="):
    assert private not in content
    assert private not in external_stream.getvalue()
""")
    console = result.stdout + result.stderr
    for marker in ("business-once-marker", "server-once-marker", "/fund/search"):
        assert console.count(marker) == 1
    assert "private-token" not in console and "private-email" not in console


def test_log_rotation_really_keeps_five_backups_and_discards_old_records(tmp_path):
    run_logging_script(tmp_path, """
configure_logging(log_dir)
handlers = [handler for handler in logging.getLogger().handlers if isinstance(handler, RotatingFileHandler)]
assert len(handlers) == 1
# 缩小阈值，实际触发滚动；不需要为测试写入数十 MB。
handlers[0].maxBytes = 256
logger = logging.getLogger("service.rotation_demo")
for number in range(12):
    logger.info("rotation-mark-%02d-%s", number, "x" * 110)
flush_handlers()
files = list(log_dir.glob("app.log*"))
assert {path.name for path in files} == {"app.log", *[f"app.log.{number}" for number in range(1, 6)]}
assert "rotation-mark-11" in (log_dir / "app.log").read_text(encoding="utf-8")
combined = "".join(path.read_text(encoding="utf-8") for path in files)
assert "rotation-mark-00" not in combined
assert all(path.stat().st_size > 0 for path in files)
""")


def test_changing_log_directory_closes_old_file_and_does_not_duplicate_records(tmp_path):
    run_logging_script(tmp_path, """
first = log_dir / "first"
second = log_dir / "second"
configure_logging(first)
logger = logging.getLogger("service.directory_demo")
logger.info("old-directory-marker")
flush_handlers()
old_handler = next(handler for handler in logging.getLogger().handlers if isinstance(handler, RotatingFileHandler))
old_stream = old_handler.stream
configure_logging(second)
assert old_stream is None or old_stream.closed
old_path = first / "app.log"
renamed = first / "archived.log"
# Windows 中仍打开的文件无法正常改名，验证切换时已释放句柄。
old_path.rename(renamed)
logger.info("new-directory-marker")
flush_handlers()
assert "new-directory-marker" not in renamed.read_text(encoding="utf-8")
new_content = (second / "app.log").read_text(encoding="utf-8")
assert new_content.count("new-directory-marker") == 1
assert "old-directory-marker" not in new_content
""")

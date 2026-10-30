"""幂等扩展账单类型至 10（收红包），只调整类型约束，不修改任何账单。"""

import asyncio
import json
import re
import sys
from pathlib import Path

from sqlalchemy import inspect, text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import Settings, get_settings
from core.database import create_database_engine
from core.fund_types import FUND_TYPE_CHECK, FUND_TYPE_MAX, fund_type_check_upper_bound


async def migrate_fund_types(settings: Settings | None = None) -> dict[str, bool]:
    engine = create_database_engine(settings or get_settings())
    try:
        async with engine.begin() as connection:
            version = await connection.scalar(text("SELECT VERSION()"))
            parsed = re.match(r"([0-9]+)\.([0-9]+)\.([0-9]+)", version or "")
            if not parsed or "mariadb" in version.lower() or tuple(map(int, parsed.groups())) < (8, 0, 16):
                raise RuntimeError("类型约束升级需要 MySQL 8.0.16 或更新版本")
            if not await connection.run_sync(lambda sync: inspect(sync).has_table("funds")):
                raise RuntimeError("账单表尚未初始化，请先运行 scripts/init_database.py")
            checks = await connection.run_sync(lambda sync: inspect(sync).get_check_constraints("funds"))
            current = next((item for item in checks if item["name"] == "chk_funds_type"), None)
            bound = fund_type_check_upper_bound(current["sqltext"]) if current else None
            if current and bound not in {7, 8, FUND_TYPE_MAX}:
                raise RuntimeError("检测到自定义账单类型约束，已停止迁移且未修改数据库")
            enforced = await connection.scalar(text(
                "SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS "
                "WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'funds' "
                "AND CONSTRAINT_NAME = 'chk_funds_type' AND CONSTRAINT_TYPE = 'CHECK'"
            ))
            if bound == FUND_TYPE_MAX and enforced == "YES":
                return {"changed": False}
            # 单条 MySQL 原子 DDL 替换约束，不先单独移除约束；不执行任何数据写入。
            # 限制锁等待，避免正在记账的请求让迁移长期阻塞。
            await connection.execute(text("SET SESSION lock_wait_timeout = 10"))
            drop = "DROP CHECK chk_funds_type, " if current else ""
            await connection.execute(text(
                f"ALTER TABLE funds {drop}ADD CONSTRAINT chk_funds_type CHECK ({FUND_TYPE_CHECK})"
            ))
        return {"changed": True}
    finally:
        await engine.dispose()


async def main() -> None:
    try:
        result = await migrate_fund_types()
    except Exception as error:
        # 不向控制台输出可能携带连接信息的原始数据库异常。
        raise SystemExit(f"账单类型约束升级失败 ({type(error).__name__})") from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())

"""幂等创建月支出限额表，不修改已有表结构或业务数据。"""

import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import inspect

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import Settings, get_settings
from core.database import create_database_engine
from models.monthly_expense_limit import MonthlyExpenseLimit


async def migrate_monthly_expense_limits(settings: Settings | None = None) -> dict[str, bool]:
    engine = create_database_engine(settings or get_settings())
    try:
        async with engine.begin() as connection:
            existed = await connection.run_sync(lambda sync: inspect(sync).has_table(MonthlyExpenseLimit.__tablename__))
            # 只建立这一张新表；严禁对其他业务表执行 create_all、ALTER 或数据迁移。
            await connection.run_sync(lambda sync: MonthlyExpenseLimit.__table__.create(sync, checkfirst=True))
        return {"created": not existed}
    finally:
        await engine.dispose()


async def main() -> None:
    try:
        result = await migrate_monthly_expense_limits()
    except Exception as error:
        raise SystemExit(f"月支出限额建表失败 ({type(error).__name__})") from None
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())

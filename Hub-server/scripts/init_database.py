"""显式初始化数据库、登录表与账单表。"""

import asyncio
import sys
from pathlib import Path

from sqlalchemy import DDL

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from config.settings import Settings, get_settings
from config.database import create_database_engine
from models import Base


async def initialize_database(settings: Settings | None = None) -> None:
    """只创建不存在的数据库和表，不修改已有表或数据。"""
    settings = settings or get_settings()
    server_engine = create_database_engine(settings, select_database=False)
    database_engine = create_database_engine(settings)
    try:
        # 数据库名已由 Settings 校验；这里执行建库 DDL。
        statement = DDL(
            f"CREATE DATABASE IF NOT EXISTS `{settings.mysql_database}` "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )
        async with server_engine.begin() as connection:
            await connection.execute(statement)
        async with database_engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    finally:
        await server_engine.dispose()
        await database_engine.dispose()


async def main() -> None:
    settings = get_settings()
    await initialize_database(settings)
    print(f"Database and application tables ready: {settings.mysql_database}")


if __name__ == "__main__":
    asyncio.run(main())

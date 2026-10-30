"""通过 SQLAlchemy 验证 MySQL，可选择初始化配置中的数据库和模型表。"""

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import get_settings
from core.database import create_database_engine
from scripts.init_database import initialize_database


async def main() -> None:
    parser = argparse.ArgumentParser(description="验证本机 MySQL 连接")
    parser.add_argument("--create-database", action="store_true", help="创建配置中的数据库和不存在的模型表")
    args = parser.parse_args()

    settings = get_settings()
    server_engine = create_database_engine(settings, select_database=False)
    try:
        async with server_engine.connect() as connection:
            result = await connection.execute(select(func.version(), func.current_user()))
            version, account = result.one()
            print(f"Connection successful. MySQL version: {version}; account: {account}")
        if args.create_database:
            await initialize_database(settings)
            print(f"Database and model tables ready: {settings.mysql_database}")
    finally:
        await server_engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())

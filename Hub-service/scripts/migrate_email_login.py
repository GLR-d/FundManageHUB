"""把已验证邮箱升级为唯一登录账号，保留用户编号、账单和登录会话。"""

import asyncio
import sys
from pathlib import Path

from sqlalchemy import inspect, text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import Settings, get_settings
from core.database import create_database_engine
from schemas.auth_request import EmailRequest
from scripts.init_database import initialize_database


async def migrate_email_login(settings: Settings | None = None) -> None:
    """先验证旧账号均能通过邮箱登录，再修改结构；重复执行不会重建用户。"""
    settings = settings or get_settings()
    server_engine = create_database_engine(settings, select_database=False)
    engine = create_database_engine(settings)
    try:
        async with server_engine.connect() as connection:
            databases = await connection.run_sync(lambda sync: inspect(sync).get_schema_names())
        if settings.mysql_database not in databases:
            await initialize_database(settings)
            return
        async with engine.connect() as connection:
            tables = set(await connection.run_sync(lambda sync: inspect(sync).get_table_names()))
            if "users" in tables:
                columns = await connection.run_sync(
                    lambda sync: {column["name"]: column for column in inspect(sync).get_columns("users")}
                )
                verified_column = "email_verified_at" if "email_verified_at" in columns else "NULL AS email_verified_at"
                users = (await connection.execute(text(
                    f"SELECT id, email, {verified_column} FROM users"
                ))).mappings().all()
            else:
                users, columns = [], {}

        addresses = set()
        normalized = []
        for user in users:
            try:
                email = EmailRequest(email=user["email"]).email
            except ValueError:
                raise RuntimeError("旧账号存在空邮箱或无效邮箱，请先在旧版个人中心绑定并验证邮箱后再升级") from None
            if user["email_verified_at"] is None:
                raise RuntimeError("旧账号存在未验证邮箱，请先在旧版个人中心完成邮箱验证后再升级")
            if email in addresses:
                raise RuntimeError("多个旧账号使用相同邮箱，请先更换重复的邮箱后再升级")
            addresses.add(email)
            normalized.append({"id": user["id"], "email": email})

        # 通过预检后才执行 DDL；不自动填写邮箱或删除任何旧账号。
        await initialize_database(settings)
        async with engine.begin() as connection:
            if "email_verified_at" not in columns and "users" in tables:
                # 只有没有旧用户的历史空表才会走到这里。
                await connection.exec_driver_sql("ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL")
            if normalized:
                await connection.execute(text("UPDATE users SET email = :email WHERE id = :id"), normalized)
            if columns and (
                columns["email"]["nullable"] or columns["email"]["default"] is not None
                or columns["email"]["type"].length != 254
            ):
                await connection.exec_driver_sql("ALTER TABLE users MODIFY COLUMN email VARCHAR(254) NOT NULL")
            constraints = await connection.run_sync(
                lambda sync: {item["name"] for item in inspect(sync).get_unique_constraints("users")}
            )
            if "uq_users_email" not in constraints:
                await connection.exec_driver_sql("ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email)")

            code_columns = await connection.run_sync(
                lambda sync: {column["name"]: column for column in inspect(sync).get_columns("auth_email_codes")}
            )
            if not code_columns["user_id"]["nullable"]:
                await connection.exec_driver_sql("ALTER TABLE auth_email_codes MODIFY COLUMN user_id BIGINT UNSIGNED NULL")

            legacy_columns = set(columns) & {"username", "recovery_email"}
            if legacy_columns:
                # 旧验证码的状态摘要包含旧字段；升级后统一重新申请，避免遗留凭据生效。
                await connection.exec_driver_sql("DELETE FROM auth_email_codes")
            for column in ("recovery_email", "username"):
                if column in legacy_columns:
                    await connection.exec_driver_sql(f"ALTER TABLE users DROP COLUMN {column}")
            session_columns = await connection.run_sync(
                lambda sync: {column["name"] for column in inspect(sync).get_columns("auth_sessions")}
            )
            if "password_verified_at" in session_columns:
                # 改密统一校验邮箱验证码，不再保留旧的原密码验证资格。
                await connection.exec_driver_sql("ALTER TABLE auth_sessions DROP COLUMN password_verified_at")
    finally:
        await engine.dispose()
        await server_engine.dispose()


if __name__ == "__main__":
    asyncio.run(migrate_email_login())
    print("Email login schema ready; user IDs, bills and sessions preserved.")

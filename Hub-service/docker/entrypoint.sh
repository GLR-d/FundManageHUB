#!/bin/sh
set -eu

# MySQL 就绪后创建缺少的数据库表；已有数据不会被覆盖。
python -B scripts/init_database.py

# 兼容已有数据库的旧类型约束；脚本幂等，只扩展约束，不改写账单。
python -B scripts/migrate_fund_types.py

# 将信号直接交给 Uvicorn，让 Docker 停止时能释放连接。
exec "$@"

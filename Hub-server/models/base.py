"""所有数据库模型共用的 SQLAlchemy 声明基类。"""

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass

"""所有业务接口共用的响应模型。"""

from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Result(BaseModel, Generic[T]):
    code: int
    msg: str | None = None
    data: T | None = None

    @classmethod
    def success(cls, data: T | None = None) -> "Result[T]":
        return cls(code=1, msg=None, data=data)

    @classmethod
    def error(cls, msg: str) -> "Result[T]":
        return cls(code=0, msg=msg)

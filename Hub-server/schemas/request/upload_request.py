"""请求刷新单张私有图片的临时地址。"""

from pydantic import BaseModel, ConfigDict, Field


class ImageRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=8192)

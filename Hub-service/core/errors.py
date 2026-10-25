"""可向前端展示的业务错误。"""


class BusinessError(Exception):
    def __init__(self, message: str, status_code: int = 200):
        super().__init__(message)
        self.message = message
        self.status_code = status_code

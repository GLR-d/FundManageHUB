"""统一管理返回给前端的错误提示文本。"""


class Messages:
    # 通用响应
    REQUEST_FAILED = "请求失败"
    DATABASE_UNAVAILABLE = "数据库暂时不可用，请稍后重试"
    INTERNAL_SERVER_ERROR = "服务器内部错误，请稍后重试"
    PARAMETER_LABEL = "参数"
    VALIDATION_ERROR_TEMPLATE = "{field}: {message}"

    # 注册与登录
    EMAIL_EXISTS = "该邮箱已注册，请直接登录或找回密码"
    LOGIN_FAILED = "邮箱或密码错误，或账号暂时被锁定"
    LOGIN_REQUIRED = "请先登录"
    SESSION_EXPIRED = "登录已过期，请重新登录"

    # 验证码
    CAPTCHA_INVALID = "验证码已失效，请刷新验证码"
    CAPTCHA_EXPIRED = "验证码已过期，请刷新验证码"
    CAPTCHA_ATTEMPTS_EXCEEDED = "验证码尝试次数过多，请刷新验证码"
    CAPTCHA_INCORRECT = "验证码错误"
    CAPTCHA_VERIFICATION_REQUIRED = "请先验证验证码"

    # 用户资料与密码
    MAIL_UNAVAILABLE = "邮件服务暂不可用，请稍后重试"
    EMAIL_REQUEST_LIMIT = "邮件请求过于频繁，请稍后重试"
    EMAIL_CODE_INVALID = "验证码错误、已过期或已失效，请重新获取"
    EMAIL_RESEND_LIMIT = "验证码发送后需等待60秒才能重新发送"
    EMAIL_ALREADY_BOUND = "该邮箱已绑定其他账号，请更换邮箱"
    EMAIL_VERIFICATION_EXPIRED = "邮箱验证已失效，请重新验证"
    BOUND_EMAIL_REQUIRED = "请使用当前绑定且已验证的邮箱"

    # 请求参数校验
    PASSWORD_BLANK = "密码不能全部为空格"
    INVALID_PHONE = "请输入有效手机号"
    INVALID_EMAIL = "请输入有效邮箱"
    INVALID_AVATAR_URL = "头像地址格式不正确"
    USER_UPDATE_REQUIRED = "请提供要更新的资料"
    UPDATE_FIELD_NULL = "更新字段不能为 null"
    INVALID_DASHBOARD_MONTH_FORMAT = "月份必须为 YYYY-MM 格式"
    INVALID_DASHBOARD_MONTH = "请选择有效月份"
    INVALID_DASHBOARD_MONTH_YEAR = "月份年份必须在 1000 至 9999 之间"

    INVALID_MONTHLY_LIMIT = "月花销限额必须为大于 0 且不超过 90071992547409.91 的金额，最多保留两位小数"

    # 账单与图片
    FUND_NOT_FOUND = "账单不存在或无权操作"
    INVALID_FUND_IDS = "请提供正确的账单编号"
    INVALID_FUND_SEARCH = "请输入正确的搜索条件"
    INVALID_FUND_CURSOR = "账单游标必须为 YYYY-MM-DD 格式的有效日期"
    INVALID_FUND_TIME = "账单时间必须为有效的本地日期时间"
    FUND_IMPORT_TOO_LARGE = "账单文件不能超过 2MB"
    FUND_IMPORT_ENCODING = "请上传 UTF-8 或 GB18030 编码的 CSV 文件"
    FUND_IMPORT_ROW_ERROR = "CSV 第 {row} 行：{reason}"
    FUND_IMPORT_HEADERS = "表头必须包含时间、类型、金额，可选备注、图片，不能重复或包含其他字段"
    FUND_IMPORT_EMPTY = "文件中至少需要一条账单"
    FUND_IMPORT_COLUMNS = "数据列数与表头不一致"
    FUND_IMPORT_INVALID_CSV = "CSV 格式不正确"
    FUND_IMPORT_TOO_MANY_ROWS = "每次最多导入 5000 条账单"
    FUND_IMPORT_INVALID_TYPE = "类型必须为 0 至 10 或消费、餐饮、购物、住房、娱乐、其他、薪资、理财、交通、收转账、收红包"
    FUND_IMPORT_INVALID_AMOUNT = "金额必须为非负数字，最多保留两位小数"
    INVALID_UPLOAD_IMAGE = "请上传有效的 JPG/PNG 图片"
    UPLOAD_TOO_LARGE = "上传图片不能超过 1MB"
    OSS_NOT_CONFIGURED = "图片存储服务尚未正确配置"
    OSS_UPLOAD_FAILED = "图片上传失败，请稍后重试"
    IMAGE_NOT_FOUND = "图片不存在或无权访问"
    IMAGE_EXPIRED = "图片已失效，请重新上传"
    OSS_REFRESH_FAILED = "图片链接刷新失败，请稍后重试"

    # 聊天会话
    CHAT_NOT_FOUND = "会话不存在或已删除"
    CHAT_BUSY = "该会话正在回复或更新，请稍后重试"
    CHAT_UNAVAILABLE = "聊天存储暂时不可用，请稍后重试"
    CHAT_REPLY_FAILED = "回答生成失败，请稍后重试。"
    CHAT_REPLY_EMPTY = "模型没有返回文字内容"
    CHAT_REPLY_INTERRUPTED = "回复未完成，请重新发送"
    CHAT_UPDATE_REQUIRED = "请提供新的会话标题或置顶状态"
    CHAT_DUPLICATE_MESSAGE = "该消息已经发送，请刷新会话后查看"

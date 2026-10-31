"""通过 SMTP 发送邮件；连接和发送在线程池中执行。"""

import logging
import smtplib
import ssl
from email.headerregistry import Address
from email.errors import HeaderParseError
from email.message import EmailMessage

from starlette.concurrency import run_in_threadpool

from config.settings import Settings
from core.exception_handlers import BusinessError
from core.messages import Messages

logger = logging.getLogger(__name__)


def ensure_mail_config(settings: Settings) -> None:
    """只在邮件接口使用时检查配置，避免未配置邮件影响原有功能启动。"""
    try:
        if not all((settings.smtp_host, settings.smtp_username, settings.smtp_password, settings.mail_from)):
            raise ValueError
        if not 1 <= settings.smtp_port <= 65535:
            raise ValueError
        sender = Address(addr_spec=settings.mail_from)
        if not sender.username or not sender.domain or not settings.mail_from.isascii():
            raise ValueError
    except (ValueError, IndexError, HeaderParseError):
        raise BusinessError(Messages.MAIL_UNAVAILABLE, 503) from None


def _send_email(settings: Settings, recipient: str, subject: str, body: str) -> None:
    message = EmailMessage()
    message["From"] = Address(addr_spec=settings.mail_from)
    message["To"] = Address(addr_spec=recipient)
    message["Subject"] = subject
    message.set_content(body)
    context = ssl.create_default_context()
    if settings.smtp_use_ssl:
        connection = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=10, context=context)
    else:
        connection = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10)
    with connection as smtp:
        if not settings.smtp_use_ssl:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
        smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(message)


async def send_email(settings: Settings, recipient: str, subject: str, body: str) -> None:
    """后台发送失败只记录异常类型，不把凭据、收件人或验证码写入日志。"""
    try:
        await run_in_threadpool(_send_email, settings, recipient, subject, body)
    except (smtplib.SMTPException, OSError, ValueError, HeaderParseError) as error:
        logger.error("邮件发送失败（%s）", type(error).__name__)

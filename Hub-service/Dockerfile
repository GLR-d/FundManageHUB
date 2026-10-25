FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 验证码使用的字体，以及向量库依赖需要的运行库。
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser

# 依赖单独一层；仅修改业务代码时可以复用这一层。
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chown=appuser:appuser . ./

# Compose 的新数据卷会继承这些目录的所有者。
RUN mkdir -p /app/logs /app/chroma_data \
    && chown -R appuser:appuser /app/logs /app/chroma_data

USER appuser
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

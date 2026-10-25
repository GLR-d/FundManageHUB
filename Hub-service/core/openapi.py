"""为通过中间件认证的接口声明 Swagger 认证方式。"""

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

from core.auth_middleware import is_public_request


def register_openapi(application: FastAPI) -> None:
    def custom_openapi():
        if application.openapi_schema is not None:
            return application.openapi_schema
        schema = get_openapi(
            title=application.title,
            version=application.version,
            routes=application.routes,
        )
        schema.setdefault("components", {})["securitySchemes"] = {
            "HTTPBearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
            "APIKeyHeader": {"type": "apiKey", "in": "header", "name": "token"},
        }
        for path, operations in schema["paths"].items():
            for method, operation in operations.items():
                if method.upper() in {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"}:
                    operation["security"] = (
                        [] if is_public_request(path, method.upper())
                        else [{"HTTPBearer": []}, {"APIKeyHeader": []}]
                    )
        application.openapi_schema = schema
        return schema

    application.openapi = custom_openapi

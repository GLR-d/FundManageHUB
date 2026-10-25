# FundsMangeHub

个人记账项目，支持邮箱注册登录、账单管理、CSV 导入导出、收支统计、每月花销限额、OSS 图片存储，以及带会话记忆的聊天助手。

## 技术栈

- 前端：Vue 3、TypeScript、Vite。
- 后端：FastAPI、SQLAlchemy 异步 ORM。
- 存储：MySQL、Redis；聊天使用 LangChain / LangGraph，文档向量库使用 Chroma。
- 部署：Docker Compose、Nginx。

## 目录

- `Hub-vue/`：前端页面和接口请求。
- `Hub-service/`：后端接口、业务逻辑、数据库访问和聊天功能。
- `deploy/`：Nginx 配置及容器运行配置。
- `compose.yaml`、`compose.dev.yaml`：容器部署和后端开发模式配置。

## 启动与停止

先启动 Docker Desktop，再在项目根目录执行：

```powershell
# 构建并启动；更新前后端后也可执行此命令
docker compose -f compose.yaml -f compose.dev.yaml up -d --build

# 停止服务，保留数据卷
docker compose stop
```

启动后访问 [项目首页](http://localhost:8088)；[接口文档](http://localhost:8088/api/docs)。Nginx 提供前端页面，并将 `/api/` 请求转发给后端。

开发模式下，Python 代码保存后自动重载；前端修改后需重新构建 Nginx 镜像。

本机后端配置使用 `Hub-service/.env`，容器配置使用 `deploy/runtime/*.env`，两者独立。数据库及聊天等持久化数据保存在 Docker 数据卷中。

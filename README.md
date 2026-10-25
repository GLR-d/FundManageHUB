# FundsMangeHub

个人记账项目，支持邮箱注册登录、账单管理、CSV 导入导出、收支统计、每月花销限额、OSS 图片存储，以及带会话记忆的聊天助手。

## 技术栈

- 前端：Vue 3、TypeScript、Vite。
- 后端：FastAPI、SQLAlchemy 异步 ORM。
- 存储：MySQL、Redis。
- 聊天与文档检索：LangChain、LangGraph、Chroma。

## 目录

- `Hub-vue/`：前端页面、接口请求及测试。
- `Hub-service/`：后端接口、业务逻辑、数据库访问、聊天功能及测试。

## 本机启动

准备 Python 3.12、Node.js 24、MySQL，以及支持 JSON/Search 功能的 Redis。
在 `Hub-service/.env` 中配置数据库、JWT、Redis，以及 `LLM_*`、`EMBEDDING_*` 模型服务；邮箱与图片功能分别需要 SMTP 和 OSS 配置。

后端：在项目根目录打开终端执行：

```powershell
cd Hub-service
python -m pip install -r requirements.txt
python -B scripts/init_database.py
python main.py
```

前端：在项目根目录另开一个终端执行：

```powershell
cd Hub-vue
npm ci
npm run dev
```

访问 [前端页面](http://localhost:7070)；[后端接口文档](http://localhost:8080/docs)。

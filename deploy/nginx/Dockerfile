FROM node:24-alpine AS frontend

WORKDIR /app

# 先安装锁定依赖，修改页面时可以复用依赖层。
COPY Hub-vue/package.json Hub-vue/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY Hub-vue/ ./
RUN npm run build

FROM nginx:stable-alpine

COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /app/dist /usr/share/nginx/html

EXPOSE 80

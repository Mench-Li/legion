# Dockerfile — 多阶段：构建（拷贝共享模块到静态前端）→ 运行（Node 22 单进程）
# 持久化用 node:sqlite（Node 22 内置，零原生依赖、零联网下载）。

FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN node scripts/build.mjs

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DB_PATH=/data/whiteboard.db \
    TTL_MS=10000
COPY package.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN node scripts/build.mjs

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.js"]

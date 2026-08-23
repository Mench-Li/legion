# DEPLOY — 部署与 CI/CD 说明（S13）

## 形态

单容器 Docker 自托管；**单实例、单进程，不承诺横向扩展**（ADR-0005）。

## 依赖

零第三方运行时依赖：Node ≥22.5（内置 `node:sqlite`）+ 浏览器。构建仅需 Node。

## 本地自托管（Node 直接跑）

```bash
cd whiteboard
node scripts/build.mjs          # 拷贝共享模块到静态前端（可省略，仓库已含）
npm start                        # 或 node apps/server/src/index.js
# 打开 http://localhost:8080
```

环境变量：`PORT`(8080)、`HOST`(0.0.0.0)、`DB_PATH`(apps/server/data/whiteboard.db)、
`TTL_MS`(10000)。

## Docker Compose 自托管

```bash
cd whiteboard
docker compose up --build
# 打开 http://localhost:8080
```

`docker compose` 挂载 `/data` 卷持久化 SQLite；`/healthz` 探活含存储可读性。

## 健康检查

```bash
curl http://localhost:8080/healthz
# => {"ok":true,"storage":"SqliteProvider","ts":...}
```

## CI 门禁（typecheck/build/test + gate 压测）

```bash
node scripts/build.mjs                 # build：共享→静态前端
node --test packages/shared/test/*.test.mjs apps/server/test/*.test.mjs   # 单测/集成/e2e
node scripts/bench/bench.mjs 20 20     # gate：20 并发
node scripts/bench/bench.mjs 50 10     # soak：50 并发
```

（本环境禁网，无 TypeScript/vitest/vite；typecheck 等价为 `node --check` 全源文件语法校验。）

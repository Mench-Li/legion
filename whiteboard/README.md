# 多人实时协作白板（collab-whiteboard）

零外部依赖、可本地自托管的多人实时协作白板 Web 应用（v1 单实例）。

## 功能（v1）

- 多用户实时画板：LWW 操作式 CRDT + 自研 RFC6455 ws relay，强最终一致。
- 图形元素：矩形 / 椭圆 / 直线(箭头) / 自由手绘 / 单行纯文本。
- 编辑：单选 / 移动 / 8 向缩放 / 删除 / 改色 / 线宽。
- 协同光标：presence 独立通道，20Hz 节流，TTL 清理（正常断开立即移除）。
- 撤销/重做：每用户局部撤销（只撤本人），redo 采用 clear-on-remote 语义。
- 无限画布 pan/zoom（视口变换不入文档/undo/同步）。
- 本地自托管：单进程 Node + SQLite(WAL) + /healthz + Docker Compose。

## 架构

```
apps/web         静态前端（Canvas 2D + presence overlay，零构建）
apps/server      单进程 Node：http + 自研 ws relay + /healthz + SQLite 持久化
packages/shared  共享契约：schema / 命中 / 视口 / 节流 / CRDT / 撤销 / XSS
scripts          构建（build.mjs）+ 压测冒烟（bench.mjs）
```

状态分层（ADR-0007）：持久态（元素，进 undo/持久化）与临态（presence，awareness
独立通道）物理分离，presence 绝不入文档/undo/持久化。

## 快速开始

```bash
cd whiteboard
node scripts/build.mjs
npm start                 # 或 node apps/server/src/index.js
# 打开 http://localhost:8080，多开标签页即可互画
```

Docker：`docker compose up --build`（见 docs/DEPLOY.md）。

## 验证

```bash
node scripts/build.mjs
node --test packages/shared/test/*.test.mjs apps/server/test/*.test.mjs
node scripts/bench/bench.mjs 20 20   # gate；50 10 = soak
```

## 关键实现说明（禁网约束）

环境禁止联网下载依赖，yjs / y-protocols / y-websocket / better-sqlite3 / vite 均不可用。
因此以**零依赖**等价实现落地（语义对齐 Yjs 基线）：自研 RFC6455 relay、LWW 操作式
CRDT、node:sqlite(WAL)。StorageProvider / 同步层留有接口边界，依赖可用时可按
ADR-0001 替换为 Yjs 而不改上层。

## ADR 索引

见 `docs/adr/`（7 份，状态：草案待签发）。

## 单实例声明

v1 为单实例、单进程，**不承诺横向扩展**；压力上限以 50 并发 soak 为界。

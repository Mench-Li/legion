# 多人实时协作白板（collab-whiteboard）

零外部依赖、可本地自托管的多人实时协作白板 Web 应用（v1 单实例，多房间）。

## 功能（v1）

- 多用户实时画板：LWW 操作式 CRDT + 自研 RFC6455 ws relay，强最终一致。
- 图形元素：矩形 / 椭圆 / 直线(箭头) / 自由手绘 / 单行纯文本。
- 编辑：单选 / 移动 / 8 向缩放 / 删除 / 改色 / 线宽。
- 协同光标：presence 独立通道，20Hz 节流，TTL 清理（正常断开立即移除）。
- 撤销/重做：每用户局部撤销（只撤本人），redo 采用 clear-on-remote 语义。
- 无限画布 pan/zoom（视口变换不入文档/undo/同步）。
- 本地自托管：单进程 Node + SQLite(WAL) + /healthz + Docker Compose。

## 多房间与连接治理（P3-1）

- **多房间**：`?room=<id>` 进入指定房间（缺省 `default`）；每个房间**独立 SQLite 文件**
  （`WB_ROOMS_DIR`，默认 `apps/server/data/rooms/<id>.db`），首个连接时惰性打开，空闲且无人时关闭。
  房间之间文档、presence、广播、存储完全隔离——**不会把 A 房间的图广播到 B 房间**。
  界面上可切换房间、复制房间链接（切换时 token 不写回 URL）。
- **房间级权限**：`WHITEBOARD_ROOMS="main:tokA:rw,view:tokB:ro,open-room::rw"`；
  `rw` 可写、`ro` 只读（可看、可移动光标，写入被服务端拒绝并回明确提示）。
  未声明的房间沿用全局 `WHITEBOARD_TOKEN` 语义（回环开发可完全不配）。
- **分级限流**（超限原因可区分）：连接数超限（全局/单房间/单 IP）→ 升级阶段 503；
  消息过大/op 条数过多/畸形 → 立即 1009/1008 断开；频率超限 → 先丢弃并告警，累计超阈值才断开。
- **可观测性**：`/healthz`（浅）、`/readyz`（深：逐房间存储 + 心跳新鲜度）、`/metrics`、
  `/api/rooms`、`/api/rooms/<id>/audit`（JSONL 落盘 + 内存环形缓冲）；控制面默认仅回环。
- 实例形态**仍是单实例、单进程**；被否的多实例共享存储方案与转 v2 触发条件见 ADR-0008。

## 架构

```
apps/web         静态前端（Canvas 2D + presence overlay，零构建）
apps/server      单进程 Node：http + 自研 ws relay + 治理（房间/限流/指标/审计）+ /healthz + SQLite 持久化
packages/shared  共享契约：schema / 命中 / 视口 / 节流 / CRDT / 撤销 / XSS / 房间与角色
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
# 指定房间：http://localhost:8080/?room=team-a
```

Docker：`docker compose up --build`（见 docs/DEPLOY.md）。
环境变量（含房间/限流/审计全套）与端点清单同样见 `docs/DEPLOY.md`。

## 验证

```bash
node scripts/build.mjs
npm test                                 # 152 例：共享契约 + 服务端单测 + 真实服务 e2e + 治理端到端
node scripts/bench/bench.mjs 20 20       # gate：20 并发
node scripts/bench/bench.mjs 50 10       # soak：50 并发
```

## 关键实现说明（禁网约束）

环境禁止联网下载依赖，yjs / y-protocols / y-websocket / better-sqlite3 / vite 均不可用。
因此以**零依赖**等价实现落地（语义对齐 Yjs 基线）：自研 RFC6455 relay、LWW 操作式
CRDT、node:sqlite(WAL)。StorageProvider / 同步层留有接口边界，依赖可用时可按
ADR-0001 替换为 Yjs 而不改上层。

## ADR 索引

见 `docs/adr/`（8 份，状态：草案待签发）。

## 单实例声明

v1 为单实例、单进程，**不承诺横向扩展**；压力上限以 50 并发 soak 为界。
P3-1 的多房间与连接治理不改变实例形态（ADR-0008）；单实例内房间数上限默认 50，
单房间连接上限默认 50，单 IP 连接上限默认 50（同一 NAT 出口的合法用户不得被误拒）。

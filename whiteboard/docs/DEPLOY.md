# DEPLOY — 部署与 CI/CD 说明（S13 / P3-1）

## 形态

单容器 Docker 自托管；**单实例、单进程，不承诺横向扩展**（ADR-0005）。
自 P3-1 起支持**多房间**：房间隔离与治理在单进程内完成，实例形态不变（ADR-0008）。

## 依赖

零第三方运行时依赖：Node ≥22.5（内置 `node:sqlite`）+ 浏览器。构建仅需 Node。

## 本地自托管（Node 直接跑）

```bash
cd whiteboard
node scripts/build.mjs          # 拷贝共享模块到静态前端（可省略，仓库已含）
npm start                        # 或 node apps/server/src/index.js
# 打开 http://localhost:8080           → 默认房间 default
# 打开 http://localhost:8080/?room=main → 指定房间
```

## 环境变量

> **P3-2 起**：白板的全部配置项已在 `apps/server/src/config-schema.mjs` 中**声明**，并接入仓库统一配置引擎
> （`packages/shared/src/config.mjs` 的同步副本，白板保持零依赖独立部署）。
> - 优先级：**CLI（`--port/--host/--token`） > 环境变量 > 默认值**；非法值**报错退出**（不再静默回退）。
> - 启动时打印一行**脱敏**配置摘要（token 只显示 `***(N 位)`；`WHITEBOARD_ROOMS` 里的房间 token 亦被隐去）。
> - 仓库根可校验白板配置面：`node scripts/config/check.mjs --process=whiteboard`（详见 `docs/CONFIG.md`）。
> - 新增 env 读取必须同时补进 `config-schema.mjs`，否则仓库 CI 的 `scan --check` 会失败。

### 基础（P0）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8080 | 监听端口（可用 `--port` 覆盖） |
| `HOST` | 127.0.0.1 | 监听地址；**非回环必须设置 token**（否则拒绝启动） |
| `DB_PATH` | `apps/server/data/whiteboard.db` | 兼容位：`:memory:` 时房间也走内存（bench/CI 冒烟用） |
| `WB_IN_MEMORY` | 0 | 置 1 强制房间用内存存储（不落盘） |
| `WHITEBOARD_TOKEN` | 空 | 全局 token（回环开发可留空）；未单独声明 token 的房间都用它（可用 `--token` 覆盖） |
| `TTL_MS` | 10000 | presence 陈旧判定（非正常断开时多久移除光标） |

### 房间与权限（P3-1）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WHITEBOARD_ROOMS` | 空 | 房间声明：`roomId:token:role`，逗号分隔，如 `main:tokA:rw,view:tokB:ro,open-room::rw`。token 留空=该房间开放；role 取 `rw`(默认)/`ro`。未声明的房间沿用全局 token 语义。**非法项会打印告警**（不静默忽略） |
| `WB_ROOMS_DIR` | `apps/server/data/rooms` | 房间 DB 目录（每房间一个 `<roomId>.db`）。**该目录被单实例独占锁保护**（P4-6）：指向已被占用的目录时进程**启动即失败**并退出 |
| `WB_ROOM_IDLE_MS` | 300000 | 房间空闲多久关闭存储（无在线用户时才关；关闭前落快照） |
| `WB_MAX_ROOMS` | 50 | 同时打开的房间数上限；超限**拒绝新房间**而不驱逐已有房间 |
| `WB_CONTROL_OPEN` | 0 | 置 1 时控制面（`/metrics`、`/readyz`、`/api/rooms*`）对非回环也开放；默认仅回环（或带 `Bearer <全局 token>`） |

### 连接与消息限流（P3-1）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WB_MAX_CONNECTIONS` | 200 | 全服连接数；超限在**升级阶段**返回 503 |
| `WB_MAX_CONNECTIONS_PER_ROOM` | 50 | 单房间连接数（对齐 50 并发 soak 承诺） |
| `WB_MAX_CONNECTIONS_PER_IP` | 50 | 单 IP 连接数（粗粒度防滥用）。**不要设小于房间上限**：真实用户常来自同一 NAT/公司出口，设小会先误拒正常用户（本仓库 bench 20 客户端同 IP 即是一例） |
| `WB_MAX_MESSAGE_BYTES` | 262144 | 单条 JSON 消息上限（按 UTF-8 字节）；超限 → 1009 断开 |
| `WB_MAX_OPS_PER_MESSAGE` | 200 | 单条消息内 op 条数；超限 → 1008 断开 |
| `WB_MESSAGE_RATE_PER_SEC` | 120 | 每连接令牌补充速率 |
| `WB_MESSAGE_BURST` | 240 | 令牌桶容量（允许的瞬时突发） |
| `WB_RATE_STRIKES` | 20 | 统计窗口内累计丢弃达到此值才断开（抖动只丢消息，不误伤） |

### 审计（P3-1）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WB_AUDIT_DIR` | `apps/server/data` | 审计 JSONL 目录（`audit.jsonl`，超过 8MiB 轮转，保留 3 份归档） |

## 端点

| 端点 | 用途 |
| --- | --- |
| `GET /healthz` | 浅探活：进程 + 存储可读；附 `rooms`/`peers`/`uptimeMs`（**保持既有 `ok`/`storage`/`ts` 契约**） |
| `GET /readyz` | 深探活：逐房间存储健康 + tick 心跳新鲜度（心跳停摆可感知）；不健康返回 503 |
| `GET /metrics` | 指标：计数器、限流配置、房间明细、活跃连接分档、拒绝原因分布、关闭码分布 |
| `GET /api/rooms` | 房间列表 + 声明配置 + 配置错误 + 生效限流参数 |
| `GET /api/rooms/<id>` | 单房间概况（在线/只读/元素数/累计统计/存储健康）；未打开的房间 404 `room_not_open` |
| `GET /api/rooms/<id>/audit?type=&limit=&source=` | 该房间审计。`source` 取 `process`（默认，本进程环形缓冲，行为与 P3-1 一致）/ `archive`（磁盘 JSONL，**重启后仍可查**）/ `all`（合并去重）；默认 limit 100、环形缓冲上限 500、归档上限 1000。响应永远附 `retention`（文件数/字节/最早最新时间/`historyTruncated`） |

控制面默认**仅回环**；远程访问需 `Authorization: Bearer <全局 token>` 或 `WB_CONTROL_OPEN=1`。
服务**不信任** `X-Forwarded-For`（避免伪造绕过单 IP 限制）；如需反代请在边界做真实客户端识别。

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
# => {"ok":true,"storage":"SqliteProvider","rooms":1,"peers":2,"uptimeMs":...,"ts":...}
curl http://localhost:8080/readyz
curl http://localhost:8080/metrics
```

## 房间运维示例

```bash
# 私有只读房间 + 私有可写房间 + 开放房间
WHITEBOARD_ROOMS="review:tok-ro:ro,team-a:tok-a:rw,open-room::rw" npm start

# 看房间与在线情况
curl http://localhost:8080/api/rooms

# 查某个房间最近的治理事件（连接/拒绝/限流/策略关闭/写入摘要）
curl "http://localhost:8080/api/rooms/team-a/audit?limit=50"
curl "http://localhost:8080/api/rooms/team-a/audit?type=op_denied"

# 服务重启后回溯历史（内存环形缓冲已清空，磁盘归档仍在）
curl "http://localhost:8080/api/rooms/team-a/audit?source=archive&limit=200"
curl "http://localhost:8080/api/rooms/team-a/audit?source=all&limit=200"

# 删掉一个房间（= 删文件；先确认无人在线）
rm apps/server/data/rooms/team-a.db*
```

## CI 门禁（typecheck/build/test + gate 压测）

```bash
node scripts/build.mjs                 # build：共享→静态前端
node --test packages/shared/test/*.test.mjs apps/server/test/*.test.mjs   # 单测/集成/e2e（含治理端到端）
node scripts/bench/bench.mjs 20 20     # gate：20 并发
node scripts/bench/bench.mjs 50 10     # soak：50 并发
```

（本环境禁网，无 TypeScript/vitest/vite；typecheck 等价为 `node --check` 全源文件语法校验。）
注意：`docker` 下 `WB_ROOMS_DIR` 必须指向挂载卷（如 `/data/rooms`），否则房间数据不持久化。

## 单实例约束（P4-6，升级为可执行守卫）

房间目录由独占锁 `<WB_ROOMS_DIR>/.whiteboard.lock` 保护。**不要**让两个实例指向同一目录：

- 第二个实例会在打开第一个房间**之前**拒绝启动（非零退出），并打印占用者 pid/端口/起始时间与处置建议；
- 旧行为（无守卫）不会报错，而是**静默分裂数据**——实测两个实例各自一份内存 doc、
  视图分别停在 2 与 3 而真值已是 4，且 `snapshot()` 的 `DELETE FROM ops` 会删掉对方未读到的 op（永久丢失）。

运维相关：

| 情况 | 现象与处置 |
| --- | --- |
| 正常启动 | 日志无锁相关输出；`/healthz` 的 `dirLock` 为 `exclusive` |
| 目录被别人占着 | 启动即失败，错误里点名占用者；停掉那个实例，或改用独立的 `WB_ROOMS_DIR` |
| 进程被强杀后重启 | 自动接管陈旧锁，日志出现「接管了陈旧目录锁」+ 审计 `lock_takeover`（留痕，避免掩盖上一次崩溃） |
| 确认占用者已不存在但锁仍在 | 删除 `<WB_ROOMS_DIR>/.whiteboard.lock` 后重启（仅在确认进程确实已死时才这样做） |
| 内存房间（`DB_PATH=':memory:'`） | 不落盘、**不加锁**，多实例共存无副作用（测试与 bench 走这条路） |

> 锁是**建议性**的：它防的是误操作，不是恶意规避。真正的多实例共享存储仍未实现，
> 其被否理由与转 v2 触发条件见 `docs/adr/ADR-0008-房间治理与实例形态.md`。
> 另注：`DB_PATH=':memory:'` 会**连带**把房间也切成内存（`index.js`），无法「主库内存 + 房间落盘」。

<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **未入库**（目录尚未提交） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P3-1 白板多房间与连接治理 · 验证证据

**切片**：P3-1 白板多房间与连接治理（房间 ID/房间级存储/成员权限 · 连接数与消息大小与频率限制 ·
指标/审计/更完整的健康检查 · 实例形态决策）
**日期**：2026-09-10
**代码位置**：`whiteboard/apps/server/src/`（`rooms.mjs`、`limits.mjs`、`metrics.mjs`、`audit.mjs`、
`security.mjs`、`room.mjs`、`ws.mjs`、`index.js`）、`whiteboard/packages/shared/src/room.mjs`（前端纯逻辑）、
`whiteboard/apps/web/public/`（房间 UI）、`scripts/ci/run-ci.mjs`（套件标签）、
`workbench/scripts/serve.mjs`（顺带修掉的静态托管缺陷）
**决策记录**：`whiteboard/docs/adr/ADR-0008-房间治理与实例形态.md`
**测试**：`whiteboard/apps/server/test/{limits,rooms,metrics-audit,governance.e2e}.test.mjs`、
`whiteboard/packages/shared/test/room.test.mjs`、`workbench/scripts/static-serve.test.mjs`

---

## 1. 交付内容与验证方式

| 子项 | 实现 | 验证 |
| --- | --- | --- |
| ① 房间 ID | `isValidRoomId` 规则 `^[a-z0-9][a-z0-9_-]{0,63}$`（服务端与前端同规则）；非法 ID 升级阶段 400 `bad_room` | 单测 4 例（合法/非法/解析/请求提取）+ 端到端（`?room=BAD` → 400、编码路径穿越 → 400，**不静默回退 default**） |
| ① 房间级存储 | `RoomRegistry`：每房间独立 `data/rooms/<id>.db`，惰性打开、空闲关闭（关闭前落快照）、房间数上限 | 单测 11 例（惰性/重复 open/隔离/重启恢复/上限不驱逐/空闲关闭/有在线不关闭/list 概况/内存模式/配置解析）+ 端到端（两房间元素数各自独立） |
| ① 成员权限 | `WHITEBOARD_ROOMS="room:token:role"`；`authorizeRoom` 常时比较；角色 rw/ro；未声明房间沿用全局 token | 单测 5 例（解析含非法项报错/未声明语义/已声明语义/全局 token 不能越权/safeEqual）+ 端到端（错 token 401、缺 token 401、正确 101、只读被拒且不广播且房间不变、只读仍可 presence） |
| ② 连接数限制 | `ConnectionLimiter` 全局/单房间/单 IP 三档，握手**之前**裁决，超限 503 | 单测 4 例（三档分别生效/优先级/释放不泄漏/只读预检/默认值容得下 20 同 IP）+ 端到端（房间上限 3 → 第 4 条 503，释放后可再进） |
| ② 消息大小与条数 | `checkPayload`（UTF-8 字节）、`checkMessage`（op 条数、presence state、畸形） | 单测 5 例 + 端到端（4KB 消息 → 1009、6 个 op（上限设 5）→ 1008 且留审计、畸形 JSON → 1008） |
| ② 消息频率 | `MessageRateLimiter` 令牌桶 + 丢弃计数窗口 + 告警节流 + 达阈值才断开 | 单测 6 例（突发/补充/阈值/告警节流/跨窗口归零）+ 端到端（260 条突发 → 收到 `rate_limited` 告警、`rateLimitDrops>0` 而 `rateLimitCloses=0`） |
| ③ 指标 | `Metrics`（计数器 + 拒绝原因 + 关闭码分布 + 实时仪表盘）→ `GET /metrics` | 单测 5 例 + 端到端（计数、按房间连接分档、限流配置、房间明细；关连接后如实报 0） |
| ③ 审计 | `AuditLog`：内存环形缓冲（500）+ JSONL 追加（8MiB 轮转，保留 3 份）→ `GET /api/rooms/<id>/audit` | 单测 8 例（按房间/类型过滤、limit、未知类型归一、白名单、上限丢最旧、落盘续算、轮转不截断行、无目录不抛错）+ 端到端（room_open/connect 可查、按房间过滤、只读拒绝可查） |
| ③ 健康检查 | `/healthz` 保持既有契约 + 附读数；`/readyz` 逐房间存储健康 + 心跳新鲜度 | 端到端（healthz 200 且含 ok/storage/ts/rooms/uptimeMs；readyz 200 且 `heartbeatAgeMs<5000`、全房间 healthy） |
| ④ 实例形态 | **继续单实例**；ADR-0008 记录被否方案与转 v2 触发条件 | ADR-0008（文档）；`RoomRegistry` 保留 `dir`/`inMemory` 注入边界 |
| 前端 | 房间切换、token 按房间记忆、只读态禁用写入、治理提示、复制房间链接 | 纯逻辑单测 12 例（URL 解析/切换 URL 不写回 token/存取键/能力/错误文案） |

## 2. 关键设计决策（与依据）

1. **每房间独立 SQLite 文件**而非单库加 `room` 列：房间隔离不能退化为「查询条件写对就行」——
   一次 WHERE 漏写就是跨房间串数据；独立文件让「删房间 = 删文件」，单房间损坏不波及他人。
   代价（跨房间聚合需逐库读）被接受，因为治理指标只需逐房间概况。
2. **权限用 token + 角色，不做成员表**：`rw`/`ro` + 每房间 token 覆盖了「私有房间」「只读房间」两类真实需求；
   邀请/踢人属产品扩张，ADR-0008 记为被否方案并给出触发条件。
3. **分级限流**而非一刀切：连接数超限在握手前 503（不建立连接，省资源且原因可区分）；
   消息过大/畸形立即断开（这类客户端不值得服务）；频率超限先丢弃+告警、持续才断开（抖动不误伤）。
4. **握手前裁决**：`ws.mjs` 新增 `gate(req)` 钩子，把「房间解析 → 鉴权 → 连接数准入」放在写 101 之前，
   拒绝时直接回 4xx/503 状态码。既有的 `authorizedUpgrade` 语义与签名未动（未提供 gate 时行为与 P0 一致）。
5. **广播按房间**：这是房间化之后才成立的**正确性要求**，而非优化——原实现遍历 `wss.clients` 全量广播。
6. **控制面默认仅回环**：`/metrics`、`/readyz`、`/api/rooms*` 会暴露在线数、房间名与治理事件，
   默认不对外开放；远程需 Bearer token 或显式 `WB_CONTROL_OPEN=1`。
7. **不信任 `X-Forwarded-For`**：单 IP 限制若可被伪造头绕过就形同虚设；需要真实客户端识别的部署
   应在反向代理层处理（ADR-0008 已登记）。
8. **房间数超限拒绝新房间而不驱逐已有房间**：驱逐会把正在看画的人踢掉，宁可让新房间进不来。

## 3. 反向断言（证明「没做」的事）

- **不跨房间广播**：A 房间发 op 后等待 200ms，B 房间收件箱中 `type==='op'` 数量为 0；presence 同理。
- **不跨房间串数据**：`/api/rooms/<a>` 元素数 1 时 `/api/rooms/<b>` 为 0；重启注册表后各房间按自己的文件恢复。
- **只读不写**：只读连接发 op 后房间元素数仍为 0，且其他连接**收不到**该 op（被拒的 op 不进广播）。
- **不静默回退**：`?room=BAD`、`?room=../etc` 均为 400，不会悄悄落到 default（对比 `?room=` 缺省才是 default）。
- **不静默忽略配置错**：`WHITEBOARD_ROOMS` 中非法项（大写房间名、未知角色、缺字段、重复声明）全部进入
  `errors` 并被打印；`/api/rooms` 也回传 `configErrors`。
- **不放 200 再断流**：静态托管缺产物时返回 404 + 指引（见 §5 缺陷 ③）。
- **限流不是永久封禁**：房间连接上限释放后可再次准入；频率限流跨统计窗口后计数归零。

## 4. 复现命令与实测输出

```powershell
# 白板全量（152 例）
cd whiteboard; npm test

# 治理端到端（真实 ws 服务 + 真实 Upgrade 响应）
node --test whiteboard/apps/server/test/governance.e2e.test.mjs
# 单测：限流 / 房间 / 指标审计 / 前端房间逻辑
node --test whiteboard/apps/server/test/limits.test.mjs
node --test whiteboard/apps/server/test/rooms.test.mjs
node --test whiteboard/apps/server/test/metrics-audit.test.mjs
node --test whiteboard/packages/shared/test/room.test.mjs

# 压测（gate 与 soak）
node whiteboard/scripts/bench/bench.mjs 20 20
node whiteboard/scripts/bench/bench.mjs 50 10

# 顺带修复的静态托管回归
node --test workbench/scripts/static-serve.test.mjs

# CI 阶段
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node scripts/ci/run-ci.mjs --only build --out .ci\p31-build
node scripts/ci/run-ci.mjs --only smoke --out .ci\p31-smoke2
```

实测输出（摘录）：

```
whiteboard 全量 : tests 158 / suites 30 / pass 158 / fail 0   （原 70 → 新增 88；12 文件）
                  ※ 该总数在合并落地后、于主 checkout 上复跑确认；逐文件用例合计亦为 158
                    （26+8+7+12+6+7+6+7+3+17+20+13+6+20）。
                    历史上出现过两个更小的中间值，**均不作最终数字**：
                    · 150 = 补「默认值必须容得下 50 并发承诺 / 单 IP 不得小于单房间上限」两条
                      回归断言之前（limits 尚为 15 例）；
                    · 152 = 再补前端静态契约 ui-contract 6 例之前（11 文件）。
governance e2e  : tests 20  / pass 20 / fail 0
limits          : tests 17  / pass 17 / fail 0
rooms           : tests 20  / pass 20 / fail 0
metrics-audit   : tests 13  / pass 13 / fail 0
shared/room     : tests 12  / pass 12 / fail 0
ui-contract     : tests 6   / pass 6  / fail 0
static-serve    : tests 6   / pass 6  / fail 0
web（回归）      : 24/24      web-p28（回归）: 21/21
bench 20×20     : 收敛 OK 26ms，P95 109ms，256 ops/s，BENCH PASS
bench 50×10 soak: 500 op 全收敛 83ms，P95 223ms，307 ops/s，BENCH PASS
build 阶段       : PASS
smoke 阶段       : PASS（chat-l1 35/35、chat-s2 9/9、files-s5 32/32、
                   whiteboard /healthz 200 与 GET / 200、v1 看板 auth=true）
```

治理端到端关键断言（真实 HTTP/ws）：

```
welcome 带上房间与角色 — {"room":"main","role":"rw","limits":{"maxMessageBytes":2048,...}}
不带 ?room= 落在 default（既有客户端无需改动）
房间隔离：alpha 的 op 不进 beta，且不跨房间广播
房间 token：错 token 401 / 缺 token 401 / 正确 101
非法房间 ID：400 bad_room（含编码路径穿越）
只读房间：op 被拒（op_denied），房间元素数仍 0，不广播；presence 仍可用
连接数超限：503 max_connections_per_room；释放后可再进
消息过大 1009 / op 过多 1008 / 畸形 JSON 1008
频率超限：先告警（retryAfterMs），rateLimitDrops>0 且 rateLimitCloses=0
/healthz（ok:true + rooms/peers/uptimeMs）、/readyz（heartbeatAgeMs 新鲜、逐房间 healthy）
/metrics（计数 + 按房间连接分档 + 限流配置）、/api/rooms、/api/rooms/<id>/audit
```

生产路径验证（**真实文件型房间**，补上测试套件用内存房间留下的覆盖缺口）：

```powershell
# 以真实进程 + 真实 room DB 文件目录 + 真实审计目录启动，并做真实进程重启
node <临时脚本>   # 脚本要点：PORT 随机、WB_ROOMS_DIR/WB_AUDIT_DIR 指向临时目录、
                  # WHITEBOARD_ROOMS='alpha:tok-a:rw,beta:tok-b:ro'，重启后重连核对恢复
```

```
生产路径验证：18/18 通过
  /healthz 200 且 storage=SqliteProvider
  alpha welcome room=alpha role=rw；beta welcome room=beta role=ro
  alpha 写入被接受（无 error 帧）；beta 收不到 alpha 的 op（跨房间不广播，真实进程）
  只读房间写入被拒：{"type":"error","code":"op_denied","message":"当前为只读角色，无法写入"}
  /api/rooms 列出 alpha,beta
  /metrics opsAccepted=1、opsDeniedReadonly=1
  /readyz 逐房间健康（alpha peers=1 elements=1，带 db 路径）heartbeatAgeMs=124
  磁盘生成房间 DB：alpha.db,alpha.db-shm,alpha.db-wal,beta.db,beta.db-shm,beta.db-wal
  审计 JSONL 落盘 5 行，每行合法 JSON 且带 room/type，含 1 条 op_denied
  **杀掉进程重启后**：alpha 元素从文件恢复 elements=1；beta 仍为 0（房间级隔离持久）
  /api/rooms/alpha/audit 可查且仅 alpha；未打开房间 → 404
```

前端静态契约（`apps/web/test/ui-contract.test.mjs` 6 例，替代无法自动化的 DOM 行为断言）：

```
main.mjs 引用的 20 个 DOM id 全部存在于 index.html（缺一个就会静默失效）
P3-1 房间/角色元素齐备且确实被 JS 接线（room-input/room-go/room-copy/room-label/role/limit）
浏览器侧 import 的共享模块都存在于 packages/shared/src（否则 build 拷不到 → 运行时 404）
被 import 的共享模块都不在 build.mjs 排除名单里（node-only 模块不得给前端用）
.room-label/.role/.role.rw/.role.ro/body.readonly/.limit 都有样式定义
只读态类名在 JS（body.readonly）与 CSS 两侧一致
```

## 5. 本轮修掉/发现的问题

| # | 问题 | 发现方式 | 处置 |
| --- | --- | --- | --- |
| ① | **全局广播**：原实现把 op/presence/leave 广播给所有连接 → 多房间下 A 房间的图会画到 B 房间 | 设计评审 + 端到端「不跨房间广播」用例 | 改为 `broadcastToRoom(roomId, …, except)`，端到端锁定 |
| ② | **单 IP 连接上限默认 10 与产品自身承诺冲突**：仓库自带 bench（20 客户端同 IP）直接失败，同一 NAT/公司出口的第 11 个正常用户会被拒 | 跑 `bench.mjs 20 20` 失败（并用环境变量复核归因） | 默认改为 50（与单房间/soak 一致），新增断言「单 IP 不得小于单房间上限」「默认配置 20 同 IP 全准入」 |
| ③ | **静态托管先发 200 再读流**：`workbench/scripts/serve.mjs` 在产物缺失时只能 `destroy()`，客户端看到「连接被意外关闭」；CI smoke 的 S2-A 因此报误导性的 `fetch failed` | 新建 worktree（未 vite build）跑 CI smoke 失败 → 单进程复现 | 先确认可读再写头，缺失时 404 + 「请先 vite build」指引；静态根提为 `DSH_WORKBENCH_ROOT` 可覆盖以便测试；新增 6 例回归 |
| ④ | 测试夹具竞态：`connect()` 仅等 `onopen`，welcome 未到就断言 → `welcome` 为 null | 治理端到端 3 例失败 | 夹具改为等 welcome（并在未拿到 welcome 就关闭时立即失败，避免干等到超时） |
| ⑤ | 限流首条告警被自身节流吞掉（`lastWarnAt` 初值 0，t=0 时被判为「刚告警过」） | `limits` 单测失败 | 初值改 `-Infinity`，区分「从未告警」与「恰在 t=0 告警过」 |
| ⑥ | 断言/夹具本身的问题（非产品缺陷）：活跃连接数在连接关闭后本就应为 0、明文 `..` 会被 URL 解析归一化、fetch 客户端会先归一化 `/../` | 各 1 例失败 | 分别改为「先开连接再验证仪表盘」「断言安全属性（不泄露根外内容）」「用原始 HTTP 请求测穿越防护」 |
| ⑦ | 生产路径脚本自身用了错误的 op 形状（`el.style` 而非 `el.stroke/strokeWidth`、缺 `c`/`v`）与错误的审计字段（`entries` 而非 `items`），导致 3 项误判为失败 | 生产路径验证 14/17 | 对照已通过用例修正脚本形状后 18/18。**过程中的产品侧疑点得到澄清**：服务端对畸形 op 不会静默丢弃，会回明确错误帧（实测 alpha 在形状正确时无 error 帧、beta 只读时回 `op_denied`） |

## 6. 已知边界（诚实登记）

1. **指标与审计是进程内的**：重启归零；审计 JSONL 按 8MiB 轮转保留 3 份，无压缩、无长期归档、无远程汇聚。
   生产路径验证实测确认了一个更具体的语义：**重启后 `/api/rooms/<id>/audit` 只返回本进程产生的事件**
   （实测重启后 alpha 只剩 `connect`/`room_open` 两条），历史事件只存在于 JSONL 文件里——
   接口**不读历史文件**。需要跨重启追溯时须直接查 `audit.jsonl*`（或用外部日志系统采集）。
2. **角色只有两档**：`rw`/`ro`；没有按元素/区域的细粒度权限，也没有操作级回放（审计只记结构性事实，不记画布内容）。
3. **单 IP 限制是粗粒度防滥用**：默认 50 且不信任 `X-Forwarded-For`；反代 + 大量同出口用户的部署需要在边界
   做真实客户端识别，否则同一出口共享该额度（ADR-0008 已登记）。
4. **空闲关闭依赖 tick 心跳**：tick 停摆时房间不会关闭（`/readyz` 会以 `heartbeatAgeMs` 暴露该情况）。
5. **多实例共享存储未实现**：单实例单进程语义（ADR-0008 给出被否理由与转 v2 触发条件）；
   `RoomRegistry`/`StorageProvider` 保留了可替换注入边界。
6. **前端为判定层测试**：房间/角色/错误文案的纯逻辑 12 例 + 静态契约 6 例（DOM id 与共享模块接线、
   CSS 类与只读态类名一致），但**没有**浏览器自动化（不引入 jsdom/Playwright）；
   只读态按钮禁用、房间切换、复制链接等 **DOM 行为未自动断言**，靠人工核对。
7. **真实浏览器多房间协同未做跨机器验证**：端到端用的是进程内 Node `WebSocket` 客户端
   （与浏览器同为 RFC6455，但不等价于浏览器行为验证）；真实文件型房间的生产路径验证同样是本机回环。
8. **本轮未重启生产服务**：白板生产实例（:8080）**当前未运行**（本轮验证时实测无监听），
   因此 P3-1 的治理端点在「生产实例」上尚未生效——但主 checkout 已构建好前端共享模块
   （`apps/web/public/shared/room.mjs` 已生成，此前缺失），下次启动即是新版；
   本机 :5173 生产实例未受影响（只在 worktree 里重建过 dist 供 CI smoke 使用，生产 dist 未改动）。

## 7. 环境陷阱（供后续参考）

- **新建 worktree 没有 `workbench/dist`**：CI 的 `build` 阶段会生成，但单独跑 `smoke` 阶段时
  chat-s2 的 S2-A 会失败（这正是缺陷 ③ 暴露的路径）。要单独验证 smoke，先跑一次 `--only build`，
  或在 worktree 里建 `workbench/node_modules` junction 后自行 `vite build`。
- `whiteboard/.gitignore` 忽略 `apps/server/data/`（房间 DB、审计 JSONL 都在其下）与
  `apps/web/public/shared/`（由 `scripts/build.mjs` 从 `packages/shared/src` 拷贝）。
  新增共享模块后**必须跑 `node scripts/build.mjs`**，否则浏览器端加载不到。
  实测教训：在主 checkout 合并后 `apps/web/public/shared/room.mjs` **确实不存在**（gitignore 产物不会随
  合并出现），补跑 build 才生成——若此时重启服务，前端会因缺模块而报错，而测试全绿也发现不了
  （测试读的是 `packages/shared/src`）。这条与 §5 缺陷 ③ 同源：**构建产物与源码的接线必须显式验证**。
- 白板的环境变量前缀是 `WB_*`（房间/限流/审计）与既有的 `PORT`/`HOST`/`DB_PATH`/`WHITEBOARD_TOKEN`/`TTL_MS`；
  与 workbench 的 `DSH_WEB_*`、team-hub 的 `TEAM_HUB_*` 三套前缀互不通用，写脚本时勿混。
- 端到端测试必须随机端口 + 内存房间（`startServer` 已封装），否则会在本机残留房间 DB 文件或撞端口。
- **gitignore 的构建产物不会随分支合并出现**：本切片在 worktree 里 build 过（产物齐全），
  但主 checkout 合并后仍需**再跑一次 `node scripts/build.mjs`**。worktree 里的产物属于 worktree 目录，
  不属于 commit。同类坑：`workbench/dist` 同理（主 checkout 的 dist 与 worktree 的 dist 互不相干）。
- 从 worktree 删除 `node_modules` 目录前先用 `cmd /c rmdir`（junction 用删除目录的方式清理），
  否则 `git worktree remove` 会因遍历 junction 而变慢或失败。
- 清理 main 上的工作树时注意：main 被主工作目录占用，**不能**另建 main 的 worktree
  （`fatal: 'main' is already used by worktree`）；合并 main 的正确做法是确认主工作区干净后
  直接在主工作区 `git merge`，而不是另开 worktree。

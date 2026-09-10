# v1 / v2 统一接口契约表（P2-1 范围对齐基线）

> 基线：`main` = `06705db`（P2-2 读面鉴权合入后）　时间：2026-09-09
> 本文档由三路只读盘点收敛而成（v1 `scrum/serve.mjs`+`taskctl.mjs`+`render.mjs`；
> v2 `team-hub/server.mjs`；board-plugin 本地/hub 双模式 + workbench 消费面），
> 全部条目带 `file:line` 引用。用途：P2-1「建立 v1/v2 统一接口契约表」的入库基线；
> 后续契约测试断言、P2-3 SSE 生命周期改造都以本文为锚，不在实现中另造口径。

## 0. 术语

- **v1**：`scrum/` 经典看板服务（数据源 `tasks.json`/`activity.jsonl`/`board.json`）。
  读开放；写经 taskctl 状态机；守护（plugins）直接写库 + activity。
- **v2**：`team-hub/server.mjs` 独立中枢（SQLite `team.db`）。所有写操作服务端审计，
  scope 一等字段，P2-2 读面鉴权门禁。
- **board-plugin**：DSH 宿主内自托管看板。本地模式复刻 v1 契约；hub 模式读写走 v2。
- **公共字段**：v1/v2 语义相同、命名相同、类型相同的字段子集（见 §2）。
  差异字段分「v1 独有」「v2 独有」，见 §2.3。

## 1. 状态与迁移（已一致，无差集）

| 项 | v1 | v2 |
|---|---|---|
| 状态枚举 | `backlog todo in_progress in_review blocked done canceled`（taskctl.mjs:33） | 同（server.mjs:97） |
| 迁移表 | taskctl.mjs:35-43 | server.mjs:98-106（逐字相同） |
| 优先级 | `high medium low`（taskctl.mjs:44） | 同（server.mjs:107） |
| 完成纪律 | done 仅 `in_review` 且 `by=general`（taskctl.mjs:527-533） | 同（server.mjs 校验） |

→ 契约断言：**同一状态机行为**（非法迁移文案结构、done 纪律、依赖阻塞 force 语义）两端一致。

## 2. 任务对象字段契约

### 2.1 公共字段（v1 tasks.json 任务 ∩ v2 rowToTask，命名/类型一致）

`id, title, description, acceptance[], priority, status, version, soldier,
claimedRound, claimedAt, ordersVersion, parent, role, scope, blocks[], blockedBy[],
comments[], evidence[], patches[], artifacts[], createdAt, updatedAt`

- v1 任务源：taskctl.mjs:270-297（create 全字段）；v2 视图：server.mjs:545-582（rowToTask）。
- `scope` 语义差异：v1 字段存在但无分区（/api/missions scopeAware:false，serve.mjs:409-411）；
  v2 scope 一等字段真分区。→ 契约：**字段名一致；分区语义 v1 登记为单分区（scope=default/software 恒量），不造伪多区**。

### 2.2 内嵌对象形状（已一致）

| 对象 | 形状 | 引用 |
|---|---|---|
| comment | `{by, at, text}` | v1 taskctl comment；v2 commentTask 同 |
| artifact entry | `{by, at, kind, path, title?}`（v2 可带 digest） | v1 taskctl.mjs:583；v2 artifacts 列 |
| patch entry | `{id, at, by, summary, files, diffFile?}` | v1 taskctl.mjs:727；v2 patches 兼容 string/结构化 |

### 2.3 独有字段（登记，不强行合并）

- **v1 独有**：`progress[]`（`{by,at,percent,note}`，taskctl.mjs:294；render.mjs 卡 progress 取末条）；
  `ttlMinutes/expiresAt/claimRequestId`（v1 原样输出；v2 有列但 rowToTask 不含）。
- **v2 独有**：`boundary{do[],dont[]}`、`hold`、`slice/sliceIdx/fixOf/fixCount`、
  `goalId`、`fileDomain`、`docSync`、`testReport`、`reviewNotes`（server.mjs:545-582）。
- 差异性质：v2 独有字段是 v1 之后功能演化的增量；v1 独有 progress 是 v1 遥测面。
  → 契约：**「公共字段一致 + 各自扩展字段不互相覆盖」；新增功能优先落 v2，v1 维持现状不新增分叉**。

## 3. 写接口契约（/api/create、/api/transition、/api/comment）

| 维度 | v1 | v2 | 一致性 |
|---|---|---|---|
| 成功响应壳 | `{ok:true, task}` | `{ok:true, task}` | ✅（注意 v2 非任务负载也塞 task 键，见 §5 登记） |
| create body | title 必填；description/acceptance(数组→`;`join CLI)/priority | title 必填；description/acceptance[]/priority/status/boundary/… | ✅ 公共子集语义一致 |
| transition body | id、to 必填；by、ifVersion、force | id、to 必填；by 壳强制；ifVersion、force | ✅ |
| comment body | id、by、text | id、text；by 壳强制（isEvidence 可选） | ✅ |
| 乐观锁 | `version` + `--if-version`→ifVersion（taskctl.mjs:189-209） | `version` + `body.ifVersion`（server.mjs:1865-1868 等） | ✅ 同机制 |
| by 纪律 | create 不要求 by；transition by 可选 | **一切写强制 by**（requireMember server.mjs:2044-2048） | ⚠️ 见 §5（v2 收紧，非冲突） |
| 自动验收/边界注入 | 无 | create 按 role 模板注入 acceptance+boundary（server.mjs:519-533） | v2 扩展，v1 保持 |

## 4. 错误分类契约

| 场景 | v1 | v2 | 裁决 |
|---|---|---|---|
| 缺参数/业务非法 | 400 `{error}` | 400 `{error}` | ✅ 一致 |
| 乐观锁冲突 | 409 `{error}`（文案含句号+`请先 taskctl get` 提示） | 409 `{error}`（文案无句号） | ✅ 状态码一致；文案 v2 为规范 |
| 未知任务 | 404（artifact/task 面） | 404 `未知任务 X` | ✅ |
| 未授权写 | 401（文案 `缺少或错误的令牌…`） | 401 `未授权：Bearer token 无效` | ✅ 状态码一致 |
| 未知路径 | 404 **text/plain** `not found` | 404 JSON `{error:'not found: …'}` | ⚠️ body 形态不一（见 §5） |
| 越权产物 | 403 | 403（artifact/content） | ✅ |
| body 结构 | 全部 `{error}`（写面） | 全部 `{error}`（无 code 字段） | ✅ **契约：错误响应恒 `{error}`** |

## 5. 登记差异（不强制合并且不可视作缺陷，写接口/读接口在各自消费面成立）

| # | 项 | v1 | v2 | 处置 |
|---|---|---|---|---|
| R1 | /api/board 语义 | board.json 渲染快照 `{generatedAt,goal,totals,columns[{id,label,cards[]}]}`（serve.mjs 读原始字节；render.mjs 生成） | **任务裸数组**（rowToTask 全行，listTasks server.mjs:584-594），前端 boardFromHubTasks 投影成 BoardData（hubBoard.ts:40-67） | **保留分叉（消费端已隔离）**：v1=文件渲染面给 kanban.html/console；v2=数据面给 workbench。契约 = 任务数组是 v2 数据面规范 |
| R2 | /api/activity 结构 | `{ts,kind,taskId,text}` 守护生命周期流（plugins/src/index.ts:467-471；kind 20+ 自由串） | audit `{seq,ts,member,scope,action,taskId,goalId,detail}` 服务端操作审计 | **语义不同型登记**：v1 activity=守护通知；v2 activity=写操作审计。公共契约 = `limit` 尾部语义一致 + `ts/taskId` 字段名一致 |
| R3 | /api/activity 参数 | `?limit=` 默认 50 无上限；无 scope/taskId/goalId/游标 | limit 默认 50 cap 500；scope/taskId/goalId；taskId 模式升序且**忽略 limit**；无 since | limit 尾部语义一致；**v1 无上限 → 对齐 cap（低风险，随 P2-1 改）** |
| R4 | /api/events vs /api/board/events+/api/activity/events | 双流：board/events 全量快照 + activity/events 增量 | 单流 /api/events（最近 30 audit 回放 + 实时） | **P2-3 主战场**：信封、Last-Event-ID、回放游标（§6） |
| R5 | /api/config | `{auth,host,port,pipeline,daemon,paused}` | `{auth,db,port}` | 消费面不同（v1 页面探测 vs v2 能力探测），登记 |
| R6 | /api/artifact | 一体 GET `?task&i&raw`（元信息/内容/url 302） | 两段：POST /api/artifact（登记）+ GET /api/artifact/content（预览） | 语义分层差异登记；board-plugin 本地模式与 v2 content 共用同一组产物语义断言（K4-B/K5-A） |
| R7 | 未知路径 404 形态 | text/plain | JSON `{error}` | 统一为 JSON 低风险，随 P2-1 收口（不改 401/200 语义） |
| R8 | 写响应壳 task 键 | task=任务对象 | 任务写返回任务；非任务负载也包 task 键 | v1 无对应端点，登记不冲突 |
| R9 | board-plugin hub 模式 SSE | 本地模式 SSE 播本地 board.json/activity.jsonl | hub 模式读写走 hub，**SSE 仍播本地文件（无 hub 事件桥接）** | **实锤缺口**：hub 模式 SSE 与数据面不同源（见 §7，登记 P2-3 修复项） |
| R10 | scope 写默认 | v1 无分区 | 写 body.scope 缺省 default；读 query 缺省=全部 | 两侧缺省语义不同，登记（避免误用） |

## 6. SSE 生命周期统一契约（P2-3）

### 6.1 已同构行为（契约断言锁定）

- 握手头：`text/event-stream; charset=utf-8` + `cache-control:no-cache` + `keep-alive`
  （v1 serve.mjs:533-539 / v2 server.mjs:3267 / board-plugin 同）。
- 首帧 `retry: 2000`（v1:539,575 / v2:3268）。
- heartbeat：15s `:hb\n\n` 注释帧（v1:544,583 / v2:3274）。
- 断线清理：`req.on('close')` → clearInterval + 从客户端 Set 删除（v1:545-548,584-587 / v2:3275）。
- 客户端集合：模块级 `Set`。
- 初始回放：v1 activity/events 最近 30 行（serve.mjs:578-582）；v2 /api/events 最近 30 audit
  （server.mjs:3270-3273，DESC LIMIT 30 后 reverse 成升序）；v1 board/events 全量 board。

### 6.2 待统一缺口（P2-3 改造点）

| # | 缺口 | 现状 | 目标 |
|---|---|---|---|
| S1 | 无 `event:`/`id:` 行 | 全部 data-only 默认 message | 统一**信封**：事件对象补 `{id, event, scope, seq, ts, payload}` 兼容字段（data JSON 平铺 + 命名），并输出 SSE `id:` 行 = seq |
| S2 | 无 Last-Event-ID | 服务端不读；断线靠回放+轮询 | v2 /api/events 读 `Last-Event-ID`：seq>N 增量回放（配合 S1 id: 行，EventSource 原生续传） |
| S3 | v1 无 seq | activity 行 `{ts,kind,taskId,text}` 无序号；board 全量帧 | 不引入文件行号体系（改动面大且 file-append 模型无全局 seq 源）→ **v1 登记维持**：v1 靠「连接回放+指纹去重」；前端已有 seenEvents 指纹去重（App.tsx:75-79） |
| S4 | heartbeat/清理 | 三端已同构 | 契约测试锁定；不引入 env 参数（保持现状即可，可测） |
| S5 | 乱序/重连测试 | 无 | 新增 HTTP 级 SSE 测试：初始回放升序、增量 seq 单调、断线重连（Last-Event-ID 续传）、重复帧去重语义 |
| S6 | 前端去重无单测 | NotifyView dedupeDesc / ChatView mergeById 组件内私有 | 抽纯函数导出 + node:test 断言（hub-board.test.mjs 已示范直接 import .ts） |

### 6.3 事件字段统一映射（v2 /api/events data 帧）

契约帧 = 现有平铺字段 + 兼容补全（**保持现有字段不动，避免破坏 NotifyView/TaskCenter/ChatView 按 seq/action/scope 消费**）：

```jsonc
{
  "seq": 42,            // 既有：单调递增审计序号（SSE id: 行同值）
  "ts": "ISO-8601",     // 既有
  "scope": "software",  // 既有
  "event": "transition",// 补：= action（语义统一名）
  "action": "transition",// 既有（保留）
  "taskId": "T-009",    // 既有
  "member": "coder",    // 既有（by）
  "goalId": null,       // 既有
  "id": 42,             // 补：= seq（兼容目标信封字段名 id）
  "payload": { },       // 补：= detail（兼容目标信封字段名 payload）
  "detail": { }         // 既有（保留）
}
```

### 6.4 F-01 第二阶段：scope 与显式游标

v2 `/api/events` 额外支持以下查询参数：

- `scope=<非空字符串>`：同时约束历史回放和实时广播；省略时保持全局订阅。
- `sinceSeq=<非负安全整数>`：页面刷新后显式从 `seq > sinceSeq` 回放。

游标优先级为 `Last-Event-ID`（合法时）> `sinceSeq` > 最近 30 条默认回放。显式提供但非法的
`sinceSeq` 返回 400；非法 `Last-Event-ID` 保持兼容行为并回退到其它游标或最近 30 条。scope 过滤后
序号允许跳号，因为 `seq` 是跨空间的全局序号。

Workbench 以 `hub + scope` 为键持久化最近消费的 seq，并在重建 EventSource 时传入 `sinceSeq`；
收到事件后仍按统一信封校验、scope 校验和单调去重。详见
`docs/superpowers/specs/2026-09-10-f01-reliable-events-design.md`。

- v1 侧不改造帧（S3 登记）；board-plugin hub 模式 SSE 桥接见 R9。

## 7. board-plugin hub 模式 SSE 实锤缺口（R9 展开）

- 现状：hub 模式写/读经 hub（src/index.ts:202-218），SSE 端点（src/index.ts:563-577、
  595-613）仍从本地 board.json/activity.jsonl 广播 → 数据面与事件面不同源。
- 修复方向（P2-3 范围内低风险做法）：hub 模式把 `/api/board/events`、`/api/activity/events`
  的行为切为「转发 hub /api/events 子集」（board 帧 = 触发后 hub GET /api/board 快照，
  activity 帧 = audit 行 → v1 形状映射），本地模式维持现状。
- 边界：本项涉及 board-plugin 宿主内注册路径 + hub 依赖，若评估改动面超出契约对齐范畴，
  登记移交 P1-3/P1-1（宿主真实注入冒烟/合并）一并验证，不在 P2-1 内造假验证。

## 8. 收口动作清单（本批次 P2-1+P2-3）

1. ✅ 本文档（契约表/字段表）入库 —— 范围对齐基线。
2. 共享 fixture + HTTP 对比测试：同一业务场景（create → claim/transition → comment →
   artifact 登记/读取）分别打 v1（serve.mjs env fixture）与 v2（tmp db），断言：写响应壳
   `{ok,task}`、任务公共字段子集、状态机行为、错误分类（400/404/409/401）一致；
   activity limit 尾部语义一致。文件放 `scrum/v1v2-contract.test.mjs` 或同语义位置，进 run-ci。
3. v1 低风险对齐：/api/activity limit 加 cap（对齐 v2 500）；未知路径 404 统一 JSON `{error}`
   （R7）—— 需先核对既有断言（board-plugin/artifact-detail 是否断言 text/plain）。
4. v2 /api/events：补 `event/id/payload` 兼容字段 + SSE `id:` 行 + `Last-Event-ID` 增量回放
   （S1/S2）—— 保持既有平铺字段，向后兼容。
5. 前端去重抽纯函数（S6）：NotifyView dedupeDesc、ChatView mergeById 导出 + node:test。
6. SSE 契约测试（S5）：v2 /api/events 初始升序、增量 seq 单调、Last-Event-ID 断线续传、
   心跳与 close 清理；board-plugin/event 语义复用既有 SSE 套件位置扩展。
7. run-ci 门禁接入 + 全量回归；evidence 文档 + REMAINING-TASKS P2-1/P2-3 更新。

## 9. 诚实边界

- v1/v2 数据底座不同（文件 vs SQLite）是架构事实；P2-1 统一的是**契约面**（字段/错误/SSE 行为），
  不是合并两套实现（P1-1 另立）。
- v1 activity 事件无全局 seq 的登记（S3）意味着 P2-3 的 Last-Event-ID 完整闭环只在 v2/board-plugin
  hub 模式成立；v1 维持「回放+指纹去重」并在契约测试中锁定该行为，避免测试冒充 v1 有续传能力。
- board-plugin hub 模式 SSE 桥接（R9）如超出本批次安全改动范围，登记移交并如实说明。

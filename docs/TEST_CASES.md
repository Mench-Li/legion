# T-098 测试用例 / 验收测试：第三批（四能力：跨空间技能共享 · 分层项目规范 · 移除空间 · 对话 AI 回复）

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-098（分支 w/T-098 独立 worktree）
> 上游：T-095 需求澄清（docs/REQUIREMENTS.md **T-095 四项能力版**，唯一权威需求基线——注意：工作树内 docs/REQUIREMENTS.md 现文已被 T-103「任务详情文档预览」链改写，本批不引用；原文经 `git show 3c8f27d:docs/REQUIREMENTS.md` 复核）→ T-096 方案搜索（docs/RESEARCH.md = T-096 四能力报告，K1-A..K10-A + 闸门 G-R1..G-R5）→ T-097 任务拆解（docs/TASK_BREAKDOWN.md：**「## slices」12 个切片 S1~S12**，本用例唯一拆解基准；每片机器验收行含命令/期望/DoD，均已映射 T-095 AC-R1-1..9 / R2-1..7 / R3-1..6 / R4-1..8）
> 下游：守护按 TASK_BREAKDOWN 注册 coder_Si → tester_Si 微链；coder 按本文档「自动化落点 / 附录 B」把 P0 用例落成契约测试与守卫断言；tester 按 §2 分层逐条执行并把结果写入 docs/TEST_REPORT.md（S12）
> 依据：TASK_BREAKDOWN §1 机器验收行（每片 DoD/验收标准逐条）、T-095 REQUIREMENTS §5 AC-* 口径、T-096 RESEARCH 闸门与设计要点、LEGION.md 纪律与 T-098 阶段验收（覆盖 主路径+边界+异常；每条含 前置/步骤/期望与通过判据；关键业务规则正反向成对）。
>
> **取代声明**：本文档取代 docs/TEST_CASES.md（T-076 第二批版 = 三中心收尾批；该批切片已交付合入 main，其执行记录见 docs/TEST_REPORT.md 与各 T0xx-evidence/）。旧版经 git 历史回溯（`git log --follow docs/TEST_CASES.md`）。历史测试文件头注释中的「TC-S1-01..18」等编号指更早批次（T-039 第一批三中心），属历史快照，不再与本文档对齐——本批追溯列一律以「S1~S12 机器验收行 / AC-Rx-y」为准。

## 0. 结论速览

- 交付单件：本文档（+ 证据目录 docs/T098-evidence/，含机器复核 01-doc-machcheck.txt）。共 **109 条用例**（S1 13 / S2 9 / S3 7 / S4 8 / S5 9 / S6 8 / S7 10 / S8 9 / S9 13 / S10 9 / S11 8 / S12 6；🟢正常 58 / 🟡边界 22 / 🔴异常 29；P0=94 / P1=12 / P2=3——已由附录 C 机器复核 PASS），每条含 前置条件 / 操作步骤 / 期望结果与通过判据；计数/ID 唯一性/表结构/追溯引用完整性已经一次性 Node 脚本复核（docs/T098-evidence/01-doc-machcheck.txt），无重复 ID、无引用缺失。
- 验收标准用例化：TASK_BREAKDOWN §1 机器验收行（S1~S12）每条 + T-095 AC-R1-1..9 / AC-R2-1..7 / AC-R3-1..6 / AC-R4-1..8 逐条映射到用例（§6 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果 / 通过判据」列，无黑盒结论。
- 关键业务规则正反向成对（§5）：跨空间可见性（A→B 可见 / C 不可见 / 撤销即消失 / 级联消失）、general 门禁（成功 vs 4xx）、草稿安全（published only / pending 绝不外泄）、规范分层合并（两段存在与顺序 / 无文件降级不报错）、预算截断（超限截断+提示 / 边界内不截断）、删除确认（confirm 正确成功 / 错配 4xx 零删除 + 受保护 + 幽灵分区收口）、AI 回复开关（开产生 awaiting / 关无回复）、失败兜底（失败可见可重试 / 不阻塞人-人收发）、防重复（CAS 幂等 / 无死循环）、渲染安全（正反向）——均给正向 + 反向用例。
- 测试代码落点：S1→team-hub/skills.test.mjs（追加 describe，P0 各一 it()）、S4→team-hub/rules.test.mjs（新增，HTTP 范式仿 calendar.test.mjs）、S7→team-hub/spaces.test.mjs（新增，同范式）、S9→team-hub/chat.test.mjs（追加）+ chat-l1-smoke.mjs（扩展断言）、S3/S5/S10→plugins/src/index.ts 抽出纯函数后 node --test（插件 tests/ 面）、S2/S6/S8/S11→L2 浏览器清单 + 评审（grep/build 断言）。骨架与代码片段见附录 B。**本阶段不新增/不预写切片域内可执行测试文件**（同前两批惯例：S1~S12 目标代码未实现，预写必全红；测试文件所有权已由 TASK_BREAKDOWN §1 第 2 段划给各 coder 文件域），仅交付用例 + 可照抄骨架。
- 现存基线（本阶段实测跑绿，见 docs/T098-evidence/01-baselines.txt）：skills.test.mjs 12/12、chat.test.mjs 13/13（node v24.19.0 直跑等效，exit 0）。
- 环境事实（写进各用例执行说明）：本 worktree **无 node_modules/dist**（不随 git 分发）；plugins typecheck（tsc -p plugins/tsconfig.json --noEmit）与 workbench build（pnpm --dir workbench build）需宿主/CI 或 junction，按「环境受限 + 复现步骤」记录不冒充通过（仓库 R-18 惯例）；`node --test <file>` 在沙箱因子进程 spawn EPERM（errno -4048）不可用，契约测试以 `node <file>` 直跑等效（本批 skills/chat 实测 exit 0）。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入与假设

| 输入 | 说明 |
| --- | --- |
| REQUIREMENTS（T-095 版，git show 3c8f27d:docs/REQUIREMENTS.md）§5 | R-1（P0 跨空间技能 AC-R1-1..9）/ R-2（P0 分层规范 AC-R2-1..7）/ R-3（P1 移除空间 AC-R3-1..6）/ R-4（P0 对话 AI 回复 AC-R4-1..8）—— 验收口径逐条可测试 |
| TASK_BREAKDOWN.md（T-097）§1 | S1~S12 机器验收行（每行含命令、期望、DoD）—— 本用例逐条翻译对象 |
| RESEARCH.md（T-096） | K1-A..K10-A 一等选型 + 闸门 G-R1..G-R5 + §16 职责总纲矩阵 —— 端点/语义默认依据 |
| 代码基线 | w/T-098 HEAD == promote T-097（代码与 T-095 基线 41fd406 逐字节一致，T-096/T-097 仅改 docs）；skills/chat/spaces/calendar 路由与 DAO 证据行号见 §9 附录 A |
| 假设 H-1 | revoke 端点形状：`POST /api/skills/revoke { id, targets:[...], by }`（与 grant 输入同构）；若实现走 grant 同端点 + revoke 标志，仅改本组用例请求形状，断言语义不变（AC-R1-2/3） |
| 假设 H-2 | rules 端点：`GET /api/rules?scope=global` → {content, updatedAt}；`POST /api/rules { scope:'global', content, by }` 写走 handleWrite（audit action=rules:update + SSE 广播）；内容上限常量默认 **MAX_RULES_LEN=3000**（⚖️ 可配 env），超限 → 400 零落库（对齐 MAX_CHAT_BODY 三值法先例；S5 注入预算在读取侧另行截断） |
| 假设 H-3 | chat 回复开关端点：`GET /api/chat/reply-settings?scope=` / `POST /api/chat/reply-settings { scope, enabled?, model?, identity?, systemHint?, by }`（若实现命名 /api/chat/settings 等仅改形状）；回复队列 `GET /api/chat/replies?scope=&sinceMsgId=`（语义见 S9 机器行） |
| 假设 H-4 | 删除预检端点：`GET /api/spaces/impact?id=`（只读计数：任务/编队/成员/会话与消息/日程/技能 + 在办执行状态），S7 实现契约；若端点名不同，仅改本组用例 URL，断言语义不变 |
| 假设 H-5 | include=pending 收口口径：非「general 复审者」的任何列表查询（含全部空间视图）不得返回 pending/rejected 技能行（prompt 不泄）；general 复审视角保留（实现以 member=general 或等价身份参数区分，断言以语义为准，AC-R1-7） |
| 假设 H-6 | 「全部空间视图」= 列表查询 scope/member 缺省（现状 server.mjs listSkills scope/member undefined 聚合语义）；跨空间共享技能在该视图中不泄漏草稿（来源标识属 UI 层，S2） |
| 假设 H-7 | 回复时间窗默认 ≤120s（AC-R4-1），awaiting 超龄兜底默认 120s（S9 机器行，⚖️ 可配 env 如 CHAT_REPLY_TIMEOUT_MS）；SSE 送达 ≤5s 沿用 chat-l1-smoke 既有断言 |
| 假设 H-8 | S5 注入预算默认：全局层 ≤3000 / 空间层 ≤4000 / 合计 ≤7000（⚖️ 可配 env/config）；截断在段落边界 + 追加「规范超限截断：原文 N 字，已保留前 M 字」；不得产生半截代码块 |
| 假设 H-9 | S10 responder 默认独立 interval 或并入 sweep，节拍 10-30s（S10 机器行）；回复模型 = chat_reply_settings.model 或该空间默认（agent_models，D-14 空间级默认）；零新凭据面（复用 DSH 既有模型通道，K10-A） |

### 1.2 决策闸门默认值（G-R1..G-R5 + D 系列，本用例判定依据；将军未否决即按默认展开）

| 闸门/决策 | 默认（本用例按此展开） | 对立主张 | 翻转影响 |
| --- | --- | --- | --- |
| G-R1 = D-7 全局层载体 | K3-A：team-hub 新表 rules + GET/POST /api/rules（全局层独立于单一仓库根） | K3-B 守护配置指向全局文件 | S4/S5 一组用例从 HTTP/DB 断言改为读文件断言 |
| G-R2 = D-10 删除级联 | 硬删 + 级联并入 conversations/messages/calendar_events/members（消孤儿/幽灵分区）；audit 保留 | 软删 tombstone / 保留聊天记录 | S7-01/02 期望变化 |
| G-R3 = D-13 回复开关 | 每消息自动回复 + 每空间开关默认开 | 默认关 + 显式按钮 | S9-03/04、S10-05 期望翻转（默认关） |
| G-R4-1 = D-12 回复方 | K8-A：守护 chat-responder 派生轻量子代理 LLM 直答（无工具），异步落第二条消息 | team-hub 内嵌 LLM 队列 | S10 整组从插件冒烟改为 hub 直连冒烟 |
| G-R4-2 = D-15/D-16 身份 | 回复身份默认 `<scope>-assistant`；空间粒度注入（D-16 不扩细粒度） | 身份=general / 按角色注入 | S9-05、S11-01 期望变化 |
| D-1..D-6 | 引用式共享 / review-grant-revoke general 门禁 / 无隐式全局技能 / B 只读含 prompt 草稿不泄 / 轮询指纹刷新 / 级联消失 | 复制分叉 / 无门禁 / scope=* | S1/S3 相应行期望变化 |
| D-8/D-9 | 两层（全局 + 空间/项目），空间层 > 全局层；与既有载体并存 + 职责总纲 | 单层/迁移废弃 | S5/S6 期望变化 |
| D-11 | 在办空间允许删除但 UI 强提示；磁盘 worktree 残留不在本批回收 | 在办拒绝删 | S7-08/S8-02 期望变化 |
| D-17 | exec/人工托管消费面不扩大（与现状一致） | — | S3/S10 注入面不变（默认） |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I-1 | 零新增运行时依赖（node:sqlite/node:http/Node fetch/EventSource/React/DSH 子代理通道均已在产线） | TC-S1-12 / S4-08 / S7-10 / S9-10 / S10-08 / S12-06 |
| I-2 | 写统一走 handleWrite / DAO 审计（by 必填 + audit + SSE）；author=by 服务端绑定防冒名 | TC-S1-05/06 / S4-04 / S7-03..06 / S9-05/08 |
| I-3 | 数据按 scope 分区；跨空间只经 grants 显式引用（无隐式 scope=*）；删除后无孤儿/幽灵分区 | TC-S1-01/09 / S7-01/02 |
| I-4 | 老库零迁移：新增一律 CREATE TABLE IF NOT EXISTS / meta JSON 扩展（不加列） | TC-S4-01 / S9-12 |
| I-5 | 渲染安全红线：服务端/远端文本一律纯文本渲染，无新增 dangerouslySetInnerHTML 直插 | TC-S2-07 / S6-06 / S8-08 / S11-04 |
| I-6 | 审计历史保留（含被删空间的 space:delete 行；删除不可恢复数据但可追溯） | TC-S7-10 |
| I-7 | team-hub 零出站模型调用（回复执行在守护侧，K8-A 纪律） | TC-S10-07（评审断言） |
| I-8 | 注入/消费仅经守护 buildWorkerPrompt 通道（worker 隔离 worktree 不读仓库文件） | TC-S5-07 / S10-01（宿主冒烟档） |
| I-9 | 守护注入缓存按 (id, version, contentHash) 指纹刷新（替代长度比较），失败不清空缓存 | TC-S3-01..05 |
| I-10 | 受保护空间 software/default 不可删（服务端 400 + 前端无入口/禁用） | TC-S7-05 / S8-01 |
| I-11 | chat 回复开关每空间独立持久化；关闭后不产生任何回复/出站调用 | TC-S9-02/04 / S10-05 |
| I-12 | 回复状态机 CAS：仅 awaiting→replied/failed 可成功，任何重复处理幂等；不自我触发死循环 | TC-S9-11 / S10-03/04 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 与前两批同构；命令以 `node <file>` 直跑等效为准（node:test 进程内执行、不 spawn 子进程 → 沙箱可跑）。**node_modules 不在本 worktree**：plugins typecheck / workbench build 按 R-18 记录「环境受限 + 复现步骤」（宿主 junction 后执行），不冒充通过。

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 契约测试直跑：`node team-hub/skills.test.mjs`（S1 增）/ `node team-hub/rules.test.mjs`（S4 新增）/ `node team-hub/spaces.test.mjs`（S7 新增）/ `node team-hub/chat.test.mjs`（S9 增）/ `node team-hub/calendar.test.mjs`（回归） | 各切片 DAO/HTTP 纯逻辑 + 路由契约（进程内 HTTP，仿 calendar.test.mjs：临时 TEAM_HUB_DB + `mod.server.listen(0)` 真随机端口） | coder 随实现交付自跑；tester 验收复跑 | 沙箱直跑已验证（skills 12、chat 13 全绿）；node v24.19.0 |
| L1 | 真进程 HTTP 冒烟：`node team-hub/chat-l1-smoke.mjs`（S9 扩展断言）+ 临时库/随机端口 curl/fetch（rules/spaces/skills 增补段） | 路由/鉴权/审计/SSE/超龄兜底/删除事务端到端 | tester（各后端切片后） | env：TEAM_HUB_DB/TEAM_HUB_PORT/TEAM_HUB_TOKEN |
| L2 | 浏览器手工验收（:5173 构建产物） | S2/S6/S8/S11 交互主路径与错误态 + R-4 三态；S12 回归 | tester + 将军验收（§7 清单） | 改前端后须 pnpm build 再验（宿主/CI）；旧标签 Ctrl+F5 |
| L3 | 集成回归 + 宿主冒烟：全量 L0+L1+build+端到端清单（§4.12） | S12 / 宿主可达面（S10 responder、注入冒烟） | tester / devops | 宿主不可达部分如实标注「环境受限 + 复现步骤」，不冒充通过 |

### 2.1 关键命令与 env（tester/coder 照抄）

| 用途 | 命令 / env | 说明 |
| --- | --- | --- |
| 技能契约 | `node team-hub/skills.test.mjs` | TEAM_HUB_DB=临时库 → import server.mjs（isMain 守卫不占端口）；DAO 级 |
| 规范契约（S4） | `node team-hub/rules.test.mjs` | 新增套件；HTTP 范式仿 calendar.test.mjs（临时库 + `mod.server.listen(0)` + fetch） |
| 空间删除契约（S7） | `node team-hub/spaces.test.mjs` | 新增套件；同 HTTP 范式；造数夹具见 §8.4 |
| chat 契约/冒烟 | `node team-hub/chat.test.mjs`（DAO 级）、`node team-hub/chat-l1-smoke.mjs`（真进程 + SSE） | S9 扩展；l1-smoke 现 22 项断言 + S9 新增断言 |
| 存量回归 | `node team-hub/calendar.test.mjs`、`node tests/contract/contracts.test.mjs`、whiteboard 套件 | 合并基线不回归 |
| 插件纯函数 | 宿主/CI：`node --test plugins/tests/*.test.mjs`；沙箱受限时记录 | S3/S5/S10 指纹/解析/状态机纯函数抽到可导入文件后测试 |
| 插件类型 | `tsc -p plugins/tsconfig.json --noEmit`（node_modules 就位后） | S3/S5/S10 DoD；缺失按 R-18 记录 |
| 前端构建 | `cd workbench && pnpm build`（或 `pnpm --dir workbench build`） | tsc 0 诊断为沙箱内最严证据；esbuild spawn EPERM 史 → 宿主/CI 补跑 |
| 真服务冒烟 | hub：`TEAM_HUB_DB=<tmp> TEAM_HUB_PORT=<p> node team-hub/server.mjs` | L1 用；随机端口 + /api/config 回读确认（chat-l1-smoke 先例） |
| 回复超龄注入 | CHAT_REPLY_TIMEOUT_MS（⚖️ 默认 120000） | S9-07 三值法：注入小值使用例秒级可测 |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> ⚖️ 为实现期可配值：实现必须导出常量或读 env，测试用「三值法」（值-1 / 值 / 值+1）断言；定值后无需改用例。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| 跨空间可见性（R-1） | grants 引用式 | A 授权 B 后 listSkills scope=B（含省略 member 形态）返回 S；未授权 C 不返回；revoke 后立即为空（TC-S1-01/02/03） |
| revoke 幂等 | 过滤式写回 | 重复 revoke / 撤销未授权目标 → 200 ok 不抛错、技能状态不变（TC-S1-04） |
| general 门禁（R-1） | 路由层校验 | by≠general 调 grant/review/revoke → 4xx + 文案含「general」；general 成功；register 不门禁（TC-S1-05） |
| 审计形状（R-1） | action=skill:grant/revoke + detail | audit.detail 含技能归属 scope 与目标空间；action 前缀 skill:（TC-S1-06） |
| 草稿安全（R-1） | published only + pending 收口 | 任何非复审查询不返回 pending/rejected 行及其 prompt；include=pending 仅 general（TC-S1-07/08、S2-02） |
| 级联消失（R-1） | 源空间删 → skills 级联 | B 查询不再含 A 技能、无悬空（TC-S1-09） |
| 指纹刷新（S3） | (id,version,contentHash) 序列 | 同量改版刷新；同指纹不刷新；撤销移除刷新（TC-S3-01..03） |
| rules 内容上限（R-2/S4） | MAX_RULES_LEN=3000 ⚖️ | 3000 → 200；3001 → 400 零落库（TC-S4-04/05） |
| 规范注入预算（R-2/S5） | 全局 3000 / 空间 4000 / 合计 7000 ⚖️ | 层内超限 → 段边界截断 + 提示语；代码块不半截；合计超限同样截断（TC-S5-05/06） |
| 分层顺序/优先级（R-2） | [全局层段] + [空间层段]（空间层后置 + 优先声明） | 两段存在、顺序固定、空间层带「优先于全局层」声明（TC-S5-01/07） |
| 删除确认（R-3） | confirm=delete-space:<id> | confirm 正确 + general → 200；缺/错/受保护/未知/非 general → 4xx 零删除（TC-S7-03..06） |
| 级联范围（R-3） | 11 张数据表 + spaces 行 | removed 逐表计数一致；conversations/messages/calendar_events/members 无残留；/api/scopes 无幽灵（TC-S7-01/02） |
| 影响预检（R-3） | GET /api/spaces/impact | 返回任务/编队/成员/会话与消息/日程/技能计数与在办状态；只读不删（TC-S7-07） |
| AI 回复窗（R-4） | ≤120s（CHAT_REPLY_TIMEOUT_MS） | 开关开发送后 ≤120s 会话内出现 author=<scope>-assistant 回复或明确失败；SSE 送达 ≤5s（TC-S9-03/08、S10-01） |
| awaiting 超龄 | 120s 默认 | 超龄消息被服务端标 failed + meta.error；从队列消失（TC-S9-07） |
| 开关持久化（R-4） | per-scope、默认开 | 关 → 无 awaiting 无回复；重开恢复；重启/重连后保持（TC-S9-02/04、S10-05） |
| 消息长度 | MAX_CHAT_BODY=8000 | 8000 → 200；8001 → 400（chat.test 既有断言不回归，S9-10） |
| UI 三态/身份（R-4） | general=我，其余对方 + 🤖 + aiModel | awaiting 等待态 / replied 正文 / failed 明确失败 + 重试；旧消息无 meta 兼容（TC-S11-01/02/03/07） |

## 4. 用例目录

> 图例：类别 🟢正常 / 🟡边界 / 🔴异常；优先级 P0（切片验收门槛，P0 用例 coder 必须落成断言）/ P1 / P2；「自动化」= 测试文件（coder 落盘）/ L1 curl / L2 浏览器 / 评审（grep + 代码审查断言）。
> 追溯列引用：T-095 验收口径（AC-R1-x / AC-R2-x / AC-R3-x / AC-R4-x）、TASK_BREAKDOWN §1 机器验收行（Sx 验收 1/2/… = 该片 DoD 分句）、闸门（G-Rx）、决策（D-x）、不变量（I-x）、假设（H-x）。
> 复现索引（§4.0）给「现状缺口 → 代码证据 → 本批切片 → 用例」映射，供 coder 先复现后实现、tester 回归时对照。

### 4.0 现状缺口 → 切片 → 用例索引

| 缺口（现状证据，T-095 §2 / 本阶段实测） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 listSkills 授权分支需传 member 才触发，UI 从不传 → B 空间跨空间不可见（server.mjs:515；api.ts:393-398） | S1/S2 | TC-S1-01/02、TC-S2-01 |
| G2 无 revoke API（grantSkill 只并集追加 :520-527） | S1/S2 | TC-S1-03/04、TC-S2-04 |
| G3 技能路由无 general 门禁（:1748-1786，对照删空间 :1875） | S1 | TC-S1-05 |
| G4 跨空间授权审计 detail 不带目标空间（grant/review 路由 :1763/:1782 audit 未携带目标空间，归属错位） | S1 | TC-S1-06 |
| G5 GET /api/skills 列表 include=pending 全量无鉴权（:1976-1980 敞口） | S1/S2 | TC-S1-07/08、TC-S2-02 |
| G6 守护缓存按长度比较，同量改版不刷新（plugins:442-445） | S3 | TC-S3-01..05 |
| G7 规范单仓库根单文件单层（readRepoRules :849-862 取首存在 + slice 4000） | S5 | TC-S5-01..06 |
| G8 无全局规范层载体（rules 表/API 不存在） | S4 | TC-S4-01..08 |
| G9 无规范维护 UI / 职责总纲 | S6 | TC-S6-01..08 |
| G10 删除级联仅 7 表（:1880-1888），conversations/messages/calendar_events/members 残留；/api/scopes 幽灵（members 无 DELETE，:1564-1566） | S7 | TC-S7-01/02 |
| G11 前端零删除入口（api.ts 无 deleteSpace / SpaceSettingsModal 无危险区） | S8 | TC-S8-01..07 |
| G12 chat 发送即终态、无回复数据面（postMessage :603-625 无 meta 状态语义） | S9 | TC-S9-01..13 |
| G13 全仓无回复执行方（plugins 0 处 chat；零出站） | S10 | TC-S10-01..09 |
| G14 ChatView author==='general' 恒为「我」（ChatView:24-26/:358-359）→ AI 身份需泛化 + 三态 | S11 | TC-S11-01..08 |

### 4.1 S1 R-1 后端：跨空间技能共享语义（listSkills scope:B 可见 + revokeSkill + general 门禁 + include=pending 收口 + 审计带目标空间）【P0 · team-hub/server.mjs 链起点】
自动化：team-hub/skills.test.mjs（DAO 级 + 进程内 HTTP，仿既有 5 组 12 例风格追加 describe）｜L1

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | 空间 A、B、C 三空间存在（spaces 行或纯 scope 语义均可）；技能 S = register(scope:A, published)（register→review publish 前置走通） | ① by=general 调 grant(S, ['scope:B']) ② GET /api/skills?scope=B ③ GET /api/skills?scope=C ④ GET /api/skills?scope=B&member=role1（守护形态） | ②返回含 S 且 prompt 全文完整（服务端判定：scope=B 自动含 grants 含 scope:B 的已发布技能，UI 无需传 member）；③不含 S；④同②（member 单值与省略两形态等价）——AC-R1-1 | skills.test.mjs（HTTP 断言组） | AC-R1-1；S1 验收 2；I-3 |
| TC-S1-02 | 🟢 P0 | 同 TC-S1-01（A 已授权 B） | DAO 直调：listSkills({scope:'B'}) 与 listSkills({scope:'B', member:'x'}) | 两形态均含 S；listSkills({scope:'C'}) 不含 S；只含 published（S 若含另一条 pending 同 scope=A 也不返回） | skills.test.mjs（DAO 断言） | AC-R1-1；S1 验收 2 |
| TC-S1-03 | 🔴 P0 | 同 TC-S1-01（A 已授权 B，B 可查） | ① by=general 调 revoke(S, ['scope:B']) ② 立即 GET /api/skills?scope=B ③ GET /api/skills?scope=B&member=role1 | ②③均为空（撤销后 B 视角**立即**不可见）；skills 行 grants 不再含 'scope:B'；技能本身仍 published 且 A 本空间仍可见 | skills.test.mjs | AC-R1-2；S1 验收 2 |
| TC-S1-04 | 🟡 P0 | 技能 S 无 'scope:B' 授权（或刚被撤销） | 重复 revoke(S,['scope:B'])、撤销未授权目标 revoke(S,['scope:D'])、重复 grant(S,['scope:B']) | 全部 200 ok 或幂等结果（不抛未定义错误/不 500）；重复 grant 为并集无重复项；技能状态/版本不变 | skills.test.mjs | AC-R1-2；S1 验收 2 |
| TC-S1-05 | 🔴 P0 | S published（scope=A）；by=coder（非 general）与 by=general 两调用方 | 非 general 依次调 POST review{action:publish} / grant / revoke；general 调同三动作 | 非 general：每动作 4xx（400/403）且错误文案明确（含「general」语义）；零审计新行；general：均成功（review 前提 pending；grant/revoke 对 published）——register 维持现状（任意 by 可提交 pending，不门禁） | skills.test.mjs（门禁矩阵） | AC-R1-3；D-2；S1 验收 3 |
| TC-S1-06 | 🔴 P0 | 完成一次 grant(S,['scope:B']) 与一次 revoke | GET /api/activity（按技能 id/时间过滤） | 出现 action=skill:grant 与 skill:revoke 审计行；detail 含技能归属 scope（A）与目标空间（'scope:B'）；audit.scope/member 语义正确（修复跨空间操作审计归错 scope） | skills.test.mjs + L1 | AC-R1-4；S1 验收 4；I-2 |
| TC-S1-07 | 🟡 P0 | 空间 A 存在 pending 技能 P（含 prompt 敏感文本）与 rejected 技能 R | ① GET /api/skills?scope=A&include=pending（by 非 general 或未带复审身份）② GET /api/skills（scope/member 全缺省 = 全部空间视图）③ GET /api/skills?scope=B（B 与 P/R 无关）④ general 复审视角 | ①②③均不含 P、R 及其 prompt（列表不暴露任何 pending/rejected prompt）；④复审视角含 P/R（通用复审可用，语义 = 既有复审面，不回归 register/review 复审流程）；非 general 的 include=pending 请求被收口（返回不含 pending 或 4xx 明确文案，以实现为准，断言不得含 P/R） | skills.test.mjs | AC-R1-7；S1 验收 5；R-1 敞口收口 |
| TC-S1-08 | 🟡 P0 | 技能 P(pending, scope=A)；技能 R(rejected, scope=A) | GET /api/skills?id=P&include=pending 缺失（普通查询）；GET /api/skills?id=R；跨 scope 单查 GET /api/skills?id=P&scope=B | 一律 404 skill_not_found（或等效 4xx），响应体不含 prompt/description 全文；已发布技能单查正常 200（正向对照） | skills.test.mjs | AC-R1-7；防泄漏语义（现状 :1966-1969 保持） |
| TC-S1-09 | 🔴 P0 | A 空间已发布技能 S 授权给 B（B 可查）；A 无在办依赖 | 以 general + confirm 删除空间 A（POST /api/spaces/delete，前提 S7 级联合入或现状 7 表删 skills 已够） | 删除后 GET /api/skills?scope=B 不再含 S、无悬空引用/不报错；skills 表无 scope=A 残留行（引用式级联消失语义，D-6） | skills.test.mjs（级联断言） | AC-R1-6；D-6；S1 验收 6 |
| TC-S1-10 | 🟢 P0 | A、B、C 各注册并发布 1 条正常技能（无任何跨空间授权） | GET /api/skills?scope=B（含 member）对照 A/C；再给 B 授权一条 A 技能后复查 | 未授权时各空间只见自己 published 技能（互不污染）；授权后 B = 自己 + A 共享（published only）；A 自身列表不受授权影响（仍含 S）——正向控制，防守卫过度拦截 | skills.test.mjs | AC-R1-1 反向补充；S1 验收 2 |
| TC-S1-11 | 🔴 P0 | — | 非法输入矩阵：revoke/grant 缺 id、缺 targets/grants、targets 空数组、id 非法格式（大写/下划线/超长）、未知技能 id | 全部 4xx + 可读错误文案（id/grants 分别指明）；技能表无副作用；无 500 崩溃（进程存活、后续请求 200） | skills.test.mjs | AC-R1-2/3 边界；I-9 进程存活 |
| TC-S1-12 | 🟢 P0 | S1 实现完成 | 复跑 `node team-hub/skills.test.mjs`；git diff 核对 server.mjs/package.json | 既有 12 例 + 新增用例全部绿、fail=0；package.json 无新增依赖（server.mjs 无新增 import）——回归 + 零依赖 | L0 + 评审 | S1 验收 1/7；AC-R1-9；I-1 |
| TC-S1-13 | 🔴 P1 | 同 TC-S1-03 夹具 | 并发/快速交替：10 并发 revoke/grant（Promise.all + 随机间隔）后读最终 grants | 进程存活无 500 风暴；最终 grants = 串行语义一致（全部完成或以最后一次写为准，无未定义崩溃）；失败请求为 4xx 非 000（并发事务不互锁死） | skills.test.mjs（并发组） | S1 验收 3；I-9 扩展 |

### 4.2 S2 R-1 前端：指挥台共享技能视图（来源标识 + 只读含 prompt + 授权/撤销接线）【P0 · workbench api.ts 链起点】
自动化：L2 浏览器清单 + 评审（grep）+ pnpm --dir workbench build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | hub 模式；空间 A 已授权技能 S 给 B（S1 后端合入）；B 空间为当前激活空间 | 打开「技能中心」面板（SkillsPanel） | 出现来自空间 X（A）的共享技能条目：来源标识可见（如「来自 space:A」）、只读（无编辑/发布按钮）、prompt 全文可见；fetch 走既有 /hub 代理（fetchSkills 不带 include 泄漏、不带 member 也可见 = 后端服务端判定生效） | L2 + 评审（api 调用形态 grep） | AC-R1-8；D-4 |
| TC-S2-02 | 🟡 P0 | A 空间有 pending 草稿 P（B 无复审权） | B 空间打开技能中心；另在全部空间视图（scope=null）查看 | 面板不显示 P/R 条目（无 include=pending 请求或后端已收口）；全部空间视图同样不含 P/R 及其 prompt（草稿绝不外泄，D-4 反向） | L2 + L1（接口断言） | AC-R1-7/8；D-4 |
| TC-S2-03 | 🟢 P0 | A 空间为当前激活空间，技能 S published | 技能中心对 S 行内「授权」：目标空间选择（来自空间列表/下拉，非仅手打文本）选 B → 提交 | 请求 = POST /api/skills/grant（hubPost by=general 注入）{id:S, grants:['scope:B']}；成功 toast；B 空间（切过去刷新）可见 S | L2 + 评审 | AC-R1-8；S2 验收 1 |
| TC-S2-04 | 🟢 P0 | 同 TC-S2-01（B 已可见 S） | A 空间技能中心 S 行内「撤销授权」→ 确认 | 请求 = revoke 端点（H-1）；成功 toast；切到 B 空间手动刷新或等 ≤2×15s 轮询 → S 条目消失（撤销后 UI 即时反映） | L2 + 评审 | AC-R1-8/R1-2；S2 验收 2 |
| TC-S2-05 | 🔴 P0 | 登录者非 general（或模拟后端 4xx：confirm/forceGeneral 缺、授权越权） | 在 B 空间触发需 general 的操作（如尝试撤销/授权他人技能）或注入后端 4xx | UI 呈现后端**明确错误文案**（toast/行内，如「仅 general 可…」），不静默吞错、不白屏；恢复权限/纠正后重试成功 | L2 + 评审 | AC-R1-8；S2 验收 3 |
| TC-S2-06 | 🟡 P1 | A 授权 S 给 B；另 C 空间有自建技能 | 「全部空间」视图（scope=null 聚合）打开技能中心 | 列表正确聚合各空间技能并带来源标识；不含任何 pending/rejected；切换具体空间再回全部空间不串数据；无因跨空间条目崩溃 | L2 | AC-R1-7/8 聚合面；H-6 |
| TC-S2-07 | 🔴 P1 | 技能名/描述/prompt 含 `<img src=x onerror=alert(1)>` / `<script>` 样本（A 空间已发布并授权 B） | B 空间查看共享技能条目与 prompt 全文 | 按**纯文本**渲染、无脚本执行、无弹窗；grep SkillsPanel.tsx 无 dangerouslySetInnerHTML 直插服务端文本 | L2 + 评审/grep | I-5；渲染安全 |
| TC-S2-08 | 🟢 P0 | S2 实现完成 | `pnpm --dir workbench build`（tsc 0 诊断；EPERM 时记录复现步骤）；评审 App/Sidebar 接线 | build 全绿或受限记录；SkillsPanel 改动不破坏 chat/files/calendar 面板（评审断言：无共享 import 破坏、入口正常） | L0 build + 评审 | S2 验收 1/2；AC-R1-9 |
| TC-S2-09 | 🟡 P2 | 同 TC-S2-01 | A 发起授权后停留在 B 空间（面板 15s 轮询） | B 技能中心在 ≤2×15s（一轮轮询内）出现 S 条目——轮询收敛不回归（15s 为 SkillsPanel 既有轮询节拍，见 api load 轮询） | L2 | AC-R1-8 实时性（观察项） |

### 4.3 S3 R-1 守护注入缓存失效：fetchSkills 指纹比对刷新（AC-R1-5）【P0 · plugins 链起点】
自动化：plugins 抽纯函数 + node --test（tests/ 面，宿主或沙箱受限记录）｜评审

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | 指纹纯函数已抽出（如 skillsFingerprint(list)=JSON of [id,version,contentHash]） | 构造 A 列表：技能 X v1 hash h1；B 列表：同 1 条 X 但 version=2 contentHash=h2（同数量改版） | skillsFingerprint(A) ≠ skillsFingerprint(B)（长度相同也判变）→ 缓存刷新并注入新 prompt（同数量改版必须刷新，替代现长度比较） | 纯函数单测 | AC-R1-5；S3 验收 1 |
| TC-S3-02 | 🟢 P0 | 同上 | C 列表 = A 的深拷贝（id/version/contentHash 全同、顺序同） | fingerprint(C) === fingerprint(A) → **不刷新**（指纹不变不触发替换；断言不产生刷新日志） | 纯函数单测 | AC-R1-5；S3 验收 2 |
| TC-S3-03 | 🔴 P0 | 缓存含 X（已注入）；Y 从列表中消失（撤销/源空间删导致） | fetch 返回无 X 的列表 D（数量或指纹变化） | 指纹变化 → 刷新：缓存移除 X，下一轮派工注入不再含 X prompt；新增技能 Z 同理进入下一轮 | 纯函数单测 + 集成 | AC-R1-5；S3 验收 3 |
| TC-S3-04 | 🟢 P0 | S1 已合入；守护 scope=B | 模拟两次 fetchSkills：① A 授权 S 后拉取（含 S）② A 撤销后下一轮拉取（不含 S） | ①缓存含 S 注入 ②缓存随指纹变化移除 S（≤intervalMs 默认 30s 内下一轮反映）；fetch 请求形态 = /api/skills?scope=B&member=config.role（既有 plugins:439 不回归） | 集成/评审 + 宿主冒烟（受限记录） | AC-R1-5 端到端；D-5 |
| TC-S3-05 | 🔴 P0 | 缓存含技能 X | fetchSkills 拉取抛错（hub 停/网络错/非 2xx） | catch 吞错：缓存保持原样（不清空不丢旧注入）；不阻塞扫单派工；恢复后下一轮正常刷新 | 纯函数/评审 + L1 | I-9；S3 验收 4 |
| TC-S3-06 | 🟡 P0 | 空库首轮 / 列表为空 / 响应顺序变化 | ① 首轮 fetch 返回 [] ② 后续轮仍 [] ③ 同一组技能服务端返回顺序 shuffle（内容不变） | ①②缓存为空列表且不报错；③若实现按原始响应序计算指纹则顺序变触发一次刷新可接受、若按 id 排序计算则顺序 shuffle 不刷新——断言以实现导出指纹函数为准：内容不变时最终注入内容一致，无重复注入/错乱 | 纯函数单测 | AC-R1-5 边界 |
| TC-S3-07 | 🟢 P0 | S3 实现完成 | `tsc -p plugins/tsconfig.json --noEmit`（受限记录复现步骤）；既有插件测试回归（宿主）；git diff package.json | typecheck 0 诊断（或受限记录）；既有派工/流转插件测试不回归；零新增依赖 | L0 build + 评审 | S3 验收；AC-R1-9；I-1 |

### 4.4 S4 R-2 后端：全局规范层（rules 表 + GET/POST /api/rules + 审计/SSE）【P0 · RESEARCH K3-A】
自动化：team-hub/rules.test.mjs（新增，HTTP 范式仿 calendar.test.mjs：临时 TEAM_HUB_DB + listen(0) 真端口）｜L1

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | 临时新库 | import server.mjs → 查 sqlite_master；再以旧库（有 tasks/skills/chat 存量、无 rules 表）二次 import（?migration= 同库） | rules 表存在且 key TEXT PRIMARY KEY / scope / content / updatedAt 形状合理；建表幂等（CREATE TABLE IF NOT EXISTS）；旧库自动建表不报错、存量数据完整 | rules.test.mjs | S4 验收 1；AC-R2-6 后端前置；I-4 |
| TC-S4-02 | 🟢 P0 | S4 实现完成、库已建表 | GET /api/rules?scope=global（未写过）；GET /api/rules?scope=software（预留空间层扩展点，未写） | 200 返回 {ok:true, rules:{scope:'global', content:'', updatedAt:null}} 或等价空串/合理默认（未设置 → 空串 + 默认时间可断言其一）；预留 scope 参数不 500 | rules.test.mjs | S4 验收 2 |
| TC-S4-03 | 🟢 P0 | 真服务随机端口 + SSE 订阅方 | POST /api/rules {scope:'global', content:'团队规范：先跑测试再提交', by:'general'} → 再 GET 回读 + GET /api/activity | 200 ok；GET 回读 content 逐字一致且 updatedAt 刷新；audit 增 action=rules:update（member=by、detail 含 scope/content 摘要可断言其一）；SSE 订阅方 ≤5s 收到 action=rules:update 帧 | rules.test.mjs + L1（SSE） | S4 验收 3/4；AC-R2-6 后端；I-2 |
| TC-S4-04 | 🔴 P0 | — | 非法输入矩阵：①缺 by ②by 空 ③scope 缺失/非法（非 global/space 语义）④content 非字符串（数组/对象）⑤content 超 MAX_RULES_LEN（默认 3000，注入 3001） | 全部 400（handleWrite 语义）+ 明确错误文案（by/content/scope 分别指明）；零落库（GET 回读为空或原值不变）；audit 无 rules:update 新行 | rules.test.mjs | S4 验收 3；I-2 |
| TC-S4-05 | 🟡 P0 | 同 TC-S4-04 前提 | 边界值：①content 恰 3000 字符 ②content 为多字节中文 3000 字（计数语义 = JS length 与实现一致）③content=''（清空）后保存 ④同一 key 重复 POST（覆盖更新） | ①200 ②按实现计数口径放行或按字节拒（断言与实现导出常量一致）③200 且 GET content=''（清空全局层可行）④200 幂等更新不产生重复行（key 主键 upsert） | rules.test.mjs | S4 验收 2/3 边界 |
| TC-S4-06 | 🔴 P0 | 已写一条全局规范 | ①GET /api/rules 前后对比 audit 行数 ②POST 后 GET /api/activity（scope/taskId 过滤）查 rules:update | ①GET 无副作用：不产生任何 audit 行 ②rules:update 行可查且含 member/scope/detail 形状（与 chat:*/skill:* 同构）——读写纪律（I-2） | rules.test.mjs | S4 验收 4；I-2/I-6 |
| TC-S4-07 | 🟢 P0 | S4 实现完成；同临时库 | 建库 + 写规范后：跑 skills/chat/calendar 既有契约等价断言（或同库 import 后 DAO 直调） | 既有 skills 12 / chat 13 / calendar 13 全绿（server.mjs 改动不回归既有模块）；同库多 import 幂等 | L0（回归照跑） | S4 验收 5；AC-R2-7 |
| TC-S4-08 | 🟢 P2 | S4 实现完成 | git diff 核对 team-hub/package.json 与 server.mjs import 区 | 零新增运行时依赖（仅 node:sqlite）；GET 只读端点不产生写日志噪音 | 评审 | S4 验收 5；I-1 |

### 4.5 S5 R-2 解析注入：readNorms 分层合并 + 预算截断 + buildWorkerPrompt 双段注入【P0 · plugins 链】
自动化：plugins 抽纯函数（readNorms/truncateNorms）+ node --test ｜评审 + 宿主冒烟（受限记录）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | 全局层来源可注入（fake fetch 返回 rules content G）；空间层 repoRoot 夹具含 agent.md（内容 S） | 调 readNorms（或抽取的解析纯函数）：全局有 G、空间层有 S | 输出两段：[全局层段] + [空间层段]；顺序稳定（空间层后置）；空间层段首带「空间/项目层优先于全局层」类声明文案（文本断言含关键词）；两段各自带来源标注（全局/rules vs 仓库文件） | 纯函数单测 | AC-R2-1/2；S5 验收 1 |
| TC-S5-02 | 🟡 P0 | repoRoot 夹具变化组合 | ①同仓同时存在 LEGION.md+AGENTS.md+agent.md ②仅 LEGION.md ③仅 agent.md ④三文件均不存在 | ①三文件全部按固定序（LEGION → AGENTS → agent.md）读入空间层段 ②③读唯一存在者 ④该层为空、函数返回无空间层段（不报错）——文件族按序读全部存在者 | 纯函数单测 | AC-R2-3；S5 验收 2；K4-A |
| TC-S5-03 | 🟢 P0 | 夹具仓库仅 LEGION.md（内容 L，现状形态）；无全局层内容 | readNorms 输出对比现状 readRepoRules(L) 的输出 | 注入文本与现状逐字一致（含「仓库规则（必须遵守，来自 LEGION.md/AGENTS.md）」段首文案）——兼容回归（现状兜底语义不破） | 纯函数单测 | AC-R2-3；S5 验收 3 |
| TC-S5-04 | 🟡 P0 | 无全局层内容且空间层无任何文件 | readNorms 调用（含 buildWorkerPrompt 拼装冒烟） | 不输出规范段（无「仓库规则」小节）、不报错；buildWorkerPrompt 其余段落正常（现状降级） | 纯函数单测 | AC-R2-3 反向；S5 验收 3 |
| TC-S5-05 | 🔴 P0 | 构造超长内容：全局层 3200 字（>3000）、空间层 4500 字（>4000）、合计 >7000 | 调截断纯函数（truncateNorms 或 readNorms 内置） | 各层按段落边界截断到预算内；截断处追加「规范超限截断：原文 N 字，已保留前 M 字」提示（N/M 为真实数字）；不产生半截代码块（样本：截断点在围栏代码块内 → 输出要么关闭该代码块要么丢弃到下一个段边界，断言输出无未闭合围栏）；合计超限同样生效 | 纯函数单测 | AC-R2-4；S5 验收 4；H-8 |
| TC-S5-06 | 🟡 P0 | 预算可配（env/config 注入如 NORMS_GLOBAL_MAX=100） | 内容 100 字全局层：注入 100 → 保留全量；101 → 截断+提示（三值法） | 新预算生效（读取侧环境变量/配置优先）；不硬编码 | 纯函数单测 | AC-R2-4；H-8 |
| TC-S5-07 | 🟢 P0 | S4+S5 实现完成 | 评审 buildWorkerPrompt：规则小节（现状 plugins:1087-1089）改为引用 readNorms；宿主可达时派工冒烟：提示词含两段且空间层后置、顺序正确；不可达记录复现步骤 | 代码评审通过（buildWorkerPrompt 规则段 = readNorms 输出，非旧 readRepoRules 直拼）；冒烟或受限记录如实标注 | 评审 + L3 | AC-R2-5；S5 验收 5；I-8 |
| TC-S5-08 | 🔴 P0 | 全局层来源（GET /api/rules）拉取失败/超时 | fetchRules 失败后调 readNorms（空间层有文件） | 降级：只用空间层段，不报错不阻塞派工；恢复后下一轮含全局层（缓存策略与 fetchSkills 同族，I-9） | 纯函数单测 + 评审 | AC-R2-3/5；G-R1 降级语义 |
| TC-S5-09 | 🟢 P0 | S5 实现完成 | `tsc -p plugins/tsconfig.json --noEmit`（受限记录）；既有插件回归（宿主）；git diff package.json | typecheck 0 诊断或受限记录；既有派工/流转插件测试不回归；零新增依赖；不改角色 prompt 职责语义（roles.json/stage-standards 不动） | L0 build + 评审 | S5 验收 6；AC-R2-7；I-1 |

### 4.6 S6 R-2 前端 + 职责总纲：指挥台「规范」维护入口 + README/LEGION 总纲段【P0 · workbench api.ts 链】
自动化：L2 浏览器清单 + 评审（grep）+ pnpm --dir workbench build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 P0 | hub 模式；S4/S5 后端合入 | 侧栏点「规范」入口 | 进入真实 RulesPanel（非 toast 占位）：全局层内容区 + 空间层文件族指引区两个明确分区；入口接线（Sidebar/App）无报错 | L2 + 评审 | S6 验收 1；AC-R2-6 |
| TC-S6-02 | 🟢 P0 | 面板已开；hub 可达 | 编辑全局层内容 → 保存 | 请求 = POST /api/rules（走既有 hub 代理，by=general 自动注入）；成功 toast；刷新/重开面板回读内容一致；GET /api/activity 可见 rules:update | L2 + L1 | S6 验收 2；AC-R2-6 |
| TC-S6-03 | 🔴 P0 | 面板已开 | ①保存空内容（清空）②保存超长（>MAX_RULES_LEN）③停 hub 后保存 | ①后端允许则成功清空 + toast（清空语义以 S4 TC-S4-05 为准）②前端阻止或后端 400 → toast 明确错误，无静默丢失 ③hub 不可达 → toast 错误、面板不白屏不崩溃；hub 恢复后重试成功 | L2 | S6 验收 3；AC-R2-6 错误路径 |
| TC-S6-04 | 🟡 P0 | 面板已开 | 查看空间层文件族区 | 显示 LEGION.md / AGENTS.md / agent.md 三文件路径 + 「文件中心/仓库内编辑」跳转指引（明确引导，非直接编辑）；未绑定仓库空间给引导文案 | L2 | S6 验收 1；AC-R2-6 空间层入口 |
| TC-S6-05 | 🟢 P1 | S4/S5 合入；宿主可达（守护可扫单） | 保存一段新全局规范 → 观察下一轮派工 worker 提示词 | 提示词规范段包含刚保存的新内容（全局层段可见）——注入链路反映保存结果；宿主不可达 → 如实记录「环境受限 + 复现步骤」 | L3（宿主冒烟）/ 受限记录 | S6 验收 3；AC-R2-5 联动 |
| TC-S6-06 | 🔴 P1 | 面板已开 | 内容含 `<script>alert(1)</script>` / `<img src=x onerror=` 样本保存后回显 | 保存/回显按纯文本处理，无脚本执行无弹窗；grep RulesPanel.tsx 无 dangerouslySetInnerHTML 直插规范内容 | L2 + 评审/grep | I-5 |
| TC-S6-07 | 🟢 P1 | S6 实现完成 | grep README.md/LEGION.md 新增「规范载体职责总纲」段 | 总纲段存在且覆盖四类载体分工：空间层文件族（LEGION/AGENTS/agent.md）= 仓库规则、rules 表全局层 = 跨空间规范、skills = 技能内容、roles.json stage.prompt/stage-standards = 岗位职责模板（各自维护入口与优先级，RESEARCH §16.1 矩阵落地） | 评审/grep（文档断言） | S6 验收 4；D-9 |
| TC-S6-08 | 🟢 P0 | S6 实现完成 | `pnpm --dir workbench build`（tsc 0 诊断；EPERM 时记录）；评审 chat/files/browser/calendar/skills 面板入口 | build 全绿或受限记录；RulesPanel 接线不破坏其它面板（无共享 import 破坏） | L0 build + 评审 | S6 验收；AC-R2-7 |

### 4.7 S7 R-3 后端：删除语义收口（级联扩至 chat/calendar/members + 影响预检端点 + 测试）【P1 · RESEARCH K6-A/K7-A 后端】
自动化：team-hub/spaces.test.mjs（新增，HTTP 范式仿 calendar.test.mjs）｜L1

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 P0 | 造数夹具空间 Z（§8.4）：tasks 3 / roster 2 / agent_models 2 / exec_requests 1 / skills 2 / goal 1 / exec_state 1 / conversations 2 / messages 5 / calendar_events 2 / members 2 | POST /api/spaces/delete {id:'Z', confirm:'delete-space:Z', by:'general'} | 200 {id:'Z', removed:{...}}；removed 逐表计数 = 造数（11 张数据表 tasks/roster/agent_models/exec_requests/skills/goal/exec_state/conversations/messages/calendar_events/members 各删对应行数）；spaces 行删除；audit 保留 space:delete 行（detail.removed 含逐表计数） | spaces.test.mjs | S7 验收 1；AC-R3-4/5；G-R2/D-10；I-6 |
| TC-S7-02 | 🟡 P0 | 删除 Z 后（同 TC-S7-01） | ①逐表 COUNT WHERE scope=Z ②GET /api/scopes ③GET /api/spaces ④GET /api/chat/conversations?scope=Z ⑤GET /api/calendar/events?scope=Z | ①全部 0（无孤儿残留）②scopes 不再含 Z（幽灵分区收口：members 已删 → 推导干净）③spaces 不再含 Z ④⑤返回空列表/空数组（无会话/事件残留可查） | spaces.test.mjs | S7 验收 2；AC-R3-5；G-R2 |
| TC-S7-03 | 🔴 P0 | 空间 Z 有造数 | confirm 错误矩阵：①缺 confirm ②confirm='delete-space:other' ③confirm 前缀错（'delete:Z'） | 全部 4xx + 明确文案（含 confirm 须为 delete-space:<id> 语义）；数据零删除（删前后 COUNT 一致）；audit 无 space:delete 新行 | spaces.test.mjs | S7 验收 3；AC-R3-4；I-2 |
| TC-S7-04 | 🔴 P0 | — | 未知空间：POST delete {id:'ghost-zz', confirm:'delete-space:ghost-zz', by:'general'}（id 合法格式） | 400 + 「未知空间」文案；不崩溃 | spaces.test.mjs | AC-R3-4 |
| TC-S7-05 | 🔴 P0 | software/default 空间有存量（或为空） | POST delete {id:'software', confirm:'delete-space:software', by:'general'}；default 同 | 400 + 受保护空间文案（拒绝顺序先于其它校验亦可，断言 4xx + 文案含「受保护」）；数据不变 | spaces.test.mjs | AC-R3-3/4；I-10 |
| TC-S7-06 | 🔴 P0 | 空间 Z 有造数 | ①by='coder'（非 general）无 forceGeneral ②by='coder' + forceGeneral:true（confirm 正确） | ①400 + 文案含「仅允许 general」；零删除 ②200 删除成功（forceGeneral 显式承担风险语义，若实现保留现状）——断言以实现为准：非 general 无 forceGeneral 必拒 | spaces.test.mjs | AC-R3-4；D-2 对称语义 |
| TC-S7-07 | 🟢 P0 | 空间 Z 有造数（含 in_progress 任务 1 条） | GET /api/spaces/impact?id=Z；GET /api/spaces/impact?id=ghost-zz；删除前再查一次 Z 计数 | 返回 {id, counts:{tasks,roster,members,conversations,messages,calendarEvents,skills,...}, running:{...在办任务/编排状态}} 形状（字段名以实现为准，值 = 造数）；未知 id → 400/404；两次调用间数据零变化（只读预检，不删除） | spaces.test.mjs | S7 验收 2；AC-R3-1 预检前传；H-4 |
| TC-S7-08 | 🟡 P1 | 空间 Z 含 1 条 in_progress 任务与 1 条 in_review 任务 | （服务端口径）以正确 confirm + general 删除 Z | 服务端允许删除（D-11 默认：在办允许删，强提示是前端职责）；removed.tasks 计数含在办行；audit 保留 | spaces.test.mjs | S7 验收；D-11；AC-R3-4 |
| TC-S7-09 | 🟢 P0 | S7 实现完成 | 复跑 `node team-hub/calendar.test.mjs` / chat / skills；原 7 表删除语义对照（删一个只含 tasks 的空间） | 既有 13/13 + 13/13 + 12/12 全绿（删除改动不回归 chat/skills/calendar）；原 7 表 + spaces 行为不回归 | L0（回归照跑） | S7 验收 4；AC-R3-6 |
| TC-S7-10 | 🟢 P2 | 删除 Z 完成 | GET /api/activity 按时间/过滤查 Z 相关 | space:delete 审计行仍在（历史保留，含 detail.removed）；删除后无新增孤儿写入（服务端其它端点不再能写入已删 scope 数据） | spaces.test.mjs + L1 | S7 验收；I-6；AC-R3-5 |

### 4.8 S8 R-3 前端：SpaceSettingsModal「删除工作空间」危险区（type-to-confirm + 影响预检 + 切回全部空间）【P1 · workbench api.ts 链】
自动化：L2 浏览器清单 + 评审（grep）+ pnpm --dir workbench build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S8-01 | 🟢 P0 | hub 模式；打开 software 空间设置与普通空间 Z 设置 | 观察两处 SpaceSettingsModal | 危险区「删除工作空间」仅对非 software/default 空间显示（或显示但禁用 + 说明原因）；software/default 无删除入口/明确禁用（对齐后端 :1873 受保护语义） | L2 + 评审 | S8 验收 1；AC-R3-3；I-10 |
| TC-S8-02 | 🟢 P0 | 空间 Z 有造数（含在办任务） | 普通空间设置中展开危险区 | 展开先调 GET /api/spaces/impact?id=Z 渲染影响清单（任务/编队/成员/会话/日程/技能计数）+ 在办任务强提示（在办 N 条 + 删除将丢失提示）；hub 停时展开 → 错误提示不白屏 | L2 + L1（接口断言） | S8 验收 1；AC-R3-1；D-11 强提示 |
| TC-S8-03 | 🟡 P0 | 危险区已展开 | type-to-confirm 输入：先输错（delete-space:zz）再输对（delete-space:Z） | 输入与 delete-space:Z 完全一致前「确认删除」按钮禁用；输对后可用；错误输入有提示 | L2 | S8 验收 1；AC-R3-1 双保险 |
| TC-S8-04 | 🔴 P0 | 危险区已展开 | 点「取消」/关闭弹窗 | 无任何删除请求发出（devtools Network 无 POST /api/spaces/delete）；空间与数据原样 | L2 | S8 验收；AC-R3-1 |
| TC-S8-05 | 🟢 P0 | 空间 Z 非当前激活空间 | 完成 type-to-confirm → 确认删除 | 请求 = POST /api/spaces/delete {id:'Z', confirm:'delete-space:Z'}（hubPost by=general）；成功 toast；spaces 列表重拉不再含 Z | L2 + 评审（api.ts deleteSpace 存在） | S8 验收 2；AC-R3-2 |
| TC-S8-06 | 🟢 P0 | 当前激活空间即 Z | 删除当前激活空间 Z → 确认 | 成功后 UI 自动切回「全部空间」并重拉列表（复用 App.tsx:288-302 刷新模式）；spaces 列表不再含 Z；当前选中状态正确 | L2 | S8 验收 2；AC-R3-2 |
| TC-S8-07 | 🔴 P0 | 空间 Z 存在 | 失败路径矩阵：①confirm 错（type 输错被禁用无法触发，改注入层测）②后端返回 400（未知/受保护/非 general 任一，如以 coder 会话调用）③hub 停 | 呈现后端明确错误文案（toast/行内），不静默失败不白屏；空间仍在；hub 恢复后重试成功 | L2 + 评审 | S8 验收 3；AC-R3-1/4 |
| TC-S8-08 | 🟡 P1 | S8 实现完成 | grep SpaceSettingsModal 渲染；输入空间名含 `<img onerror>` 影响清单回显；`pnpm --dir workbench build` | 影响清单/文案纯文本渲染无脚本执行、无 dangerouslySetInnerHTML 直插服务端数据；build 全绿或受限记录；无回归（files/chat/browser/calendar/skills/rules 面板正常） | L2 + 评审 + L0 build | S8 验收 4；I-5 |
| TC-S8-09 | 🟢 P1 | S8 实现完成 | grep README.md 空间管理节 | README §3.1/§4 空间管理已补「移除空间」说明（入口/确认/级联范围/受保护/磁盘残留由运维处理提示） | 评审/grep | S8 验收；文档联动 |

### 4.9 S9 R-4 后端数据面：每空间回复开关 + awaiting 状态机 + 回复队列端点 + 超龄兜底【P0 · team-hub/server.mjs chat 段】
自动化：team-hub/chat.test.mjs（追加用例且既有 13 例不回归）+ chat-l1-smoke.mjs（扩展断言）｜L1

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S9-01 | 🟢 P0 | 临时新库 | import server.mjs → 查 sqlite_master；再以旧库（有 chat/skills、无 chat_reply_settings）二次 import | chat_reply_settings 表存在：scope TEXT PRIMARY KEY / enabled INTEGER 默认 1 / model / identity / systemHint / updatedAt（可空列）；CREATE TABLE IF NOT EXISTS 幂等；旧库自动建表不报错、chat 存量完整 | chat.test.mjs | S9 验收 1；AC-R4-3 后端；I-4 |
| TC-S9-02 | 🟢 P0 | 表已建 | ①GET 某 scope 未设置 ②POST 设置 {scope:'software', enabled:false} ③GET 回读 ④重启/重连（新 import 同库）后 GET ⑤POST 恢复 enabled:true | ①默认 enabled=true（D-13 默认开）②200 持久化 ③enabled=false ④重启后仍 false（持久化）⑤恢复 true；software 与 marketing 各自独立设置互不影响（per-scope 隔离） | chat.test.mjs + L1 | S9 验收 1/2；AC-R4-3；D-13；I-11 |
| TC-S9-03 | 🟢 P0 | software 空间开关开（默认）；会话 C 存在 | POST /api/chat/messages {conv:C, body:'你好，请帮我总结', by:'general'} | 200；返回消息 meta.aiStatus='awaiting'（同事务写入，零迁移 meta 扩展）；消息 author='general'；conversation 正常更新；audit chat:message 形状不回归 | chat.test.mjs | S9 验收 2/3；AC-R4-1 后端；I-2 |
| TC-S9-04 | 🟡 P0 | software 开关关（enabled:false） | 同 TC-S9-03 发消息 | 返回消息 meta 无 aiStatus='awaiting'（或无 aiStatus 字段）；不进入回复队列（GET replies 为空）；人-人消息本身正常（不因开关影响存储） | chat.test.mjs | AC-R4-3；I-11；G-R3 |
| TC-S9-05 | 🔴 P0 | 会话 C 在 software | ①回复方身份消息：POST {conv:C, body:'回复内容', by:'software-assistant'} ②author='software-assistant' 消息发出后检查是否被再次标 awaiting ③by='software-assistant' 冒名普通用户视角 | ①author=by='software-assistant'（服务端绑定防冒名不回归——chat.test.mjs 既有 author=by 契约语义保持，非本批 TC-S1-07 收口用例）②identity 消息不标 awaiting（防自我触发死循环）③身份默认 = scope 名 + '-assistant'（实现导出常量可断言）；identity ≠ 'general' 且 ≠ 用户 by | chat.test.mjs | S9 验收 4；AC-R4-2；D-15；I-12 |
| TC-S9-06 | 🟢 P0 | software 有 2 条 awaiting 消息（不同会话） | GET /api/chat/replies?scope=software&sinceMsgId=0；再 GET 带 limit | 返回 awaiting 消息列表（含 conv/msg id/body/上下文聚合：最近 N 条同会话消息供应答上下文）；limit 上限防爆（超限截断或 400，断言其一）；跨空间隔离（marketing 队列不含 software awaiting） | chat.test.mjs + L1 | S9 验收 5；AC-R4-4 后端前置；I-3 |
| TC-S9-07 | 🔴 P0 | 注入 CHAT_REPLY_TIMEOUT_MS=200（小值）后造 1 条 awaiting | 等待 >200ms 后 GET /api/chat/replies；GET 该消息详情 | awaiting 消息被服务端标记 meta.aiStatus='failed' + meta.error（含 timeout/超时语义）；不再出现在 replies 队列；不产生崩溃 | chat.test.mjs（注入小值三值法） | S9 验收 6；AC-R4-4；H-7 |
| TC-S9-08 | 🟢 P0 | 开关开；源消息 awaiting | 回复方写入（复用 postMessage DAO：by='software-assistant'）；SSE 订阅方观察；GET 源消息 meta | 回复消息落库（author='software-assistant'）；audit 增 chat:message（member='software-assistant'）；SSE 订阅方 ≤5s 收到 chat:message 帧；源消息 meta.aiStatus 更新为 replied（状态回写通道，机制以实现为准——队列标记/回写端点/守护直写，断言终态 = replied 且不重复回复） | chat.test.mjs + L1（SSE） | S9 验收 7；AC-R4-6；I-2 |
| TC-S9-09 | 🔴 P0 | — | replies 非法入参：scope 空/缺、sinceMsgId='abc'/负数、limit=0/负数/超大、conv 不存在 | 400 + 可读错误（或受控截断，断言其一）；不 500、零副作用 | chat.test.mjs | S9 验收 5 边界 |
| TC-S9-10 | 🟡 P0 | 开关开 | 回复消息边界：body 恰 8000 字符 → 200；8001 → 400（kind 必须 text）；kind='markdown' 的回复拒绝或按实现允许（若实现仅 text，断言 kind 白名单不回归既有 text/markdown/system 语义） | MAX_CHAT_BODY=8000 常量断言不回归（chat.test.mjs 既有 8000/8001 边界用例语义保持）；回复消息 kind=text | chat.test.mjs | S9 验收 8；AC-R4-7；H-7 |
| TC-S9-11 | 🔴 P0 | 1 条 awaiting 消息 M | ①并发/重复两次标记 replied（模拟守护与手工重复回写）②M 已 replied 后再 GET replies | 状态机 CAS：仅 awaiting→replied 可成功；第二次回写幂等（不产生第二条回复、不抛未定义错误）；M 不再出现在 replies 队列 | chat.test.mjs（CAS 幂等组） | S9 验收 7；AC-R4-4；I-12 |
| TC-S9-12 | 🟢 P0 | 旧库（无 chat_reply_settings、messages.meta 无 aiStatus 字段、含既有 chat 数据） | 同库 import 后跑 chat 既有 13 例契约（含 chat.test.mjs 既有老库迁移锚定用例，见该文件头注释） | 既有 13 例全绿（零迁移风格不回归）；旧消息 meta={} 读取正常（默认 aiStatus 语义 = 无/兼容渲染） | chat.test.mjs | S9 验收 9；AC-R4-5；I-4 |
| TC-S9-13 | 🟢 P1 | S9 实现完成；真进程 | `node team-hub/chat-l1-smoke.mjs`（含 S9 新增断言：settings 读写/awaiting 可见/开关关无队列/超龄 failed/SSE ≤5s） | 22+ 项断言 + S9 新增全部通过（exit 0）；无 token 写 401、带 token 200 语义不回归 | L1 | S9 验收 9；AC-R4-8 |

### 4.10 S10 R-4 守护执行：chat-responder 扫单（拉 awaiting → 轻量子代理直答 → 落第二条消息 → 状态回写）【P0 · plugins 链】
自动化：评审 + 纯函数单测（状态机/护栏）+ 宿主冒烟（受限记录）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S10-01 | 🟢 P0 | 宿主守护可达（responder 已实现）；software 开关开 | 用户在会话发消息 → 等待 | 守护 interval（默认 10-30s）拉 GET /api/chat/replies → 派生**无仓库工具**轻量子代理（提示词 = 空间对话助手 + 会话历史、禁工具/文件访问）→ ≤120s 内会话出现回复消息（author=<scope>-assistant，body 非空与提问相关）；源消息 meta.aiStatus='replied'——宿主不可达 → 如实记录「环境受限 + 复现步骤」 | L3（宿主冒烟）/ 受限记录 | S10 验收 1/2；AC-R4-1；D-12 |
| TC-S10-02 | 🔴 P0 | responder 已实现；注入子代理失败/超时（mock 或宿主不可达模拟） | 扫单处理一条 awaiting 时子代理抛错/超时 | 源消息回写 meta.aiStatus='failed' + meta.error（含失败原因）；不产生半条回复/空回复；UI 侧呈现失败（S11）；守护继续处理其它消息不中断 | 评审/单测 + L3 | S10 验收 3；AC-R4-4 |
| TC-S10-03 | 🟡 P0 | 同一条 awaiting 被两次扫单命中（并发/重复轮） | 并发执行 responder 处理同一条 | 状态机 CAS（仅 awaiting→replied 可成功）：仅一次派生/一次回复；第二次处理幂等跳过（不产生重复回复、不重复计费出站）；无 500/未捕获异常 | 评审/单测 | S10 验收 3；AC-R4-4；I-12 |
| TC-S10-04 | 🔴 P0 | 会话含回复方身份消息 | responder 扫单 | 只处理非回复方身份（作者 ≠ <scope>-assistant）的 awaiting 消息；identity 消息不被再次触发（防死循环） | 评审/单测 | S10 验收 3；I-12 |
| TC-S10-05 | 🟢 P0 | software 开关关 | 发消息（无 awaiting）后观察守护日志/队列 | 空转无任何回复动作、零出站模型调用；重新打开开关后新消息恢复 awaiting→回复流程 | 评审 + L3 | AC-R4-3；I-11 |
| TC-S10-06 | 🟡 P0 | settings.model 未设 / 设为 'x-unknown' / 设为合法模型名 | 分别扫单 | 模型解析 = settings.model ?? 该空间默认（agent_models）；未知模型 → 回写 failed + error 不崩溃；合法模型 → 正常直答 | 评审/单测 + L3 | S10 验收 4；D-14 |
| TC-S10-07 | 🟢 P0 | S10 实现完成 | 评审 responder 段：并发/超时护栏仿 worker 既有 config（intervalMs 默认 30s 或独立 10-30s 节拍）；team-hub 无出站模型调用（K8-A 纪律）、零新凭据面 | 评审通过（护栏存在且与既有 config 同构；无新增 fetch 出站到外网；复用 DSH 模型通道） | 评审 | S10 验收 5；I-7；K8-A/K10-A |
| TC-S10-08 | 🟢 P0 | S10 实现完成 | `tsc -p plugins/tsconfig.json --noEmit`（受限记录）；既有插件回归（宿主）；git diff package.json | typecheck 0 诊断或受限记录；既有派工/流转插件测试不回归；零新增依赖 | L0 build + 评审 | S10 验收 6；AC-R4-8；I-1 |
| TC-S10-09 | 🟢 P1 | 宿主可达 | 端到端三路径冒烟：①发送 → ≤120s 收到回复 ②关开关后发送 → 无回复 ③失败注入 → failed 呈现 | 三路径结果与判据一致（宿主不可达记录复现步骤不冒充） | L3（宿主冒烟） | S10 验收 1/2/3；AC-R4-1/3/4 |

### 4.11 S11 R-4 前端：ChatView 身份泛化 + AI 回复三态气泡（等待中/失败可重试/已回复 + 模型徽标）【P0 · ChatView.tsx】
自动化：L2 浏览器清单 + 评审（grep）+ pnpm --dir workbench build

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S11-01 | 🟢 P0 | 会话含 author='software-assistant' 消息（S9/S10 数据） | 打开会话查看渲染 | author 判定泛化：general = 我（右侧/me）；其余 author（含 software-assistant）一律对方侧渲染；回复方气泡带 🤖 标识 + meta.aiModel 模型徽标（可见） | L2 + 评审 | S11 验收 1；AC-R4-2 UI |
| TC-S11-02 | 🟢 P0 | 发送一条消息（开关开） | 观察气泡状态流转 | 三态呈现：awaiting → 「等待回复…」+ 时间戳（无正文或占位）；replied → 正文显示（AI 气泡）；failed → 明确失败提示（含原因/重试动作）；状态由 messages.meta.aiStatus 驱动 | L2 | S11 验收 2；AC-R4-4 UI |
| TC-S11-03 | 🟡 P0 | 一条 failed 消息 | 点「重试」 | 触发动作把该消息重新置 awaiting（重发队列/重置 meta）→ 气泡回等待态；不重复插入新消息/新气泡；成功后进入 replied | L2 | S11 验收 2；AC-R4-4 UI |
| TC-S11-04 | 🔴 P0 | 回复正文含 `<img src=x onerror=alert(1)>` / `<script>` 样本 | 查看回复气泡 | 按纯文本渲染、无脚本执行无弹窗；grep ChatView.tsx 无 dangerouslySetInnerHTML 直插消息正文 | L2 + 评审/grep | S11 验收 3；AC-R4-7；I-5 |
| TC-S11-05 | 🟢 P0 | A/B 两会话 | A/B 快速切换 + 在途 loadOlder/send（既有 R-A5 会话守卫回归） | 不串显：在途响应不回写到非发起会话；AI 回复到达后落入正确会话；无重复/乱序 | L2 + 评审 | S11 验收 4；R-A5 回归 |
| TC-S11-06 | 🟢 P0 | 人-人会话 | general 对 general 收发；刷新；分页 loadOlder | 左右侧/身份渲染正确（author 泛化不破坏人-人收发）；历史完整；分页正常（主路径无回归） | L2 | S11 验收 4；AC-R4-8 |
| TC-S11-07 | 🟡 P0 | 旧消息无 meta / 无 aiStatus；未知 author 名 | 打开含旧消息会话 | 按 replied/普通气泡渲染，不白屏、无误标「失败/等待」；未知 author 显示原名字符串 | L2 | S11 验收；兼容性边界 |
| TC-S11-08 | 🟢 P0 | S11 实现完成 | `pnpm --dir workbench build`（tsc 0 诊断；EPERM 记录）；宿主可用时 `chat-s2-smoke`（/hub 代理主路径） | build 全绿或受限记录；chat-s2-smoke 通过或受限记录；api.ts 无需改动（回复经既有 postChatMessage/SSE 到达，评审确认） | L0 build + L3 | S11 验收 5；AC-R4-8 |

### 4.12 S12 四能力集成回归锚定（收口验证：全量套件 + 端到端清单写入 docs/TEST_REPORT.md）【收口 · 仿 T-075 S8/T-091 惯例】
自动化：L3 全量套件 + 宿主端到端清单；结果沉淀 docs/TEST_REPORT.md（本片为验证型，tester 执行；本设计给出命令、判据与勾选清单）

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S12-01 | 🟢 P0 | S1~S11 合入完成 | 逐套件运行并记录输出要点：skills / chat / rules（S4 新）/ spaces（S7 新）/ calendar / contracts / whiteboard | 全部 fail=0（记录 tests/pass 计数与命令输出要点入 docs/TEST_REPORT.md）；calendar 13/13、skills 12+ 新增、chat 13+ 新增全绿 | L3 | S12 验收；S1~S11 各 DoD 回归汇总 |
| TC-S12-02 | 🟢 P0 | 同上 | R-1 端到端：A 授权 S 给 B → B 可见（含守护注入冒烟）→ A 撤销 → B 消失 → A 删除 → B 无悬空 → include=pending 非 general 不泄 | 每步判据 = 对应 TC-S1-xx/S2-xx/S3-xx 期望；全链走通（宿主守护冒烟部分受限时记录） | L3（端到端脚本/清单） | S12 验收 R-1 链 |
| TC-S12-03 | 🟢 P0 | 同上 | R-2 端到端：全局层保存（rules:update audit）→ 空间层文件族 → 派工提示词两段注入且空间层后置优先声明 → 超限截断生效 | 每步判据 = TC-S4-xx/S5-xx/S6-xx；宿主注入冒烟受限时记录 | L3 | S12 验收 R-2 链 |
| TC-S12-04 | 🟢 P0 | 同上 | R-3 端到端：设置弹窗预检 → type-to-confirm → 删除 → （当前空间则）切回全部空间 → scopes/spaces 无幽灵 | 每步判据 = TC-S8-xx/S7-xx；浏览器走查 + API 断言 | L3（浏览器 + L1） | S12 验收 R-3 链 |
| TC-S12-05 | 🟢 P0 | 同上 | R-4 端到端：发送 → awaiting 等待态 → AI 回复或明确失败呈现（关开关无回复对照） | 每步判据 = TC-S9-xx/S10-xx/S11-xx；宿主可达才可完整走通，不可达记录「环境受限 + 复现步骤」 | L3 | S12 验收 R-4 链 |
| TC-S12-06 | 🟢 P1 | S12 执行完毕 | git diff 复核全批 package.json（team-hub/plugins/workbench）；汇总 build/typecheck 状态 | 零新增运行时依赖（package.json 无新增项）；build/typecheck 逐项标注通过或「环境受限 + 复现步骤」 | L3 + 评审 | S12 验收；I-1 |

## 5. 关键业务规则 正反向覆盖矩阵

| 业务规则 | 正向用例（规则成立/被满足） | 反向用例（违反/攻击/边界被拒） |
| --- | --- | --- |
| 跨空间共享可见性（引用式 grants） | TC-S1-01/02（授权后 B 可见含 prompt；member 省略/单值两形态） | TC-S1-01（C 不可见）/ TC-S1-03（撤销即消失）/ TC-S1-09（级联消失）/ TC-S1-10（未授权不串） |
| revoke 幂等与错误处理 | TC-S1-04（重复撤销/撤销未授权幂等不抛错） | TC-S1-11（缺参/非法 id/未知技能 4xx 零副作用） |
| general 门禁（review/grant/revoke） | TC-S1-05（general 成功） | TC-S1-05（非 general 4xx + 明确文案 + 零审计）/ TC-S2-05（UI 透传 4xx 文案） |
| 审计带源与目标（skill:grant/revoke） | TC-S1-06（detail 含归属 scope + 目标空间） | TC-S1-05（非 general 被拒 → 无审计新行）/ S4-06（GET 无副作用同族） |
| 草稿/驳回绝不外泄 | TC-S1-07④（general 复审视角可见，复审流程不回归） | TC-S1-07①②③ / TC-S1-08（非复审查询与全部空间视图不暴露 pending/rejected prompt） |
| 守护指纹刷新（内容/数量/成员变化） | TC-S3-01（同量改版刷新）/ TC-S3-03（撤销移除刷新）/ TC-S3-04（授权-撤销端到端） | TC-S3-02（同指纹不刷新）/ TC-S3-05（拉取失败不清缓存）/ TC-S3-06（空列表/顺序变化不崩） |
| 规范两层合并 + 顺序 + 优先级 | TC-S5-01（两段顺序稳定、空间层后置 + 优先声明）/ TC-S5-07（buildWorkerPrompt 引用 readNorms） | TC-S5-04（无文件无全局 → 无规范段不报错）/ TC-S5-02④（文件族空层不报错） |
| 兼容回归（仅 LEGION.md） | TC-S5-03（与现状逐字一致） | TC-S5-02（多文件/仅 agent.md 形状正确，不误读漏读） |
| 预算截断 | TC-S5-05/06（超限段落边界截断 + 提示 + 预算可配） | TC-S5-05（代码块不半截，无未闭合围栏） |
| rules 读写纪律 | TC-S4-03（写入持久化 + audit rules:update + SSE ≤5s） | TC-S4-04（非法输入 400 零落库）/ TC-S4-06（GET 无副作用） |
| 删除确认与护栏 | TC-S7-01（confirm 正确 + general → 级联删除成功）/ TC-S8-03/05/06（type-to-confirm → 删除成功/切回全部空间） | TC-S7-03（confirm 缺/错 4xx 零删除）/ TC-S7-04（未知空间）/ TC-S7-05（受保护）/ TC-S7-06（非 general）/ TC-S8-04（取消无请求） |
| 级联收口与幽灵分区 | TC-S7-01/02（11 表计数 + scopes/spaces/chat/calendar 干净） | TC-S7-02（任何残留/幽灵 = FAIL） |
| 影响预检 | TC-S7-07（计数准确、只读） | TC-S7-07（未知 id 400、两次调用数据零变化） |
| AI 回复开关 | TC-S9-03（开 → awaiting）/ TC-S9-02（关持久化 + 每空间隔离）/ TC-S10-05（开恢复） | TC-S9-04（关 → 无 awaiting 无回复）/ TC-S10-05（关 → 空转零出站） |
| 回复身份安全（author=by） | TC-S9-05①（回复方 author=identity）/ TC-S9-08（audit member=identity + SSE） | TC-S9-05②（identity 消息不被再次标 awaiting，防死循环）/ 冒名语义不回归 |
| awaiting 状态机与超龄 | TC-S9-08（awaiting→replied 终态 + 回写通道） | TC-S9-07（超龄 → failed + meta.error）/ TC-S9-11（重复回写幂等、不重复回复） |
| 回复队列隔离与防爆 | TC-S9-06（scope 过滤 + limit 防爆 + 上下文聚合） | TC-S9-06（跨空间队列不含对方 awaiting）/ TC-S9-09（非法入参 400） |
| UI 三态/身份/渲染安全 | TC-S11-01/02（author 泛化 + 三态气泡 + 徽标）/ TC-S11-03（重试成功路径） | TC-S11-04（XSS 纯文本）/ TC-S11-07（无 meta 兼容不误标）/ TC-S11-05（A/B 切换不串显） |
| 渲染安全（通用红线） | TC-S8-08/S6-06/S2-07 正向（文本正常显示） | 同列各 TC 反向（脚本样本不执行、grep 无 dangerouslySetInnerHTML） |
| 零新增依赖 / 老库零迁移 | TC-S1-12 / S4-01 / S9-12 / S10-08（0 依赖、旧库 import 幂等存量完整） | TC-S12-06（package.json 出现新增依赖 = FAIL） |

## 6. 验收标准逐条用例化：需求/验收 → 用例追溯矩阵

> PASS 判据 = 该需求/验收行映射的全部用例通过；机器验收行（TASK_BREAKDOWN §1 S1~S12）→ 用例见各表「追溯」列，下表为需求级汇总。

| 需求/验收（T-095 §5 / TASK_BREAKDOWN §1） | 直接用例 | 边界/异常补充 | 通过判据（汇总） |
| --- | --- | --- | --- |
| AC-R1-1 授权后 B 可见、C 不可见 | TC-S1-01/02 | TC-S1-10（反向不串） | listSkills scope=B（含省略 member）含 S 且 prompt 全；C 空 |
| AC-R1-2 撤销立即不可见 + 幂等 | TC-S1-03 | TC-S1-04/11 | revoke 后 B 空；重复撤销幂等不抛错 |
| AC-R1-3 非 general 门禁 4xx / general 成功 | TC-S1-05 | TC-S2-05（UI 透传） | 非 general 全 4xx + 文案；general 成功；register 不门禁 |
| AC-R1-4 审计带归属与目标 | TC-S1-06 | — | detail 含源 scope + 目标空间，action 前缀 skill: |
| AC-R1-5 守护按指纹刷新注入 | TC-S3-01/02/03/04 | TC-S3-05/06 | 同量改版刷新 / 同指纹不刷 / 撤销移除 / 失败不清缓存 |
| AC-R1-6 删源空间后 B 无悬空 | TC-S1-09 | — | B 查询干净、无悬空引用 |
| AC-R1-7 pending/rejected 不外泄 | TC-S1-07 | TC-S1-08 | 非复审查询（含全部空间视图）零泄漏；general 复审可用 |
| AC-R1-8 UI 冒烟（共享视图/授权/撤销/代理链路） | TC-S2-01/03/04 | TC-S2-02/05/06/09 | B 可见共享条目带来源 + 只读含 prompt；A 授权/撤销接线；4xx 文案透传；无草稿 |
| AC-R1-9 回归 + build | TC-S1-12 / S2-08 / S3-07 | — | skills 全绿、workbench build 绿/受限记录、plugins typecheck 0/受限 |
| AC-R2-1 分层两段输出 | TC-S5-01 | TC-S5-02 | [全局层段]+[空间层段] 顺序稳定、来源标注 |
| AC-R2-2 空间层覆盖全局层（文本断言） | TC-S5-01/07 | TC-S5-07（冒烟档） | 空间层后置 + 「优先于全局层」声明可见 |
| AC-R2-3 兼容回归/无文件降级 | TC-S5-03 | TC-S5-04 | 仅 LEGION.md 逐字一致；无文件无段不报错 |
| AC-R2-4 预算截断 + 无半截破坏 | TC-S5-05 | TC-S5-06（可配） | 段落边界截断 + 提示 + 无未闭合代码块 |
| AC-R2-5 派工提示词两段可达 | TC-S5-07 | TC-S5-08（全局拉取失败降级） | 宿主冒烟两段存在顺序正确或受限记录 |
| AC-R2-6 UI 维护入口 + audit 可断言 | TC-S6-01/02/03/04 + S4-03 | TC-S6-03（错误路径） | RulesPanel 可达可编辑保存；rules:update 留痕；空间层文件族指引 |
| AC-R2-7 回归 + 文档联动 | TC-S6-08 / S6-07 | — | build 绿/受限；职责总纲段入 README/LEGION；plugins 不回归 |
| AC-R3-1 删除入口 + 二次确认 + 预检 | TC-S8-01/02/03 | TC-S8-04/07 | 危险区仅非受保护；type-to-confirm 门控；impact 清单渲染 |
| AC-R3-2 删除当前空间切回全部空间 + 列表干净 | TC-S8-05/06 | — | 自动切回 + 重拉无该 id |
| AC-R3-3 software/default 不可删（UI+服务端） | TC-S8-01 | TC-S7-05 | 无入口/禁用 + 400 受保护 |
| AC-R3-4 服务端用例（removed 计数/confirm 错/未知/非 general 4xx） | TC-S7-01 | TC-S7-03/04/05/06 | 逐表 removed 正确；四类 4xx 零删除 |
| AC-R3-5 孤儿/幽灵按 D-10 收口 | TC-S7-02 | TC-S7-10（audit 保留） | 残留/幽灵 = FAIL；audit 历史保留 |
| AC-R3-6 回归（calendar/chat/skills + /api/spaces + build） | TC-S7-09 / S8-08 | — | 既有套件全绿、build 绿/受限 |
| AC-R4-1 回复可达（≤120s 回复消息） | TC-S9-03 + S10-01 | TC-S10-09（宿主冒烟） | 开关开发送 → ≤120s 出现 identity 回复或明确失败 |
| AC-R4-2 身份安全（author=by 防冒名不回归） | TC-S9-05 | TC-S9-05②（防死循环） | author 恒=by；identity ≠ 用户/general |
| AC-R4-3 开关（默认开、关闭无回复、持久化 per-scope） | TC-S9-02/04 | TC-S10-05 | 关 → 无 awaiting 无回复；重启保持 |
| AC-R4-4 失败路径（UI 呈现失败不阻塞人-人） | TC-S9-07（超龄 failed） | TC-S10-02/03/06 + S11-03 | failed + error 可见；CAS 幂等；重试动作 |
| AC-R4-5 数据与迁移（老库 chat 契约全绿） | TC-S9-12 | — | 旧库 import 后 13 例契约全绿（零迁移） |
| AC-R4-6 审计与实时（chat:message + SSE ≤5s） | TC-S9-08 | — | audit + SSE 同构于既有 chat:* |
| AC-R4-7 渲染安全 + 长度（纯文本、≤8000） | TC-S11-04 | TC-S9-10 | 纯文本渲染无 dangerouslySetInnerHTML；8000/8001 边界 |
| AC-R4-8 回归（chat.test/chat-l1-smoke/chat-s2-smoke/build） | TC-S9-13 / S11-08 | S10-08 | chat 13+ 全绿、l1-smoke 22+、s2-smoke 或受限、build 绿/受限 |
| S1~S12 机器验收行（DoD/命令/期望逐条） | 各表「追溯」列 | — | §4 各片表中「Sx 验收 n」引用的用例全过 + 该片 P0 用例落成断言 |
| T-098 阶段验收 1（主路径+边界+异常，每条含前置/步骤/期望） | §4 全部 109 条 | — | 每条含三类要素 + 类别 + 优先级 |
| T-098 阶段验收 2（通过/失败判据） | 每条「期望结果 / 通过判据」列 | — | 无黑盒（可命令/断言/可观察状态表达） |
| T-098 阶段验收 3（关键规则正反向） | §5 矩阵 | — | 15+ 条规则成对覆盖 |

## 7. 浏览器手工验收清单模板（L2，tester 执行时逐条勾选并记录可见结果）

### 7.1 技能共享（S2，R-1）
- [ ] B 空间技能中心可见「来自空间 A」共享条目 + 只读 + prompt 全文（TC-S2-01）
- [ ] B 空间无任何 A 的草稿/驳回条目（TC-S2-02）
- [ ] A 空间行内授权（目标空间选择）→ B 可见（TC-S2-03/09）
- [ ] A 空间行内撤销 → B 刷新/轮询后消失（TC-S2-04）
- [ ] 非 general/后端 4xx → 明确错误文案 toast（TC-S2-05）
- [ ] 「全部空间」视图聚合正确、无草稿、不崩溃（TC-S2-06）
- [ ] 技能 prompt 含脚本样本 → 纯文本显示无弹窗（TC-S2-07）

### 7.2 规范面板（S6，R-2）
- [ ] 侧栏「规范」→ 真实 RulesPanel（TC-S6-01）
- [ ] 全局层编辑保存成功 → 回读一致 + toast（TC-S6-02）
- [ ] 超长/停 hub 保存 → 明确错误不白屏（TC-S6-03）
- [ ] 空间层文件族三文件路径 + 跳转指引（TC-S6-04）
- [ ] 内容含脚本样本保存回显纯文本（TC-S6-06）

### 7.3 移除空间（S8，R-3）
- [ ] software/default 空间设置无删除入口/禁用说明（TC-S8-01）
- [ ] 普通空间危险区展开 → 影响预检清单 + 在办强提示（TC-S8-02）
- [ ] type-to-confirm：输错禁用 / 输对可点（TC-S8-03）
- [ ] 取消/关闭 → 无请求（TC-S8-04）
- [ ] 删除非激活空间 → 列表移除（TC-S8-05）
- [ ] 删除当前激活空间 → 自动切「全部空间」+ 重拉无该 id（TC-S8-06）
- [ ] 失败路径（confirm 错/未知/受保护/停 hub）→ 后端文案呈现（TC-S8-07）

### 7.4 对话 AI 回复（S11，R-4；需 S9/S10 后端）
- [ ] 发送 → awaiting 等待态（时间戳）→ 回复到达 replied（🤖 + 模型徽标）或失败（TC-S11-01/02）
- [ ] 失败气泡点重试 → 回等待态 → 成功后 replied（TC-S11-03）
- [ ] 回复含脚本样本 → 纯文本渲染无弹窗（TC-S11-04）
- [ ] A/B 会话快速切换不串显（含 AI 回复到达正确会话）（TC-S11-05）
- [ ] 人-人收发/刷新/分页无回归（TC-S11-06）
- [ ] 旧消息（无 meta）正常渲染无误标（TC-S11-07）
- [ ] 空间开关关 → 发送后无 AI 回复（对照 TC-S11-02；后端已由 S9-04 断言）

## 8. 测试夹具与数据约定（供 coder 落测试 / tester 执行）

### 8.1 技能跨空间夹具（S1/S2/S3 用；skills.test.mjs mkdtemp/临时库先例）

``text
// 空间 A / B / C（spaces 行注册或纯 scope 语义，由测试层决定）
A.registerSkill -> id='doc-review', scope:'A'            // pending
A.reviewSkill('doc-review','publish') -> published       // version 1
B.registerSkill -> id='b-own', scope:'B'（published）     // B 自有（正向对照）
// 授权与撤销：
grantSkill('doc-review', ['scope:B'])                     // by general
listSkills({scope:'B'})            // 含 doc-review（prompt 全文）
listSkills({scope:'B', member:'role1'}) // 同（守护形态）
revokeSkill('doc-review', ['scope:B']) // by general
// 防泄样本：id='draft-x' scope:'A' status:'pending' prompt:'敏感草稿文本'
GET /api/skills?scope=A&include=pending            // 非 general → 不得含 draft-x
GET /api/skills?scope=B&include=pending            // 不得含 A 的 pending
``

### 8.2 rules / 规范夹具（S4/S5/S6 用）

``text
// rules（S4 HTTP 契约；假设 H-2）
GET  /api/rules?scope=global            -> { ok:true, rules:{ scope:'global', content:'', updatedAt:null } }
POST /api/rules { scope:'global', content:'<文本>', by:'general' }   -> 200；audit action=rules:update
// 注入解析（S5 纯函数夹具）
repoRoot/ LEGION.md | AGENTS.md | agent.md           // 文件族组合矩阵（只存在 / 全存在 / 都不存在）
全局层来源 = fake fetch 返回 {content:G} / 失败        // 降级路径
超限样本：G=3200 字（>3000）、S=4500 字（>4000）、合计 7700（>7000）；代码块截断样本含围栏段落
``

### 8.3 chat 回复夹具（S9/S10/S11 用）

``text
// settings（S9；假设 H-3）
GET  /api/chat/reply-settings?scope=software   // 未设置 → enabled:true（默认开）
POST /api/chat/reply-settings { scope:'software', enabled:false, by:'general' }
// 队列
POST /api/chat/messages { conv:1, body:'你好请总结', by:'general' }
     -> 开关开：meta.aiStatus='awaiting'；开关关：无
GET  /api/chat/replies?scope=software&sinceMsgId=0   // awaiting + 最近上下文；limit 防爆
// 超龄（注入 CHAT_REPLY_TIMEOUT_MS=200）→ 服务端标 meta.aiStatus='failed' + meta.error
// 回复方：POST /api/chat/messages { conv:1, body:'...', by:'software-assistant' }（author=by，防冒名）
``

### 8.4 删除空间造数夹具（S7/S8 用；spaces.test.mjs 新建）

``text
// 造数空间 Z：先 POST /api/spaces { id:'Z', name:'测试空间', by:'general' } 注册
// 依次造数据（计数供 removed/impact 断言）：
//   tasks 3（含 1 条 in_progress、1 条 in_review）｜roster 2｜agent_models 2｜exec_requests 1
//   skills 2（scope:'Z'）｜goal 1｜exec_state 1
//   conversations 2（scope:'Z'）+ messages 5｜calendar_events 2（scope:'Z'）｜members 2（scope:'Z'）
// 删除（AC-R3-1 契约）：
POST /api/spaces/delete { id:'Z', confirm:'delete-space:Z', by:'general' }   // -> 200 {id, removed:{...}}
// 反向矩阵：confirm 缺/错配｜未知空间｜software/default｜by 非 general（forceGeneral 缺）
// 预检：GET /api/spaces/impact?id=Z（只读计数 + 在办状态；两次调用间数据零变化）
// 收口断言：DELETE 后各表 COUNT WHERE scope='Z' = 0；GET /api/scopes 与 /api/spaces 不含 Z
``

### 8.5 env / token / 端口约定

| 用途 | env/参数 | 说明 |
| --- | --- | --- |
| hub 临时库/端口 | TEAM_HUB_DB / TEAM_HUB_PORT / TEAM_HUB_HOST | chat/skills/calendar/rules/spaces 测试临时库 import（isMain 不占端口）或 listen(0) |
| hub 写 token | TEAM_HUB_TOKEN（非空时写需 Bearer） | 写经 handleWrite（authorized），401 断言沿用 chat-l1-smoke 既有 token 用例语义（见该文件头注释） |
| 注入预算（S5） | NORMS_GLOBAL_MAX / NORMS_SPACE_MAX / NORMS_TOTAL_MAX（⚖️） | 默认 3000/4000/7000 |
| rules 上限（S4） | MAX_RULES_LEN（⚖️ 默认 3000） | 三值法 |
| 回复超龄（S9） | CHAT_REPLY_TIMEOUT_MS（⚖️ 默认 120000） | S9-07 注入小值 |
| 守护节拍 | config.intervalMs（默认 30000，plugins:92） | S3 指纹 ≤30s 收敛 |
| UI 轮询 | SkillsPanel 15s（既有）；chat SSE retry 2s + 15s 轮询兜底（既有） | S2-09 实时性 |
| 前端构建 | pnpm --dir workbench build（或 cd workbench && pnpm build） | tsc 0 诊断为沙箱内最严证据 |

## 9. 附录

### 附录 A：现状代码证据锚点（T-095 §10 精简 + 本阶段实测复核，行号基于 w/T-098 HEAD == 41fd406 代码字节）

| 主题 | 证据 |
| --- | --- |
| skills 表 / DAO（register/review/list/grant） | team-hub/server.mjs:201-215（表）、:469-527（listSkills 授权分支 :515、grantSkill 只并集 :520-527） |
| 技能路由（无 general 门禁）+ GET /api/skills（include=pending 敞口） | server.mjs:1748-1786、:1960-1982 |
| 技能级联删除 / 空间删除（7 表） | server.mjs:1885 / :1867-1896（护栏 :1873-1875） |
| /api/scopes（tasks+members 推导；members 无 DELETE） | server.mjs:1562-1568、:1617-1624 |
| chat 表（meta JSON 列）与 DAO（发送即终态） | server.mjs:232-244、:603-625；chat 路由 :1788-1821 |
| 受保护空间 / handleWrite / 单一审计 SSE | server.mjs:1873、:1150-1163、:1983-1994 |
| 守护 fetchSkills（长度比较 :442-445）与注入点 | plugins/src/index.ts:434-447、:1087-1092（仓库规则段）/ :1090-1092（技能段） |
| 守护 readRepoRules（单文件单层 + 4000 截断） | plugins/src/index.ts:849-862；intervalMs 默认 30000（:92） |
| 前端技能 UI（无 member、无空间选择） | workbench/src/components/SkillsPanel.tsx:35/:42/:97-105/:178-199；api.ts:393-398 |
| 前端 hub 代理（恒注入 by=general）/ chat 客户端 | workbench/src/api.ts:379-390（hubPost）、:481-488（postChatMessage）、:491-501（SSE） |
| ChatView 身份判定（author==='general' 恒为「我」） | workbench/src/components/ChatView.tsx:24-26/:358-359；MAX_BODY=8000（:6） |
| 既有测试面 | team-hub/skills.test.mjs（12 例）、chat.test.mjs（13 例）、calendar.test.mjs（13 例，HTTP listen(0) 范式）、chat-l1-smoke.mjs（22 项断言） |

### 附录 B：测试代码落点骨架（coder 落盘时照此；断言细则以 §4「期望结果 / 通过判据」列为准；P0 用例必须各有一条对应断言）

**S1 → team-hub/skills.test.mjs（追加 describe；skills.test.mjs 既有 import 模式：临时 TEAM_HUB_DB + import server.mjs + mod.xxx DAO 直调）：**
``js
describe('S1 跨空间共享语义（R-1）', () => {
  it('TC-S1-01/02 grant scope:B 后 scope=B 列表含 S（member 省略与单值两形态）；scope=C 不含', () => {
    // A 注册发布 doc-review；B/C 造数据；grantSkill('doc-review', ['scope:B'])（by general 语义走 mod.grantSkill）
    const b = mod.listSkills({ scope: 'B' })
    assert.ok(b.some(s => s.id === 'doc-review' && s.prompt.length > 0)) // prompt 全文
    const c = mod.listSkills({ scope: 'C' })
    assert.ok(!c.some(s => s.id === 'doc-review'))
  })
  it('TC-S1-03/04 revoke 后 B 空 + 重复撤销幂等不抛错', async () => { /* revokeSkill → listSkills scope:B 空；再 revoke 不 throw */ })
  it('TC-S1-05 非 general 路由 4xx（HTTP 层 by=coder 调 review/grant/revoke）', async () => { /* listen(0) + fetch；断言 status 4xx + error 含 general */ })
  it('TC-S1-06 审计 detail 含归属 scope 与目标空间（action=skill:grant/revoke）', () => { /* auditRows() 过滤 */ })
  it('TC-S1-07/08 非复审查询不含 pending/rejected prompt（含 include=pending 收口）', () => { /* listSkills includePending=false / HTTP include=pending 以 member 判定 */ })
  it('TC-S1-09 删 A 空间后 B 不含 A 技能（级联消失）', () => { /* 删除空间后复查 */ })
  it('TC-S1-10 正向控制：未授权空间互不污染', () => {})
  it('TC-S1-11 非法输入矩阵 → 4xx/抛错不崩溃', () => {})
  it('TC-S1-13 并发 grant/revoke 不崩溃最终一致', async () => { /* Promise.all 10 次 */ })
})
``

**S4 → team-hub/rules.test.mjs（新增；仿 calendar.test.mjs：临时 TEAM_HUB_DB + import server.mjs + mod.server.listen(0) + fetch）：**
``js
describe('S4 rules 全局规范层', () => {
  it('TC-S4-01 新库/旧库建表幂等（sqlite_master + ?migration= 二次 import）', () => {})
  it('TC-S4-02 GET /api/rules?scope=global 未设置 → content 空 + 合理默认', async () => {})
  it('TC-S4-03 POST 写入 → GET 回读一致 + audit rules:update + SSE ≤5s', async () => { /* sseCollector 仿 chat-l1-smoke */ })
  it('TC-S4-04 非法矩阵（缺 by/非法 scope/非字符串/3001 超限）→ 400 零落库', async () => {})
  it('TC-S4-05 边界 3000/清空/覆盖更新 upsert', async () => {})
  it('TC-S4-06 GET 无 audit 副作用', async () => {})
})
``

**S7 → team-hub/spaces.test.mjs（新增；HTTP 范式同 rules）：**
``js
describe('S7 spaces 删除收口 + impact 预检', () => {
  it('TC-S7-01 造数空间 Z 删除 → removed 逐表计数 + spaces 行删 + audit 保留', async () => { /* 11 表造数（§8.4） */ })
  it('TC-S7-02 删除后逐表 COUNT=0、/api/scopes 与 /api/spaces 无 Z、chat/calendar 空', async () => {})
  it('TC-S7-03/04/05/06 confirm 错配/未知/受保护/非 general → 4xx 零删除', async () => {})
  it('TC-S7-07 GET /api/spaces/impact?id=Z 计数 + 只读（两调零变化）', async () => {})
  it('TC-S7-08 含在办任务空间可删（D-11）', async () => {})
})
``

**S9 → team-hub/chat.test.mjs（追加 describe）+ chat-l1-smoke.mjs（追加 check 断言）：**
``js
describe('S9 chat 回复数据面（R-4）', () => {
  it('TC-S9-01 chat_reply_settings 建表幂等', () => { /* sqlite_master */ })
  it('TC-S9-02/04 settings 默认开 + 读写持久化 per-scope + 关后无 awaiting', () => {})
  it('TC-S9-03 开关开发消息 → meta.aiStatus=awaiting（同事务）', () => {})
  it('TC-S9-05 回复方身份 author=by；identity 消息不被自我标 awaiting', () => {})
  it('TC-S9-06 replies 队列 scope 过滤 + limit + 上下文聚合', () => {})
  it('TC-S9-07 超龄（CHAT_REPLY_TIMEOUT_MS=200）→ failed + meta.error', async () => { /* sleep 300 */ })
  it('TC-S9-11 状态机 CAS：重复标记幂等不重复回复', () => {})
  it('TC-S9-12 旧库（无新表）import 后 chat 既有 13 例契约全绿', async () => {})
})
``

**S3/S5/S10 → plugins：指纹/解析/截断/状态机判读逻辑抽纯函数（导出自可测模块或 plugins/src/index.ts 顶部导出区），tests/ 下新增 node --test 文件断言三态与降级（宿主受限时记录复现步骤）；responder 状态机以「awaiting→replied/failed 仅一次 + identity 不触发」为最小单测面。**

**S2/S6/S8/S11（前端，无 test runner）**：以 §7 清单 + 评审断言（grep dangerouslySetInnerHTML、api.ts 接线、deleteSpace 客户端存在、author 泛化判定）为准；若 coder 抽纯函数（如 type-to-confirm 判定 / aiStatus 三态映射），在同一文件域内新增 .mjs node --test 并把函数导出。

### 附录 C：机器复核（本文件自检）

- 用例计数、类别分布、追溯引用完整性、正反向矩阵与 §4 的 ID 一致性：以一次性 Node 脚本复核为准（读取 docs/TEST_CASES.md，按「| ID | 类/优 |」行抽取 TC-xx 编号并统计类别/优先级、校验 ID 唯一、校验 §5 矩阵与 §6 矩阵引用的 ID 均存在于 §4）。结果写入 docs/T098-evidence/01-doc-machcheck.txt（含每片计数与类别分布，与 §0 设计值核对；若有差异以脚本复核为准，表内为设计值）。
- 行数/计数（T-098 阶段验收用）：S1 13 / S2 9 / S3 7 / S4 8 / S5 9 / S6 8 / S7 10 / S8 9 / S9 13 / S10 9 / S11 8 / S12 6 = 109；🟢正常 58 / 🟡边界 22 / 🔴异常 29；P0=94 / P1=12 / P2=3（本阶段实测 machcheck PASS：declaredTotal=109、unique=109、dup=0、dangling=0，输出 docs/T098-evidence/01-doc-machcheck.txt）。

### 附录 D：风险与开放项

- R-11 同文件域串行（server.mjs S1→S4→S7→S9、plugins S3→S5→S10、workbench 壳 S2→S6→S8）：用例按切片归属文件，coder 不越域写测试文件（TASK_BREAKDOWN §2.2）。
- R-12 假设待下游复核：H-1（revoke 端点形状）、H-2（MAX_RULES_LEN=3000 与超限 400）、H-3（reply-settings/replies 端点名）、H-4（/api/spaces/impact 端点）、H-7（超龄与回复窗 120s + env 名）、H-8（预算默认值）——均为本文件内可单点修改的用例形状/默认值；实现若给不同契约/常量，仅改对应行请求形状或常量，断言语义不变。
- R-13 宿主面环境受限：plugins typecheck/build、workbench pnpm build、S10 responder 端到端、S3/S5 注入冒烟均需宿主（本 worktree 无 node_modules；node --test spawn EPERM）——按「环境受限 + 复现步骤」记录，不冒充通过（TC-S3-07/S5-09/S8-08/S10-08/S11-08 等）。
- R-14 include=pending 收口的具体身份通道（member=general vs 专用参数）由 S1 实现定，断言以「语义不泄」为准（H-5）。
- R-15 技能全量注入叠加提示词膨胀：S5 预算与 S6 职责总纲缓解；若将军后续要按角色过滤技能注入（D-16 勾选）则 S3 用例追加角色级断言。
- R-16 forceGeneral 语义（TC-S7-06②）：现状代码允许 forceGeneral:true 越权删，本批按现状语义断言并提示前端不暴露该通道（仅 API 内部/运维）；若将军裁决收紧（非 general 一律禁删）只改该用例期望。
- ❓ 回复「相关性」判据（AC-R4-1 body 与提问相关）：以「同会话新增消息、内容非空、非模板错误串」为自动化判据；语义相关性属人工抽检（S12-05 端到端）。
- ❓ S12-05 宿主端到端依赖守护 + 模型通道可用；不可达时以 S9 数据面 + S11 UI 三态 + S10 受限记录共同给出判据，不静默判过。

---
（本文档由 T-098 test-designer 产出；只写用例与落点，不写业务实现、不执行用例——执行为 tester 职责。改动仅落 w/T-098 worktree，不 push；本文件取代 T-076 批 docs/TEST_CASES.md，旧版经 git 历史回溯。）







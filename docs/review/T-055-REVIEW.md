# T-055 代码审查报告（review）—— S1：team-hub 扩表扩 /api/chat/* + 审计/SSE

> 审查人：reviewer（T-055，分支 w/T-055）｜波次：1
> 审查对象（S1 切片编码交付，按 git 溯源）：
> - 实现基线提交 9f7deaf（S1：对话中心后端交付）—— team-hub/server.mjs（chat 建表/迁移 + DAO + /api/chat/* REST + 审计/SSE，+187 行）、team-hub/chat.test.mjs（+190 行）；
> - 验收轮提交 b16bc59（T-045 coder 轮）—— team-hub/chat-l1-smoke.mjs（+262 行，L1 真实服务冒烟资产）＋ docs/T045-evidence/*（证据）；
> - 已核验 git diff 9f7deaf HEAD -- team-hub/：自 9f7deaf 后 server.mjs / chat.test.mjs 零改动（T-045 轮 server.mjs 行为零改动），HEAD 上 S1 代码即上述两提交内容，无漂移。
> 审查方式：逐函数真读代码（server.mjs / chat.test.mjs / chat-l1-smoke.mjs / 相关集成面）+ 独立复跑验证 + 交叉核对消费方（workbench/src/api.ts S2 接线）；只给反馈，不改实现。
> 结论分级：**必须修改**（缺陷/契约失实，修复后 promote）与**建议优化**（不影响主路径，可排期）；严重度 🔴高 / 🟠中 / 🟡低。

---

## 0. 独立复跑验证证据（本报告全部为 reviewer 实跑，非引用提交自述）

| 验证项 | 命令 | 结果（本环境） |
| --- | --- | --- |
| chat DAO 契约 | node team-hub/chat.test.mjs | tests 13 / pass 13 / fail 0，exit 0（TC-S1-01..13、16；套件 5） |
| skills 回归（AC2） | node team-hub/skills.test.mjs | tests 12 / pass 12 / fail 0，exit 0 |
| L1 真实服务冒烟 | node team-hub/chat-l1-smoke.mjs | 22/22 断言通过、进程级异常 0、exit 0；SSE live 事件实测 ≤5s 收到：{"seq":34,...,"member":"coder","scope":"software","action":"chat:message","detail":{"conv":1,"msg":29,"kind":"text"}} |
| AC1 字面命令 node --test | node --test team-hub/chat.test.mjs | 沙箱限制：test runner 子进程 spawn EPERM（既有边界，见 T-045 假设 2），故以直跑等效；宿主环境可 node --test 复跑 |
| scope 边界实证探测 | node --input-type=module 直连 DAO | 见问题 R-1：无 scope 列表返回全分区；跨 scope 凭 conv id 可读消息、可由 A 侧成员向 B 会话写消息 |
| typecheck | node <DSH>/node_modules/typescript/bin/tsc -p team-hub/tsconfig.json --noEmit | 环境限制：本 worktree 无 team-hub/node_modules junction，types:["node"] 缺失报 TS2688；T-045 在宿主 junction 下 exit 0。S1 chat 代码为 server.mjs（ESM JS），不在 tsconfig include:["src"] 覆盖内，由测试/L1 真进程验证 |
| 零新增依赖（AC6） | git diff 5677f5fb..HEAD --name-only | 无任何 package.json 变更；chat 只用 node:sqlite/node:http/node:child_process/node:fs 内置模块 |

> 环境事实：Node v24.19.0（node:sqlite 内置可用）；本 worktree 无 node_modules 且禁网，不满足项均已说明成因，非代码缺陷。

---

## 1. S1 验收标准（docs/TASK_BREAKDOWN.md S1 AC1..AC6）逐条核对

| 验收标准 | 结论 | 依据（代码/命令） |
| --- | --- | --- |
| AC1 node --test team-hub/chat.test.mjs 全绿；覆盖会话创建/列表（scope 过滤）、消息追加与分页（limit/before、升序）、scope 隔离、by/author 缺失被拒、长度上限拒绝 | ✅ 通过 | chat.test.mjs 13/13（TC-S1-01..13、16）＋ L1 22/22（HTTP 层 400/401 矩阵）。分页三页 10/10/5 无重无漏升序（server.mjs listMessages 584–600）；MAX_CHAT_BODY=8000 恰好过/+1 拒（486–488、567，TC-S1-12）；author 服务端绑定 by 防冒名（postMessage 572，TC-S1-07）。scope 隔离注记见 R-1 |
| AC2 回归 skills.test.mjs 仍全绿；老库无 chat 表自动建表迁移冒烟 | ✅ 通过 | skills.test.mjs 12/12；chat.test.mjs TC-S1-16（旧 tasks/skills 库 import 后自动建 conversations/messages 且存量无损）实测过；建表 DDL 幂等（server.mjs 211–237） |
| AC3 curl 冒烟：POST 会话→POST 消息→GET 列表含 last_message_at→GET 分页；GET /api/activity 可查 chat:* 审计 | ✅ 通过 | L1 真进程 TC-S1-01/06/08/13 实测：last_message_at 更新、分页正确、/api/activity?scope=software 含 chat:create/chat:message（member/scope/detail 形状） |
| AC4 事件冒烟：订阅 /api/events 写入→流内收到 chat 事件 ≤5s | ✅ 通过 | L1 TC-S1-14 实测收到 live chat:message（member=coder，超时窗内）；复用单一 /api/events（I8），未新增事件端点（server.mjs 1478–1488 + broadcastAudit 819–822） |
| AC5 写纪律：所有 chat 写经统一 handleWrite（by 必填、scope 归一），错误映射 400/401 与既有接口一致，响应含 ok/task 同构体 | ✅ 通过 | 四个 chat 路由均走 handleWrite（1335–1367；handleWrite 857–870）；缺 by→400「缺少操作者身份 by」、错 token→401、非法 kind→400；响应 {ok:true, task}（L1 TC-S1-01/04/05/17 实测）。DAO 内审计保证任何调用路径留痕（chat.test TC-S1-13） |
| AC6 零新增依赖 | ✅ 通过 | 全程无 package.json diff；只用 node 内置模块（见 §0） |

---

## 2. 与 docs/TEST_CASES.md 硬性不变量/量化判据的对应

| 口径 | 结论 | 依据 |
| --- | --- | --- |
| I1 零新增运行时依赖（TC-S1-18） | ✅ | §0 依赖核对 |
| I3 chat 写统一走 handleWrite（by 必填 + audit + SSE） | ✅ | 见 AC5；DAO 内 audit（createConversation 542、postMessage 575） |
| I4 三中心数据按 scope 隔离（TC-S1-03..05） | ✅（含注记 R-1） | 列表级过滤（listConversations 547–553）与消息 scope=会话 scope（postMessage 572）经 TC-S1-02/03 实测；消息级跨 scope 读/写凭 conv id 可达，见 R-1 |
| I8 单一 /api/events 按 kind 过滤 | ✅ | SSE 只存在于既有 /api/events（1478）；chat 事件 action=chat:* 供前端过滤（api.ts subscribeHubAudit 475–484） |
| MAX_CHAT_BODY=8000 三值法 | ✅ | TC-S1-12 实测 8000 过 / 8001 拒且不落库 |
| 分页 limit 默认 50 / 上限 200 / before 游标 | ✅ | listMessages 588–597；TC-S1-08/09 实测 |
| 服务端生成 id、单调排序 | ✅ | AUTOINCREMENT 整数主键 + ORDER BY id/updatedAt desc（213/236–237）；TC-S1-01/08 断言 |
| 审计 action 命名 chat:* + SSE 载荷形状 | ✅ | audit 389–395；TC-S1-13/14 实测 |

---

## 3. 问题清单

### 3.1 必须修改

**无。** 依据：S1 验收 AC1–AC6 逐条实测通过（§0/§1）；chat 主路径（创建/列表/发消息/分页/审计/SSE/鉴权矩阵）在真实 HTTP/SSE 上 22/22 断言通过；未发现数据安全、契约失实或明显正确性缺陷。前序审查（T-041）针对本切片提出的 chat 域问题（P1-3 scope 缺省全量读、P1-5 SSE 扇出在 chat withTx 内）在 S1 代码上仍成立，均属设计取舍/加固类，归入 3.2 并给出处置建议；若将军把对话内容视为机密面，请按 R-1 的升级条件裁决。

### 3.2 建议优化

#### R-1 🟠（最高优先）scope 隔离为「列表级软分区」：跨 scope 消息读写凭 conv id 可达，无 scope 列表返回全分区
- 位置：team-hub/server.mjs listConversations（547–553，scope 缺省→WHERE 为空）、listMessages（584–600，无 scope 参数/无归属校验）、GET 路由 1339–1368；配合 hub 默认 HOST 0.0.0.0（47）且读接口不鉴权（authorized 仅 handleWrite 用，841–845）。
- 实测（reviewer 直连 DAO 探测）：① 无 scope 的 listConversations({}) 返回全部 2 个分区会话（含标题）；② 持有 scopeB 会话 id 时，A 侧上下文可直接 listMessages({conv: b.id}) 读到 B 的正文；③ A 侧成员可 postMessage({conv: b.id, by:"alice"}) 写入 B 会话。TC-S1-03 只覆盖列表级反向隔离与「消息 scope 恒等于会话 scope」，未覆盖按 id 直取路径。
- 影响：会话 id 为全局自增整数、可枚举；无 token 部署（默认）下任何能连到 :8787 的读方都可列举全部会话标题并翻读任意消息正文；token 部署也只护写不护读。与 tasks/board 的既有信任模型一致，但 chat 正文敏感度高于任务元数据。
- 修改建议（成本由低到高，请将军拍板取档）：① 文档明示边界（server.mjs 头注释 + README：「chat scope 隔离为列表级；内容面信任局域网/由部署网络边界保障」）；② GET messages 支持可选 scope 且提供时校验 conv.scope 一致，不一致 403/400；③ GET conversations 缺省 scope 时返回空或 400 提示（破坏既有「无 scope 全量」语义，需同步 S2 客户端——恒传 scope，实际无感）；④ 生产建议 hub 绑定 127.0.0.1 或前置鉴权（超出本次 diff，立新任务）。若将军判定 chat 内容需要强分区 → 升为必须修改。

#### R-2 🟠 SSE 扇出无异常隔离且发生在 chat 写事务内：单客户端异常可回滚一次写操作
- 位置：team-hub/server.mjs broadcastAudit（819–822，逐客户端 res.write 无 try/catch、无 res error 监听）；chat 的 audit 在 withTx 内调用（createConversation 537–543 / postMessage 569–576）——与 tasks 侧「路由层先 commit 后 audit」不同。
- 问题：若某 SSE 客户端 socket 在清理前写入抛错（destroyed 竞窗），chat 写的整个事务回滚（会话/消息未落库却报错）；审计 INSERT 与广播同处事务内也拉长写锁持有。TC-S1-15（断开不崩）实测通过，说明现网窗口窄，属加固项。
- 修改建议：broadcastAudit 逐客户端 try/catch（写失败即剔除 eventClients）；订阅处给 res 挂 error 监听清理（1478–1488 已有 close 清理，补 error 即可）；chat 审计是否移出事务（先 commit 再 audit）为取舍，建议至少补注释说明。

#### R-3 🟡 数值参数用 Number() 宽松解析，非规范输入可漏过
- 位置：team-hub/server.mjs GET /api/chat/messages 路由（1358–1362 conv/limit/before 均 Number(...)）；DAO 内同（559、588、592）。
- 问题：conv=1e3、conv=0x10、limit=1e2、前导空白等会被 Number() 接受（如会话 1000 存在时 conv=1e3 等价合法），契约语义外的畸形输入不报 400；非法形态（NaN/小数/≤0）已正确 400（TC-S1-09 实测），故为收严建议。
- 修改建议：路由/DAO 对 conv/limit/before 用 /^\d+$/ 校验后再 Number（或直接用字符串绑定查询），非纯数字 400。

#### R-4 🟡 meta / by / participants 单元素 / readBody 均无长度上限（防膨胀）
- 位置：team-hub/server.mjs postMessage meta（572 JSON.stringify(input.meta) 无上限）、by（526–527/557–558 仅非空校验）、createConversation participants（533–535 仅数量 ≤128、单元素不设长）、readBody（830–839 无体积上限，hub 既有）。
- 影响：消息正文有 8000 上限，但 meta（如大对象）与超长 by/participants 元素可造成审计/表行膨胀；readBody 无上限为 hub 全局既有行为（任意 POST 接口一致），单列成本低。
- 修改建议：meta 序列化后设长度上限（如 ≤16KB，与 MAX_CHAT_BODY 并列常量）；by 与 participants 单元素设上限（如 256/512）；readBody 若要对 chat 收严可加全局 body 上限（跨接口统一，建议立任务评估）。

#### R-5 🟡 TC-S1-15 断言可被 SSE 连接回放满足，证明力弱；注释声称的泄漏检查未实现
- 位置：team-hub/chat-l1-smoke.mjs sseCollector（70–95）＋ TC-S1-15（209–219）。
- 问题：sub2 在 post 前连接，其 seen 会收到连接回放的近 30 条历史（含 member=general 的 chat:message，如 TC-S1-06 的 hello），故「断开后其余订阅端仍收到事件」的断言可能由回放数据满足，而非证明断连后的 live 广播；文件头注释「eventClients 无泄漏」并无对应断言。
- 修改建议：collector 记录连接时点收到的最大 audit seq，断言只看 seq 大于基线的事件（或断言收到含刚发消息 seq 的事件）；泄漏检查可加内部计数（如 /api/events 存活连接数上报）或重复订阅/断开循环后断言服务进程内存/句柄不回涨（后者属 L1 进程级，成本较高，可选）。

#### R-6 🟡 audit() 内两处 now()：SSE 载荷 ts 与落库行 ts 可能不一致
- 位置：team-hub/server.mjs audit（389–395：INSERT 用一次 now()，broadcastAudit 载荷内又 ts: now() 一次）。
- 影响：订阅端收到的审计事件 ts 与 /api/activity 行 ts 可能差 1ms；chat 写使广播频率升高，该不一致更易被观察到。属既有继承行为，非 S1 引入缺陷。
- 修改建议：audit 内先取一次 ts 变量复用于 INSERT 与广播（一行改动）。

#### R-7 🟡 消息 kind=system 未限制发送方（可冒充系统消息）
- 位置：team-hub/server.mjs postMessage（562–563，CHAT_MSG_KINDS 含 system 且任何 by 可用）。
- 影响：任何具备写权限者可用 kind:system 发消息，前端若对 system 样式特殊渲染可能造成误导（当前 S2 纯文本渲染无特殊样式，风险低）。
- 修改建议（产品决策）：system 类消息限定 by=general 或服务端内部专用；或保留现状并在文档注明。

### 3.3 测试/验收注记（不阻塞）

- 覆盖分层完整：DAO 级 TC-S1-01..13、16（chat.test.mjs）；HTTP/SSE/鉴权 TC-S1-01..15、17（chat-l1-smoke.mjs）；TC-S1-18 依赖核对（§0）。文件头注释「对齐 TC-S1-01..18」与分层分布略有出入，建议注释明示各层覆盖号段。
- L1 冒烟为可重复执行资产（node team-hub/chat-l1-smoke.mjs，失败非 0 退出），已在本环境 22/22 通过——满足「事件冒烟固化为可回归资产」的验收意图。
- 沙箱限制记录：node --test 需子进程（EPERM 边界），chat.test.mjs 直跑等价（chat.test.mjs 头注释已说明）；typecheck 需 node_modules junction（宿主可跑，T-045 证据 exit 0）。

### 3.4 继承性观察（非本次 S1 diff 引入，promote 不阻塞）
- 与 T-041 审查衔接：chat 域 P1-3（scope 缺省全量读）、P1-5（SSE 扇出无隔离/在 withTx 内）在本切片代码上依旧成立 → 本报告 R-1/R-2 承接并给出实测与处置建议；P1-4（前端历史仅 50 条）属 S2 前端切片，不在 S1 范围。

---

## 4. 总体判定

- S1 实现质量**良好，验收可推进**：AC1–AC6 全部实测成立；DAO/HTTP 双层契约 + L1 真进程（含 SSE ≤5s、断连韧性、401/200 矩阵）覆盖到位；scope 分区、author 服务端绑定、统一写纪律（audit/SSE）、分页无重无漏、老库幂等迁移等关键面均有测试锚定。
- **无必须修改项，不阻塞 promote**。R-1（chat 内容面 scope 软隔离，含无 token 部署全量可读）与 R-2（SSE 扇出隔离）建议将军裁决处置档位——若 chat 内容属机密，R-1 应升级为必须修改并立修复任务。
- R-3..R-7 为低成本加固/收严项，可并入后续迭代排期。

_审查人：reviewer（T-055）· 依据：S1 代码真读（server.mjs/chat.test.mjs/chat-l1-smoke.mjs + S2 消费方交叉核对）+ §0 独立复跑证据 · 未修改任何实现代码_
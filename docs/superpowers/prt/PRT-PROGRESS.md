# PRT 任务进度表（全 145 项）

> **本文件是「PRT 实施到哪一步」的唯一入口。** spec
> [`2026-09-11-legion-product-runtime-design.md`](../specs/2026-09-11-legion-product-runtime-design.md)
> §12 的 145 个任务是权威清单；本表只记录**状态、证据指针与未交付项**，
> 不重复任务描述。与 spec 冲突时以 spec 为准。
>
> 状态口径：
> - ✅ **已完成**：有代码/文档交付物 + 可复跑的用例或实测证据
> - 🟡 **部分**：交付物已落地但完成标准未全部满足（下表必须写明缺哪一条）
> - ⬜ **未开始**
> - ⏸ **需外部输入**（真实用户、裁决、机器或凭证），代码侧无法单独关闭
>
> ⚠️ 「有用例」不等于「已生效」。带生产调用方的任务在证据栏注明调用方；
> 只有自己的用例驱动的原语一律标 🟡。

**最近更新**：PRT-312 真实进程被强杀的整链路演练（不丢任务 / 不伪装成功 / 不重复外部写）

---

## 阶段 0：冻结基线（10/11）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-001 进程/端口/组件/数据拓扑 | ✅ | `PRT-001-topology-inventory.md`、`prt-001-003-inventory.json`、套件 `prt-topology` |
| PRT-002 DSH/Cordis 依赖清单与静态扫描规则 | ✅ | `PRT-002-dsh-boundary-inventory.md`、`scripts/ci/dsh-boundary.mjs` + 基线 JSON |
| PRT-003 配置/环境变量/密钥/路径来源清单 | ✅ | `PRT-003-config-secret-inventory.md`（声明缺口 0；4 处目录越界写入） |
| PRT-004 软件交付黄金流程与固定输入仓库 | ✅ | `PRT-004-golden-flow.md`（夹具哈希 `9d4d958c…`）、套件 `prt-golden-flow` |
| PRT-005 旧路径任务状态/执行事件/产物/审计证据 | ✅ | `docs/PRT-005-evidence/verify-evidence.md`、套件 `prt-old-path` |
| PRT-006 team-hub 备份与恢复验证 | ✅ | `docs/PRT-006-evidence/backup-restore-evidence.md`（陈旧 WAL 危害实测）、套件 `prt-backup` |
| PRT-007 旧系统功能/HTTP/数据库/执行行为基线 | ✅ | `prt-007-baseline.json`（85 路由 / 22 表 / 7 状态 / 20 迁移边）、套件 `prt-baseline` |
| PRT-008 术语冻结 | ✅ | `prt-010-composition-baseline.json` 内术语表 + 反例表 |
| PRT-009 成功率/人工介入/token/费用/耗时/资源基线 | 🟡 | token 与端到端耗时**已采**；**费用缺有来源单价、峰值资源未采**（阻塞原因见 `docs/PRT-009-evidence/verify-evidence.md` §4） |
| PRT-010 DSH 组合层/profile/bundle/patch 锚点基线 | ✅ | `PRT-010-dsh-composition-baseline.md`、`prt-010-composition-baseline.json` |
| PRT-011 确定 DSH 分发形态 | ✅ | `PRT-011-dsh-distribution-decision.md`（**已裁决：路线 C**） |

## 阶段 1：Runtime Contract（9/9）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-101 RuntimeAdapter / RuntimeCapabilities | ✅ | `runtime/contracts/adapter.mjs`、`index.d.mts` |
| PRT-102 ModelProfile / ModelDescriptor / 验证结果 | ✅ | `runtime/contracts/model.mjs`（含明文密钥结构化拒绝） |
| PRT-103 RunRequest / RunEvent / RunResult | ✅ | `runtime/contracts/run.mjs` |
| PRT-104 标准错误码 / 重试等级 / 用户可见错误 | ✅ | `runtime/contracts/errors.mjs`（16 码版本化映射） |
| PRT-105 取消 / 超时 / 恢复 / UnknownOutcome 语义 | ✅ | `runtime/contracts/contract.test.mjs`（终态唯一、cancel 幂等） |
| PRT-106 Runtime Contract 契约测试 | ✅ | 套件 `runtime-contract`（43 例） |
| PRT-107 内存 FakeRuntimeAdapter | ✅ | `runtime/contracts/fake-adapter.mjs` + 19 例（六条编排路径） |
| PRT-108 禁止新增直接 DSH 调用的静态边界检查 | ✅ | `dsh-boundary` 阶段（秒级门禁），基线 3 文件 / 26 处 |
| PRT-109 精确主版本校验与 capabilities 协商 | ✅ | `runtime/contracts/adapter.mjs`（必需能力缺失 → `UNSUPPORTED_CAPABILITY`） |

## 阶段 2：DshRuntimeAdapter（10/15）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-201 包装模型读取与 ModelProfile 转换 | ✅ | `runtime/adapters/dsh/*`，套件 `dsh-adapter`（85 例） |
| PRT-202 包装 `subagents.start` 与运行标识映射 | ✅ | 同上 |
| PRT-203 转换 DSH 流式事件与最终结果 | ✅ | `runtime/adapters/dsh/events.mjs` |
| PRT-204 结构化输出校验 | ✅ | `runtime/adapters/dsh/schema.mjs`（旧路径不校验，见 PRT-210 intended 差异） |
| PRT-205 取消、超时与生命周期清理 | ✅ | `runtime/adapters/dsh/adapter.test.mjs`（看门狗 / abort 无效用例） |
| PRT-206 异常标准化与重试分类 | ✅ | `runtime/adapters/dsh/errors.mjs` |
| PRT-207 采集模型 / token / 费用估算 / 耗时 | 🟡 | 采集已实现；**费用估算因单价缺失返回 `null`**（与 PRT-009 同一阻塞） |
| PRT-208 日志、异常与事件脱敏 | ✅ | `runtime/adapters/dsh/redact.mjs` |
| PRT-209 DSH 版本与能力探测 | ✅ | `runtime/adapters/dsh/probe.mjs` |
| PRT-210 旧调用与 Adapter 路径对拍测试 | ✅ | `parity.mjs` + 套件 `dsh-parity`（36 例，violations = 0，漂移检测 `drifted = false`） |
| PRT-211 continuable session 边界验证 | 🟡 | **接口面已验证**；运行时行为 `behavior-unverified`（需真实 parent/child 会话对，属阶段 3） |
| PRT-212 最小 DSH 强制面（Guard / pre-execute / answerer） | 🟡 | `runtime/dsh-composition/enforcement.mjs`（34 例）；**审批 answerer 尚未接 team-hub 审批箱**，无生产调用方 |
| PRT-213 探测 sandbox backend 与 enforcement | ✅ | `runtime/dsh-composition/selfcheck.mjs`（`full`/`partial` 判据） |
| PRT-214 Legion DSH 组合补丁层与员工 agent preset | 🟡 | 声明 + 生成物 `legion-host.patch.yml` 已就绪；**补丁层未落盘应用**（profile 层 `patchReload: live`，写入会立刻改变运行中的强制面） |
| PRT-215 补丁层应用与强制面生效启动自检 | 🟡 | 自检门禁已实现（`incompatible` 判定）；因未落盘，**自检目前没有真实调用方** |

## 阶段 2.5：商业薄垂直切片（2/8）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-251 最小 Product Launcher | ✅ | `product/launcher/*`、套件 `product-launcher`（57 例，含 3 例真实进程）、`PRT-251-product-launcher.md`；`--check` 如实报出两个入口缺口 |
| PRT-252 Workbench 模型配置产品化校验 | ⬜ | |
| PRT-253 单员工黄金任务迁移到 RuntimeAdapter | ⬜ | |
| PRT-254 per-user 数据目录 + Secret Store 最小闭环 | 🟡 | **目录布局与密钥库都已冻结**（`product/paths.mjs`、`security/secrets/`）；**密钥库仍无生产调用方**（PRT-501/253 接线），写路径已由 Launcher 指到 DataDir |
| PRT-255 隔离测试空间安装/运行/取消/重启/诊断验证 | ⬜ | |
| PRT-256 设计伙伴独立完成真实低风险任务 | ⏸ | 需真实外部用户 |
| PRT-257 Launcher 负责 DSH 运行时与补丁层安装/自检/修复 | ⬜ | 分发形态路线 C 已裁决；Legion 自身四个 `file:` 包的分发方式待定 |
| PRT-258 冻结进程清单 / 目录布局 / 配置 Schema / Secret Store 接口 | ✅ | 四份契约全部有实现与用例：`PRT-258-product-contracts.md`（前三份）+ `PRT-505-secret-store.md`（第四份） |

## 阶段 3：Orchestrator Core（12/16）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-301 持久化运行状态机 | ✅ | `orchestrator/state-machine/*`（13 态、CAS 迁移、具名拒绝码、失败分类、恢复判定）+ `orchestrator/worker/*` + 入口 `product/orchestrator/worker.mjs`；套件 `orchestrator`（56 例含 1 例真实进程）。**`MANIFEST_KNOWN_GAPS` 的 ENTRY_MISSING 已随之消失**（门禁先红后改） |
| PRT-302 task lease、租期与 heartbeat | ✅ | `team-hub/run-store.mjs`（`claim`/`heartbeat`/`release`、`lease_epoch`、到期时间与恢复扫描）+ `/api/runtime/{claim,heartbeat,release,recover,status,attempt}`；套件 `run-plane`。判据：权威时间只在服务端（客户端 `nowMs` 被忽略并回显在 `ignoredClientFields`）、同一条任务并发领取只有一个赢家、释放后**立刻**可被别的 worker 领走（不是等租期过期） |
| PRT-303 attempt 与不可覆盖历史 | ✅ | `run_attempts`（`UNIQUE(task_id, attempt_no)`）+ 只追加的 `run_attempt_events`（无 `updated_at` 列，结构上无法改历史）+ `historyOf`/`eventsOf`。重试经 `RetryableFailure → Queued` 的 `createsNewAttempt` **新建**尝试，旧尝试的作用域、失败码与原因原样保留 |
| PRT-304 提取任务扫描与认领 | ⬜ | 运行面已有 `claim` 的完整实现与 HTTP 路由；「提取 `plugins/src/index.ts` 的扫描/认领」属 PRT-315/316 的同批拆分 |
| PRT-305 提取岗位、流水线与团队快照 | ✅ | `orchestrator/pipeline/index.mjs`（**纯函数**：`indexStages` 按 role 索引、`pipelineView` 报结构完整性、`resolveNextPost` 回答"后面还有没有岗位"、`buildHandoffTask` 拼装交接任务）+ `GET /api/runtime/next-post`；套件 `pipeline`（16 例）。**核心判据是把「链断」与「链尾」分开**：两者在数据上长得一模一样（都表现为"查不到下一岗位"），而前者是配置错误（`next` 拼错、或下一岗位被停用、或任务上记的岗位已改名）、后者是正常的。当成链尾会让任务链静默断在这里，直到整个目标停住才被发现。`next` 是**没有外键约束**的字符串，所以这件事只能靠判定兜住 |
| PRT-306 提取 workspace/worktree 管理 | ⬜ | |
| PRT-307 提取结构化结果与机器验收 | ✅ | `orchestrator/acceptance/index.mjs`（**纯函数**：判据核验 + 结论到去向的映射）+ `run_validations` 只追加表（结论与**当时用的判据**一起落库）+ `runStore.recordValidation/validationsOf/criteriaOf` + `POST /api/runtime/validate`、`GET /api/runtime/validations`；套件 `acceptance`（24 例）、`acceptance-store`（16 例）、`acceptance-routes`（10 例）。判据有四条：① **三种结论而不是布尔**——`accepted`/`rejected`/`needs-human`，因为"没通过"的两种成因（机器确认不满足 / 机器判不了）走的路完全不同，合成一个 `false` 时选哪条都是错的；② 判据**封闭**——不在已登记种类里的一律算"判不了"而**不是**通过，新增一种必须显式加进清单；③ **散文判据 = 人工判据**（`tasks.acceptance` 由 `stage-standards.mjs` 生成的正是散文），任务只带散文判据时结论必然是 `needs-human`，这是对的——从没人说过"什么叫做完了"；④ 状态机声明的 `requiresPersist: ['attempt','validation']` **真的被核验**：一条从未被验收过的尝试进 `Completed` 会被 409 `EVIDENCE_MISSING` 拒绝（只记录不核验时那句话只是事件流里的一段 JSON，而"没人验收过"会被写成"已验收"）。**这条路抓到一个真实缺陷**：交付级审批（`Validating → AwaitingApproval`）的任务在看板上显示为 `in_progress` 而不是 `in_review`——因为投影读的是**边**的 hint 而不是刚写进那一行的 `returnTo`；审批人于是以为活还在干，任务既不在待办里也没人在跑。**执行成功不再等于交付完成**：PRT-312 那条用例留下的"成功永远停在 `Validating`"由此收口 |
| PRT-308 提取打回、交接与完成 | ✅ | **打回**（`rejected` → 经 `scheduleRetry` 重试或 Dead Letter）、**完成**（`accepted` + `hasNextPost=false` → `Completed`）随 PRT-307 落地；**交接**随本批落地：`runStore.handoff` 在**一个事务**里建后继任务 + 记 `run_handoffs` + 收口，`createTask`/`readPipeline` 由 server 注入（运行仓储不认识那两张表的 schema，但注入的实现跑在它的事务里）。判据四条：① spec 第 333 行的「**原子**创建/释放下一岗位任务」——建任务失败时整笔回滚，不留孤儿后继（有用例撞唯一索引验证）；② **幂等**靠 `run_handoffs` 查询 + `successor_id` 上的**唯一索引**两处，且都在同一事务里——只在应用层查重时两个并发进程会各建一条（与 `ensureColumn` 那次的失败模式一样）；③ `HandingOff → Completed` 要 `handoff` 证据，**没有后继就收口会被 409 拒绝**，否则任务链静默断在这里；④ `successor_id` 建出后若 `createTask` 没返回 id 一律拒绝，不把"下一岗位已建好"写成事实。套件 `handoff-store`（12 例）、`handoff-routes`（8 例）。**这条路抓到一个真实缺陷**：`server.mjs` 与 `run-store.mjs` 各有一个 `withTx`，两个闭包各记各的 `txDepth`——`createTask` 进到运行仓储已开启的事务里时以为自己在最外层，于是又发一次 `BEGIN IMMEDIATE`，报 `cannot start a transaction within a transaction`；修法是把函数体拆成 `createTaskInTx`，由调用方声明"我已经在事务里了" |
| PRT-309 重试、退避与 Dead Letter | ✅ | `scheduleRetry`（重试/放弃的**唯一**决策点）+ `failAndRetry` + 退避写进队列 `next_attempt_at_ms`（真的生效，不是没人调用的纯函数）+ 额度上限（默认 5 次）+ `retryDelayMs` 指数退避；`/api/runtime/fail`（失败结算的唯一入口）与 `/api/runtime/budget`。判据：额度耗尽必进 `DeadLetter`（终态），且回收路径**同样**查额度——否则"每次快失败就被杀"的任务会永远重试 |
| PRT-310 恢复扫描与人工处置 | ✅ | `recoverExpired` 两条分支 + `listHeld`（`UnknownOutcome`/`DeadLetter` 待办清单，标出 `isLatest` 避免历史条目反复出现）+ `resolveAttempt`（四种决定各自对应一个不同的事实，缺省拒绝不猜）；路由 `GET /api/runtime/held` 与 `POST /api/runtime/resolve`。判据：挂起的任务必须能从界面找到并逐个结清，否则"不会静默重跑"会变成"静默消失" |
| PRT-311 外部副作用幂等与 Unknown Outcome | ✅ | ① **幂等键跨尝试稳定**（`idem:{taskId}`，刻意不含 `attempt_no`——含了就等于没有）；② 状态机为 `UnknownOutcome` 补 `Validating`（确认已发生 → 按成功走验收，绝不重跑）与 `RetryableFailure`（确认未发生 → 降级为普通可重试失败）两条出边，`UnknownOutcome → Queued` **仍然非法**；③ 两个守卫要求显式布尔值，缺省报 `MISSING_GUARD_INPUT`。判据：对账的两个确定结论都能被记下来——原来一个只能被当失败重做（重复付费），一个永远等人工 |
| PRT-312 状态迁移 / 并发 / 崩溃 / 恢复测试 | ✅ | 13×13 迁移矩阵、CAS 竞态、两连接并发领取、过期 epoch 拒写、崩后回收两条分支、**真进程被强杀**的整链路演练（`run-kill-drill` 2 例：真 worker 进程 + 真 team-hub，`SIGKILL` 后逐条验阶段 3 完成标准的三个分句「不丢任务 / 不伪装成功 / 不重复执行已确认的外部写操作」，并用 marker 文件数外部写的**次数**）+ 多进程并发（PRT-314）+ 运行面用例。**这条用例抓到的第一件事**是"执行成功 ≠ `Completed`"：成功入 `Validating`。当时我写的是断言 `Completed`——它暴露了一个真实的诱惑：为了让用例变绿而把"执行完"写成"已完成"，那正是完成标准里"不伪装成功"要禁的事。该落点已由 PRT-307 补上后续（`Validating` 现在真的能被验收，并按结论收口） |
| PRT-313 lease 权威时间、`leaseEpoch`、过期拒写 | ✅ | `lease_epoch` 单调、每次 `claim`/`release`/回收都推进；过期写入返回 `LEASE_EPOCH_STALE` 且**带上真实 epoch**（否则 worker 只能无限重试）；`/api/config` 增加 `runPlane` 能力发现位 |
| PRT-314 WAL / `busy_timeout` / 原子领取并发语义 | ✅ | 真**操作系统进程**并发（`team-hub/scripts/claim-probe.mjs` + `run-concurrency` 套件 5 例）：WAL 跨进程可见、`busy_timeout` 在锁争用下按预算等待而不是抛 SQLITE_BUSY、6 个进程同时抢同一条任务**恰好一个赢**（不重复执行的数据面保证）、并发补列不崩。原子原语提取到 `team-hub/schema-util.mjs`（`BEGIN IMMEDIATE` 内重读后 ALTER）。**这条用例当场抓到过真实缺陷**：非原子 `ensureColumn` 让两个并发启动的进程各执行一次 ALTER，后者在模块加载期因 `duplicate column name` 崩溃 |
| PRT-315 拆分 `plugins/src/index.ts` | ⬜ | 阶段 3 评审闸门已过（热点文件 1/40、2/40） |
| PRT-316 team-hub 模块提取 | ⬜ | 需排在启动期并发迁移加固沉淀一个发布周期之后。运行面仓储已按此方向**新建在独立模块**（`team-hub/run-store.mjs`）而不是继续堆积 `server.mjs` |

## 阶段 4：上下文边界（0/13）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-401 Context Source 与 RunContextSnapshot | ⬜ | |
| PRT-402 接入 TeamPlan 与 EmployeeManifest | ⬜ | |
| PRT-403 接入目标上下文与 `contextVersion` | ⬜ | |
| PRT-404 接入任务、评论与用户反馈 | ⬜ | |
| PRT-405 接入上游员工交付与产物 | ⬜ | |
| PRT-406 接入已发布 Skills 与显式文档 | ⬜ | |
| PRT-407 作用域、权限、预算与裁剪 | ⬜ | |
| PRT-408 脱敏、来源清单与内容哈希 | ⬜ | |
| PRT-409 持久化快照并支持查看导出 | ⬜ | |
| PRT-410 确定性 / 越权 / 超限 / 回放测试 | ⬜ | |
| PRT-411 冻结时点与运行中更新规则 | ⬜ | |
| PRT-412 标记不可信来源并验证不能扩权 | ⬜ | |
| PRT-413 canonical JSON、tokenizer 与保守估算降级 | ⬜ | |

## 阶段 5：模型和密钥配置（0/11）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-501 ModelProfile 数据模型与 API | ⬜ | 校验函数已在 `runtime/contracts/model.mjs` |
| PRT-502 岗位模型绑定与 fallback | ⬜ | 旧路径实测**按岗位模型未生效**（`gf001-run.mjs` 的 `modelDrift`） |
| PRT-503 单次运行与岗位预算策略 | ⬜ | |
| PRT-504 模型连通性与能力测试 | ⬜ | |
| PRT-505 Windows Secret Store | 🟡 | `security/secrets/`（DPAPI 往返实测 + fail-closed + 六条出口脱敏）、套件 `secret-store`；**尚无生产调用方**；与 `$DSH_HOME/.credentials.yaml` 的收敛属 PRT-257 |
| PRT-506 迁移现有非敏感模型配置 | ⬜ | |
| PRT-507 Workbench 模型设置页面 | ⬜ | |
| PRT-508 配置导入导出（排除密钥） | ⬜ | |
| PRT-509 密钥读取 / 轮换 / 删除 / 泄漏测试 | 🟡 | 读取/轮换/删除的泄漏断言已入 `secret-store` 套件；**跨账户与 ACL 加固未做** |
| PRT-510 预算原子预留、结算、取消与 Unknown Outcome 锁定 | ⬜ | |
| PRT-511 冻结价格表版本、币种、计价单位与生效时间 | ⬜ | |

## 阶段 6：工具、权限和审批（1/20）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-601 工具能力描述与风险等级 | ⬜ | |
| PRT-602 DSH Enforcement Bridge 与统一 ToolRequest 投影 | ⬜ | |
| PRT-603 接入 EmployeeManifest 工具白名单 | ⬜ | |
| PRT-604 文件与工作目录范围限制 | ⬜ | |
| PRT-605 命令、网络与 MCP 权限控制 | ⬜ | |
| PRT-606 外部 API 读 / 写权限区分 | ⬜ | |
| PRT-607 审批箱与无人值守策略 | ⬜ | |
| PRT-608 审批绑定规范化操作哈希 | ⬜ | 哈希原语已在 `runtime/dsh-composition/enforcement.mjs` |
| PRT-609 字段变化后审批失效 | ⬜ | |
| PRT-610 持久化工具调用、决定来源、结果与幂等键 | ⬜ | |
| PRT-611 扩展 F-02 canonical operation | ⬜ | |
| PRT-612 Legion 权限语义到强制面的固定映射 | 🟡 | 映射表与 preset 声明已在 `runtime/dsh-composition/`；**无生产调用方** |
| PRT-613 审批/UI/审计/执行看到同一不可变参数 | ⬜ | |
| PRT-614 新强制面前禁用 legacy 高风险工具 + 发布门禁 | ⬜ | |
| PRT-615 审批 TTL 与 lease/heartbeat 交互 | ⬜ | |
| PRT-616 `allow-once` 原子 CAS 消费 | ⬜ | |
| PRT-617 策略门与 answerer 双段超时 + `unavailable` + 决定来源审计 | 🟡 | 双段超时与 fail-closed 原语已实现（`enforcement.mjs` + 34 例）；**未接真实 team-hub** |
| PRT-618 声明 `legion-attended` / `legion-unattended` preset 表 | ✅ | `runtime/dsh-composition/patch-layer.mjs`（`legion-unattended` 锁死 `workspace-write`） |
| PRT-619 Run 期间 policy/preset 冻结与改写审计 | ⬜ | |
| PRT-620 pre-execute 放行与 ToolGuard 拒绝的一致性不变量 | 🟡 | 用例已就位；**需真实组合面生效才成立**（依赖 PRT-214/215 落盘） |

## 阶段 7：Product Launcher（5/13）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-701 进程清单、启动依赖与健康协议 | ✅ | 清单/波次已冻结（`product/process-manifest.mjs`）；就绪判据含**身份断言**并由套件 `product-launcher` 在真实进程上**实测**（`readiness.mjs` + `measureReadiness`） |
| PRT-702 统一启动、停止与状态查询 | ✅ | `product/launcher/launcher.mjs`（start/stop/status/retry + 六态映射）+ `cli.mjs`；`--check` 体检与退出码契约例 |
| PRT-703 端口冲突 / 依赖缺失 / 配置错误诊断 | ✅ | `ports.mjs`（可绑性 vs 是否有人在听、同批端口重复申请）+ `readiness.mjs`（失败分类：可重试 vs 立刻失败）；真实进程用例证明**身份不符不等超时**。配置侧由 `config.mjs` 补齐：坏 JSON / 读不出 / 类型不符 / 明文密钥 / UTF-8 BOM，配 `product-config` 套件 |
| PRT-704 子进程监督、退避重启与熔断 | ✅ | `supervisor.mjs`（按存活时长重置退避 + 连续快速失败熔断 + 人工 reset）；原 `services-plugin` 无熔断，会以 30s 周期永远重启 |
| PRT-705 优雅关闭与僵尸进程清理 | 🟡 | 已做 SIGTERM→宽限→杀**进程树**（Windows `taskkill /T /F`）并在真实进程用例里断言停止后端口可绑；**日志轮转/托盘/僵尸兜底扫描未做** |
| PRT-706 产品目录与首次运行初始化 | ✅ | `product/init.mjs` + `cli.mjs --init [--dry-run]`：建 DataDir/Cache/Log 与各进程写入子目录、写默认产品配置与 `product.json` 元数据、幂等且**不覆盖用户配置**；三条拒绝边界（不写安装目录 / 不替用户建工作区 / 布局有错时一个目录都不建）各有用例 |
| PRT-707 首次运行向导 | ⬜ | |
| PRT-708 系统托盘与打开 Workbench | ⬜ | |
| PRT-709 日志轮转与磁盘保护 | ⬜ | |
| PRT-710 脱敏诊断包导出 | ⬜ | |
| PRT-711 Runtime 健康状态到产品状态的映射 | 🟡 | `productStateOf` + `PRODUCT_STATE_TEXT` 已实现六态中的五态并有用例；**`incompatible`/`upgrading` 需版本清单（PRT-801）才有判据来源** |
| PRT-712 本地队列 / lease / 重试 / 死信 / 可用率指标 | ⬜ | |
| PRT-713 显式选择加入的脱敏健康心跳 | ⬜ | |

## 阶段 8：安装、升级和回滚（0/13）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-801 产品版本清单 | ⬜ | |
| PRT-802 锁定 DSH 与依赖精确版本 | ⬜ | |
| PRT-803 可签名安装包 | ⬜ | |
| PRT-804 升级包、清单签名与完整性校验 | ⬜ | |
| PRT-805 升级前兼容性 / 磁盘 / 在途任务检查 | ⬜ | |
| PRT-806 数据库与配置自动备份 | 🟡 | 备份/恢复路线已验证（PRT-006）；**自动备份未实现** |
| PRT-807 幂等数据库迁移框架 | ⬜ | |
| PRT-808 原子程序切换与升级健康检查 | ⬜ | |
| PRT-809 安全回滚或向前修复 | ⬜ | PRT-006 已定「恢复前必须删 `-wal`/`-shm`」 |
| PRT-810 internal / canary / stable 通道 | ⬜ | |
| PRT-811 升级审计、发布说明与用户通知 | ⬜ | |
| PRT-812 N-1 升级窗口、备份保留与恢复演练 | ⬜ | |
| PRT-813 Windows 文件占用 / Defender 延迟 / 长路径 / 子进程树退出 | ⬜ | |

## 阶段 9：商业 Alpha 发布保障（0/10）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-901 第三方许可证清单与 SBOM | ⬜ | PRT-011 已确认 DSH 为 MIT |
| PRT-902 DSH / 供应商 / 依赖商业分发条件 | ⬜ | |
| PRT-903 隐私、数据处理与模型调用说明 | ⬜ | |
| PRT-904 日志、执行事件与产物保留策略 | ⬜ | |
| PRT-905 备份、恢复与数据导出入口 | ⬜ | |
| PRT-906 崩溃报告授权与脱敏策略 | ⬜ | |
| PRT-907 支持诊断与故障处置手册 | ⬜ | |
| PRT-908 卸载数据保留与彻底删除选择 | ⬜ | |
| PRT-909 产品发布检查清单 | ⬜ | |
| PRT-910 内部与金丝雀真实项目验证 | ⏸ | 需真实用户项目 |

## 阶段 10：能力包协议（0/6）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-1001 PackManifest / 类型 / 语义版本 / 协议版本 | ⬜ | |
| PRT-1002 内容哈希、签名/来源、依赖与兼容性预检 | ⬜ | |
| PRT-1003 安装、启用、停用与升级记录 | ⬜ | |
| PRT-1004 不可变 CompiledTeamPlan 与运行中版本固定 | ⬜ | |
| PRT-1005 能力包不得携带密钥 / 扩权 / 绕过强制面 | ⬜ | 判据可复用 `findPlaintextSecrets` |
| PRT-1006 软件交付团队整理为首个内置能力包 | ⬜ | |

---

## 汇总

| 阶段 | 已完成 | 部分 | 未开始 | 需外部输入 | 合计 |
| --- | --- | --- | --- | --- | --- |
| 0 冻结基线 | 10 | 1 | 0 | 0 | 11 |
| 1 Runtime Contract | 9 | 0 | 0 | 0 | 9 |
| 2 DshRuntimeAdapter | 10 | 5 | 0 | 0 | 15 |
| 2.5 商业薄切片 | 2 | 1 | 4 | 1 | 8 |
| 3 Orchestrator Core | 12 | 0 | 4 | 0 | 16 |
| 4 上下文边界 | 0 | 0 | 13 | 0 | 13 |
| 5 模型与密钥 | 0 | 2 | 9 | 0 | 11 |
| 6 工具、权限和审批 | 1 | 3 | 16 | 0 | 20 |
| 7 Product Launcher | 5 | 2 | 6 | 0 | 13 |
| 8 安装、升级和回滚 | 0 | 1 | 12 | 0 | 13 |
| 9 商业 Alpha 保障 | 0 | 0 | 9 | 1 | 10 |
| 10 能力包协议 | 0 | 0 | 6 | 0 | 6 |
| **合计** | **49** | **15** | **79** | **2** | **145** |

> 计数口径：**部分**计入「已有交付物但完成标准未全部满足」，
> 因此不能与「已完成」相加后宣称完成度。真实完成度按**完成标准**判定：
> 阶段 0～2 的完成标准已满足或已写明未满足项，阶段 2.5 及其后均未达标。

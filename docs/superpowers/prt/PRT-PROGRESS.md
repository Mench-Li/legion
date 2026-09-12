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

## 阶段 2.5：商业薄垂直切片（3/8）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-251 最小 Product Launcher | ✅ | `product/launcher/*`、套件 `product-launcher`（57 例，含 3 例真实进程）、`PRT-251-product-launcher.md`；`--check` 如实报出两个入口缺口 |
| PRT-252 Workbench 模型配置产品化校验 | ✅ | `runtime/contracts/model-config.mjs`（**纯函数**，套件 `model-config`，18 例）把"配置错误"从"运行时失败"里抢回来：**校验不了 ≠ 配置错了**（读不到仓储 → `CANNOT_VALIDATE` 且 **fail closed**，报"未知供应商"是撒谎）、**一个档案都没有 ≠ 未知供应商**（该做的是先去登记）、**合法 ≠ 能跑**（缺凭证/停用是**警告**不是拒绝，但必须显示——不允许"看起来成功了但跑不了"）。型号**不做模糊匹配**；档案两种形态都没有凭证字段时**不报**（猜"没有"会制造永远不对的告警）。接线：`POST /api/models` 配置期校验 + `handleWrite` 透出 `code`/`field`/`hint`/`candidates`；端到端实测返回 400 + 可读文案。**已知盲区**：接线用例是**源码断言**，抓得住"调用被删掉"、**抓不住"语义被削弱"**（已写明）。**未交付**：前端仍从硬编码 `MODEL_OPTIONS` 渲染、未消费 `field`/`hint`（PRT-507）；档位不在产品档案里；hub 路由测试未纳入套件 |
| PRT-253 单员工黄金任务迁移到 RuntimeAdapter | ⬜ | |
| PRT-254 per-user 数据目录 + Secret Store 最小闭环 | 🟡 | 目录部分由 PRT-258 的 `product/paths.mjs` 承载（五角色隔离、配置优先级、越界诊断）；**本批补上 Secret Store 最小闭环**：新增 `product/secrets.mjs` + 套件 `product-secrets`（**23 例**），`resolveLayout() → layout.secretsFile → createProductSecretStore → createSecretResolver → 启动自检`——这把连续三份文档都记为「**尚无生产调用方**」的那根线接上了（**一份没人用的密钥库等于没有密钥库**），关键断言是"解析器**真的解出了明文**并能喂给探测执行器"，而不是"函数存在"。**密钥库刻意不在 DataDir 内**（默认 `<产品家目录>/secrets/credentials.json`，与 `dataDir` 是**兄弟**）：**DataDir 是备份、恢复、诊断包导出、整目录拷贝处理的那一个目录**，密钥库落在里面会被任何"把 DataDir 打个包"的操作**顺手**带走，而 spec §3.1 要求密钥不得进入**导出证据**与**能力包**；放在外面，这类泄漏就从"需要每个人每次都记得"变成"结构上做不到"——**一道看不见某类变化的大门比没有大门更坏；反过来也成立：一道不需要人记住的大门才真的守得住**。三条 `error` 诊断把它结构化：`SECRETS_INSIDE_DATA_DIR`（备份会带走）/ `SECRETS_INSIDE_INSTALL_DIR`（升级会替换，而密钥库**机器与账户绑定**，换机器换账户都解不开）/ `SECRETS_INSIDE_CACHE_DIR`（缓存被定义为可安全删除，而删掉之后**无法找回**）；`openProductSecrets` **自己再判一次**而非只信调用方，位置不合法时**连库都不打开**。**明文后端 fail closed，但把"放开"做成一次说出来的选择**（错误文案里直接写出 `requireProtected: false` 怎么写——**一个让人猜不到怎么放开的门禁最后会被人绕过；一个写清怎么放开的门禁，至少让绕过成为一个被记录下来的决定**）；**自检返回结果而不抛**（与既有"形状错误抛出、配置问题返回值"同一条分界）；底层异常 `message` **被收敛掉**（只留 `err.name`）；本模块**不读 `process.env`**，ACL 的 `owner` 是显式入参、**不给就不加固**（**猜一个主体去授权等于把权限给错人，而猜错的失败方向是"给了别人权限"**）。**抓到的问题**：① ACL 检查不传 `owner` 而 `icacls` **不标出**所有者 → 真所有者被当成越权、干净 ACL 永远显示"越权"（fail closed 所以看起来没问题，但**一个永远在报错的警告与没有警告是同一件事**）；② **该缺陷一开始被加固路径掩盖**（判越权 → 加固 → 复验通过 → 看起来正常），补用例"**本来就干净的 ACL 不得触发加固**"钉住——通用形式：**一个"反正最后是对的"的实现，会掩盖它多做了一件不该做的事**；③ 测试自身两处错误（`assert.equal(arr, [])` 按引用比较；"加固被调用"用例加固前后返回**同一份干净 ACL**，断言是对着一次**根本没发生**的加固通过的）。**仍未做**：**Launcher 还没调用 `openProductSecrets`**（线的一端还没插上，接线位置 PRT-257）；**`owner` 没有来源**（所以默认情况下加固不会发生，只被报成"未加固"）;**密钥库无并发保护**（Launcher 与 worker 同时打开时的读-改-写竞争未处理，而多个 Runtime 并存是正常形态）；**未阻止跨机器拷贝**（DPAPI 绑定，拷过去只是 `SECRET_DECRYPT_FAILED`，没有"这台机器的库是新的"这类标记）；`LEGION_SECRETS_FILE` 可指到网络盘而无检查；`count` 用 `store.list()` 无分页无上限；**与 `$DSH_HOME/.credentials.yaml` 的对账仍未解**（spec 附录 A.2 第 2 条要求**不要另建密钥库**，而本模块恰恰是另建的那一个——张力与两条候选路线见 `PRT-509-file-acl-hardening.md` §9，**需产品决策"哪一个是权威"**）；**「一键启动」的端到端验证没做过**（安装 → 初始化 → 打开密钥库 → 录入凭证 → 探测通过）。详见 docs/superpowers/prt/PRT-254-secret-store-closure.md；**生产调用方已由 PRT-257 接上**：`product/launcher/secrets-check.mjs` 在启动前调用 `openProductSecrets`，并按"是否制造新危险"决定**阻止启动**还是**仅提醒** |
| PRT-255 隔离测试空间安装/运行/取消/重启/诊断验证 | ⬜ | |
| PRT-256 设计伙伴独立完成真实低风险任务 | ⏸ | 需真实外部用户 |
| PRT-257 Launcher 负责 DSH 运行时与补丁层安装/自检/修复 | 🟡 | **本批交付「自检」的一半**：`product/launcher/secrets-check.mjs` 把 `openProductSecrets` 接到 `preflight()` 上（套件 `launcher-secrets`，17 例 + `launcher.test.mjs` 4 条接线用例）。**分界**：**阻止启动的，是"启动本身会制造新的危险"；只提醒的，是"现在就不工作"**——明文后端与密钥库落在 DataDir/InstallDir/CacheDir 是 error，打不开/ACL 过宽/ACL 查不出来/平台不支持只是 warn（该提醒却阻止会让用户**被锁在门外**，而修它的 Workbench 也在被启动的东西里）。新增 `ACL_NOT_CREATED` 与 `ACL_UNVERIFIABLE` **分开**（两者都是 ok:false，区别在"有没有东西可保护"），否则新装机器上每次启动都报一条**永远不对**的告警。**顺带修掉一截空接线**：ACL 检查在生产里从来没有 runner（`run: run ?? undefined`，无调用方传 `run`），整套 PRT-509 实现每次真实检查都只说"没查过"——**功能有了、接线也有了，而中间那一截是空的，且是安静地空的**；现由 `createSystemRunner()` 默认使用，本机真实输出 `ACL_TOO_PERMISSIVE` 并点名 `Amench\CodexSandboxUsers`。**未交付**：`owner` 无来源（**加固默认不发生**）；无并发写保护；无跨机器复制防护；`LEGION_SECRETS_FILE` 指向网络盘未检查；`count` 用无界 `store.list()`；与 `$DSH_HOME/.credentials.yaml` 的关系未定；"一键启动"端到端未验证 |
| PRT-258 冻结进程清单 / 目录布局 / 配置 Schema / Secret Store 接口 | ✅ | 四份契约全部有实现与用例：`PRT-258-product-contracts.md`（前三份）+ `PRT-505-secret-store.md`（第四份） |

## 阶段 3：Orchestrator Core（13/16）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-301 持久化运行状态机 | ✅ | `orchestrator/state-machine/*`（13 态、CAS 迁移、具名拒绝码、失败分类、恢复判定）+ `orchestrator/worker/*` + 入口 `product/orchestrator/worker.mjs`；套件 `orchestrator`（56 例含 1 例真实进程）。**`MANIFEST_KNOWN_GAPS` 的 ENTRY_MISSING 已随之消失**（门禁先红后改） |
| PRT-302 task lease、租期与 heartbeat | ✅ | `team-hub/run-store.mjs`（`claim`/`heartbeat`/`release`、`lease_epoch`、到期时间与恢复扫描）+ `/api/runtime/{claim,heartbeat,release,recover,status,attempt}`；套件 `run-plane`。判据：权威时间只在服务端（客户端 `nowMs` 被忽略并回显在 `ignoredClientFields`）、同一条任务并发领取只有一个赢家、释放后**立刻**可被别的 worker 领走（不是等租期过期） |
| PRT-303 attempt 与不可覆盖历史 | ✅ | `run_attempts`（`UNIQUE(task_id, attempt_no)`）+ 只追加的 `run_attempt_events`（无 `updated_at` 列，结构上无法改历史）+ `historyOf`/`eventsOf`。重试经 `RetryableFailure → Queued` 的 `createsNewAttempt` **新建**尝试，旧尝试的作用域、失败码与原因原样保留 |
| PRT-304 提取任务扫描与认领 | ⬜ | 运行面已有 `claim` 的完整实现与 HTTP 路由；「提取 `plugins/src/index.ts` 的扫描/认领」属 PRT-315/316 的同批拆分 |
| PRT-305 提取岗位、流水线与团队快照 | ✅ | `orchestrator/pipeline/index.mjs`（**纯函数**：`indexStages` 按 role 索引、`pipelineView` 报结构完整性、`resolveNextPost` 回答"后面还有没有岗位"、`buildHandoffTask` 拼装交接任务）+ `GET /api/runtime/next-post`；套件 `pipeline`（16 例）。**核心判据是把「链断」与「链尾」分开**：两者在数据上长得一模一样（都表现为"查不到下一岗位"），而前者是配置错误（`next` 拼错、或下一岗位被停用、或任务上记的岗位已改名）、后者是正常的。当成链尾会让任务链静默断在这里，直到整个目标停住才被发现。`next` 是**没有外键约束**的字符串，所以这件事只能靠判定兜住 |
| PRT-306 提取 workspace/worktree 管理 | ✅ | `orchestrator/workspace/index.mjs`（真 `git worktree`：`planWorkspace` 规划期拒绝、`createWorkspace` 先落意图再做副作用、`reclaimWorkspace` 删除是拒绝边界）+ `worktreeStages()` 声明 `workspaceIsolation: 'worktree'` + worker 接线（`LEGION_WORKSPACE_DIR`、`resolveWorkspaceStages`、状态文件 `workspaceMode` 四态）；套件 `workspace`（24 例，跑真 git）、`workspace-wiring`（9 例）。判据四条：① **按 Attempt 分配**（不按 Task）——按 Task 时重试会继承上一次的半成品改动，于是"上次改坏了"的东西这次看起来是"已经改好了"；② **拒绝嵌套布局**——worktree 落在仓库内部会出现在主仓库的 `git status` 里，另一个 worker 的 `git add -A` 会把它整棵树提交走，本模块不靠"记得加 .gitignore"来防；③ **删除是拒绝边界**——有未提交改动就拒绝回收，`force` 也不越过（一个布尔开关不该成为丢掉别人唯一一份成果的入口），陌生目录一律拒绝覆盖；④ **「git 说成功」≠「工作区可用」**——建完重读登记表，没有登记就报错（起了但干不了活不能看起来像成功）。**抓到两个真实缺陷**：Attempt id 是 `att:<taskId>:<n>`，**含冒号**，而冒号在 Windows 上是非法文件名字符——"id 直接当目录名"这条路根本走不通，必须有显式且**单射**的编码（`att:T-1:2` 与 `att-T-1-2` 不得撞进同一个目录）；以及 worker 调 `prepareWorkspace`/`buildContext` 时是 `await run()`，**不传 lease**——空的 `inPlaceStages()` 不需要它，于是从没人发现阶段拿不到自己在给哪条任务干活 |
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
| PRT-401 Context Source 与 RunContextSnapshot | 🟡 | `runtime/contracts/context.mjs` + `canonical.mjs`（**共享基础库**）+ 套件 `context-snapshot`（33 例）。spec §6.5 的约束是"能**还原**实际输入、来源版本、过滤和裁剪原因"——重点是能**区分**：「没有这个来源」/「有但无权读」/「有但被裁掉了」原本长得一样，故 `excluded[]` 与 `sources[]` 同等重要，由**计数守恒**断言守着（`入选+排除==候选数`，不守恒即抛错）。**不可信是默认值**（没写 `trust` 即 `untrusted`，字面量比较——`'Trusted'` 不会被当成 `trusted`），否则**新增一种来源类型就静默获得权限**。被用例逼出的改正：第一版只在 untrusted 时查权威字段，等于"**提权只需标 trusted**"→ 改成**任何**来源都不许带，并拒绝未知字段（**忽略会让不该出现的字段搭便车**）。token 计量必带出处且**出处进哈希**（精确与保守估算的可信度不同，同哈希会让回放误判）。并**提取共享 canonical 基础库**：审批侧原有一份自己的实现，两份今天一致而**无人维持**——已证明重构后**审批哈希逐位不变**（25 个值比对 0 处不一致）。domain separator 用 NUL 分隔（`domain\0schemaVersion\0json`），使审批哈希与快照哈希在构造上不可互换。**未交付**：来源装配 PRT-402~406、裁剪实现 PRT-407、脱敏 PRT-408、**持久化 PRT-409**、越权/超限测试 PRT-410、冻结接线 PRT-411、tokenizer estimator PRT-413——**没有持久化故目前无法从界面查看任何快照** | |
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

## 阶段 5：模型和密钥配置（9/11）

| 任务 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| PRT-501 ModelProfile 数据模型与 API | ✅ | `team-hub/model-store.mjs`（仓储：**CAS 版本**、**墓碑删除**、审计脱敏守卫）+ 6 条路由（`GET/POST /api/model-profiles`、`GET/PATCH/PUT/DELETE /api/model-profiles/<id>`）+ 套件 `model-store`（20 例）、`model-routes`（14 例）。判据四条：① **校验只有一处**——写入复用 PRT-102 的 `validateProfile`，API 层不再写一遍；重复的后果不是多一道防线，而是两处判据会漂移，而漂移的那一次就是把明文密钥写进库的那一次；② **读出去的东西不含 `secretRef`**——连**引用名**都不给（只给 `hasCredential`），因为引用名也是可枚举的攻击面，而它没有必要出现在界面上；③ **更新用 `version` 做 CAS，不给就拒绝**——不默认成"最后一版"，否则两个界面同时保存会静默覆盖而两边都显示成功，用户只会觉得"我改的东西自己变回去了"（配置类 lost update 尤其难查）；冲突时带 `currentVersion`，不带的话调用方只能盲试；④ **删除是墓碑**——一次 Run 会记着 `modelProfileRef`，硬删除会让"当时用的哪个模型"永远答不上来；墓碑与"不存在"分开报（409 vs 404），混成一个会让「删掉再用同名建」看起来像一次干净的首次创建。审计只记非敏感事实（provider/model/字段名清单/「引用变了没有」），并在写入器**之前**过一道守卫：含疑似明文密钥就**拒绝写**（fail closed），不脱敏后照写——脱敏逻辑漏一处就等于把密钥永久留在库里。**这条路抓到三个真实缺陷**：① `findPlaintextSecrets` 只看键名不看值，于是 `limits.maxTokens` 被判成"检测到疑似明文密钥"——任何带 token 限额的模型档案**根本写不进去**，而报错把人送去查一个不存在的事故（`team-hub` 既有写入路径只有 provider/model 两列，从不传 limits，所以一直没人走过这条路）；② **契约基线看不见运行面建的表**：`dbTables` 只扫 `server.mjs`，于是 `run_attempts`/`run_attempt_events`/`run_validations`/`run_handoffs`/`model_profiles` **五张表对基线完全不可见**，`--check` 报"无漂移"而真实 schema 已经多了五张（基线由 101 路由/22 表 → **107 路由/27 表**——新增的 5 张不是本次新增的，是 PRT-301/307/308 就建好的）；③ **正则形态的路由对契约基线不可见**——`extractRoutes` 只认 `path === '…'` 与 `path.startsWith('…')`，我最初用 `/^\/api\/model-profiles\/(.+)$/.exec(path)` 写的三条路由在 diff 里根本不出现，可以不经评审地增删 |
| PRT-502 岗位模型绑定与 fallback | ✅ | `orchestrator/model-binding/index.mjs`（**纯**解析：候选链 + 每一条的理由）+ `team-hub/binding-store.mjs`（`employee_model_bindings`，键是 **(scope, employee_role)**）+ 5 条路由；套件 `model-binding`（18 例）、`binding-store`（16 例）、`binding-routes`（10 例）。这个模块要回答的唯一问题是「**这条任务用的是哪个模型，为什么是它**」——它必须可回答，因为换模型会同时改变**成本、质量、以及数据去了哪**，三件都不可见时一次"用错了模型"的运行在事后完全没有痕迹（进度表原先在这一行留的「旧路径实测按岗位模型未生效 / `modelDrift`」正是这个现象被专门探针抓到的记录）。判据四条：① **主档案解析不出来 = 绑定不可用，不允许 fallback 悄悄顶替**——fallback 的意义是"主档案**运行时**连不上"，不是"配置写错了替我兜住"；悄悄顶替会让 `primaryProfile` 一直是错的，而每次运行都在用一个没人选过的模型（与 §6.6「不得在未获用户批准时自动切换到更昂贵模型」同一条纪律）。备用仍出现在链里（诊断要看得到"本来会用什么"），但 `role` 保持 `fallback`——改成 `primary` 会让"这个岗位的主档案是哪个"事后无法回答。**写入时也验**：主档案不可用直接 409，不把跑不起来的绑定存进库（等到运行时才发现，那次运行已经认领任务、烧掉一次尝试，而错误出现在**运行日志**里，不是在"保存配置"这个动作上）。② **不可用的备用是"跳过 + 理由"而不是错误**，但必须报出来——链短一位意味着真实的容错余量比看起来少一位；**"不存在"与"已下线"分开报**（前者去查是不是 id 打错，后者去找谁下线的），保留 `order` 原位置。③ **链有序且去重**：同一档案出现两次会让"重试"变成对着同一个模型重试两次——那不是容错，是把一次瞬时故障变成两次同样的失败。④ **解析结果无密钥**（连引用名都不给），在**序列化后的原始字节**上验。另有一条刻意分界：**形状错误用异常、配置问题用返回值**（binding 不是对象 / fallbackProfiles 不是数组 / profiles 类型不对 → 抛；主档案不可用 / 备用不可用 / 预算形态不对 → `ok:false` + 码）——混成一种会让真正的**代码错**被当成一条正常的配置诊断埋在日志里。`perRunBudget` 只做形态校验（执行是 PRT-503/510），但**未知字段拒绝而不是忽略**：`maxCst` 被静默忽略后配置界面看起来配了预算而实际没有上限。`chainSnapshot` 交付冻结时点（§6.7 密钥轮换只影响轮换后创建的 Run 的对应物），只存 id 与顺序、不存 provider/model 的值（那会变成两份互相矛盾的真相）。**抓到两个真实缺陷**：① 解析路由**没包在 `handleRun` 里**，于是缺 role 时 `requireKey` 抛的 `ROLE_REQUIRED` 逃到外层兜底处理器 → **500**——调用方少传一个参数被报成"服务端出错"，运维会去查服务端日志而真正要做的是补上参数（与 PRT-308 `next-post` 同一条教训：用异常表达正常的流程控制会让状态码失去意义）；② **新的建表模块又一次对契约基线不可见**——PRT-501 刚修过 `dbTables` 只扫 `server.mjs` 的问题，这次加 `binding-store.mjs` 的表后 `数据表` 仍是 27，同一个缺陷换个模块立刻又发生一次；说明"记得更新列表"这件事本身需要门禁，于是加了覆盖率检查（遍历所有可能放 schema 的目录找出建表模块，逐个断言已登记，**反向也查**登记了却不再建表的），错误信息直接说明该怎么做，并**验过会变红**。基线由 107 路由 / 27 表 → **112 路由 / 28 表** |
| PRT-503 单次运行与岗位预算策略 | ✅ | `team-hub/budget-ledger.mjs` 的预算判定面：**没配预算 = 显式 `budgetState: 'unbounded'` 且不建预留**（否则"没配预算"与"预算闸门在工作"从外面看完全一样）、运行中 `observe()` 按累计用量判硬上限并**请求取消**（账本只请求，不自己取消——它不知道 Run 的生命周期）、超支**如实报出且不裁剪**（`spentAmount` 记真实值 + `overrunAmount` 记差额，而且仍然可以结算——拒绝结算只会让账本与事实脱节）、`maySwitchModel` 不得自动切到更贵模型（更便宜放行 / 更贵无批准拒绝 / **任一侧未定价也拒绝**，`approved` 不能替代定价）。套件 `budget-ledger`（**38 例**）+ `budget-routes`（**17 例**）。**未接线**：worker 与适配器尚未在 Run 开始时调 `reserve()`（见 docs/superpowers/prt/PRT-503-510-511-budget-ledger.md §10）。详见 docs/superpowers/prt/PRT-503-510-511-budget-ledger.md |
| PRT-504 模型连通性与能力测试 | ✅ | **（PRT-507 已接线：此前无任何非测试调用方，整块功能没有入口）**  `runtime/contracts/model-probe.mjs`（失败分类 / 判定 / 缓存策略，**纯函数无 I/O**）+ `runtime/probe/index.mjs`（执行器，transport 与凭证解析**双注入**）+ `runtime/probe/http.mjs`（真实 HTTP transport）。**连通 / 可用 / 能力是三个问题**，落地成三类码：`ENDPOINT_UNREACHABLE`/`TLS_FAILED`/`TIMEOUT`（连通）、`AUTH_FAILED`/`MODEL_NOT_FOUND`（可用）、`CAPABILITY_MISSING`（能力）——合成一个布尔值会让"TCP 握手成功"被当成模型可用（真实运行到第一次推理才失败，那时已认领任务烧掉一次尝试），或让"连得上但不支持 tools"被判为可用（依赖工具调用的运行中途崩而配置页显示通过）。**`SECRET_UNAVAILABLE` ≠ `AUTH_FAILED` 落在结构上**（spec §6.7）：`resolveSecret` 抛异常 → 本地密钥库问题（下一动作是查本机密钥库，**不要去供应商控制台换钥匙**），只有解析**成功之后**才去敲供应商的门、拿到 401 才是供应商拒绝（本机密钥库是好的）；**解不开钥匙时根本不发请求**（一旦发出，那次 401 会成为一条什么都没证明的"鉴权失败"证据）。**处置类别决定下一动作**：`fail-closed`/`config`/`transient`/`unknown`；**TLS 刻意不是 transient**（证书问题重试一百次也一样）；**未知码 → `unknown` 而非 transient**（不许静默重试）；**主动取消返回 `null` 而不是某个失败码**。**能力必须"有据可依"**：大多数供应商不报能力，此时唯一诚实的答案是空表而非猜测（猜错成"支持"会让运行半途崩，猜错成"不支持"会让能用的模型被排除，**两种都比"不知道"更糟**）；只提取响应明确写了的东西并标注来源，未知条目忽略，**能力声明必须严格为 `true`**（`"yes"`/`1`/`"true"` 都不算），未声明的能力**不在**对象里而非 `false`。**判定顺序刻意**：观测失败时不去看能力（"连不上"不能被"缺 tools"盖掉）。**缓存成功 5 分钟、失败 30 秒**（对称缓存会让一次抖动导致配置页长时间说谎并把用户引去改一个没问题的 endpoint），**按配置指纹分桶**（少则"给 A 探的成功被 B 继承"——一次从未发生过的成功变成可用性证明），指纹不含密钥值，时钟倒流按不新鲜，缓存有界（LRU）。**用"列模型"而不是"发一次推理"**：配置页的测试按钮是会被反复点的，每次点都花钱的结果是没人敢点——**而没人敢点的验证按钮等于没有验证**。**凭证三条结构保证**：不进判定/缓存/诊断（在序列化字节上用真实密钥字面量与仓库自己的 `findPlaintextSecrets` 双重检查）、解析失败原文不外带（只留 `name/code`）、失败响应正文不读（供应商可能回显提交的凭证）。套件 `model-probe`（**18 例**）、`probe`（**22 例**，假 transport 覆盖全部分类）、`probe-http`（**19 例**，起**真** HTTP 服务）。**八条判定逐条验证会变红**：密钥库失败报成 `AUTH_FAILED`、能力接受模糊真值、未知码默认 `transient`、TLS 归成 `transient`、成功失败同一 TTL、指纹不含配置、清单里没有也判成功、能力凭空产生。**未接线**：Workbench 的"测试连接"按钮与 team-hub 侧探测路由（探测要解密钥，按 §6.7 属 Runtime 侧，team-hub 应委托适配器而非自己读密钥库）——界面属 PRT-507。详见 docs/superpowers/prt/PRT-504-model-connectivity.md |
| PRT-505 Windows Secret Store | ✅ | `security/secrets/`（DPAPI 往返实测 + fail-closed + 六条出口脱敏）、套件 `secret-store`；**生产调用方已接**：`runtime/probe/secret-resolver.mjs` 是它的第一个也是唯一调用方（此前状态正是「尚无生产调用方」——**一份没人用的密钥库等于没有密钥库**）。**`SECRET_UNAVAILABLE` ≠ `AUTH_FAILED` 落在结构上**：本模块只抛 `SecretStoreError`，`RUNTIME_CODE_FOR` 把全部内部码收敛到 `SECRET_UNAVAILABLE`，**任何异常都只意味着"本机取不到明文"**，供应商拒绝是 transport 拿到 401 之后的事、在本模块之外——没有第二个出口，所以不存在"顺手报成 AUTH_FAILED"的可能；配套：**解不开钥匙时根本不发请求**（一旦发出，那次 401 会成为一条什么都没证明的"鉴权失败"证据）。**明文后端在构造时就被拒绝**（用 `memoryBackend`/`nullProtector` 等于把密钥明文落盘，而这**不会报错、只会静默地不安全**；关键是失败的**时刻**——等到第一次要用密钥时才发现，错误会落在**一次运行中间**，用户会读成"这次运行失败了"而不是"密钥库没加密"）。**不缓存明文**（§6.7 按需解析：缓存会让明文活过很多次运行，而**每一次运行都是一个新的授权边界**）。**底层异常被收敛**（只留 `name`/`code`）：密钥库异常里可能出现密文片段、路径、Windows 账户名或后端 stderr 正文——**诊断价值由"哪一类失败"提供，不由原文提供**。套件 `secret-resolver`（**21 例**）。与 `$DSH_HOME/.credentials.yaml` 的收敛**仍未做**（属 PRT-257）；**没有接到真实 Runtime 启动路径**（`orchestrator/worker/` 与 `runtime/adapters/dsh/` 尚未装载，属 PRT-253/254——真实运行目前仍不解析密钥）。详见 docs/superpowers/prt/PRT-505-509-secret-resolver.md |
| PRT-506 迁移现有非敏感模型配置 | ✅ | `team-hub/model-migration.mjs`（套件 `model-migration`，30 例）+ `GET /api/model-migration/plan` + `POST /api/model-migration/apply`。核心判断：**一次迁移最危险的产物，是一份看起来可用的配置**——老数据只有 `(scope,role,provider,model)`，而 `runtimeType`/`endpoint`/凭证**三样都不许猜**（猜协议→以错误协议发请求；猜地址→档案看起来配好了直到第一次运行才炸；猜凭证→界面显示就绪）。产物是「确定的部分 + **待补清单**」，总述里**不得**出现"迁移完成"。**id 归一化会静默撞车**（`p,m/n` 与 `p,m-n` 都是 `p.m-n`）→ 拒绝整个计划；源里有密钥 → **拒绝整个计划**（一次泄漏不该看起来像成功迁移）；计划与执行之间用 `digest` 对齐（不一致 → 409 `MIGRATION_PLAN_STALE`）；只增不改、**绝不删源**、半途失败**如实报告已写入的部分**。**未交付**：前端未接；DSH `settings.yaml` 的 `model` 未纳入迁移源；无"补 endpoint"引导流 |
| PRT-507 Workbench 模型设置页面 | 🟡 | **客户端层已补**：`workbench/src/hub-errors.ts`（结构化错误）+ `workbench/scripts/model-api.test.mjs`（套件 `model-api`，10 例）覆盖档案 CRUD / 岗位绑定 / 探测 / 迁移 / 导入导出。这一层此前**完全不存在**——后端 PRT-501/502/504/506/508 全都做完了而 `api.ts` **一个客户端函数都没有**（**功能在、测试在、文档在，没有入口**，与"PRT-504 没有任何非测试调用方"同源）。并修掉一条断链：`hubPost` 原本把响应体**压成一句字符串**，于是 PRT-252 的 `field`/`hint`/`candidates`（**后端有 18 条用例守着**）在到达界面之前就没了——**后端加了码、前端还是笼统提示，那条码就等于没加**。新增交叉校验：`api.ts` 的字面量路径必须与 `server.mjs` 抽出的路由表逐条对上（抓"前端写了个不存在的端点"，这种错只会 404）。**仍未交付**：React 组件仍从硬编码 `MODEL_OPTIONS` 渲染、未调用探测/迁移/导入；`hubGet` 读路径失败仍丢响应体 | **后端已接**：`team-hub/probe-service.mjs`（套件 `probe-service`，13 例）+ `POST /api/model-profiles/:id/probe`。这一轮起点是一次调用方排查——`git grep createModelProbe` 的**非测试命中只有它自己的实现文件**：PRT-504 的实现/套件/文档全在，**没有任何入口能触发它**（与 PRT-509 的 ACL runner 同源，而两次**用例都是全绿**）。核心判断：**「没探测过」不是「探测失败」**——密钥库打不开/布局不合法/没填 endpoint 时我们**根本没问过供应商**，返回任何 `ok:false` 判定都是**撒谎**（说成"连不上"会把用户引向网络与供应商状态，**一条完全错误的方向**）。故返回**结构不同**的 `unavailable:true`（**无 `class`**、**无 `latencyMs`**），HTTP **503**。**前端纯逻辑已交付**：`workbench/src/modelSettings.ts`（套件 `model-settings`，34 例），守「后端加了码、前端还是笼统提示 —— 那条码就等于没加」；分类决定下一步（`unknown` **不得**猜成 `transient`）；空能力表 ≠ "什么都不支持"；凭证状态未知 ≠ "没有凭证"；被跳过的候选**也要显示**。**未交付**：React 组件未写（`ModelConfigModal.tsx` 仍用硬编码 `MODEL_OPTIONS`）、`api.ts` 缺客户端函数、档位不在产品档案里 |
| PRT-508 配置导入导出（排除密钥） | ✅ | `runtime/contracts/config-bundle.mjs`（构造 / 校验 / 导入计划，**纯模块不做 I/O**）+ 三条路由 `GET /api/config-bundle`、`POST /api/config-bundle/plan`、`POST /api/config-bundle/apply`（平台契约路由 122 → **125**，数据表仍 31）。**`secretRef` 一定剥掉，而不是"保留但说明"**：① 引用名本身是可枚举的攻击面（`toModelDescriptor` 早就只暴露 `hasCredential`，**同一份判断不该在导出路径上放宽**）；② **`secretRef` 是**本机**的配置，不是模型档案的属性**——它命名的是*这台机器*密钥库里的一个槽位，带到另一台机器上那个名字什么也不指，**最坏的结果是新机器上恰好有同名槽位，于是这条档案用上了一把完全无关的钥匙，而且看起来一切正常**（没有报错、没有鉴权失败，那把钥匙有效，只是属于另一个服务或另一个人；只有账单或数据流向能暴露它）。导出物保留 `credentialRequired`（"要不要凭证"是档案的属性）、丢掉 `secretRef`（"从哪台机器的哪个槽位取"是那台机器的事）；**代价明确**：同机恢复备份也要重新绑定一次引用。**出口保证是拒绝而不是剥掉**——有明文密钥就**拒绝构造**导出包（剥掉需要脱敏逻辑正确，而**脱敏漏一处就等于把密钥永久留在导出文件里**；拒绝是 fail closed 且立刻可见），顺序**先查后返回**，不存在"已经返回了才发现要拒绝"的窗口；另有一条显式检查再验一遍"引用名真的没了"（查的是引用**名**不是密钥**值**，而一条只在"代码写对了"时才有效的防线需要一条能验它在不在的检查）。**导入方向同样挡**：整包查疑似明文、`containsSecrets: true`、逐条带 `secretRef`、**未知顶层字段拒绝**（忽略会让密钥字段搭便车）、**版本不等于 1 拒绝**（尽力解析会把"格式变了"变成"少导了几条"，而少导几条是静默的）。**导入必须两段式**（`plan` dry run 不写任何东西 → `apply`）：换模型**同时**改变**成本**（单价不同而预算按运行预留）、**质量**、以及最要紧的**数据去了哪**（换供应商就换数据出境目的地）——**换模型不是换配置，是换供应商**；`plan` 的返回同时带 `applicable`，否则前端要自己重算"有没有冲突/悬空引用"而两份判定必然漂移。**冲突默认 `fail` 而不是 `keep`**：`keep` 看起来更安全，但它会让一次本该报错的导入**静默地什么都没做**——用户以为配置已导入，下次运行才发现用的还是旧模型；**报错至少是可见的**。而 `keep` 把冲突转成 `skip`、于是 `conflicts` 变成 0，只报 `conflicts` 的回执看起来是"零冲突、成功"而包里那些改动**一处都没进去**——所以被策略跳过的动作带 `keptLocal: true` 并单独计数（**让它可数，而不只活在提示语里**）。**不删除**（包里没有的档案保持不动：导入是补齐不是同步，否则一份不完整的包会清空整台机器）；**悬空引用拒绝应用**（绑定指向"包里没有、本机也没有"的档案时拦下，否则存下的绑定要到运行时才发现跑不起来，与 PRT-502 同一条纪律）。**副产品：修掉 `handleRun` 的双写缺陷**——拒绝路径在回调内直接 `json(res, 409, ...)` 然后 return，而 `json()` 没有"已发送"守卫，于是 `handleRun` 之后又写一次 200 → 抛 `ERR_HTTP_HEADERS_SENT` → 被它自己的 catch 再写一次（又抛）→ 逃到最外层被 `if (res.headersSent) res.end()` **静默吞掉**；**客户端拿到的响应完全正确**，所以 18 条路由用例一条都没红（我一度以为"没有报错 = 没有发生"，直到把 `json()` 包一层计数器：守卫在位 `[409]` 一次，守卫拿掉 `[409, 200, 400]` **三次写、两次抛、零条记录**）；覆盖**PRT-503/510/511 的十条预算路由**（它们此前一直靠最外层那个吞异常的 `end()` 兜底）。**抓到 6 个真实缺陷**，其中一个只被"往返一致"用例抓到：`toExportableProfile` 重算 `credentialRequired` 会让"这条档案需要凭证"在导出→导入→导出后**静默消失**（新机器导入时不再提示绑定引用，会在第一次真实运行解密钥时才发现）。**测试自身也抓到 5 个错误**，两个值得记：「夹带密钥」用例把密钥藏在 `note` 里而 `note` 不在允许列表内——**白名单先把它扔了**，用例"通过"了一个从未被执行的检查；用 CRLF 不敏感的锚点做"改坏源码"验证时 `String.replace` 找不到就什么都不做，于是"撤销守卫"根本没生效、测试当然全绿（**一个没生效的验证和一次通过的验证，在输出上完全一样**）。套件 `config-bundle`（**27 例**）+ `config-bundle-routes`（**18 例**，自起进程/库/端口）。**十条判定逐条验证会变红**。**未接线**：Workbench 的导出按钮与"导入前预览差异"对话框（**导入最需要界面**——`plan` 的价值就是让人在执行前看到会变什么）；导出无落盘/压缩/**校验和**（被改过的包无法与原始包区分）；导出无审计；导入写入**不是原子的**（中途失败会留半份）。详见 docs/superpowers/prt/PRT-508-config-import-export.md |
| PRT-509 密钥读取 / 轮换 / 删除 / 泄漏测试 | 🟡 | 读取/轮换/删除的泄漏断言已入 `secret-store` 与 `secret-resolver` 套件；**本批新增：轮换让探测缓存自动失效**——PRT-504 的缓存按 `probeFingerprint` 分桶，而我原先的注释写的是"引用名会随轮换改变，但轮换**不应**让一次刚刚完成的探测失效（那由 PRT-509 的轮换流程负责）"，**这句话是错的**：轮换的**定义**就是"引用名不变、值变了"，于是指纹不变、缓存命中、判定不重来——坏钥匙换好钥匙则配置页仍显示"鉴权失败"，而**好钥匙换坏钥匙则界面显示"通过"而真实运行会失败**（反方向更糟：把一次可用性证明给了一把已经不能用的钥匙）；而"由轮换流程负责"是一个**不存在且容易被忘记**的责任——**一道看不见某类变化的大门，比没有大门更坏**。修法：密钥的 `rotatedAt`/`updatedAt` 是**只读元数据、不需解密**，取出来进 `probeFingerprint` 的 `credentialVersion`；关键是 `credentialVersionOf` 在**执行器内部**自动调用，而不是要求每个调用点记得传（**调用点的纪律必然会被忘记，内建的纪律不会**）；版本取不到时给**唯一值**而非空串（给唯一值只多花一次请求、结果正确；给空串会让"版本未知"的两次探测互相命中，**可能拿旧钥匙的判定回答新钥匙的问题**）。**跨账户与 ACL 加固已做**（本批新增 `security/secrets/acl.mjs` + 套件 `secret-acl`（**22 例**））：**DPAPI 保护的是内容、不是文件**——另一个账户仍可复制它、看到**有哪些引用名**（`refs` 的 key 是明文的）、把解密失败变成可观测信号；DSH 自己的 `credentials-local` 在这里写明 *Windows has no mode to inspect … so the check is **skipped rather than faked***——这条纪律必须继承，但它留下一个缺口：**本产品的主平台就是 Windows**，而"跳过"等于"Windows 上从不检查"；Windows 的 ACL **是可查的**，于是三态分开：`ACL_OK` / `ACL_TOO_PERMISSIVE`（点名是谁）/ `ACL_UNVERIFIABLE`——第三种**绝不等同于第一种**（**一条"查不出来就当通过"的检查比没有检查更坏，它会让人相信一件没被验证过的事**），代码里落在返回值上（无 runner → `ACL_NO_RUNNER` + `ok:false`，**"跳过"这个状态根本不存在**）；**本机真实 `icacls` 输出当场抓出两个 bug**（它本身就是不安全样本：把 Modify 给了一个沙箱组**和一个未解析的 SID**）：① 按空白切 token 会切断含空格的主体名 `NT AUTHORITY\SYSTEM`；② `grantsAccess` 把已抽好的权限字母**又抽了一遍**（`'M'` 里没有括号 → 返回空串 → `/[FMRXWD]/.test('')` 永远 false）→ **每一个主体都被跳过、检查永远通过**，而它**不报错**（`ok:true`、`offenders:[]` 看起来像"ACL 很干净"）——**一个永远返回 ok:true 的实现，在所有干净样本上都是对的，只有"不安全的输入必须报不安全"这条用例能抓住它**；③ 权限串有多个括号组（`(I)(M)`），只取第一组会把继承标记 `I` 当成权限字母，于是**每一条继承来的 ACE 都被判成授权**，而继承来的 ACE 恰恰最需要警惕（文件自己没授权、父目录给了 `Users`，**效果完全一样**）；判定只允许 所有者（调用方传入，`icacls` **不标出**所有者）+ `SYSTEM` + `Administrators`（后两个是**操作系统要求**而非"我们信任"，且**挡管理员不是 ACL 能做的事**）；`Users`/`Everyone`/`Authenticated Users` 在拒绝之列——**它们才是"多用户机器上另一个用户能读到"的真正原因**；加固**先断继承再授权**（只加权限不删继承则父目录授权仍在，而"操作成功了但结果没变"最容易被误认为加固已完成），且**每步之后复验**（命令返回 0 不等于加固完成）；不知道所有者时**一个命令都不发**——**猜一个主体去授权等于把权限给错人**；**仍未做**：`acl.mjs` **没有接到启动路径**（今天没有人会因为密钥库文件权限过宽而被拦下，接线位置是 PRT-253/254）；`fileBackend` 自己**不检查权限**（创建之后再收紧之间有一个宽权限窗口）；**没有对真实 `$DSH_HOME` 下的文件跑过**（端到端用例用的是临时空文件）；判越权时**不会自动加固**（刻意的，改权限应是明确动作，但"检测到了"与"修好了"之间需要有人接线）；**且与 DSH `.credentials.yaml` 的并存仍未解**：spec 附录 A.2 第 2 条要求「**复用** `$DSH_HOME/.credentials.yaml`，**不要另建密钥库**」，本批实测核对了这条指令并**如实升级**它——支持复用的一面是 DSH 的 `CredentialKey` 语法 `<scope>/<id>` 与 Legion 的 `secretRef` **正好相容**、且 `credentials-local` 已实现 `assertOwnerOnly`（"复用"是真的复用）；反对直接复用的一面是**它是明文的**（本机实测 `refs: { DEEPSEEK_API_KEY: sk-be96… }`），复用会把保护等级从 DPAPI 降到明文，且 Legion 有**零第三方依赖**纪律而 DSH 用 `yaml` 包解析它，**解析错一个凭证文件是安全事件**；文档给出两条候选路线（**读桥** / **一次性迁移**）并指出**两者都需要产品决策"哪一个是权威"**，不适合由实现者单方面决定；**轮换无版本历史**（`rotate` 覆盖同一槽位，审计上无法区分"轮换了几次"）；**删除无软删除/宽限期**（误删会让所有引用立刻变 `SECRET_UNAVAILABLE`，而"密钥被删了"与"密钥库坏了"**对外收敛后是同一个码**）；**`purpose` 未被利用**——spec §6.7 的"授权"**完全没有实现**，任何能调用解析器的代码都能拿到任意引用名的明文。详见 docs/superpowers/prt/PRT-509-file-acl-hardening.md；**本批再修**：`createSystemRunner()` 让 ACL 检查在生产里**真的执行**（此前没有调用方传 runner，整套是死代码），并新增 `ACL_NOT_CREATED` 把"文件还没创建"与"查不出来"分开 |
| PRT-510 预算原子预留、结算、取消与 Unknown Outcome 锁定 | ✅ | `reserve` 用 `BEGIN IMMEDIATE` + `attempt_id` 主键，预留的是**最大预算**而不是估算值；重复预留幂等但**参数不一致拒绝 409**（上限可以被改，但必须是一次显式动作，"不能靠重新预留悄悄替换"）；`settle({outcome:'known'})` 按实际用量结算并释放，**二结算 409**（余额被释放两次是真钱）；`settle({outcome:'unknown'})` → `locked`，**不写任何实际金额**（`spentAmount` 保持 `null` 而不是 0，因为写入任何数字都等于宣称"算清了"），**余额仍被占住**，`locked` 不是终态且只能由 `resolveLocked()`（显式 `disposition: 'release'|'settle'` + `actor`）解开；状态机 `RESERVATION_TRANSITIONS` **全定义**（每个状态都有键，哪怕空数组——缺键会让 `TRANSITIONS[x]` 是 `undefined`，异常掩盖"这个状态我根本没想过"），有用例断言键集与状态集一一对应。详见 docs/superpowers/prt/PRT-503-510-511-budget-ledger.md |
| PRT-511 冻结价格表版本、币种、计价单位与生效时间 | ✅ | `runtime/contracts/price-table.mjs`（`createPriceTable` 强制要求 version / currency / effectiveAtMs——一张没有版本、没有生效时间的价目表**构造不出来**，因此无法被冻结进记录、无法在事后被解释；`estimateCost` **未定价或 token 未知时返回 `ok:false` 而不是 0**；`canSwitchModel` 择价）+ `price_tables` 表与 `createPriceTableRegistry`：**版本为主键且发布不可覆盖**（同版本 → 409 `PRICE_TABLE_IMMUTABLE`），于是"改价"在类型上只能是"发新版本"，历史记录引用的旧版本对象**没有可改的东西**——**冻结是结构性的，不是一条纪律**。`usage_records` 追加式且每次写入都带全部五个冻结字段；结算**按预留时冻结的版本**取表，取不到就拒绝（`PRICE_TABLE_GONE`）**不回退到现价**。端到端用例：发布 v1 → 预留 → 发布 v2（涨价 100 倍）→ 结算**仍按 v1**。套件 `price-table`（**19 例**）。详见 docs/superpowers/prt/PRT-503-510-511-budget-ledger.md |

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
| 2.5 商业薄切片 | 3 | 2 | 2 | 1 | 8 |
| 3 Orchestrator Core | 13 | 0 | 3 | 0 | 16 |
| 4 上下文边界 | 0 | 1 | 12 | 0 | 13 |
| 5 模型与密钥 | 9 | 2 | 0 | 0 | 11 |
| 6 工具、权限和审批 | 1 | 3 | 16 | 0 | 20 |
| 7 Product Launcher | 5 | 2 | 6 | 0 | 13 |
| 8 安装、升级和回滚 | 0 | 1 | 12 | 0 | 13 |
| 9 商业 Alpha 保障 | 0 | 0 | 9 | 1 | 10 |
| 10 能力包协议 | 0 | 0 | 6 | 0 | 6 |
| **合计** | **60** | **17** | **66** | **2** | **145** |

> 计数口径：**部分**计入「已有交付物但完成标准未全部满足」，
> 因此不能与「已完成」相加后宣称完成度。真实完成度按**完成标准**判定：
> 阶段 0～2 的完成标准已满足或已写明未满足项，阶段 2.5 及其后均未达标。

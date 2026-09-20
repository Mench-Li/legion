#!/usr/bin/env node
// scripts/prt/baseline-snapshot.mjs
// ============================================================================
// PRT-007：旧系统平台契约基线（HTTP / 数据库 / 状态机）
//
// 目的：§14.2 要求对同一黄金任务比较新旧两条路径的「任务状态序列、结构化结果、
// 产物、审批与审计」。要比较，先得有一份**可 diff 的旧路径契约快照**——否则
// 「新路径没改变既有契约」只能靠人肉记忆判断。
//
// 本工具从源码**提取**平台表面，不执行任何进程、不连数据库：
//   - team-hub HTTP 路由（方法 + 路径）
//   - SQLite 表名
//   - 任务状态机（STATUSES + TRANSITIONS）
//   - 目标状态机
//   - 权限决策模式
//
// 输出刻意**不含时间戳**：快照要能逐字节 diff，时间戳会让每次都「有变化」。
// 漂移由 `sources` 里各源文件的 sha256 归因。
//
// 为什么**不**接进 CI 作为阻断门禁：
//   迁移期旧路径仍在被并行开发（新增路由、加表是常态）。把它做成硬门禁会让
//   每个正常的功能提交都红，最后必然被人用 `--record` 无脑刷掉，反而失去意义。
//   因此它是**比较工具**：阶段 3 对拍、以及每次 DSH/产品升级前手动跑一次 diff。
//
// ★★★ **订正（2026-09-18，第 23 轮）：上面那段话与事实不符——它已经是一门阻断门禁了。**
//
// `scripts/prt/baseline-snapshot.test.mjs` 的用例 ④ 做的事正是：
//
//     assert.deepEqual(diffSnapshots(recorded, current), [])
//
// 而那个文件**在 CI 的 `test` 阶段里**（套件名 `prt-baseline（PRT-007 平台契约基线
// 与漂移定位）`）。⇒ 任何一个改动 `team-hub/server.mjs` 的正常提交都会红，
// 而**唯一**的解除方式就是 `--record`。
//
//   上面第 21–22 行**逐字预言了**这个结局（"每个正常的功能提交都红，最后必然
//   被人用 `--record` 无脑刷掉"）。它没有防住——因为写下那段话的人以为
//   "没接进 CI"是**已经完成的事实**，而实际上它是以另一个文件名接进去的。
//
//   > 一份写着"这东西没有接进门禁"的设计说明，与它真的没接进门禁，
//   > 在下一个提交功能的人看来是同一个东西——直到他红了一次。
//
// 本轮的实测经过（**这就是那句预言的复现**）：我加了一条只读路由
// `GET /api/usage/alert`，全量 CI 的 `test` 阶段红在 `prt-baseline` ④ 上，
// 报 `+ 路由: GET /api/usage/alert` 与 `~ 源文件已变更：team-hub/server.mjs`。
// 解除方式**只有** `--record`，我照做了。
//
// ⇒ 现状是：**它是一门门禁，而 `--record` 是官方解除方式。**
//   这句话不改变任何行为，只是让下一个人不必先红一次才知道。
//   它带来的一条**真实价值**也一并记在这里：那次 diff **只有 2 行**
//   （1 条新路由 + 1 个源文件哈希），⇒ 它顺手证明了"这次的契约变化**只有**这一条"，
//   没有意外的建表 / 状态机漂移。**门禁的价值正是这个读数**，而不是"拦住人"。
//
// 用法：
//   node scripts/prt/baseline-snapshot.mjs --record    # 写入/刷新基线
//   node scripts/prt/baseline-snapshot.mjs --diff      # 与基线比较（默认）
//   node scripts/prt/baseline-snapshot.mjs --json      # 打印当前提取结果
//   node scripts/prt/baseline-snapshot.mjs --help
// ============================================================================
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_PATH = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-007-baseline.json')

const SOURCES = {
  server: join(ROOT, 'team-hub', 'server.mjs'),
  permissions: join(ROOT, 'team-hub', 'permission-engine.mjs'),
}

/**
 * 声明 SQLite schema 的模块。
 *
 * **为什么必须列全**：`dbTables` 曾经只扫 `server.mjs`，于是
 * `run-store.mjs`（`run_attempts` / `run_attempt_events` / `run_validations` /
 * `run_handoffs`）与 `model-store.mjs`（`model_profiles`）建的表对基线
 * **完全不可见**——`--check` 报告"无漂移"，而真实 schema 已经多了五张表。
 * 一个看不见某类变更的棘轮比没有棘轮更坏：它给出"已核对过"的错觉。
 *
 * 逐个列名而不是 glob：glob 会漏掉新文件，而漏掉的那次同样是静默的。
 * `SOURCES` 的每个路径都会先经 `existsSync` 检查，改名/移动会被立刻发现。
 */
const SCHEMA_SOURCES = [
  'server',
  'runStore',
  'modelStore',
  'bindingStore',
  'budgetLedger',
  'contextStore',
  // PRT-615：`permission_requests` 的建表 DDL 从 `server.mjs` 搬到了
  // `approval-binding.mjs`（`ensureApprovalSchema`）。
  //
  // 搬家的理由不是整洁，而是**只有一份是对的**：此前 `permission_requests` 在
  // `server.mjs` 里建、又被测试夹具手抄一份列清单，两份迟早会不一致，
  // 而 `attempt_id` 这种后加的列恰恰是"不一致时静默失效"的那种。
  //
  //   > 一个"生产建一份、夹具抄一份"的表结构，
  //   > 与一个"迟早只有一份是对的"的表结构，在「新加的列到底有没有生效」上是同一个东西。
  //
  // 代价是必须同步登记到这里——**这条门禁就是在替我记得这件事**：
  // 不登记的话，`permission_requests` 会对平台契约基线不可见，
  // 而 `--check` 会兴高采烈地报告"无漂移"。实测它当场就红了。
  'approvalBinding',
  // PRT-616：`approval_consumptions`（`allow-once` 的占位账本）。
  //
  // 它必须是**独立一张表**、而且必须是**能挡住第二次放行**的那一张：
  // 把"这一次放行被用掉了"这个不可回收的安全事实放进 `permission_requests`
  // （一张会被清理/过期的表），表现是"清理跑完之后，同一操作又能被放行一次"。
  'allowOnce',
  // PRT-610：`tool_calls`（决定 + 决定来源 + 原始/canonical 输入 + 结果 + 幂等键）。
  //
  // 它必须进契约基线，因为它的列就是 spec §6.8 那几条要求的落地：
  // 少了 `decisionSource`，"策略拒绝与沙箱兜底拒绝的修复动作不同"就无从谈起；
  // 少了 `rawInput`，事后回答不了"模型当初到底要它做什么"。
  'toolCallLog',
  // PRT-402：`team_plans`（冻结的团队计划快照）与 `employee_manifests`（活的岗位清单）。
  //
  // 这两张表进基线，与上面几张同一条理由：**表结构就是 spec 那几条要求本身**。
  // `team_plans` 的复合主键 `(scope, id, version)` 不是索引偏好——它就是
  // "冻结"这件事的落地：没有 version 进主键，改写旧版就是一次普通 UPDATE；
  // `employee_manifests` 的 `(scope, role)` 主键就是"一个岗位在这个空间里只有一份"。
  //
  // 两列还各自替一句话做证：`team_plans.created_at_ms`（"当时冻的是哪一版、什么时候"）
  // 与 `employee_manifests.version`（"边界变过没有"——`sources.mjs` 拿它当来源版本，
  // 于是它决定快照哈希）。少任何一列，那两句话都无从回答。
  'contextPlanStore',
  // F-05 后半（§4.1）：`event_subscribers` / `event_deliveries`。
  //
  // 这两张表进基线，是因为**它们就是"投递状态机"这件事本身**：
  // `event_deliveries.state` 的取值集合就是那六态，`carrier_deadline_ms`
  // （租约）就是"崩溃收敛为 unknown"的判据，`fanout` 就是"多个活连接
  // 属于同一个订阅者"的落地。少任何一列，同一句 spec 都无从核对。
  'eventDelivery',
  // F-16（§4.4）：`automation_schedules` / `automation_runs`。
  //
  // ★ 这里有一条**必须进基线**的判据：`automation_runs` 上的
  //   `UNIQUE(schedule_id, planned_at_ms)`。它不是索引偏好——它是
  //   "同一个计划在同一时刻只能物化一次"的落地。只在应用层查重时，
  //   两个进程会各查一次、各写一行，而那是**并发下的必然**。
  //   唯一约束不在契约基线里，这件事就没有任何地方能核。
  'automationStore',
  // F-17（§4.3）：`compaction_messages` / `compaction_summaries`。
  //
  // 同样，表结构就是那三条要求在的落地：
  //   · `compaction_messages.content` 只追加（无 UPDATE/DELETE 路径）⇒ "不可变原文"
  //   · `compaction_summaries` 的 `PRIMARY KEY(session_id, version)` ⇒ "版本化"
  //   · `covers_from_seq` / `covers_to_seq` ⇒ "引用回原文"
  // 把 `version` 从主键里拿掉，第二条就会变成"改摘要"——而那是一次
  // 静默的信息丢失，正是这三列要防的事。
  'compactionStore',
  // F-20 缺口③（§4.4）：`pack_install_facts`。
  //
  // 这张表进基线，是因为**它自己就是"team-hub 保存安装事实"这句话的落地**，
  // 而它的形状承载了三条必须能核的要求：
  //   · `seq` 是 PRIMARY KEY ⇒ "账只追加、顺序就是发生顺序"（重号即写入失败）
  //   · `kind` 的取值集合里有 `rollback` ⇒ "安装可回滚"在账上有一条**自己的**
  //     方向，而不是伪装成 install / upgrade
  //   · `content_hash` / `declared_content_hash` 两列并存 ⇒ "账上记的是算出来的
  //     那一个，不是作者声明的那个"
  // 把 `seq` 从主键里拿掉，第一条就没有任何地方能核——而它是这份账唯一
  // 能证明"没有静默重排"的东西。
  'packFacts',
  // F-19（§4.4）：`role_packs`（冻结的岗位包）。
  //
  // ★ 它与 `employee_manifests` **必须**是两张表，而这条正是要进基线的判据：
  //   后者主键 `(scope, role)` 且就地更新，回答"这个岗位**现在**是什么"；
  //   前者主键 `(scope, role_pack_id, version)`，回答"**当时**是哪一版"。
  //   把后者塞进前者，第二次修改就把第一次的答案覆盖掉了——
  //   而 `version` 进主键这件事**没有别的地方能核**：少了它，
  //   "冻结"与"只保留最近一版"在 schema 上长得一模一样。
  'rolePackStore',
  // F-18（§4.4）：`experience_records`（经验图谱 + 摩擦草稿的**只追加**记录流）。
  //
  // ★ 进基线的判据是"这张表**没有** UPDATE 路径"这件事本身：
  //   "图现在长什么样"与"这条草稿现在是什么状态"都是从记录流**推导**出来的。
  //   一旦有人给它加上一段就地更新，推导就变成了第二份真相，
  //   而它与记录流不一致时**没有任何东西能判定谁对**。
  //   这条性质在 schema 上只体现为"只有一张表、没有状态列"——
  //   正是那种"改坏了也看不出来"的契约，所以必须钉住。
  'experienceStore',
  // F-21（§4.4）：`connector_registrations`（按内容哈希冻结的连接器声明）
  // 与 `connector_incidents`（点名的熔断事件）。两张都是**只追加**。
  //
  // ★ 进基线的判据与 F-18/F-19 同源，但这一处更重：
  //   连接器声明说的是"一个**外部进程**能拿到什么权限"。
  //   一旦有人给它加上一段就地更新（"把策略改一下"），
  //   "当时放行了哪些工具"这个问题就在**写的那一刻**失去唯一答案——
  //   而这正是事后复盘唯一要问的问题。
  //   这条性质在 schema 上只体现为"没有状态列、没有 UPDATE 路径"，
  //   正是那种"改坏了也看不出来"的契约，所以必须钉住。
  'connectorStore',
]

// 这些模块也一并纳入 sources 哈希：它们变了，基线里的表清单就可能过期。
SOURCES.runStore = join(ROOT, 'team-hub', 'run-store.mjs')
SOURCES.modelStore = join(ROOT, 'team-hub', 'model-store.mjs')
SOURCES.bindingStore = join(ROOT, 'team-hub', 'binding-store.mjs')
SOURCES.budgetLedger = join(ROOT, 'team-hub', 'budget-ledger.mjs')
SOURCES.contextStore = join(ROOT, 'team-hub', 'context-store.mjs')
SOURCES.approvalBinding = join(ROOT, 'team-hub', 'approval-binding.mjs')
SOURCES.allowOnce = join(ROOT, 'team-hub', 'allow-once.mjs')
SOURCES.toolCallLog = join(ROOT, 'team-hub', 'tool-call-log.mjs')
// PRT-402：TeamPlan 与 EmployeeManifest 两张表。
//
// ★ 这一行是**门禁自己要求加的**，不是我事先想到的：新文件建了表却没登记，
//   `--check` 直接报"它们的表对平台契约基线**不可见**"。
//   不登记的后果正是这道门禁存在的理由——表在真实 schema 里多出来，
//   而 `--check` 兴高采烈地说"无漂移"。
SOURCES.contextPlanStore = join(ROOT, 'team-hub', 'context-plan-store.mjs')
SOURCES.eventDelivery = join(ROOT, 'team-hub', 'event-delivery.mjs')
SOURCES.automationStore = join(ROOT, 'team-hub', 'automation-store.mjs')
SOURCES.compactionStore = join(ROOT, 'team-hub', 'compaction-store.mjs')
SOURCES.packFacts = join(ROOT, 'team-hub', 'pack-facts.mjs')
SOURCES.connectorStore = join(ROOT, 'team-hub', 'connector-store.mjs')
SOURCES.rolePackStore = join(ROOT, 'team-hub', 'role-pack-store.mjs')

// ── PRT-316：已从 `handle()` 提取出去的路由族 ────────────────────────────────
//
// ★ 这些文件里的路由**不在** `server.mjs` 的字面量 if 链里，所以主抽取器看不见它们。
//   不登记的话，"把一条路由搬进族模块"会在 `--check` 里报成"这条路由被删了"——
//   而那正是本片第一次跑门禁时真的发生的事。
//
// ★ 逐个列名，与上面 `SCHEMA_SOURCES` 同一纪律（glob 会漏掉新文件，而漏掉是静默的）。
//   列名是否齐全由 `assertRouteFamilyCoverage()` 以 `server.mjs` 的装配处为权威核对。
SOURCES.routesRules = join(ROOT, 'team-hub', 'routes', 'rules.mjs')
SOURCES.routesPermissions = join(ROOT, 'team-hub', 'routes', 'permissions.mjs')
SOURCES.routesChat = join(ROOT, 'team-hub', 'routes', 'chat.mjs')
SOURCES.routesCalendar = join(ROOT, 'team-hub', 'routes', 'calendar.mjs')
SOURCES.routesCompaction = join(ROOT, 'team-hub', 'routes', 'compaction.mjs')
SOURCES.routesSecrets = join(ROOT, 'team-hub', 'routes', 'secrets.mjs')
SOURCES.routesAutomation = join(ROOT, 'team-hub', 'routes', 'automation.mjs')
SOURCES.routesExperience = join(ROOT, 'team-hub', 'routes', 'experience.mjs')
SOURCES.routesPacks = join(ROOT, 'team-hub', 'routes', 'packs.mjs')
SOURCES.routesRolePacks = join(ROOT, 'team-hub', 'routes', 'role-packs.mjs')
SOURCES.routesToolCalls = join(ROOT, 'team-hub', 'routes', 'tool-calls.mjs')
SOURCES.routesConnectors = join(ROOT, 'team-hub', 'routes', 'connectors.mjs')
// ★ 切片 13（model-profiles）是第一个**带块前言**的族：5 条路由裹在一个裸块里，
//   块内先声明 `MODEL_PREFIX` 与 `modelId` 再写那 5 条。抽取器只认
//   `req.method === '…' && path …` 这一种**同一行**的写法，所以块前言
//   对它是透明的 —— 但这一点值得在这里写一句，因为下一个人遇到"路由在块里"
//   时会先怀疑抽取器，而它其实没问题（`findOpaqueRouteGuards` 也不响）。
SOURCES.routesModelProfiles = join(ROOT, 'team-hub', 'routes', 'model-profiles.mjs')
// ★ 切片 14（usage）是第一个**被内部子分隔符切成两段**的族：
//   `// ── F-15 用量汇总 ──` 下面是 totals/rollup，又一个 `// ── F-15 告警与降级 ──`
//   下面是 alert。抽取器对此同样是透明的（它按声明式条目逐条认，不看注释）。
SOURCES.routesUsage = join(ROOT, 'team-hub', 'routes', 'usage.mjs')
// ★ 切片 16（context-snapshots）是**子分隔符最多**的族（4 个），
//   而且 `assemble` 那条上面没有分隔符 —— "有的路由有说明、有的没有"两种都要对。
SOURCES.routesContextSnapshots = join(ROOT, 'team-hub', 'routes', 'context-snapshots.mjs')
// ★ 切片 17（config-bundle）：这一族逼出了生成器两个"前十六族恰好都成立"的假定 ——
//   `instanceof` 不沾"被调用/取成员"两种形态；`ALWAYS` 只放行、不注入。
SOURCES.routesConfigBundle = join(ROOT, 'team-hub', 'routes', 'config-bundle.mjs')
// ★ 切片 18（price-tables）：第一族**被夹在别人的区间里**的 —— 逼出了搬运脚本
//   上边界的真 bug（往上找分隔符时可能找到**别人**的分隔符）。
SOURCES.routesPriceTables = join(ROOT, 'team-hub', 'routes', 'price-tables.mjs')
// ★ 切片 19（config）：第一族走**活绑定** —— 它读的 `deliveryBookkeepingFailures`
//   在宿主里是 `let` 且三处 `+= 1`，按值注入会永久陈旧。
SOURCES.routesConfig = join(ROOT, 'team-hub', 'routes', 'config.mjs')
SOURCES.routesCreate = join(ROOT, 'team-hub', 'routes', 'create.mjs')
SOURCES.routesComment = join(ROOT, 'team-hub', 'routes', 'comment.mjs')
SOURCES.routesTeamPlans = join(ROOT, 'team-hub', 'routes', 'team-plans.mjs')
SOURCES.routesMembers = join(ROOT, 'team-hub', 'routes', 'members.mjs')
SOURCES.routesEmployeeManifests = join(ROOT, 'team-hub', 'routes', 'employee-manifests.mjs')
SOURCES.routesExec = join(ROOT, 'team-hub', 'routes', 'exec.mjs')
SOURCES.routesModels = join(ROOT, 'team-hub', 'routes', 'models.mjs')
SOURCES.routesWeb = join(ROOT, 'team-hub', 'routes', 'web.mjs')
SOURCES.routesModelMigration = join(ROOT, 'team-hub', 'routes', 'model-migration.mjs')
SOURCES.routesSkillSource = join(ROOT, 'team-hub', 'routes', 'skill-source.mjs')
SOURCES.routesRunBudget = join(ROOT, 'team-hub', 'routes', 'run-budget.mjs')
SOURCES.routesSkillsDocuments = join(ROOT, 'team-hub', 'routes', 'skills-documents.mjs')
SOURCES.routesReadModels = join(ROOT, 'team-hub', 'routes', 'read-models.mjs')

/** 已提取出去的路由族模块（值 = 该文件里**声明式**路由的归属名）。 */
export const ROUTE_FAMILY_SOURCES = Object.freeze([
  { module: 'routesRules', family: 'rules', factory: 'createRulesRoutes' },
  { module: 'routesPermissions', family: 'permissions', factory: 'createPermissionsRoutes' },
  { module: 'routesChat', family: 'chat', factory: 'createChatRoutes' },
  { module: 'routesCalendar', family: 'calendar', factory: 'createCalendarRoutes' },
  { module: 'routesCompaction', family: 'compaction', factory: 'createCompactionRoutes' },
  { module: 'routesSecrets', family: 'secrets', factory: 'createSecretsRoutes' },
  { module: 'routesAutomation', family: 'automation', factory: 'createAutomationRoutes' },
  { module: 'routesExperience', family: 'experience', factory: 'createExperienceRoutes' },
  { module: 'routesPacks', family: 'packs', factory: 'createPacksRoutes' },
  { module: 'routesRolePacks', family: 'role-packs', factory: 'createRolePacksRoutes' },
  { module: 'routesToolCalls', family: 'tool-calls', factory: 'createToolCallsRoutes' },
  { module: 'routesConnectors', family: 'connectors', factory: 'createConnectorsRoutes' },
  { module: 'routesModelProfiles', family: 'model-profiles', factory: 'createModelProfilesRoutes' },
  { module: 'routesUsage', family: 'usage', factory: 'createUsageRoutes' },
  { module: 'routesContextSnapshots', family: 'context-snapshots', factory: 'createContextSnapshotsRoutes' },
  { module: 'routesConfigBundle', family: 'config-bundle', factory: 'createConfigBundleRoutes' },
  { module: 'routesPriceTables', family: 'price-tables', factory: 'createPriceTablesRoutes' },
  { module: 'routesConfig', family: 'config', factory: 'createConfigRoutes' },
  { module: 'routesCreate', family: 'create', factory: 'createCreateRoutes' },
  { module: 'routesComment', family: 'comment', factory: 'createCommentRoutes' },
  { module: 'routesTeamPlans', family: 'team-plans', factory: 'createTeamPlansRoutes' },
  { module: 'routesMembers', family: 'members', factory: 'createMembersRoutes' },
  { module: 'routesEmployeeManifests', family: 'employee-manifests', factory: 'createEmployeeManifestsRoutes' },
  { module: 'routesExec', family: 'exec', factory: 'createExecRoutes' },
  { module: 'routesModels', family: 'models', factory: 'createModelsRoutes' },
  { module: 'routesWeb', family: 'web', factory: 'createWebRoutes' },
  { module: 'routesModelMigration', family: 'model-migration', factory: 'createModelMigrationRoutes' },
  { module: 'routesSkillSource', family: 'skill-source', factory: 'createSkillSourceRoutes' },
  { module: 'routesRunBudget', family: 'run-budget', factory: 'createRunBudgetRoutes' },
  { module: 'routesSkillsDocuments', family: 'skills-documents', factory: 'createSkillsDocumentsRoutes' },
  { module: 'routesReadModels', family: 'read-models', factory: 'createReadModelsRoutes' },
])
SOURCES.experienceStore = join(ROOT, 'team-hub', 'experience-store.mjs')

/**
 * 采集 schema 的目录。
 *
 * 供 `SCHEMA_SOURCES` 覆盖率检查使用：**新增一个建表模块却忘了登记**时，
 * 那张表对基线不可见，而 `--check` 会报告"无漂移"。因此这条检查是
 * 把"记得更新列表"变成一个**会红的门禁**，而不是一条注释。
 * `baseline-snapshot.test.mjs` 会调用它。
 */
export const SCHEMA_SCAN_DIRS = ['team-hub', 'orchestrator', 'runtime', 'security', 'product']

export { SCHEMA_SOURCES }

/** 已登记进 schema 采集的模块的绝对路径（供覆盖率检查比对）。 */
export const SCHEMA_SOURCE_PATHS = Object.freeze(
  SCHEMA_SOURCES.map((name) => SOURCES[name]),
)

/** 模块名 → 绝对路径。按**名字**取，不按位置取：
 *  `SCHEMA_SOURCE_PATHS[0]` 这种写法会在列表重排时静默指向另一个模块，
 *  而"检查 server 的路由"变成了"检查某个别的文件"——依然会绿。 */
export const SCHEMA_SOURCE_FOR = Object.freeze({ ...SOURCES })

/** 仓库根（供覆盖率检查遍历）。 */
export const REPO_ROOT = ROOT

const rel = (p) => relative(ROOT, p).split(sep).join('/')
// ★ 先归一化 EOL 再哈希：`core.autocrlf=true` 下仓库存 LF、工作区落 CRLF，
//   不归一化的话，一次 `git checkout` 就会让"源文件已变更"凭空出现
//   （而 `git status` 干净、`git diff` 为空——两边量的不是同一个东西）。
const sha256 = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')

/**
 * 提取失败必须抛错，而不是安静地记录一个空基线。
 * 一个「看起来正常但什么都没提取到」的基线，比没有基线更危险：
 * 它会让后续 diff 全部显示为「新增」，从而被当成噪音忽略。
 */
function must(cond, message) {
  if (!cond) throw new Error(`基线提取失败：${message}`)
}

/** 提取 HTTP 路由。四种书写顺序都要认，否则会漏掉一半端点。 */
/**
 * 抽取规则与源码脱节的护栏阈值。
 * 真实源码远高于阈值；单测用小型夹具时通过 `min` 覆盖，以免为了测试而拆掉护栏。
 */
const MIN_ROUTES = 10
const MIN_TABLES = 10

/**
 * 找出**抽取规则看不见**的路由守卫。
 *
 * ## 为什么需要它（这是一次真实事故）
 *
 * 上面四条正则都要求路径是**字符串字面量**。而源码里很容易写成：
 *
 *     const MODEL_PREFIX = '/api/model-profiles/'
 *     if (req.method === 'POST' && path.startsWith(MODEL_PREFIX)) { ... }
 *
 * 这时抽取器**一条都提取不到**，于是：
 *   - `--check` 说「与基线一致」；
 *   - `--record` 把一个**漏了一条真实路由**的快照写进基线。
 *
 * 结果是一份**看起来正常**的平台契约，而它少了一条端点。这正是本仓库
 * 已经记过的那条、也是最贵的一条：
 *
 *   **一道看不见某类改动的闸门，比没有闸门更危险**——它给人"已经守住了"的错觉。
 *
 * PRT-507 加 `/api/model-profiles/:id/probe` 时就真的踩了这个坑：路由加上了、
 * 端到端能跑，而 `--record` 仍然报「125 条」，与改动前一模一样。
 *
 * 所以这里不再依赖"写的时候记得用字面量"，而是**主动去找**这种写法并拒绝生成基线。
 * 修法有两种：改成字面量（与同级路由一致），或扩展抽取规则支持常量解析。
 * 无论哪种，都必须在**这里被拦住**，而不是在几个月后被人发现契约少了一条。
 */
export function findOpaqueRouteGuards(source) {
  const found = []
  const guards = [
    // (method, path-identifier)
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\s*(?:\.startsWith\s*\(\s*([A-Za-z_$][\w$]*)|===\s*([A-Za-z_$][\w$]*))/g,
    // (path-identifier, method)，两种书写顺序
    /path\s*\.startsWith\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
    /path\s*===\s*([A-Za-z_$][\w$]*)\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
  ]
  for (const re of guards) {
    let m
    while ((m = re.exec(source)) !== null) {
      const name = m[2] ?? m[1]
      // 只关心看起来像 API 路径的常量名，避免把 `path === someVar` 的普通分支也报出来
      if (!/PREFIX|PATH|ROUTE|URL/i.test(name)) continue
      found.push(name)
    }
  }
  return [...new Set(found)]
}

/**
 * 提取 HTTP 路由。四种书写顺序都要认，否则会漏掉一半端点。
 * @param {string} source
 * @param {{min?: number}} [options] 覆盖最小路由数护栏（单测用）
 */
export function extractRoutes(source, options = {}) {
  const min = options.min ?? MIN_ROUTES
  // 先拒绝"抽取器看不见的路由"：漏掉一条端点却报「与基线一致」是最坏的输出。
  const opaque = findOpaqueRouteGuards(source)
  must(opaque.length === 0,
    `发现 ${opaque.length} 处用**常量**做路径守卫的路由（${opaque.join('、')}）：` +
    '抽取正则只认字符串字面量，这些路由会被静默漏掉。' +
    '请改用字面量，或扩展抽取规则支持常量解析。')
  const routes = new Set()
  const patterns = [
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\s*===\s*'([^']+)'/g,
    /path\s*===\s*'([^']+)'\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\.startsWith\(\s*'([^']+)'/g,
    /path\.startsWith\(\s*'([^']+)'\s*\)\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
  ]
  // 前两个 pattern 是 (method, path)，后两个是 (path, method)
  const isMethodFirst = [true, false, true, false]
  patterns.forEach((re, i) => {
    let m
    while ((m = re.exec(source)) !== null) {
      const [method, path] = isMethodFirst[i] ? [m[1], m[2]] : [m[2], m[1]]
      // 只收 API 面：静态资源与内部路径不属于平台契约
      if (!path.startsWith('/api/')) continue
      routes.add(`${method} ${path}`)
    }
  })
  must(routes.size >= min, `HTTP 路由只提取到 ${routes.size} 条（下限 ${min}），抽取规则可能已与源码脱节`)
  return [...routes].sort()
}

/**
 * 提取**带出现次数**的路由表，用于发现「同一条路由被写了两次」。
 *
 * 为什么单靠 `extractRoutes` 发现不了：它返回的是 `Set`，于是重复的路由
 * 被静默合并成一条。而重复恰恰是最危险的一种——后写的那条会**遮蔽**先写的，
 * 于是先写那条成为**不可达的死代码**，而路由清单看起来完全正常。
 *
 * 实测（PRT-503）：新增 `GET /api/runtime/budget`（费用预算）时，
 * 该路径已被 PRT-309 的**重试预算**读面占用。基线里 `GET /api/runtime/budget`
 * 仍然只出现一次（因为 Set 去重），`--check` 报"无漂移"，
 * 而 `run-plane` 的"还能自动重试几次"读面已经永久返回错误结构。
 *
 * 返回 `[{ route, count }]`，按出现次数降序（重复的排前面）。
 */
/**
 * 提取**声明式**路由（PRT-316 提取出去的路由族用的形态）：
 *
 *   { method: 'GET', path: '/api/rules', async run(...) {} }
 *
 * ★ 与 `extractRoutes` 分开写而不是塞进它的 patterns：那个函数带着 `MIN_ROUTES`
 *   护栏（"抽取规则是否已与源码脱节"），而族模块天然只有个位数条路由——
 *   把两种量级塞进同一条下限，护栏会在正确的时候报错。
 *
 * ★ 两种书写顺序都认（`method` 在前 / `path` 在前），否则换一下顺序就少扫一半，
 *   而少扫一半在这里的表现是"路由被删了"。
 */
export function extractDeclaredRoutes(source) {
  const routes = new Set()
  // ★ 允许 method 与 path **之间夹着别的键**（如切片 5 起的 `match:` / `suffix:`），
  //   但 `[^}]*?` 保证不跨过对象边界（对象里没有 `}`）。
  //   写成"要求相邻"会让新形态的路由对抽取器不可见 ⇒ 搬家被报成删除。
  const pairs = [
    /method:\s*'([A-Z]+)',[^}]*?path:\s*'([^']+)'/g,
    /path:\s*'([^']+)',[^}]*?method:\s*'([A-Z]+)'/g,
  ]
  const isMethodFirst = [true, false]
  pairs.forEach((re, i) => {
    let m
    while ((m = re.exec(source)) !== null) {
      const [method, path] = isMethodFirst[i] ? [m[1], m[2]] : [m[2], m[1]]
      if (!path.startsWith('/api/')) continue
      routes.add(`${method} ${path}`)
    }
  })
  return [...routes].sort()
}

/**
 * ★★★ 列名齐全性：`server.mjs` 的 `createRouter([...])` 装配处是**权威**。
 *
 * 装配里调用了哪些 `createXxxRoutes(`，就必须在 `ROUTE_FAMILY_SOURCES` 里逐个列到，
 * 且登记的 `factory` 必须与之同名。少了 ⇒ 那个族的路由对基线**完全不可见**，
 * `--check` 会说"与基线一致"。
 */
export function assertRouteFamilyCoverage(serverSource) {
  const block = /createRouter\(\[([\s\S]*?)\]\)/.exec(serverSource)
  must(block !== null, "`server.mjs` 里找不到 `createRouter([...])` 装配处：路由族的列名无从核对")
  const wired = [...block[1].matchAll(/(\w+)\(/g)].map((m) => m[1]).filter((n) => n.startsWith('create') && n.endsWith('Routes'))
  const listed = ROUTE_FAMILY_SOURCES.map((x) => x.factory)
  const unlisted = wired.filter((f) => !listed.includes(f))
  const stale = listed.filter((f) => !wired.includes(f))
  must(unlisted.length === 0,
    `server.mjs 装配了未登记的路由族：${unlisted.join('、')} ⇒ 它们的路由对基线不可见。`
    + "请加进 `ROUTE_FAMILY_SOURCES`（并补 `SOURCES`）。")
  must(stale.length === 0,
    `ROUTE_FAMILY_SOURCES 登记了未装配的族：${stale.join('、')} ⇒ 列名已过期，请删掉。`)
  return wired
}

export function extractRouteOccurrences(source) {
  const counts = new Map()
  const patterns = [
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\s*===\s*'([^']+)'/g,
    /path\s*===\s*'([^']+)'\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
    /req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\.startsWith\(\s*'([^']+)'/g,
    /path\.startsWith\(\s*'([^']+)'\s*\)\s*&&\s*req\.method\s*===\s*'([A-Z]+)'/g,
  ]
  const isMethodFirst = [true, false, true, false]
  patterns.forEach((re, i) => {
    let m
    while ((m = re.exec(source)) !== null) {
      const [method, path] = isMethodFirst[i] ? [m[1], m[2]] : [m[2], m[1]]
      if (!path.startsWith('/api/')) continue
      const key = `${method} ${path}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  })
  return [...counts.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route))
}

/**
 * 提取 SQLite 表名。
 * @param {string} source
 * @param {{min?: number}} [options]
 */
/**
 * 提取 SQLite 表名。
 *
 * 支持两种写法：
 *   · `CREATE TABLE IF NOT EXISTS audit (`          —— 字面量
 *   · `CREATE TABLE IF NOT EXISTS ${APPROVAL_TABLE} (` —— 同一文件里的字符串常量
 *
 * 第二种不是可有可无的。PRT-615 把 `permission_requests` 的 DDL 从 `server.mjs`
 * 搬进 `approval-binding.mjs` 时改用了常量，于是表名抽取**静默返回空**：
 * 那张表对平台契约基线**不可见**，而 `--check` 报的是"表被移除了"——
 * 真正的危险在于，如果同时新增一张表，它会**根本不出现在漂移里**。
 *
 *   > 一个"认不出来的建表语句就当它没建表"的抽取，
 *   > 与一个"可以被无声地绕过"的契约门禁，是同一个东西。
 *
 * 所以：认不出来的引用**直接抛错**，而不是跳过。宁可门禁报"抽取规则已与源码脱节"，
 * 也不要它报"无漂移"。
 */
export function extractTables(source, options = {}) {
  const min = options.min ?? MIN_TABLES
  const tables = new Set()
  // 先收同文件里的字符串常量（`const APPROVAL_TABLE = 'permission_requests'`），
  // 用于解析 `${IDENT}` 形式的表名。
  //
  // ⚠️ 必须要求整条赋值**就是**那个字符串。宽松写成 `=\s*'([A-Za-z_]*)'` 时，
  // `const T = 'a' + 'b'` 会被认成 `T = 'a'` —— 于是拼出来的表名被"解析"成了
  // 一个**恰好是前缀**的名字，而这个名字在库里根本不存在。
  // 它不会报错（抽取"成功"了），只会让基线里多一张不存在的表。
  const consts = new Map()
  for (const m of source.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*;?[ \t]*(?:\r?\n|$)/g)) {
    consts.set(m[1], m[2])
  }
  const re = /CREATE TABLE IF NOT EXISTS\s+(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|'?([A-Za-z_][A-Za-z0-9_]*)'?)/g
  let m
  while ((m = re.exec(source)) !== null) {
    if (m[2] !== undefined) {
      tables.add(m[2])
      continue
    }
    const resolved = consts.get(m[1])
    must(
      resolved !== undefined,
      `建表语句用了 \`\${${m[1]}}\`，但在同一文件里找不到 \`const ${m[1]} = '...'\`。`
      + '抽取规则认不出来的表会**对平台契约基线不可见**——'
      + '请把它写成字符串常量，或改用字面量，不要把这条门禁变成"报无漂移"。',
    )
    tables.add(resolved)
  }
  must(tables.size >= min, `SQLite 表只提取到 ${tables.size} 张（下限 ${min}），抽取规则可能已与源码脱节`)
  return [...tables].sort()
}

/** 提取一个字符串数组字面量，如 const STATUSES = ['a', 'b']。 */
export function extractStringArray(source, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\\[([^\\]]*)\\]`)
  const m = re.exec(source)
  must(m, `找不到 ${constName} 数组字面量`)
  const items = m[1].match(/'([^']*)'/g) || []
  must(items.length > 0, `${constName} 数组为空`)
  return items.map((s) => s.slice(1, -1))
}

/**
 * 提取状态迁移表。只解析 `key: ['a', 'b'],` 形态的字面量块。
 * 不做 eval：基线工具自身不应执行被采集文件里的代码。
 */
export function extractTransitions(source, constName) {
  const start = source.indexOf(`const ${constName} = {`)
  must(start !== -1, `找不到 ${constName} 对象字面量`)
  const end = source.indexOf('\n}', start)
  must(end !== -1, `${constName} 对象字面量未闭合`)
  const block = source.slice(start, end)
  const out = {}
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[([^\]]*)\]\s*,?\s*$/gm
  let m
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = (m[2].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)).sort()
  }
  must(Object.keys(out).length > 3, `${constName} 只解析出 ${Object.keys(out).length} 个状态`)
  return out
}

/** 提取权限决策模式（MODES 集合）。 */
export function extractPermissionModes(source) {
  const m = /const\s+MODES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(source)
  must(m, '找不到 MODES 集合')
  const modes = (m[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1))
  must(modes.length > 0, 'MODES 为空')
  return [...modes].sort()
}

/**
 * 找出所有**会建表的非测试源文件**。
 *
 * 与 `SCHEMA_SOURCES` 配合构成覆盖率检查：新增一个建表模块却忘了登记时，
 * 那张表对基线不可见，而 `--check` 会报告"无漂移"。
 */
export function findSchemaCreatingFiles() {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      // **只容忍"这个目录不存在"**（某些工作树里没有 security/ 等）。
      //
      // 第一版这里写的是裸 `catch { return }`——于是它把
      // `readdirSync is not defined`（漏了 import）也一起吞了，
      // `found` 变成空数组，覆盖率检查**静默地什么都没查**。
      //
      // 那次是反向检查（"登记了却不再建表"）把它撞出来的：它报了 6 个假阳性。
      // 如果只有正向检查，`assertSchemaCoverage()` 会返回 `{found: 0}` 并**通过**
      // ——即"一个什么都不查的闸门报绿灯"，正是这个函数被写出来要防的那种事，
      // 只不过这次发生在它自己身上。
      //
      // 一个把编程错误吞成"没有发现"的 catch，比没有 catch 更坏。
      if (e !== null && typeof e === 'object' && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return
      throw e
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!e.name.endsWith('.mjs')) continue
      // 测试文件里的建表语句是夹具，不属于产品 schema
      if (e.name.includes('.test.')) continue
      let text
      try { text = readFileSync(full, 'utf8') } catch { continue }
      if (/CREATE TABLE IF NOT EXISTS/.test(text)) found.push(resolve(full))
    }
  }
  for (const d of SCHEMA_SCAN_DIRS) walk(join(ROOT, d))
  return found
}

/**
 * 覆盖率检查：**每个建表模块都必须登记进 `SCHEMA_SOURCES`**。
 *
 * ## 为什么这条检查在**工具里**，而不是只在测试里
 *
 * 它原先只在 `baseline-snapshot.test.mjs` 里。于是出现了一个真实的双层失效：
 *
 *   · `node scripts/prt/baseline-snapshot.mjs --check` 报 **"无漂移"**；
 *   · 而 `run-ci` 里的那条用例会红。
 *
 * 两者都对，但**人跑门禁时拿到的是绿灯**。本项目的纪律是
 * 「**一道没人必须记得的闸门才是能守住的闸门**」——把检查留在测试里，
 * 等于要求每个人在跑 `--check` 之前先想起"还要跑测试"。所以把它搬进 `buildSnapshot()`：
 * `--check` 与 `--record` 都会先撞上它。
 *
 * （这次是 `team-hub/context-store.mjs` 触发的：`run_context_snapshots` 建了表，
 *   而基线报"无漂移"。测试红得完全正确，只是**门禁没红**。）
 *
 * `registeredPaths` 可注入是为了**让这条检查本身可以被反向验证**：
 * `SCHEMA_SOURCE_PATHS` 是模块加载时算好的快照，运行时改不动它，
 * 于是"临时把一项拿掉看它会不会红"在那个层面做不到。
 */
export function assertSchemaCoverage({ registeredPaths = SCHEMA_SOURCE_PATHS } = {}) {
  const registered = new Set(registeredPaths.map((p) => resolve(p)))
  const found = findSchemaCreatingFiles()
  const unregistered = found.filter((p) => !registered.has(p))
  must(
    unregistered.length === 0,
    '以下文件建表但未登记进 SCHEMA_SOURCES，它们的表对平台契约基线**不可见**：\n' +
    unregistered.map((p) => `  · ${rel(p)}`).join('\n') +
    '\n请在 scripts/prt/baseline-snapshot.mjs 的 SCHEMA_SOURCES 里加上它们。',
  )
  // 反向：登记了却不再建表的文件要报出来（列表老化会让下一个人以为它被覆盖了）
  const stale = registeredPaths
    .filter((p) => SCHEMA_SCAN_DIRS.some((d) => resolve(p).startsWith(resolve(join(ROOT, d)))))
    .filter((p) => !found.includes(resolve(p)))
  must(
    stale.length === 0,
    '以下文件已登记进 SCHEMA_SOURCES 但不再建表，请移除：\n' +
    stale.map((p) => `  · ${rel(p)}`).join('\n'),
  )
  return { found: found.length, registered: registered.size }
}

/** 生成快照（确定性：不含时间戳，键序固定）。 */
export function buildSnapshot() {
  // **先查覆盖率，再采数。** 顺序重要：一张未登记的表的创建模块不会被读进
  // `schemaText`，所以"先采再查"会让快照本身少一张表——而少的那张正是
  // 检查要发现的那一张。
  assertSchemaCoverage()
  assertRouteFamilyCoverage(readFileSync(SOURCES.server, 'utf8'))
  for (const [name, p] of Object.entries(SOURCES)) {
    must(existsSync(p), `源文件不存在：${rel(p)}（${name}）`)
  }
  const server = readFileSync(SOURCES.server, 'utf8')
  const perms = readFileSync(SOURCES.permissions, 'utf8')
  // 表清单取自**所有**声明 schema 的模块。只读 server.mjs 会让运行面与
  // 模型面建的表对基线不可见（见 SCHEMA_SOURCES 的说明）。
  const schemaText = SCHEMA_SOURCES.map((name) => readFileSync(SOURCES[name], 'utf8')).join('\n')

  return {
    $comment:
      'PRT-007 旧系统平台契约基线。由 scripts/prt/baseline-snapshot.mjs 生成；' +
      '不含时间戳以便逐字节 diff。漂移由 sources 的 sha256 归因。',
    version: 1,
    sources: Object.fromEntries(
      Object.entries(SOURCES).map(([name, p]) => [rel(p), sha256(readFileSync(p, 'utf8'))]),
    ),
    httpRoutes: [
      ...extractRoutes(server),
      ...ROUTE_FAMILY_SOURCES.flatMap(({ module }) => extractDeclaredRoutes(readFileSync(SOURCES[module], 'utf8'))),
    ].sort(),
    dbTables: extractTables(schemaText),
    taskStatuses: extractStringArray(server, 'STATUSES'),
    taskTransitions: extractTransitions(server, 'TRANSITIONS'),
    goalStatuses: extractStringArray(server, 'GOAL_STATUSES'),
    permissionModes: extractPermissionModes(perms),
  }
}

// ---------------------------------------------------------------- diff

/** 比较两份快照，返回人类可读的差异行。 */
export function diffSnapshots(before, after) {
  const lines = []
  const listDiff = (label, a = [], b = []) => {
    const added = b.filter((x) => !a.includes(x))
    const removed = a.filter((x) => !b.includes(x))
    for (const x of added) lines.push(`  + ${label}: ${x}`)
    for (const x of removed) lines.push(`  - ${label}: ${x}`)
  }
  listDiff('路由', before.httpRoutes, after.httpRoutes)
  listDiff('数据表', before.dbTables, after.dbTables)
  listDiff('任务状态', before.taskStatuses, after.taskStatuses)
  listDiff('目标状态', before.goalStatuses, after.goalStatuses)
  listDiff('权限模式', before.permissionModes, after.permissionModes)

  // 迁移表的每条边单独比较，能定位到具体状态
  const states = new Set([...Object.keys(before.taskTransitions ?? {}), ...Object.keys(after.taskTransitions ?? {})])
  for (const s of [...states].sort()) {
    listDiff(`迁移 ${s}`, before.taskTransitions?.[s] ?? [], after.taskTransitions?.[s] ?? [])
  }
  for (const [file, hash] of Object.entries(after.sources ?? {})) {
    const prev = before.sources?.[file]
    if (prev && prev !== hash) lines.push(`  ~ 源文件已变更（需人工确认是否为契约变化）：${file}`)
  }
  return lines
}

function summary(snap) {
  return [
    `  路由       ${snap.httpRoutes.length}`,
    `  数据表     ${snap.dbTables.length}`,
    `  任务状态   ${snap.taskStatuses.length}（迁移边 ${Object.values(snap.taskTransitions).flat().length}）`,
    `  目标状态   ${snap.goalStatuses.length}`,
    `  权限模式   ${snap.permissionModes.length}`,
  ].join('\n')
}

function usage() {
  console.log('baseline-snapshot.mjs — PRT-007 旧系统平台契约基线')
  console.log('')
  console.log('  --record   写入/刷新基线')
  console.log('  --diff     与基线比较（默认）')
  console.log('  --json     打印当前提取结果')
  console.log('  --help     本说明')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage(), process.exit(0)

  let current
  try {
    current = buildSnapshot()
  } catch (err) {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify(current, null, 2))
    process.exit(0)
  }

  if (argv.includes('--record')) {
    writeFileSync(OUT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
    console.log(`基线已写入 ${rel(OUT_PATH)}`)
    console.log(summary(current))
    process.exit(0)
  }

  if (!existsSync(OUT_PATH)) {
    console.error(`未找到基线 ${rel(OUT_PATH)}。先运行 --record。`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(OUT_PATH, 'utf8'))
  const lines = diffSnapshots(before, current)
  if (lines.length === 0) {
    console.log('baseline-snapshot: 平台契约与基线一致（无漂移）')
    process.exit(0)
  }
  console.log('baseline-snapshot: 检测到平台契约漂移')
  console.log(lines.join('\n'))
  console.log('')
  console.log('  若确为有意变更，运行 --record 刷新基线并在提交信息中说明。')
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}

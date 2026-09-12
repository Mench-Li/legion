// runtime/packs/builtin/software-delivery.mjs
// ============================================================================
// PRT-1006：把**软件交付团队**整理为首个内置能力包。
//
// spec §6.13 line 572：
//   「软件交付团队作为内置首包验证协议；跨境电商团队在商业 Alpha 底座通过后接入。」
// spec §6.13 line 570：
//   「安装时验证签名/来源、内容哈希、`packProtocolVersion`、依赖和产品兼容性；
//     解析成功后生成不可变 `CompiledTeamPlan`。运行中的目标始终使用创建时快照，
//     能力包升级只影响之后创建的目标。」
//
// ---------------------------------------------------------------------------
// 这个包为什么存在：它是协议唯一的**真实调用方**
//
// 阶段 10 的六个任务里，五个是判据与机制；只有这一个是"真的有东西在用它们"。
// 一个只有判据、没有被任何真实包走过的协议，会有一种很安静的失效：
//
//   > 一个「所有判据都有用例、而没有任何一个真实包通过它们」的协议，
//   > 与一个「判据只在夹具上成立」的协议，是同一个东西——
//   > 只不过前者在报表上每一项都是绿的。
//
// 所以这个文件把整条链路走完并用**算出来的读数**留证：
// 内容哈希 → 预检（清单 + 依赖 + 兼容 + 来源）→ 越权检查 → 编译成不可变计划
// → 建一个目标（钉在 1.0.0）→ 发布 1.1.0 → 目标仍然报 1.0.0。
//
// ---------------------------------------------------------------------------
// 内置身份不是这个包自己说了算
//
// `provenance` 是 `null`（内置包没有签名者），可信等级来自**宿主的登记表**
// （`builtinPackIds`）。装载自检里有一条反向探针：同一份内容，只要把
// `builtinPackIds` 换成空数组，`trust` 立刻从 `builtin` 掉成 `unsigned`。
//
//   > 一个「包里写着它是内置的」的实现，
//   > 与一个「任何包都能自称内置」的实现，是同一个东西。
//
// ---------------------------------------------------------------------------
// 这个包**不带任何凭据**，而且这一点是被扫出来的
//
// 载荷里的文档会提到"需要外部资源时只留引用"，但它不包含任何密钥材料——
// 这不是靠作者自觉，而是 `SOFTWARE_DELIVERY_CHECKED.secretHits === 0` 这个读数。
// ============================================================================

import { hostEnforcementSurface, preflightPack } from '../authority.mjs'
import {
  COMPILED_TEAM_PLAN_VERSION,
  assertPlanImmutable,
  compileTeamPlan,
  createPlanRegistry,
  planIdOf,
} from '../compiled-plan.mjs'
import { PACK_MANIFEST_VERSION, PACK_PROTOCOL_VERSION, contentHashOfEntries, normalizePayload } from '../manifest.mjs'
import { createPackStore } from '../store.mjs'

/** 内置包的 packId。宿主的内置登记表按它认人。 */
export const SOFTWARE_DELIVERY_PACK_ID = 'legion.software-delivery'

/** 首个内置包的类型。 */
export const SOFTWARE_DELIVERY_PACK_TYPE = 'team'

/** 宿主版本三元组。与 `manifest.mjs` 的 `SAMPLE_HOST` 同构，但这里写的是产品真实值。 */
export const SOFTWARE_DELIVERY_HOST = Object.freeze({
  productVersion: '1.0.0',
  packProtocolVersion: PACK_PROTOCOL_VERSION,
  dshCompositionPatchVersion: 1,
})

/**
 * 五个岗位的清单。
 *
 * 权限是**按岗位收窄**的，不是照团队最大值给每个人：
 * 规划、架构、评审只读；实现能改仓库；验证能跑命令。
 * 一个"所有人都拿团队最大权限"的清单在用例里也对，但它把
 * "岗位"这个维度变成了文档里的一个词。
 */
const EMPLOYEES = Object.freeze([
  Object.freeze({
    employeeId: 'sd-planner', role: 'planner', displayName: '规划师',
    allowedTools: Object.freeze(['read-file', 'git-status']),
    allowedCapabilities: Object.freeze(['file:read', 'repo:read']),
    maxRisk: 'low', workspaceRoot: 'C:/work/legion-delivery', unattended: true,
    notes: '把目标拆成可验证的任务，不写代码',
  }),
  Object.freeze({
    employeeId: 'sd-architect', role: 'architect', displayName: '架构师',
    allowedTools: Object.freeze(['read-file', 'git-status']),
    allowedCapabilities: Object.freeze(['file:read', 'repo:read']),
    maxRisk: 'low', workspaceRoot: 'C:/work/legion-delivery', unattended: true,
    notes: '定边界与接口，不改代码',
  }),
  Object.freeze({
    employeeId: 'sd-implementer', role: 'implementer', displayName: '实现工程师',
    allowedTools: Object.freeze(['read-file', 'write-file', 'git-status', 'git-commit']),
    allowedCapabilities: Object.freeze(['file:read', 'file:write', 'repo:read', 'repo:write']),
    maxRisk: 'high', workspaceRoot: 'C:/work/legion-delivery', unattended: true,
    notes: '只改工作目录内的代码，改动要小、要能回退',
  }),
  Object.freeze({
    employeeId: 'sd-verifier', role: 'verifier', displayName: '验证工程师',
    allowedTools: Object.freeze(['read-file', 'run-command', 'git-status']),
    allowedCapabilities: Object.freeze(['file:read', 'repo:read', 'command:exec', 'process:spawn']),
    maxRisk: 'high', workspaceRoot: 'C:/work/legion-delivery', unattended: true,
    notes: '证明它真的做到了，不是再看一遍代码',
  }),
  Object.freeze({
    employeeId: 'sd-reviewer', role: 'reviewer', displayName: '评审员',
    allowedTools: Object.freeze(['read-file', 'git-status']),
    allowedCapabilities: Object.freeze(['file:read', 'repo:read']),
    maxRisk: 'low', workspaceRoot: 'C:/work/legion-delivery', unattended: true,
    notes: '对照验收标准做人工评审',
  }),
])

/** 五段流水线，逐段交接；最后一段没有下游。 */
const PIPELINE = Object.freeze([
  Object.freeze({ stage: 'plan', role: 'planner', handoffTo: 'architect' }),
  Object.freeze({ stage: 'design', role: 'architect', handoffTo: 'implementer' }),
  Object.freeze({ stage: 'implement', role: 'implementer', handoffTo: 'verifier' }),
  Object.freeze({ stage: 'verify', role: 'verifier', handoffTo: 'reviewer' }),
  Object.freeze({ stage: 'review', role: 'reviewer', handoffTo: null }),
])

/** 团队清单的聚合：包声明的权限必须**足够**跑这条流水线，而每一项都来自上面那五个岗位。 */
const REQUESTED_PERMISSIONS = Object.freeze({
  capabilities: Object.freeze([...new Set(EMPLOYEES.flatMap((e) => [...e.allowedCapabilities]))].sort()),
  tools: Object.freeze([...new Set(EMPLOYEES.flatMap((e) => [...e.allowedTools]))].sort()),
  maxRisk: 'high',
  workspaceRoot: 'C:/work/legion-delivery',
})

/** 只读内容。**这就是包的全部内容**，内容哈希覆盖它。 */
function buildFiles({ version }) {
  return Object.freeze([
    Object.freeze({
      path: 'team/team-plan.json',
      text: `${JSON.stringify({ employees: EMPLOYEES, pipeline: PIPELINE }, null, 2)}\n`,
    }),
    Object.freeze({
      path: 'prompts/planner.md',
      text: [
        '# 规划师 · 提示段',
        '',
        '你在一个受限工作目录里工作，只能读取仓库与文件。',
        '',
        '- 先把目标拆成可验证的任务，再交给下游岗位。',
        '- 每条任务都写清"做完之后拿什么证明它做完了"。',
        '- 不确定的地方标出来，不要替用户猜。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'prompts/architect.md',
      text: [
        '# 架构师 · 提示段',
        '',
        '- 先定边界与接口，再谈实现顺序。',
        '- 每个决定都写上它排除了什么方案。',
        '- 不写代码：这个岗位的产出是判断，不是补丁。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'prompts/implementer.md',
      text: [
        '# 实现工程师 · 提示段',
        '',
        '你只改工作目录里的代码，改动要小、要能回退。',
        '',
        '- 每改一处都在提交信息里写清为什么。',
        '- 不要提交凭据、令牌或任何环境相关的值；需要外部资源时留一个引用，由宿主解析。',
        '- 跑不通的检查不要注释掉，照实报。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'prompts/verifier.md',
      text: [
        '# 验证工程师 · 提示段',
        '',
        '你负责"证明它真的做到了"，不是"再看一遍代码"。',
        '',
        '- 先跑仓库里已有的检查，再补一个能失败的用例。',
        '- 一次只验证一条验收标准，通过与否都给出命令与输出原文。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'prompts/reviewer.md',
      text: [
        '# 评审员 · 提示段',
        '',
        '- 对照验收标准逐条核对，不接受"我看过了"。',
        '- 不通过时给出**可复现**的失败现场，退回实现岗位。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'schema/task.json',
      text: `${JSON.stringify({
        title: '软件交付任务',
        type: 'object',
        required: ['id', 'goalId', 'role', 'acceptance'],
        properties: {
          id: { type: 'string' },
          goalId: { type: 'string' },
          role: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      }, null, 2)}\n`,
    }),
    Object.freeze({
      path: 'rules/acceptance.md',
      text: [
        '# 验收规则',
        '',
        '1. 每条验收标准都要有**可复跑**的命令，不接受"我看过了"。',
        '2. 机器验收先过、人工评审在后；两者都过才算交付。',
        '3. 交付物必须带内容哈希与来源，缺一个就不能进入下一岗位。',
        '4. 验证不通过时退回给实现岗位，并附上失败输出的原文。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'tests/samples.json',
      text: `${JSON.stringify([
        { name: '只读岗位不能写文件', expect: 'denied' },
        { name: '实现岗位可以提交工作目录内的改动', expect: 'allowed' },
        { name: '验证岗位可以跑仓库里已有的检查', expect: 'allowed' },
      ], null, 2)}\n`,
    }),
    Object.freeze({
      path: 'docs/README.md',
      text: [
        '# 软件交付团队（内置能力包）',
        '',
        '这是 Legion 的第一个内置能力包，用来验证能力包协议本身。',
        '',
        '- 五个岗位：规划、架构、实现、验证、评审。',
        '- 一条五段流水线，逐段交接，最后一段没有下游。',
        '- 团队不携带任何凭据：需要外部资源时只留引用，由宿主解析。',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      path: 'docs/CHANGELOG.md',
      text: [
        '# 变更',
        '',
        '## 1.0.0',
        '- 首个内置能力包。',
        version === '1.0.0' ? '' : '## 1.1.0\n- 提示段补充"不要注释掉跑不通的检查"。\n',
        '',
      ].join('\n'),
    }),
  ])
}

/**
 * 造一份内置包的 manifest + 载荷。
 *
 * `version` 可注入，让"升一次级"这条完成标准能被**真的**构造出来
 * （升级必须有内容差异，否则 `store.upgrade` 会以 `UPGRADE_NO_CHANGE` 拒绝）。
 */
export function buildSoftwareDeliveryPack({ version = '1.0.0' } = {}) {
  const files = buildFiles({ version })
  const entries = normalizePayload(files)
  const manifest = {
    manifestVersion: PACK_MANIFEST_VERSION,
    packId: SOFTWARE_DELIVERY_PACK_ID,
    packType: SOFTWARE_DELIVERY_PACK_TYPE,
    version,
    packProtocolVersion: PACK_PROTOCOL_VERSION,
    contentHash: contentHashOfEntries(entries),
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    entrypoints: { teamPlan: 'team/team-plan.json' },
    // 内置包不依赖别的包。空表要**写出来**：缺 `dependsOn` 是拒绝。
    dependsOn: [],
    compatibility: {
      product: '^1.0.0',
      packProtocolVersion: PACK_PROTOCOL_VERSION,
      dshCompositionPatchVersion: '^1.0.0',
    },
    requestedPermissions: REQUESTED_PERMISSIONS,
    dataDependencies: [
      { id: 'workspace', kind: 'workspace-state' },
      { id: 'goal', kind: 'goal-context' },
      { id: 'upstream', kind: 'upstream-delivery' },
      { id: 'artifacts', kind: 'artifact' },
    ],
    // 内置包没有签名者：它的身份来自**宿主的登记表**，不是这个字段。
    provenance: null,
    containsSecrets: false,
  }
  return Object.freeze({ manifest, files })
}

/** 1.0.0 的包。 */
export const SOFTWARE_DELIVERY_PACK = buildSoftwareDeliveryPack({ version: '1.0.0' })

/** 1.1.0 的包（只改了提示段与变更日志，内容哈希因此不同）。 */
export const SOFTWARE_DELIVERY_PACK_NEXT = buildSoftwareDeliveryPack({ version: '1.1.0' })

/**
 * 宿主对**内置包**的授予。这是宿主侧的判断，不是包能改的东西。
 *
 * 它逐项等于包的聚合声明——因为这是内置首包，宿主预先授予了它需要的东西。
 * 一个**更严**的宿主（用例里会构造）会让同一个包被拒：那正是
 * "方向必须是包 ⊆ 宿主"这句话可被检验的方式。
 */
export const SOFTWARE_DELIVERY_GRANT = Object.freeze({
  allowedCapabilities: REQUESTED_PERMISSIONS.capabilities,
  allowedTools: REQUESTED_PERMISSIONS.tools,
  maxRisk: REQUESTED_PERMISSIONS.maxRisk,
  workspaceRoot: REQUESTED_PERMISSIONS.workspaceRoot,
})

/** 宿主强制面基线（内置包用有人值守档）。 */
export const SOFTWARE_DELIVERY_SURFACE = hostEnforcementSurface({
  preset: 'legion-attended',
  grant: SOFTWARE_DELIVERY_GRANT,
  patchVersion: SOFTWARE_DELIVERY_HOST.dshCompositionPatchVersion,
})

/** 宿主的内置包登记表。**内置身份只来自这里。** */
export const SOFTWARE_DELIVERY_BUILTIN_IDS = Object.freeze([SOFTWARE_DELIVERY_PACK_ID])

/** 1.0.0 的完整预检。 */
export const SOFTWARE_DELIVERY_VERDICT = preflightPack({
  manifest: SOFTWARE_DELIVERY_PACK.manifest,
  files: SOFTWARE_DELIVERY_PACK.files,
  host: SOFTWARE_DELIVERY_HOST,
  hostSurface: SOFTWARE_DELIVERY_SURFACE,
  installed: [],
  builtinPackIds: SOFTWARE_DELIVERY_BUILTIN_IDS,
})

if (SOFTWARE_DELIVERY_VERDICT.ok !== true) {
  // 内置包是产品的一部分：它编译不出来就不该启动。
  // 这不是"自检失败"（那种我们要留值），这是**产品坏了**（那种要立刻停）。
  throw new Error(
    `内部错误（PRT-1006）：内置能力包 ${SOFTWARE_DELIVERY_PACK_ID}@1.0.0 没有通过预检：`
    + JSON.stringify(SOFTWARE_DELIVERY_VERDICT.problems.map((p) => `${p.code}@${p.field}`)),
  )
}

/** 1.1.0 的完整预检（升级复用同一条链路，没有"绕过校验的升级通道"）。 */
export const SOFTWARE_DELIVERY_UPGRADE_VERDICT = preflightPack({
  manifest: SOFTWARE_DELIVERY_PACK_NEXT.manifest,
  files: SOFTWARE_DELIVERY_PACK_NEXT.files,
  host: SOFTWARE_DELIVERY_HOST,
  hostSurface: SOFTWARE_DELIVERY_SURFACE,
  installed: [{ packId: SOFTWARE_DELIVERY_PACK_ID, version: '1.0.0' }],
  builtinPackIds: SOFTWARE_DELIVERY_BUILTIN_IDS,
})

/** 1.0.0 编译出的不可变团队方案。 */
export const SOFTWARE_DELIVERY_PLAN = compileTeamPlan({
  manifest: SOFTWARE_DELIVERY_PACK.manifest,
  files: SOFTWARE_DELIVERY_PACK.files,
  compiledAtMs: 0,
})

/** 1.1.0 编译出的不可变团队方案。 */
export const SOFTWARE_DELIVERY_PLAN_NEXT = compileTeamPlan({
  manifest: SOFTWARE_DELIVERY_PACK_NEXT.manifest,
  files: SOFTWARE_DELIVERY_PACK_NEXT.files,
  compiledAtMs: 0,
})

// ---------------------------------------------------------------------------
// 走一遍真实链路
// ---------------------------------------------------------------------------

/**
 * 从**安装记录**到一个**钉住版本的目标**。
 *
 * 顺序是刻意的，与 spec §8.1 的"用户创建目标 → 冻结 TeamPlan"一致：
 *   预检（先于一切） → 记录安装 → 启用 → 编译计划 → 创建目标（钉在计划上）
 * 之后再来一次升级：**只动最新版指针，不动已经建出来的目标**。
 */
function runDeliveryFlow() {
  const store = createPackStore({ now: () => 0 })
  const registry = createPlanRegistry({ now: () => 0 })

  const installRecord = store.install({
    manifest: SOFTWARE_DELIVERY_PACK.manifest,
    verdict: SOFTWARE_DELIVERY_VERDICT,
  })
  const enabled = store.enable(SOFTWARE_DELIVERY_PACK_ID)

  const planV1 = registry.publish(SOFTWARE_DELIVERY_PLAN)
  const target = registry.createTarget({ targetId: 'goal-1', planId: planIdOf(planV1) })

  // 升级：同一份校验链再跑一次，然后只把"最新版"往前提。
  const upgradeRecord = store.upgrade({
    manifest: SOFTWARE_DELIVERY_PACK_NEXT.manifest,
    verdict: SOFTWARE_DELIVERY_UPGRADE_VERDICT,
  })
  registry.publish(SOFTWARE_DELIVERY_PLAN_NEXT)

  return Object.freeze({
    store,
    registry,
    installRecord,
    enabled,
    upgradeRecord,
    target,
    planV1,
    // ★ 两个方向都要看得见：最新版**已经**是 1.1.0，而运行中的目标**仍然**报 1.0.0。
    latestVersionAfterUpgrade: registry.latestPlanOf(SOFTWARE_DELIVERY_PACK_ID).packVersion,
    targetVersionAfterUpgrade: registry.versionOf(target.targetId).packVersion,
    targetStillTheSamePlan: registry.planOf(target.targetId) === planV1,
  })
}

/** 真实链路的产物（模块装载时算一次，读数全部导出）。 */
export const SOFTWARE_DELIVERY_FLOW = runDeliveryFlow()

// ---------------------------------------------------------------------------
// 装载时自检
// ---------------------------------------------------------------------------

function codeOf(fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

/**
 * 内置包的自检。**可注入，且用一个坏基线反向证明它真的会拒。**
 *
 * 正确实现下 `problems` 恒为空，所以"拒绝那一段"在真实输入上永远不触发：
 *
 *   > 一段永远不会触发的拒绝，与一段不存在的拒绝，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 *
 * 所以 `narrowVerdict` 是必需的：同一份包内容，只把宿主基线收窄一项，
 * 它必须**立刻**被拒。
 */
export function assertSoftwareDeliverySemantics({
  pack = SOFTWARE_DELIVERY_PACK,
  host = SOFTWARE_DELIVERY_HOST,
  hostSurface = SOFTWARE_DELIVERY_SURFACE,
  builtinPackIds = SOFTWARE_DELIVERY_BUILTIN_IDS,
} = {}) {
  const problems = []
  const samples = {}

  const verdict = preflightPack({ manifest: pack.manifest, files: pack.files, host, hostSurface, installed: [], builtinPackIds })
  samples.verdictOk = verdict.ok
  samples.verdictCodes = Object.freeze(verdict.problems.map((p) => p.code))
  if (verdict.ok !== true) problems.push(`内置包没有通过预检：${JSON.stringify(samples.verdictCodes)}`)

  // 内置身份来自登记表，不来自包
  samples.trust = verdict.computed.trust
  samples.trustWithoutRegistry = preflightPack({
    manifest: pack.manifest, files: pack.files, host, hostSurface, installed: [], builtinPackIds: [],
  }).computed.trust
  if (samples.trust !== 'builtin') problems.push(`内置包的可信等级是 ${samples.trust}，期望 builtin`)
  if (samples.trustWithoutRegistry !== 'unsigned') {
    problems.push(`把内置登记表清空后等级仍然是 ${samples.trustWithoutRegistry}——那说明"内置"不是宿主说的`)
  }

  // 权限方向：宿主基线收窄一项 → 必须被拒
  const narrowSurface = hostEnforcementSurface({
    preset: 'legion-attended',
    patchVersion: host.dshCompositionPatchVersion,
    grant: {
      allowedCapabilities: SOFTWARE_DELIVERY_GRANT.allowedCapabilities.filter((c) => c !== 'repo:write'),
      allowedTools: SOFTWARE_DELIVERY_GRANT.allowedTools,
      maxRisk: SOFTWARE_DELIVERY_GRANT.maxRisk,
      workspaceRoot: SOFTWARE_DELIVERY_GRANT.workspaceRoot,
    },
  })
  const narrowVerdict = preflightPack({
    manifest: pack.manifest, files: pack.files, host, hostSurface: narrowSurface, installed: [], builtinPackIds,
  })
  samples.narrowVerdictCode = narrowVerdict.code
  samples.narrowVerdictCreatedNothing = narrowVerdict.ok === false
  if (narrowVerdict.code !== 'pack-authority-capability-widens-host') {
    problems.push(`宿主收窄 repo:write 后内置包没有被判成越权（${narrowVerdict.code}）`)
  }

  // 密钥与强制面：两条扫描的读数都是 0，而不是"作者说没有"
  samples.secretHits = verdict.computed.secretHits.length
  samples.bypassHits = verdict.computed.bypassHits.length
  if (samples.secretHits !== 0) problems.push(`内置包载荷里扫到 ${samples.secretHits} 处密钥`)
  if (samples.bypassHits !== 0) problems.push(`内置包载荷里扫到 ${samples.bypassHits} 处强制面记号`)

  // 计划：不可变 + 哈希自洽
  const plan = compileTeamPlan({ manifest: pack.manifest, files: pack.files, compiledAtMs: 0 })
  const immutable = assertPlanImmutable({ plan })
  samples.planVersion = plan.planVersion
  samples.planHash = plan.planHash
  samples.planFrozenPathCount = immutable.frozenPathCount
  samples.planMutablePaths = immutable.mutablePaths
  samples.planRoles = Object.freeze(plan.employees.map((e) => e.role))
  samples.pipelineStages = Object.freeze(plan.pipeline.map((s) => `${s.stage}:${s.role}->${s.handoffTo ?? 'null'}`))
  samples.planCompileCode = codeOf(() => compileTeamPlan({ manifest: pack.manifest, files: pack.files, compiledAtMs: 0 }))
  if (plan.planVersion !== COMPILED_TEAM_PLAN_VERSION) problems.push('计划版本不对')
  if (immutable.mutablePaths.length !== 0) problems.push('内置包编译出的计划有没冻住的地方')
  if (plan.employees.length !== EMPLOYEES.length) problems.push('计划里的岗位数与包内容不一致')
  if (plan.pipeline.length !== PIPELINE.length) problems.push('计划里的流水线段数与包内容不一致')

  // 数据依赖的种类必须在 §6.5 的来源类型里（由 authority 判，这里留读数）
  samples.dataDependencyKinds = Object.freeze(pack.manifest.dataDependencies.map((d) => d.kind))

  return Object.freeze({ problems: Object.freeze(problems), samples: Object.freeze(samples) })
}

// 装载即执行。导出的是**算出来的读数**（码、哈希、冻结路径数、两个方向的版本）。
export const SOFTWARE_DELIVERY_CHECKED = Object.freeze({
  packId: SOFTWARE_DELIVERY_PACK_ID,
  packType: SOFTWARE_DELIVERY_PACK_TYPE,
  version: SOFTWARE_DELIVERY_PACK.manifest.version,
  nextVersion: SOFTWARE_DELIVERY_PACK_NEXT.manifest.version,
  fileCount: SOFTWARE_DELIVERY_PACK.files.length,
  contentHash: SOFTWARE_DELIVERY_PACK.manifest.contentHash,
  nextContentHash: SOFTWARE_DELIVERY_PACK_NEXT.manifest.contentHash,
  installedVersion: SOFTWARE_DELIVERY_VERDICT.computed.version,
  trust: SOFTWARE_DELIVERY_VERDICT.computed.trust,
  upgradeVerdictOk: SOFTWARE_DELIVERY_UPGRADE_VERDICT.ok,
  upgradeVerdictCodes: Object.freeze(SOFTWARE_DELIVERY_UPGRADE_VERDICT.problems.map((p) => p.code)),
  planId: planIdOf(SOFTWARE_DELIVERY_PLAN),
  planHash: SOFTWARE_DELIVERY_PLAN.planHash,
  flow: Object.freeze({
    installKind: SOFTWARE_DELIVERY_FLOW.installRecord.kind,
    enableChanged: SOFTWARE_DELIVERY_FLOW.enabled.changed,
    upgradeFrom: SOFTWARE_DELIVERY_FLOW.upgradeRecord.fromVersion,
    upgradeTo: SOFTWARE_DELIVERY_FLOW.upgradeRecord.version,
    recordKinds: Object.freeze(SOFTWARE_DELIVERY_FLOW.store.history().map((r) => r.kind)),
    activeVersion: SOFTWARE_DELIVERY_FLOW.store.stateOf(SOFTWARE_DELIVERY_PACK_ID).activeVersion,
    enabled: SOFTWARE_DELIVERY_FLOW.store.stateOf(SOFTWARE_DELIVERY_PACK_ID).enabled,
    latestVersionAfterUpgrade: SOFTWARE_DELIVERY_FLOW.latestVersionAfterUpgrade,
    targetVersionAfterUpgrade: SOFTWARE_DELIVERY_FLOW.targetVersionAfterUpgrade,
    targetStillTheSamePlan: SOFTWARE_DELIVERY_FLOW.targetStillTheSamePlan,
  }),
  // 内置包用的强制面：有人值守档 + 宿主预授予的授予表。
  surfaceOrigin: SOFTWARE_DELIVERY_SURFACE.origin,
  surfacePreset: SOFTWARE_DELIVERY_SURFACE.preset,
  surfaceSandbox: SOFTWARE_DELIVERY_SURFACE.sandbox,
  surfaceApproval: SOFTWARE_DELIVERY_SURFACE.approval,
  ...assertSoftwareDeliverySemantics(),
})

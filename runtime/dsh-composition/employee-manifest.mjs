// runtime/dsh-composition/employee-manifest.mjs
// ============================================================================
// PRT-603：接入 EmployeeManifest 工具白名单
//
// spec line 925：「`PRT-603`：接入 EmployeeManifest 工具白名单。」
// spec §6.9 line 489：员工 agent preset 属于 **agent 平面**，按 session 挂载，
//   内容是"岗位工具集、persona、提示段、skill 引用"。
// spec §6.9 line 488：ToolGuard hard floor、`tools/pre-execute` 策略 listener、
//   approval answerer、Legion 自有 permission preset 表属于 **host 组合 / profile 层**。
// spec line 472：「无人值守模式下，要求人工审批的操作默认拒绝或保持等待，**不自动降级
//   为允许**。legacy 路径在完成 DSH 强制面接线前禁止高风险工具。」
//
// ---------------------------------------------------------------------------
// 唯一真正要紧的纪律：**清单只能收窄，不能放宽**
//
// 员工清单挂在 agent 平面（按 session 挂载），而强制面挂在 host 组合。
// 两者是**不同的平面**，所以清单里的任何一项都**不能**产生新的权限——
// 它只能从"这个员工已经被授予的东西"里**减掉**。
//
//   > 一个「岗位清单里写着 allow 工具 X」的清单，
//   > 与一个「岗位自己给自己发权限」的清单，是同一个东西——
//   > 只不过前者看起来像配置。
//
// 所以合并是**取交集**，而且越权项要**响亮地抛**，不能静默丢掉：
//
//   > 一个「取交集、静默丢掉越权项」的清单合并，
//   > 与一个「岗位在申请一个它没有的工具、而没人知道」的清单合并，是同一个东西。
//
// ---------------------------------------------------------------------------
// 第二件事：白名单**不能**是空的判定
//
// 一个白名单唯一有意义的时候，是它**拒绝**某样东西的时候。三种写法会让它恒真：
//
//   ① 支持通配符 `*`
//
//   > 一个「支持通配 `*`」的白名单，
//   > 与一个「所有工具都被允许」的白名单，是同一个东西——
//   > 只不过前者在配置里看起来是有选择的。
//
//   ② 用"它的能力都在允许集合里"判定**未知**工具
//
//   未知工具的能力集合是**空集**，而空集是任何集合的子集。于是
//   `every(c => allowed.includes(c))` 对未知工具**恒真**：
//
//   > 一个「用'它的能力都在允许集合里'来判定未知工具」的白名单，
//   > 与一个「所有未知工具都被允许」的白名单，是同一个东西——
//   > 因为未知工具的能力集合是空的，而空集是任何集合的子集。
//
//   ③ 靠**能力**授权去到达 hard floor 动作
//
//   > 一个「靠能力授权就能到达 hard floor 动作」的白名单，
//   > 与一个「删除文件这件事不需要在岗位清单里被点名」的白名单，是同一个东西。
//
// 所以：未知工具、hard floor 工具都必须在 `allowedTools` 里**被点名**。
//
// ---------------------------------------------------------------------------
// 第三件事：按**能力**列举比按工具名列举更耐用
//
//   > 一个「按工具名列举」的白名单，
//   > 与一个「工具改名之后这个岗位就什么都做不了」的白名单，是同一个东西。
//
// 所以清单同时支持 `allowedTools`（名字）与 `allowedCapabilities`（能力）。
// 但两者都不是"放宽"：写进清单的能力必须已经在授予里。
// ============================================================================

import { CAPABILITY_IDS, CAPABILITY_KINDS, RISK_RANK, resolveTool } from './tool-capability.mjs'
import { EMPLOYEE_PRESET_CONTRACT } from './patch-layer.mjs'

export const EMPLOYEE_MANIFEST_VERSION = 'legion/employee-manifest@1'

export const MANIFEST_CODES = Object.freeze({
  BAD_MANIFEST: 'employee-manifest-malformed',
  WIDENS_GRANT: 'employee-manifest-widens-grant',
  WILDCARD: 'employee-manifest-wildcard',
  ENFORCEMENT_ON_AGENT_PLANE: 'employee-manifest-enforcement-on-agent-plane',
  UNKNOWN_CAPABILITY: 'employee-manifest-unknown-capability',
  BAD_RISK: 'employee-manifest-bad-risk',
  OUT_OF_WORKSPACE: 'employee-manifest-out-of-workspace',
  NOT_WHITELISTED: 'employee-manifest-not-whitelisted',
  UNKNOWN_TOOL_NOT_NAMED: 'employee-manifest-unknown-tool-not-named',
  HARD_FLOOR_NOT_NAMED: 'employee-manifest-hard-floor-not-named',
  RISK_ABOVE_CEILING: 'employee-manifest-risk-above-ceiling',
  AMBIGUOUS: 'employee-manifest-ambiguous',
})

/**
 * 清单里**不允许**出现的字段。
 *
 * 强制面属于 host 组合（§6.9 line 488），员工清单属于 agent 平面（line 489）。
 * 一个能写这些字段的清单，就是一个能给自己发权限的清单。
 */
export const FORBIDDEN_MANIFEST_FIELDS = Object.freeze([
  'hardFloor', 'hard_floor', 'denyTools', 'denyPathPrefixes',
  'approval', 'approvalPolicy', 'sandbox', 'permissionPreset', 'permission_preset',
  'presets', 'allowOnce', 'allow_once', 'guard', 'preExecute', 'answerer',
])

/** 清单允许出现的字段（两个方向都查，见 `assertManifestFieldsClosed`）。 */
export const MANIFEST_FIELDS = Object.freeze([
  'version', 'employeeId', 'role', 'displayName', 'allowedTools', 'allowedCapabilities',
  'maxRisk', 'workspaceRoot', 'unattended', 'notes',
])

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/**
 * 清单字段必须**闭合**：不在名单里的字段一律拒绝。
 *
 *   > 一个「忽略不认识字段」的清单，
 *   > 与一个「多打的一个字母让整条限制静默失效」的清单，是同一个东西。
 *
 * 这一条与 `FORBIDDEN_MANIFEST_FIELDS` 是两件事：前者查"我知道的字段里没有越权的"，
 * 后者查"出现了一个我不知道的字段"。只做前者时，`denyTools` 拼成 `denyTool` 就绕过了。
 */
export function assertManifestFieldsClosed({ manifest, fields = MANIFEST_FIELDS } = {}) {
  const seen = Object.keys(manifest ?? {})
  const unknown = seen.filter((k) => !fields.includes(k))
  const forbidden = seen.filter((k) => FORBIDDEN_MANIFEST_FIELDS.includes(k))
  if (forbidden.length > 0) {
    throw fail(
      MANIFEST_CODES.ENFORCEMENT_ON_AGENT_PLANE,
      `员工清单里出现了强制面字段 ${JSON.stringify(forbidden)}。` +
      '强制面属于 host 组合、员工清单属于 agent 平面（spec §6.9），' +
      '一个能写这些字段的清单就是一个能给自己发权限的清单',
    )
  }
  if (unknown.length > 0) {
    throw fail(
      MANIFEST_CODES.BAD_MANIFEST,
      `员工清单里出现了不认识的字段 ${JSON.stringify(unknown)}。不忽略——` +
      '一个"忽略不认识字段"的清单，与一个"多打的一个字母让整条限制静默失效"的清单，是同一个东西',
    )
  }
  return Object.freeze({ fields: Object.freeze(seen), unknown: Object.freeze(unknown), forbidden: Object.freeze(forbidden) })
}

/** 名字类清单里不得有通配符。 */
export function assertNoWildcard({ list, what = '列表' } = {}) {
  const wild = (list ?? []).filter((x) => typeof x !== 'string' || x.includes('*') || x.includes('?') || x.trim() === '')
  if (wild.length > 0) {
    throw fail(
      MANIFEST_CODES.WILDCARD,
      `${what} 里出现了通配或空项 ${JSON.stringify(wild)}。` +
      '一个"支持通配 `*`"的白名单，与一个"所有工具都被允许"的白名单，是同一个东西——' +
      '只不过前者在配置里看起来是有选择的',
    )
  }
  return Object.freeze({ list: Object.freeze([...(list ?? [])]), wild: Object.freeze(wild) })
}

/**
 * 归一化并校验一份员工清单。**只校验，不合并**。
 */
export function normalizeManifest(input) {
  if (input === null || typeof input !== 'object') {
    throw fail(MANIFEST_CODES.BAD_MANIFEST, 'normalizeManifest 需要一份清单对象')
  }
  assertManifestFieldsClosed({ manifest: input })

  const employeeId = String(input.employeeId ?? '').trim()
  if (employeeId === '') throw fail(MANIFEST_CODES.BAD_MANIFEST, '员工清单缺少 employeeId')
  const role = String(input.role ?? '').trim()
  if (role === '') throw fail(MANIFEST_CODES.BAD_MANIFEST, `员工 ${employeeId} 的清单缺少 role`)

  const allowedTools = assertNoWildcard({ list: input.allowedTools ?? [], what: `${employeeId} 的 allowedTools` }).list
  const allowedCapabilities = assertNoWildcard({ list: input.allowedCapabilities ?? [], what: `${employeeId} 的 allowedCapabilities` }).list

  const badCaps = allowedCapabilities.filter((c) => !CAPABILITY_IDS.includes(c))
  if (badCaps.length > 0) {
    throw fail(
      MANIFEST_CODES.UNKNOWN_CAPABILITY,
      `${employeeId} 的 allowedCapabilities 里有不认识的能力 ${JSON.stringify(badCaps)}。` +
      `合法值：${CAPABILITY_IDS.join(' / ')}。拼错的能力名会让这一条限制**静默失效**`,
    )
  }

  const maxRisk = String(input.maxRisk ?? '').trim()
  if (!Object.prototype.hasOwnProperty.call(RISK_RANK, maxRisk)) {
    throw fail(
      MANIFEST_CODES.BAD_RISK,
      `${employeeId} 的 maxRisk 是 ${JSON.stringify(input.maxRisk)}，不在 ${JSON.stringify(Object.keys(RISK_RANK))} 里。` +
      '不给默认值——一个"maxRisk 写错了就用最宽松的那个"的解析，与一个"没有上限"的解析，是同一个东西',
    )
  }

  const workspaceRoot = input.workspaceRoot === undefined || input.workspaceRoot === null
    ? null
    : String(input.workspaceRoot).trim()
  if (input.workspaceRoot !== undefined && input.workspaceRoot !== null && workspaceRoot === '') {
    throw fail(MANIFEST_CODES.BAD_MANIFEST, `${employeeId} 的 workspaceRoot 是空串`)
  }

  return Object.freeze({
    version: EMPLOYEE_MANIFEST_VERSION,
    employeeId,
    role,
    displayName: input.displayName === undefined || input.displayName === null ? role : String(input.displayName),
    allowedTools: Object.freeze([...new Set(allowedTools)]),
    allowedCapabilities: Object.freeze([...new Set(allowedCapabilities)]),
    maxRisk,
    workspaceRoot,
    unattended: input.unattended === true,
    // ⚠️ 归一化必须**幂等**：`notes` 的裸 `null` 与字符串 `'null'` 是两件事。
    // 第一版写的是 `input.notes === undefined ? null : String(input.notes)`，
    // 于是第二次归一化把 `null` 变成了 `'null'`（装载自检抓到的）。
    //
    //   > 一个「第二次归一化把 null 变成 'null'」的归一化，
    //   > 与一个「每次经过一层就多出一点内容是'已处理'」的归一化，是同一个东西。
    notes: input.notes === undefined || input.notes === null ? null : String(input.notes),
  })
}

function rankOf(risk) {
  const r = RISK_RANK[risk]
  if (typeof r !== 'number') throw fail(MANIFEST_CODES.BAD_RISK, `不认识的风险等级 ${JSON.stringify(risk)}`)
  return r
}

/**
 * 把清单**收窄**到授予之内，得到该员工的有效许可。
 *
 * 越权项**抛**，不静默丢。
 *
 * @param {object} p
 * @param {object} p.manifest 已归一化的清单
 * @param {object} p.grant    该员工的授予（host 平面给的，清单不能改它）
 */
export function narrowToGrant({ manifest, grant } = {}) {
  // ⚠️ **总是**归一化。第一版写的是
  //     `manifest?.version === EMPLOYEE_MANIFEST_VERSION ? manifest : normalizeManifest(manifest)`
  // —— 于是清单里写一行 `version` 就跳过了**全部**校验（字段闭合、通配符、
  //    不认识的能力名、风险等级）。装载自检当场撞上了这一点。
  //
  //   > 一个「看到 version 字段就认为它已经校验过」的校验，
  //   > 与一个「在清单里写一行 version 就能跳过所有检查」的校验，是同一个东西。
  //
  // `normalizeManifest` 是幂等的（输出只含已知字段、取值都已合法），所以重复调用无害。
  const m = normalizeManifest(manifest)
  if (grant === null || typeof grant !== 'object') {
    throw fail(MANIFEST_CODES.BAD_MANIFEST, `员工 ${m.employeeId} 没有授予——清单不能在没有授予的情况下生效`)
  }
  const grantTools = new Set(grant.allowedTools ?? [])
  const grantCaps = new Set(grant.allowedCapabilities ?? [])
  const grantRisk = rankOf(grant.maxRisk ?? 'low')
  const grantRoot = grant.workspaceRoot ?? null

  const toolOverreach = m.allowedTools.filter((t) => !grantTools.has(t))
  const capOverreach = m.allowedCapabilities.filter((c) => !grantCaps.has(c))
  if (toolOverreach.length > 0 || capOverreach.length > 0) {
    throw fail(
      MANIFEST_CODES.WIDENS_GRANT,
      `员工 ${m.employeeId} 的清单申请了授予之外的东西：工具 ${JSON.stringify(toolOverreach)}，能力 ${JSON.stringify(capOverreach)}。` +
      '清单只能收窄——一个"取交集、静默丢掉越权项"的清单合并，' +
      '与一个"岗位在申请一个它没有的工具、而没人知道"的清单合并，是同一个东西',
    )
  }

  const manifestRisk = rankOf(m.maxRisk)
  if (manifestRisk > grantRisk) {
    throw fail(
      MANIFEST_CODES.WIDENS_GRANT,
      `员工 ${m.employeeId} 的 maxRisk=${m.maxRisk} 高于授予的 ${grant.maxRisk}。清单只能收窄`,
    )
  }

  if (m.workspaceRoot !== null && grantRoot !== null) {
    // 工作目录也只能收窄：清单的根必须**在授予的根之内**（或相等）。
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const root = norm(grantRoot)
    const mine = norm(m.workspaceRoot)
    if (mine !== root && !mine.startsWith(`${root}/`)) {
      throw fail(
        MANIFEST_CODES.OUT_OF_WORKSPACE,
        `员工 ${m.employeeId} 的 workspaceRoot=${m.workspaceRoot} 不在授予的 ${grantRoot} 之内。` +
        '工作目录同样只能收窄——一个"能把自己的工作目录指到别处"的清单，' +
        '与一个"越界检查其实以清单为准"的清单，是同一个东西',
      )
    }
  } else if (m.workspaceRoot !== null && grantRoot === null) {
    // 授予没有限定工作目录 → 清单指定一个等于放宽（授予没说不许）。拒绝。
    throw fail(
      MANIFEST_CODES.OUT_OF_WORKSPACE,
      `员工 ${m.employeeId} 指定了 workspaceRoot 但授予没有限定工作目录——那样清单是在**放宽**，不是在收窄`,
    )
  }

  return Object.freeze({
    version: EMPLOYEE_MANIFEST_VERSION,
    employeeId: m.employeeId,
    role: m.role,
    displayName: m.displayName,
    unattended: m.unattended,
    // 有效许可 = 清单（清单已在授予之内，所以就是清单本身）
    allowedTools: m.allowedTools,
    allowedCapabilities: m.allowedCapabilities,
    maxRisk: m.maxRisk,
    workspaceRoot: m.workspaceRoot ?? grantRoot,
    // 留证：这两个等级必须相等或清单更低
    grantMaxRisk: grant.maxRisk,
    manifestMaxRisk: m.maxRisk,
  })
}

/**
 * 判定一次调用是否在这个员工的白名单之内。
 *
 * 失败一律 `allowed: false`，并把**是哪一条规则**拒绝的写进 `rule`。
 * 这一点很重要：说明书 §6.8 要求拒绝可归因，而"岗位清单"与"策略规则"是
 * **两处不同的配置**，值班的人要能分清该改哪一个。
 *
 * ## ★★★ 2026-09-18 第 21 轮：这个函数的输入是 **Legion 能力名**，不是执行面名
 *
 * `toolName` 走 `resolveTool()`，也就是**本仓的能力目录**
 * （`read-file` / `write-file` / `git-push` / `run-command` / …）。
 * 而强制面桥那一侧交进来的名字是**执行面（DSH）的工具名**
 * （`read` / `write` / `bash` / `web_fetch` / …）——两个空间**结构上不相交**
 * （同一件事在**静态下限**上早就写着：`tool-capability.mjs:465-492`）。
 *
 * 实测（第 21 轮，`scripts/prt/whitelist-limb.test.mjs` ③）：同一份 `permit`，
 * 喂 Legion 名 ⇒ **放行**；喂 DSH 名 ⇒ **一个都不放行**。而把 `maxRisk`
 * 抬到最高也**救不了**——拒因从 `risk-above-ceiling` 挪到
 * `unknown-tool-not-named`，**还是拒**。
 *
 *   > 一个「拒得对、而理由是错的」的检查，
 *   > 与一个「放行了它该拒的」的检查，在今天的行为上是同一个东西——
 *   > 只不过照着理由去改的人会改错地方，而改完仍然是拒的，
 *   > 于是没有人会发现理由本身是错的。
 *
 * ⇒ 于是**"用 DSH 名调这个函数"是一条走不通的路**，而它走不通的方式是"全拒"，
 * 不是"报错"：接进桥只会得到一个**全拒**的强制面，看起来像"岗位清单写错了"。
 * 要走通需先裁决「岗位清单说的是哪套名字」（`MULTI-AGENT-FEATURE-STATUS.md`
 * §5 第 27 条）；而**翻译不是机械的**——`LEGION_TOOL_ROUTING` 的反推在
 * `bash` / `pwsh`（各 4 个）与 `web_fetch`（2 个）上**一对多**，
 * 而 `bash` 那一堆里同时塌着低风险的 `git-status` 与高风险的 `git-push`。
 * @returns {{allowed: boolean, rule: string|null, reason: string|null, riskRaised: boolean}}
 */
export function permitsTool({ permit, toolName, capabilities = null } = {}) {
  if (permit === null || typeof permit !== 'object') {
    return Object.freeze({ allowed: false, rule: 'no-permit', reason: '这个员工没有有效许可', riskRaised: false })
  }
  const name = String(toolName ?? '').trim()
  if (name === '') {
    return Object.freeze({ allowed: false, rule: 'bad-tool-name', reason: '工具名是空的', riskRaised: false })
  }
  const facts = resolveTool(name)
  const caps = capabilities ?? facts.capabilities
  const ranked = rankOf(permit.maxRisk)
  const toolRisk = rankOf(facts.risk)

  // ① 风险上限：与是否被点名无关。先查它，因为它是最强的收窄。
  if (toolRisk > ranked) {
    return Object.freeze({
      allowed: false,
      rule: MANIFEST_CODES.RISK_ABOVE_CEILING,
      reason: `工具 ${name} 的有效风险 ${facts.risk} 高于岗位上限 ${permit.maxRisk}`,
      riskRaised: facts.riskRaised === true,
    })
  }

  const named = permit.allowedTools.includes(name)

  // ② 未知工具必须**被点名**。
  //
  // 未知工具的能力集合是**空集**，空集是任何集合的子集，所以"它的能力都在允许集合里"
  // 对未知工具恒真。
  //
  //   > 一个「用'它的能力都在允许集合里'来判定未知工具」的白名单，
  //   > 与一个「所有未知工具都被允许」的白名单，是同一个东西。
  if (!facts.known && !named) {
    return Object.freeze({
      allowed: false,
      rule: MANIFEST_CODES.UNKNOWN_TOOL_NOT_NAMED,
      reason: `工具 ${name} 不在工具目录里，必须由岗位清单**点名**才允许——` +
        '未知工具的能力集合是空集，而空集是任何集合的子集，所以"能力都在允许集合里"对它恒真',
      riskRaised: false,
    })
  }

  // ③ hard floor 动作必须**被点名**：靠能力授权到达它是不够的。
  if (facts.hardFloor && !named) {
    return Object.freeze({
      allowed: false,
      rule: MANIFEST_CODES.HARD_FLOOR_NOT_NAMED,
      reason: `工具 ${name} 触及 hard floor（${JSON.stringify(caps)}），必须在岗位清单里被点名——` +
        '一个"靠能力授权就能到达 hard floor 动作"的白名单，' +
        '与一个"删除文件这件事不需要在岗位清单里被点名"的白名单，是同一个东西',
      riskRaised: facts.riskRaised === true,
    })
  }

  if (named) {
    return Object.freeze({ allowed: true, rule: null, reason: null, riskRaised: facts.riskRaised === true })
  }

  // ④ 按能力：**全部**能力都要在允许集合里。
  //    多出一个没被授予的能力 → 拒绝（fail closed），不是"至少一个匹配"。
  const missing = caps.filter((c) => !permit.allowedCapabilities.includes(c))
  const capKinds = caps.map((c) => CAPABILITY_KINDS[c]).filter(Boolean)
  if (missing.length > 0 || capKinds.length !== caps.length) {
    return Object.freeze({
      allowed: false,
      rule: MANIFEST_CODES.NOT_WHITELISTED,
      reason: `工具 ${name} 的能力 ${JSON.stringify(caps)} 不都在岗位允许的 ${JSON.stringify(permit.allowedCapabilities)} 之内`
        + (missing.length > 0 ? `（多出 ${JSON.stringify(missing)}）` : '（有能力不在能力表里）'),
      riskRaised: false,
    })
  }

  return Object.freeze({ allowed: true, rule: null, reason: null, riskRaised: facts.riskRaised === true })
}

// ---------------------------------------------------------------- 装载时自检

/**
 * 空集是任何集合的子集 —— 这条性质必须**被真的演示一次**。
 *
 * 否则"未知工具必须被点名"这条规则看起来像是多余的谨慎：
 * 只有把 `every(...)` 对空集的结果算出来，才知道它恒真。
 */
export function assertEmptyCapabilityIsVacuouslyAllowed() {
  const unknownName = 'totally-unknown-manifest-probe'
  const facts = resolveTool(unknownName)
  const allowedCaps = []
  const vacuouslyTrue = facts.capabilities.every((c) => allowedCaps.includes(c))
  const emptySet = facts.capabilities.length === 0
  const permit = Object.freeze({
    version: EMPLOYEE_MANIFEST_VERSION,
    employeeId: 'probe',
    role: 'probe',
    displayName: 'probe',
    unattended: false,
    allowedTools: Object.freeze([]),
    allowedCapabilities: Object.freeze([]),
    maxRisk: 'critical',
    workspaceRoot: null,
    grantMaxRisk: 'critical',
    manifestMaxRisk: 'critical',
  })
  const verdict = permitsTool({ permit, toolName: unknownName })
  return Object.freeze({
    unknownToolCapabilities: Object.freeze([...facts.capabilities]),
    emptySet,
    everyOnEmptySet: vacuouslyTrue,
    verdict,
  })
}

/**
 * 每条规则都必须**真的能触发**。
 *
 *   > 一个「写在那里、但没有任何输入能触发它」的检查，
 *   > 与一个不存在的检查，在「它到底拦不拦得住」上是同一个东西。
 *
 * 所以逐个规则构造一份真实清单与授予，把它**走到拒绝**，并把结果留证。
 */
export function proveEveryRuleFires({ cases = RULE_PROBES } = {}) {
  const out = []
  for (const c of cases) {
    let verdict
    try {
      const permit = narrowToGrant({ manifest: c.manifest, grant: c.grant })
      const v = permitsTool({ permit, toolName: c.toolName, capabilities: c.capabilities })
      verdict = Object.freeze({ ...v, message: v.reason })
    } catch (err) {
      verdict = Object.freeze({
        allowed: false,
        rule: err?.code ?? null,
        reason: err?.message ?? String(err),
        message: err?.message ?? String(err),
        threw: err?.code ?? err?.message ?? String(err),
      })
    }
    out.push(Object.freeze({ label: c.label, expectedRule: c.expectedRule, expectedMarker: c.expectedMarker ?? null, verdict }))
  }
  const misfired = out.filter((o) => o.verdict.allowed !== false
    || (o.expectedRule !== null && o.verdict.rule !== o.expectedRule && o.verdict.threw !== o.expectedRule)
    || (o.expectedMarker !== null && !String(o.verdict.message ?? '').includes(o.expectedMarker)))
  return Object.freeze({ cases: Object.freeze(out), misfired: Object.freeze(misfired) })
}

/** 基线授予：探针都用它，且**故意**给得比任何清单都宽。 */
export const PROBE_GRANT = Object.freeze({
  allowedTools: Object.freeze(['read-file', 'write-file', 'delete-file', 'run-command', 'fetch-url', 'git-status', 'call-external-api']),
  allowedCapabilities: Object.freeze([...CAPABILITY_IDS]),
  maxRisk: 'critical',
  workspaceRoot: 'C:/work',
})

const mkManifest = (over) => ({
  version: EMPLOYEE_MANIFEST_VERSION,
  employeeId: 'probe-1',
  role: 'probe',
  allowedTools: [],
  allowedCapabilities: [],
  maxRisk: 'critical',
  ...over,
})

const RULE_PROBES = Object.freeze([
  Object.freeze({
    label: '通配符',
    manifest: mkManifest({ allowedTools: ['*'] }),
    grant: PROBE_GRANT,
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.WILDCARD,
    expectedMarker: '通配',
  }),
  Object.freeze({
    label: '越权工具',
    manifest: mkManifest({ allowedTools: ['nope-tool'], maxRisk: 'low' }),
    grant: PROBE_GRANT,
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.WIDENS_GRANT,
    expectedMarker: 'nope-tool',
  }),
  Object.freeze({
    label: '越权能力',
    manifest: mkManifest({ allowedCapabilities: ['file:read'], maxRisk: 'low' }),
    grant: Object.freeze({ ...PROBE_GRANT, allowedCapabilities: Object.freeze([]) }),
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.WIDENS_GRANT,
    expectedMarker: 'file:read',
  }),
  Object.freeze({
    label: '风险上限越权',
    manifest: mkManifest({ maxRisk: 'critical' }),
    grant: Object.freeze({ ...PROBE_GRANT, maxRisk: 'low' }),
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.WIDENS_GRANT,
    expectedMarker: 'maxRisk=critical',
  }),
  Object.freeze({
    label: '工作目录越权',
    manifest: mkManifest({ workspaceRoot: 'C:/elsewhere' }),
    grant: PROBE_GRANT,
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.OUT_OF_WORKSPACE,
    expectedMarker: 'C:/elsewhere',
  }),
  Object.freeze({
    label: '强制面字段',
    manifest: mkManifest({ denyTools: ['read-file'] }),
    grant: PROBE_GRANT,
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.ENFORCEMENT_ON_AGENT_PLANE,
    expectedMarker: 'denyTools',
  }),
  Object.freeze({
    label: '不认识的能力名',
    manifest: mkManifest({ allowedCapabilities: ['file:reed'] }),
    grant: PROBE_GRANT,
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.UNKNOWN_CAPABILITY,
    expectedMarker: 'file:reed',
  }),
  Object.freeze({
    label: '风险等级写错',
    manifest: mkManifest({ maxRisk: 'Critical' }),
    grant: PROBE_GRANT,
    toolName: 'read-file',
    expectedRule: MANIFEST_CODES.BAD_RISK,
    expectedMarker: '"Critical"',
  }),
  Object.freeze({
    label: '未知工具没被点名',
    manifest: mkManifest({ allowedCapabilities: [...CAPABILITY_IDS], maxRisk: 'critical' }),
    grant: PROBE_GRANT,
    toolName: 'totally-unknown-tool',
    expectedRule: MANIFEST_CODES.UNKNOWN_TOOL_NOT_NAMED,
    expectedMarker: '空集',
  }),
  Object.freeze({
    label: 'hard floor 只靠能力授权',
    manifest: mkManifest({ allowedCapabilities: ['file:write', 'file:delete'], maxRisk: 'critical' }),
    grant: PROBE_GRANT,
    toolName: 'delete-file',
    expectedRule: MANIFEST_CODES.HARD_FLOOR_NOT_NAMED,
    expectedMarker: 'hard floor',
  }),
  Object.freeze({
    label: '风险高于岗位上限',
    manifest: mkManifest({ allowedTools: ['delete-file', 'read-file'], maxRisk: 'high' }),
    grant: PROBE_GRANT,
    toolName: 'delete-file',
    expectedRule: MANIFEST_CODES.RISK_ABOVE_CEILING,
    expectedMarker: 'delete-file',
  }),
  Object.freeze({
    // maxRisk 必须**高于** run-command 的风险，否则先被 RISK_ABOVE_CEILING 拦下，
    // 这条规则就永远走不到。
    //   > 一个「被前一道更宽的规则挡住的探针」，
    //   > 与一个「从没验证过这条规则」的探针，是同一个东西。
    label: '能力不都在允许集合里',
    manifest: mkManifest({ allowedCapabilities: ['repo:read'], maxRisk: 'critical' }),
    grant: PROBE_GRANT,
    toolName: 'run-command',
    expectedRule: MANIFEST_CODES.NOT_WHITELISTED,
    expectedMarker: '多出',
  }),
])

/**
 * 通配符与其它"会让白名单恒真"的写法必须**被真的拒绝一次**，而不是只写在拒绝名单里。
 *
 *   > 一个「写在拒绝名单里、但没有任何输入能走到它」的检查，
 *   > 与一个不存在的检查，在「它到底拦不拦得住」上是同一个东西。
 */
export function proveWildcardsRejected({ samples = ['*', 'file*', 'file?', '  ', 42] } = {}) {
  const rejected = []
  for (const s of samples) {
    try {
      assertNoWildcard({ list: [s], what: 'probe' })
      rejected.push(Object.freeze({ sample: s, code: null }))
    } catch (err) {
      rejected.push(Object.freeze({ sample: String(s), code: err?.code ?? null }))
    }
  }
  return Object.freeze({
    samples: Object.freeze(rejected),
    allRejected: rejected.every((r) => r.code === MANIFEST_CODES.WILDCARD),
  })
}

/**
 * `EMPLOYEE_PRESET_CONTRACT` 说员工 preset "可以携带岗位工具集"、
 * `mayCarryEnforcement: false`。本模块的字段闭合检查就是那句话的落地。
 */
export function assertContractMatchesManifest({ contract = EMPLOYEE_PRESET_CONTRACT } = {}) {
  const enforcement = FORBIDDEN_MANIFEST_FIELDS
  return Object.freeze({
    mayCarryEnforcement: contract.mayCarryEnforcement,
    carries: Object.freeze([...(contract.carries ?? [])]),
    // 契约说"不携带强制面"，而我们把每一个强制面字段都列进了拒绝名单
    forbiddenEnforcementFields: enforcement,
    // 两者的关系必须是：契约不许携带强制面 ⇔ 清单字段闭合拒绝强制面字段
    aligned: contract.mayCarryEnforcement === false && enforcement.length > 0,
  })
}

export const EMPLOYEE_MANIFEST_CHECKED = Object.freeze({
  version: EMPLOYEE_MANIFEST_VERSION,
  fields: MANIFEST_FIELDS,
  forbidden: FORBIDDEN_MANIFEST_FIELDS,
  contract: assertContractMatchesManifest(),
  wildcards: proveWildcardsRejected(),
  emptyCapability: assertEmptyCapabilityIsVacuouslyAllowed(),
  rules: proveEveryRuleFires(),
  // 一个**真的能用**的清单（正例）：只读岗
  readonlyEmployee: narrowToGrant({
    manifest: mkManifest({ role: 'reader', allowedCapabilities: ['file:read', 'repo:read'], maxRisk: 'low' }),
    grant: PROBE_GRANT,
  }),
})

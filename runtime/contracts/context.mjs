// runtime/contracts/context.mjs
// ============================================================================
// Context Source 与 RunContextSnapshot（PRT-401，spec §6.5）
//
// 纯模块：不依赖 Cordis / DSH / 网络 / 文件系统。
//
// spec §6.5 的一句话是本文件的全部设计约束：
//
//   「任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因。」
//
// 「还原」是关键词。它要求的不是"记了一些日志"，而是：给定一个快照，
// 能回答**这一次运行到底看到了什么、每个来源是哪一版、以及**没看到的东西为什么没看到**。
//
// 由此推出本模块的四条判断：
//
// ① **被丢掉的东西也必须记录。** 一个只有 `sources` 的快照无法区分
//    "没有这个来源"与"有这个来源但被裁掉了"。所以 `excluded[]` 与 `sources[]`
//    同等重要，并且有一个**计数守恒**断言在守它（见 `assertAccounting`）。
//
// ② **不可信是默认值，不是选项。** spec §6.5 点名仓库文件、网页、附件、
//    上游产物、用户输入一律不可信。默认可信意味着**新增一种来源类型就静默获得权限**。
//    所以没写 `trust` 的来源一律按 `untrusted` 处理，而 `trusted` 必须显式声明。
//
// ③ **不可信内容不能承载权限。** spec §6.5 要求它"永远不能授予权限、修改
//    EmployeeManifest、改变审批策略或扩大工具范围"。光靠"我们会小心"不行，
//    所以不可信来源**在结构上就不允许**出现会改变策略的字段
//    （`grants` / `policy` / `manifestPatch` / `approvalPolicy` / `toolScope`），
//    出现即抛错。这不是校验风格，这是把那句话变成一个会失败的断言。
//
// ④ **token 数不能没有出处。** 拿不到精确 tokenizer 时必须用**明确标记**的保守估算器
//    （spec §6.5）。一个裸数字是一个没有出处的断言：`5000` 与 `"约 5000（保守估算）"`
//    在界面上看起来一样，而后者才是可复核的。所以估算器种类是快照的一部分，
//    并且**参与哈希**。
// ============================================================================

import { canonicalJson, domainSeparatedHash, nfc } from './canonical.mjs'

/**
 * 快照 schema 版本。**改变快照的 canonical 形式必须递增它。**
 * 它同时参与 domain separator，因此旧快照的哈希不会与新规则"碰巧"相同。
 */
export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1

/**
 * domain separator。**必须与审批哈希（`legion.tool-execution.v1`）不同**：
 * 两者的对象结构可能恰好相似，共用 domain 会让一个用途的哈希冒充另一个用途的。
 */
export const CONTEXT_SNAPSHOT_DOMAIN = 'legion.run-context-snapshot.v1'

/** 来源类型（spec §6.5 的清单）。 */
export const CONTEXT_SOURCE_TYPES = Object.freeze([
  'team-plan',
  'employee-manifest',
  'goal-context',
  'task',
  'comment',
  'user-feedback',
  'upstream-delivery',
  'artifact',
  'skill',
  'document',
  'workspace-state',
])

/** 可信性。`untrusted` 是**默认值**。 */
export const SOURCE_TRUST = Object.freeze({
  TRUSTED: 'trusted',
  UNTRUSTED: 'untrusted',
})

/**
 * 默认不可信的来源类型（spec §6.5 点名的那几类）。
 *
 * 这个集合**不是判据本身**——判据是"没显式声明 trusted 就是 untrusted"。
 * 它存在是为了：当调用方把一个本该显式声明的类型留空时，
 * 我们能说出"这一类向来是外来的"，从而把默认值选对。
 */
export const INHERENTLY_UNTRUSTED_TYPES = Object.freeze([
  'artifact',
  'document',
  'comment',
  'user-feedback',
  'upstream-delivery',
  'workspace-state',
])

/** 裁剪 / 排除理由（机器可判，不写自然语言）。 */
export const EXCLUSION_REASONS = Object.freeze({
  /** 越权：该员工无权读取。 */
  UNAUTHORIZED: 'unauthorized',
  /** 过期：版本已被更新的版本取代。 */
  STALE: 'stale',
  /** 超出预算：裁剪后仍放不下。 */
  OVER_BUDGET: 'over-budget',
  /** 脱敏：内容整体不可外发（不是"改写"，是整条不发）。 */
  REDACTED: 'redacted',
  /** 显式引用不存在：引用指向的来源查不到。 */
  MISSING: 'missing',
  /** 与该运行无关（作用域不匹配）。 */
  OUT_OF_SCOPE: 'out-of-scope',
})

/** token 计量的来源。 **绝不省略**。 */
export const TOKEN_ESTIMATOR_KINDS = Object.freeze({
  /** 用了所选 ModelProfile 的真实 tokenizer。 */
  EXACT: 'exact',
  /** 拿不到 tokenizer，用**明确标记的保守估算器**（只会高估，不会低估）。 */
  CONSERVATIVE_ESTIMATE: 'conservative-estimate',
})

/**
 * 能改变权限 / 策略的字段名。不可信来源**不得**携带它们。
 *
 * 这是把 spec §6.5「永远不能授予权限、修改 EmployeeManifest、改变审批策略
 * 或扩大工具范围」变成一条会抛错的断言。名单宁可偏严：
 * 多拒一个无害字段名只是让调用方换个名字，漏掉一个就是一条提权路径。
 */
export const AUTHORITY_BEARING_KEYS = Object.freeze([
  'grants',
  'policy',
  'approvalPolicy',
  'manifestPatch',
  'manifest',
  'toolScope',
  'allowedTools',
  'permissions',
  'roleChange',
  'budgetOverride',
])

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 允许出现在来源上的**元数据**字段。
 *
 * 白名单而不是"其余忽略"：一个 ContextSource 是**内容 + 出处**，不是策略对象。
 * 未知字段一律拒绝，理由与 ModelProfile 同一条——**忽略会让不该出现的字段搭便车**。
 * 一个被静默丢掉的 `grants` 比一个被拒绝的 `grants` 坏得多：前者让调用方以为
 * "我已经把权限声明出去了"，而实际上什么都没发生。
 */
export const SOURCE_METADATA_KEYS = Object.freeze(['scope', 'tags', 'ref', 'originUrl', 'redacted'])

/** 来源上允许出现的全部键。 */
const SOURCE_ALLOWED_KEYS = new Set([
  'id', 'type', 'version', 'acquiredAtMs', 'trust', 'content', ...SOURCE_METADATA_KEYS,
])

function requireString(v, field) {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`ContextSource.${field} 必须是非空字符串`)
  return v
}

/**
 * 构造一个不可变的 Context Source。
 *
 * @param {object} input
 * @param {string} input.id 来源自身的标识（不是快照内的序号）
 * @param {string} input.type 见 {@link CONTEXT_SOURCE_TYPES}
 * @param {string} input.version 来源版本（内容变了版本必须变，否则无法判断"过期"）
 * @param {number} input.acquiredAtMs 取得时间
 * @param {string} [input.trust] 省略即 `untrusted`
 * @param {string|null} [input.content] 正文（不可信类型同样可以带正文）
 */
export function createContextSource(input) {
  if (input === null || typeof input !== 'object') throw new Error('ContextSource 必须是对象')
  const id = requireString(input.id, 'id')
  const type = requireString(input.type, 'type')
  if (!CONTEXT_SOURCE_TYPES.includes(type)) {
    throw new Error(`未知的 ContextSource.type：${type}（必须是 ${CONTEXT_SOURCE_TYPES.join(' / ')} 之一）`)
  }
  const version = requireString(input.version, 'version')
  if (!Number.isInteger(input.acquiredAtMs)) {
    // 取得时间是"来源版本 + 当时内容"的锚点。允许省略会让快照无法回答"什么时候拿到的"。
    throw new Error('ContextSource.acquiredAtMs 必须是整数毫秒')
  }

  // 默认不可信：没声明就是 untrusted。声明了就必须是两个字面量之一，
  // 拼错的 'Trusted' 不会被当成 trusted（否则一个笔误就是一权限提升）。
  let trust = SOURCE_TRUST.UNTRUSTED
  if (input.trust !== undefined && input.trust !== null) {
    if (input.trust !== SOURCE_TRUST.TRUSTED && input.trust !== SOURCE_TRUST.UNTRUSTED) {
      throw new Error(`ContextSource.trust 只能是 '${SOURCE_TRUST.TRUSTED}' 或 '${SOURCE_TRUST.UNTRUSTED}'，收到：${JSON.stringify(input.trust)}`)
    }
    trust = input.trust
  }

  // 权威字段：**任何**来源都不许带，与可信性无关。
  //
  // spec §6.5 说的是"不可信内容永远不能授予权限"。但让**可信**来源也能带 `grants`
  // 会开一个更隐蔽的口子：一次提权只需要把来源标成 `trusted`。
  // 权限的来处是 EmployeeManifest（它作为**内容**进入快照），不是快照上的一个活字段。
  // 所以这里一律拒绝，而不是"可信就放行"。
  for (const key of AUTHORITY_BEARING_KEYS) {
    if (input[key] !== undefined) {
      throw new Error(
        `来源 ${id} 携带了会改变权限/策略的字段 ${key}：` +
        '来源是**内容 + 出处**，不是策略对象。不可信内容永远不能授予权限、修改员工清单、' +
        '改变审批策略或扩大工具范围（spec §6.5）；而允许可信来源携带它，' +
        '会让一次提权只需要把来源标成 trusted。',
      )
    }
  }

  // 未知字段一律拒绝：忽略会让不该出现的字段搭便车。
  for (const key of Object.keys(input)) {
    if (!SOURCE_ALLOWED_KEYS.has(key)) {
      throw new Error(
        `ContextSource 出现未知字段 ${key}：` +
        `只接受 ${[...SOURCE_ALLOWED_KEYS].join(' / ')}。忽略未知字段会让调用方以为它生效了。`,
      )
    }
  }

  const content = input.content === undefined || input.content === null ? null : String(input.content)
  const source = {
    id: nfc(id),
    type,
    version: nfc(version),
    acquiredAtMs: input.acquiredAtMs,
    trust,
    content,
    chars: content === null ? 0 : content.length,
    // 来源自己的内容哈希：让"同一版内容有没有变过"可判，而不必比对全文。
    contentHash: `sha256:${domainSeparatedHash('legion.context-source-content.v1', 1, { type, version, content }).slice(7)}`,
  }
  for (const key of SOURCE_METADATA_KEYS) {
    if (input[key] !== undefined) source[key] = input[key]
  }
  return deepFreeze(source)
}

/**
 * 一条被排除的来源记录。**每一条都必须能回答"为什么没进去"。**
 */
export function createExclusion(input) {
  if (input === null || typeof input !== 'object') throw new Error('Exclusion 必须是对象')
  const id = requireString(input.id, 'id')
  const reason = requireString(input.reason, 'reason')
  if (!Object.values(EXCLUSION_REASONS).includes(reason)) {
    throw new Error(`未知的排除理由：${reason}`)
  }
  // 理由必须附一句给人看的说明；只有机器码时用户在界面上看到的是一串常量。
  const detail = typeof input.detail === 'string' && input.detail !== '' ? input.detail : null
  return deepFreeze({ id: nfc(id), reason, detail, excludedAtMs: input.excludedAtMs ?? null })
}

/**
 * 计数守恒：**每一个候选来源，要么在 `sources`，要么在 `excluded`。**
 *
 * 这是本模块最重要的一条断言。没有它，一个"忘记记录被裁掉来源"的实现
 * 会产出一个**看起来完整**的快照——而 spec §6.5 要的正是"还原裁剪原因"。
 * 有了它，那种实现会直接抛错。
 *
 * @param {{candidateCount: number, sources: unknown[], excluded: unknown[]}} snapshot
 */
export function assertAccounting(snapshot) {
  const { candidateCount, sources, excluded } = snapshot
  if (!Number.isInteger(candidateCount) || candidateCount < 0) {
    throw new Error('快照必须记录 candidateCount（进入裁剪前的候选来源总数）')
  }
  const got = sources.length + excluded.length
  if (got !== candidateCount) {
    throw new Error(
      `来源计数不守恒：候选 ${candidateCount}，但账上是 ${sources.length} 个入选 + ${excluded.length} 个排除 = ${got}。` +
      '每一个候选来源都必须有去向——否则快照无法回答"被裁掉了什么、为什么"（spec §6.5）。',
    )
  }
  // 同一个来源不能既入选又被排除：那说明两次判定不一致，而其中一个必然是错的。
  const included = new Set(sources.map((s) => s.id))
  for (const e of excluded) {
    if (included.has(e.id)) {
      throw new Error(`来源 ${e.id} 同时出现在入选与排除里：两次判定不一致，其中一次必然是错的`)
    }
  }
  return true
}

/**
 * token 计量。种类与数字**一起**冻结，且都进哈希。
 *
 * 为什么种类必须进哈希：两次运行的 token 数一样但一次是精确值、一次是保守估算，
 * 它们的"上下文是否放得下"结论可信度不同。若哈希相同，回放时会以为
 * 两次的计量同等可信。
 */
export function createTokenMeasurement(input) {
  if (input === null || typeof input !== 'object') throw new Error('TokenMeasurement 必须是对象')
  const kind = input.kind
  if (kind !== TOKEN_ESTIMATOR_KINDS.EXACT && kind !== TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE) {
    throw new Error(
      `token 计量的 kind 必须是 '${TOKEN_ESTIMATOR_KINDS.EXACT}' 或 '${TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE}'；` +
      '一个没有出处的数字无法复核（spec §6.5 要求保守估算必须"明确标记"）',
    )
  }
  if (!Number.isFinite(input.tokens) || input.tokens < 0) throw new Error('TokenMeasurement.tokens 必须是非负数')
  const note = typeof input.note === 'string' && input.note !== '' ? input.note : null
  // 保守估算必须自带说明，且说明里必须点明它是估算——
  // 否则界面上它和一个精确值长得一样。
  if (kind === TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE) {
    if (note === null || !/估算|estimate/i.test(note)) {
      throw new Error('保守估算必须带 note 且注明是估算（否则它看起来像精确值）')
    }
  }
  return deepFreeze({ kind, tokens: Math.ceil(input.tokens), note })
}

/**
 * 冻结一个 RunContextSnapshot。
 *
 * 快照在 `BuildingContext` 完成、Attempt 进入 `Running` **之前**冻结，之后不可修改
 * （spec §6.5）。本函数返回深度冻结对象，并算出组合哈希。
 *
 * @param {object} input
 * @param {string} input.attemptId
 * @param {string} input.runId
 * @param {object} input.associations `{goalId, taskId, employeeId, teamPlanId}`
 * @param {unknown[]} input.sources 入选来源（`createContextSource` 的产物）
 * @param {unknown[]} input.excluded 被排除来源（`createExclusion` 的产物）
 * @param {number} input.candidateCount 裁剪前的候选总数
 * @param {object} input.tokens `createTokenMeasurement` 的产物
 * @param {object} [input.budget] `{maxTokens, trimmed}` —— 裁剪是否发生过
 * @param {string|null} [input.finalText] 真正发给 Runtime 的文本
 * @param {unknown[]} [input.segments] 最终文本的段落表（每段切回一个来源）
 * @param {unknown[]} [input.truncations] 被截断的来源清单（**部分包含**是第三种状态）
 */
export function freezeContextSnapshot(input) {
  if (input === null || typeof input !== 'object') throw new Error('RunContextSnapshot 必须是对象')
  const attemptId = requireString(input.attemptId, 'attemptId')
  const runId = requireString(input.runId, 'runId')
  if (!Number.isInteger(input.frozenAtMs)) throw new Error('快照必须有 frozenAtMs（冻结时点）')
  const sources = Array.isArray(input.sources) ? input.sources : null
  const excluded = Array.isArray(input.excluded) ? input.excluded : null
  if (sources === null || excluded === null) throw new Error('快照必须同时给出 sources 与 excluded（没有来源时给空数组）')
  const tokens = input.tokens
  if (tokens === undefined || tokens === null) throw new Error('快照必须记录 token 计量')

  const associations = input.associations ?? {}
  const budget = input.budget ?? { maxTokens: null, trimmed: false }

  const body = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    attemptId: nfc(attemptId),
    runId: nfc(runId),
    frozenAtMs: input.frozenAtMs,
    associations: {
      goalId: associations.goalId ?? null,
      taskId: associations.taskId ?? null,
      employeeId: associations.employeeId ?? null,
      teamPlanId: associations.teamPlanId ?? null,
    },
    candidateCount: input.candidateCount,
    sources,
    excluded,
    // `segments` 与 `truncations` **必须进哈希**。
    //
    // 第一版把它们当成"附加信息"，在 freeze 之后才拼上去——于是
    // `verifySnapshotHash` 对**每一份**装配出来的快照都返回 false。
    // 一个总是失败的校验函数比没有更坏：所有人都会学会忽略它。
    // 更本质的是：截断改变了"模型实际看到了什么"，那正是这份哈希要封住的东西。
    segments: Array.isArray(input.segments) ? input.segments : [],
    truncations: Array.isArray(input.truncations) ? input.truncations : [],
    tokens,
    budget: { maxTokens: budget.maxTokens ?? null, trimmed: budget.trimmed === true },
    finalText: input.finalText === undefined ? null : input.finalText,
  }

  // 守恒必须先成立再算哈希：不守恒的快照不该有一个"看起来正常"的哈希，
  // 否则它会被当成一个合法快照被存下来。
  assertAccounting(body)
  const snapshotHash = domainSeparatedHash(CONTEXT_SNAPSHOT_DOMAIN, CONTEXT_SNAPSHOT_SCHEMA_VERSION, body)
  return deepFreeze({ ...body, snapshotHash })
}

/** 重新计算一个快照的哈希，用于校验它有没有被改过。 */
export function computeSnapshotHash(snapshot) {
  const { snapshotHash, ...body } = snapshot
  void snapshotHash
  return domainSeparatedHash(CONTEXT_SNAPSHOT_DOMAIN, body.schemaVersion ?? CONTEXT_SNAPSHOT_SCHEMA_VERSION, body)
}

/** 快照是否被改动过。 */
export function verifySnapshotHash(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') throw new Error('快照必须是对象')
  return snapshot.snapshotHash === computeSnapshotHash(snapshot)
}

/**
 * 把一组来源按**确定性顺序**排好。
 *
 * 顺序会进入最终文本，因此它必须是确定的（spec §6.5「确定性、可回放」）。
 * 依赖调用方恰好按什么顺序传进来，会让同一批输入在不同路径下产出不同哈希。
 * 排序键用 (type, id, version)：同一来源的新版本排在旧版本之后，便于阅读，
 * 且与"谁先被检索到"无关。
 */
export function orderSources(sources) {
  return [...sources].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    return a.version < b.version ? -1 : (a.version > b.version ? 1 : 0)
  })
}

/** 快照的 canonical 文本（供导出与哈希复核）。 */
export function snapshotCanonicalJson(snapshot) {
  const { snapshotHash, ...body } = snapshot
  void snapshotHash
  return canonicalJson(body)
}

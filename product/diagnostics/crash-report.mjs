// product/diagnostics/crash-report.mjs
// ============================================================================
// PRT-906：崩溃报告的**用户授权**与**脱敏策略**。
//
// spec §10 line 747–750：
//   「诊断包默认脱敏，并由用户主动生成。」（line 747）
//   「高风险操作必须可定位到发起人、审批人、内容哈希和实际结果。」（line 750）
//
// 脱敏那一半已经在 `redact-package.mjs` 里了——本模块**复用**它，不重写。
// 本模块补的是另一半：**授权**。
//
// ## 为什么授权不能集中在一个布尔上
//
// 崩溃报告与诊断包是**两件不同的事**，而它们的区别恰好在于"谁在什么时候决定"：
//
//   · 诊断包：用户**主动**生成（spec line 747 明说）。生成的那一刻就是授权。
//   · 崩溃报告：**进程崩了**。没有人在场可以问。
//
// 于是崩溃报告拆成两个动作：**本地落盘**与**对外发送**。
// 崩溃当时无法征求同意，所以只能：
//
//   ① 本地落盘**在用户事先同意的范围内**发生，且**落盘时就已脱敏**；
//   ② 对外发送**必须**有明确同意，且可以在事后被撤销。
//
// ## ★ 三个会安静出错的坑
//
// ### ① 「本地生成不用问，那就先存下来，以后再问」
//
// 这是最自然的实现，也是最糟的：
//
//   > 一个「本地先生成、等用户同意再上传」的崩溃报告，
//   > 与一个「在用户从没同意过的磁盘上，已经躺着一份未脱敏的内存转储」的实现，
//   > 是同一个东西——只不过前者的授权检查发生在**另一个模块**里。
//
// 所以本模块要求本地落盘也**必须在事先同意的范围内**，且**落盘前**就脱敏。
//
// ### ② 「没同意」与「没说」是两回事，而只有一个是安全的
//
// 同意状态是三分的：`granted` / `denied` / `unknown`。
// `unknown`（配置里没有这一项、读不出来、旧版本没这个字段）**不是** `granted`。
//
//   > 一个「把读不出来的同意当成默认同意」的崩溃报告，
//   > 与一个「用户明确拒绝过、报告照样发出去」的实现，是同一个东西——
//   > 只不过前者的默认值是在一个没人会去看的地方写的。
//
// ### ③ 撤销同意之后，**已经躺在磁盘上的**报告怎么办
//
// 撤销只影响"以后"是最容易写的，也是最没用的：
// 用户点"我不再同意"的时候，心里想的是"把我机器上那些东西处理掉"。
//
//   > 一个「撤销只影响将来生成的报告」的同意模型，
//   > 与一个「用户点了拒绝、而之前那份报告还在磁盘上等着某天被上传」的模型，
//   > 是同一个东西——只不过前者在同意状态上看起来是完全正确的。
//
// 所以撤销必须产出**待处理清单**（`staleReports`），而不是只改一个字段。
// ============================================================================

import { STRUCTURAL_EXCLUSIONS, structuralExclusionFor, DEFAULT_LIMITS } from './redact-package.mjs'

/** 策略版本。改动同意语义或脱敏规则时递增。 */
export const CRASH_POLICY_VERSION = 'legion/crash-policy@1'

/**
 * 同意事项。**每一项都要单独同意**——把它们合成一个"同意诊断"，
 * 就等于让用户为了上报崩溃而不得不同意遥测。
 */
export const CONSENT_PURPOSES = Object.freeze([
  Object.freeze({
    id: 'crash-local',
    label: '在本地保存崩溃报告',
    why: '崩溃发生时没人在场可以问，所以这一项必须**事先**同意；不同意时崩溃只留下不可解释的退出码',
  }),
  Object.freeze({
    id: 'crash-upload',
    label: '把崩溃报告发送给开发者',
    why: '对外传输是单独一件事——本地留一份与把它发出去，风险不同',
  }),
  Object.freeze({
    id: 'diagnostic-package',
    label: '生成诊断包',
    why: 'spec line 747：诊断包由用户**主动**生成。这一项同意只是允许入口出现，不代替那一次主动动作',
  }),
  Object.freeze({
    id: 'usage-telemetry',
    label: '发送使用统计',
    why: '与崩溃无关；单独列出，免得"同意上报崩溃"被读成"同意一切"',
  }),
  Object.freeze({
    id: 'model-call',
    label: '把上下文与输入发送给模型供应商',
    // 这一项的来源是 PRT-903：出境通道清单里 `model-call` 声明了需要用户同意，
    // 但当时**没有任何同意事项对应它**，于是 PRT-903 的装载期自检红了。
    // 那是它抓出来的真缺口，不是它误报——一条"要求同意"却没有对应事项的通道，
    // 它的"同意"在配置里无处可表达。
    //
    // 为什么它必须是一个**独立的**同意事项：模型调用是唯一一条**必然**出境的
    // 通道（心跳默认关着，而任务一跑上下文就出去了），却由 DSH 投递、
    // Legion 看不到目的地。把这一项并进别的同意事项，等于把"我关不掉它"
    // 藏进一个用户以为能关的开关里。
    why: '任务一运行，装配后的上下文与输入就会被送往 DSH 配置的模型供应商；' +
      '这一项是产品对**那条**通道的表态，而不是对遥测的表态',
  }),
])

export const CONSENT_PURPOSE_IDS = Object.freeze(CONSENT_PURPOSES.map((p) => p.id))

/** 同意状态是**三分**的。`unknown` 不是 `granted`。 */
export const CONSENT_STATES = Object.freeze(['granted', 'denied', 'unknown'])

/** 出厂默认：**全部 unknown**，不是全部 granted。 */
export const DEFAULT_CONSENT = Object.freeze(
  Object.fromEntries(CONSENT_PURPOSE_IDS.map((id) => [id, 'unknown'])),
)

export const CRASH_CODES = Object.freeze({
  /** 同意状态不是三态之一。 */
  CONSENT_INVALID: 'crash-consent-invalid',
  /** 本地落盘未获同意。 */
  LOCAL_NOT_CONSENTED: 'crash-local-not-consented',
  /** 对外发送未获同意。 */
  UPLOAD_NOT_CONSENTED: 'crash-upload-not-consented',
  /** 崩溃报告里仍有未脱敏的敏感内容。 */
  UNREDACTED: 'crash-unredacted',
  /** 撤销同意后仍有历史报告留在磁盘上。 */
  STALE_AFTER_REVOKE: 'crash-stale-after-revoke',
  /** 崩溃载荷超出上限。 */
  OVERSIZED: 'crash-oversized',
})

/**
 * 归一化一份同意记录。
 *
 * ★ 缺字段 → `unknown`，**不是** `granted`。这是本模块最要紧的一行。
 *
 * @param {Record<string, string>} [raw]
 * @returns {{state: Record<string, string>, findings: ReadonlyArray<object>}}
 */
export function normalizeConsent(raw = {}) {
  const state = {}
  const findings = []
  for (const purpose of CONSENT_PURPOSE_IDS) {
    const value = raw?.[purpose]
    if (value === undefined || value === null || value === '') {
      // 缺席 = 没说 = unknown。**不填默认值**。
      state[purpose] = 'unknown'
      continue
    }
    if (!CONSENT_STATES.includes(value)) {
      state[purpose] = 'unknown'
      findings.push(Object.freeze({
        code: CRASH_CODES.CONSENT_INVALID,
        purpose,
        detail: `同意事项 ${purpose} 的值 ${JSON.stringify(value)} 不是合法状态（${CONSENT_STATES.join(' / ')}）——按 unknown 处理，不按 granted`,
      }))
      continue
    }
    state[purpose] = value
  }
  return Object.freeze({ state: Object.freeze(state), findings: Object.freeze(findings) })
}

/**
 * 崩溃发生时能做什么。
 *
 * @param {object} args
 * @param {Record<string, string>} args.consent 归一化后的同意状态
 * @param {{bytes?: number, fields?: ReadonlyArray<{name: string, value: string, kind?: string}>}} [args.payload]
 * @param {object} [args.limits]
 * @returns {{captureLocal: boolean, transmit: boolean, redact: ReadonlyArray<object>,
 *            drop: ReadonlyArray<object>, findings: ReadonlyArray<object>, version: string}}
 */
export function planCrashReport({ consent = DEFAULT_CONSENT, payload = {}, limits = DEFAULT_LIMITS } = {}) {
  const findings = []
  const redact = []
  const drop = []

  const localOk = consent['crash-local'] === 'granted'
  const uploadOk = consent['crash-upload'] === 'granted'

  if (!localOk) {
    findings.push(Object.freeze({
      code: CRASH_CODES.LOCAL_NOT_CONSENTED,
      detail: `本地保存崩溃报告未获同意（当前 ${JSON.stringify(consent['crash-local'])}）——` +
        '崩溃时没人在场可以问，所以这一项必须事先同意；此时只留下不可解释的退出码',
    }))
  }

  // ★ 脱敏**无条件**执行：即使只本地落盘。
  //   "先原样存下来、以后再脱敏"会把未脱敏的内容留在磁盘上，而那一刻用户
  //   从来没有同意过任何东西留在那里。
  for (const field of payload.fields ?? []) {
    const structural = structuralExclusionFor(field.name, field.name)
    if (structural !== null) {
      drop.push(Object.freeze({ name: field.name, rule: structural.id, why: structural.why }))
      continue
    }
    // 崩溃特有的两类：环境变量与绝对家目录路径。
    // 诊断包里不一定有它们，而内存转储里几乎一定有。
    if (field.kind === 'env' || /^[A-Z][A-Z0-9_]{2,}$/.test(field.name)) {
      redact.push(Object.freeze({ name: field.name, rule: 'crash-env', replacement: '<env:redacted>' }))
      continue
    }
    if (field.kind === 'path' || /([A-Za-z]:\\|\/Users\/|\/home\/)/.test(field.value ?? '')) {
      redact.push(Object.freeze({ name: field.name, rule: 'crash-abs-path', replacement: '<path:redacted>' }))
    }
  }

  if (!uploadOk) {
    findings.push(Object.freeze({
      code: CRASH_CODES.UPLOAD_NOT_CONSENTED,
      detail: `对外发送崩溃报告未获同意（当前 ${JSON.stringify(consent['crash-upload'])}）——` +
        '本地保存与对外传输是两件事，前者不蕴含后者',
    }))
  }

  const bytes = Number.isFinite(payload.bytes) ? payload.bytes : 0
  let captureLocal = localOk
  if (captureLocal && bytes > (limits.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes)) {
    captureLocal = false
    findings.push(Object.freeze({
      code: CRASH_CODES.OVERSIZED,
      bytes,
      cap: limits.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
      detail: `崩溃载荷 ${bytes} 超过上限——不放宽上限来容纳它，因为放宽的代价是磁盘`,
    }))
  }

  return Object.freeze({
    version: CRASH_POLICY_VERSION,
    captureLocal,
    // ★ 发送**要求**本地已获同意。没有本地副本就没有可发送的东西——
    //   这一条防的是"只勾了上传、于是实现临时生成一个未脱敏的副本直接发走"。
    transmit: uploadOk && captureLocal,
    redact: Object.freeze(redact),
    drop: Object.freeze(drop),
    findings: Object.freeze(findings),
  })
}

/**
 * 撤销同意后的待处理清单。
 *
 * ★ 撤销只改一个布尔是最容易写的，也是最没用的——用户点"不再同意"时，
 *   心里想的是"把我机器上那些东西处理掉"。
 *
 * @param {object} args
 * @param {Record<string, string>} args.consent 归一化后的（**撤销后**的）状态
 * @param {ReadonlyArray<{id: string, purpose: string, path: string, atMs?: number}>} args.onDisk
 * @returns {{stale: ReadonlyArray<object>, findings: ReadonlyArray<object>, clean: boolean}}
 */
export function revokeConsent({ consent = DEFAULT_CONSENT, onDisk = [] } = {}) {
  const findings = []
  const stale = []
  for (const item of onDisk) {
    const state = consent[item.purpose]
    // 已经不同意的类别，磁盘上还留着的就是待处理项。
    // `unknown` 也算——用户没说同意，那就没有理由留着。
    if (state !== 'granted') {
      stale.push(Object.freeze({
        id: item.id, purpose: item.purpose, path: item.path, atMs: item.atMs ?? null,
        state,
        reason: state === 'denied' ? '用户已拒绝该事项' : '该事项从未获同意（unknown）——没有理由留着',
      }))
    }
  }
  if (stale.length > 0) {
    findings.push(Object.freeze({
      code: CRASH_CODES.STALE_AFTER_REVOKE,
      count: stale.length,
      detail: `${stale.length} 份报告在磁盘上，而对应事项未获同意——撤销必须产出这份清单，而不是只改一个字段`,
    }))
  }
  return Object.freeze({
    stale: Object.freeze(stale),
    findings: Object.freeze(findings),
    clean: stale.length === 0,
  })
}

/**
 * 一份崩溃报告**可不可以**被描述成"已脱敏"。
 *
 * ★ 这条判据要挡的是"脱敏了但仍然可还原"：如果脱敏映射（原文→占位符）
 *   和被脱敏的内容一起被存进包里，那这份包里的敏感信息一个都没少。
 *
 * @param {{redact?: ReadonlyArray<object>, drop?: ReadonlyArray<object>, includeMap?: boolean,
 *          residual?: ReadonlyArray<{name: string, value: string}>}} report
 */
export function assertRedacted(report = {}) {
  const problems = []
  const rules = new Set(STRUCTURAL_EXCLUSIONS.map((e) => e.id))

  for (const r of report.redact ?? []) {
    if (typeof r.replacement !== 'string' || r.replacement === '') {
      problems.push(`脱敏项 ${r.name} 没有给出替换值——"删掉字段"与"替换成占位符"不是同一件事`)
    }
  }
  for (const d of report.drop ?? []) {
    if (!rules.has(d.rule)) problems.push(`排除项 ${d.name} 引用了不存在的规则 ${JSON.stringify(d.rule)}`)
    if (typeof d.why !== 'string' || d.why === '') problems.push(`排除项 ${d.name} 没有说明理由`)
  }
  // ★ 反向映射
  if (report.includeMap === true) {
    problems.push('报告里带了脱敏映射表——带映射的脱敏等于没脱敏：原文与占位符的对应关系就在包里')
  }
  // ★ 残留：脱敏之后又出现的东西（比如日志正文里还写着原值）
  for (const r of report.residual ?? []) {
    problems.push(`脱敏后仍残留 ${r.name}`)
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    redactedCount: (report.redact ?? []).length,
    droppedCount: (report.drop ?? []).length,
    knownRules: Object.freeze([...rules]),
  })
}

/**
 * 装载期自检：把三条核心判据各真的跑一遍，留下算出来的值。
 */
function auditCrashPolicy() {
  const problems = []

  // ① 缺字段 → unknown，不是 granted
  const empty = normalizeConsent({})
  for (const p of CONSENT_PURPOSE_IDS) {
    if (empty.state[p] !== 'unknown') problems.push(`缺字段的 ${p} 被归成了 ${empty.state[p]}`)
  }
  const bogus = normalizeConsent({ 'crash-local': 'yes' })
  if (bogus.state['crash-local'] !== 'unknown') problems.push('非法同意值没有被归成 unknown')

  // ② unknown **不能**导致落盘或发送
  const unknownPlan = planCrashReport({ consent: DEFAULT_CONSENT })
  if (unknownPlan.captureLocal) problems.push('unknown 状态下仍然落盘')
  if (unknownPlan.transmit) problems.push('unknown 状态下仍然发送')

  // ③ 只同意本地 → 落盘但不发送
  const localOnly = planCrashReport({ consent: normalizeConsent({ 'crash-local': 'granted' }).state })
  if (!localOnly.captureLocal) problems.push('已同意本地但没落盘')
  if (localOnly.transmit) problems.push('只同意本地却发送了')

  // ④ 只同意上传 → 既不落盘也不发送（没有本地副本就没有可发送的东西）
  const uploadOnly = planCrashReport({ consent: normalizeConsent({ 'crash-upload': 'granted' }).state })
  if (uploadOnly.captureLocal) problems.push('只同意上传却落盘了')
  if (uploadOnly.transmit) problems.push('只同意上传却发送了——不允许临时生成副本直接发走')

  // ⑤ 脱敏是无条件的
  const withSecrets = planCrashReport({
    consent: normalizeConsent({ 'crash-local': 'granted' }).state,
    payload: { fields: [{ name: 'credentials.yaml', value: 'x' }, { name: 'HOME', value: 'C:/Users/me', kind: 'env' }] },
  })
  if (withSecrets.drop.length === 0) problems.push('结构性排除没有生效')
  if (withSecrets.redact.length === 0) problems.push('崩溃特有的脱敏（env/绝对路径）没有生效')

  // ⑥ 撤销产出待处理清单，而不是只改一个字段
  const revoked = revokeConsent({
    consent: normalizeConsent({}).state,
    onDisk: [{ id: 'r1', purpose: 'crash-local', path: '/x/r1.json' }],
  })
  if (revoked.clean) problems.push('撤销后仍有磁盘报告却报 clean')

  // ⑦ 带映射表的报告不算已脱敏
  if (assertRedacted({ includeMap: true }).ok) problems.push('带脱敏映射表的报告被判为已脱敏')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: CRASH_POLICY_VERSION,
    purposes: CONSENT_PURPOSE_IDS,
    states: CONSENT_STATES,
    defaultConsent: DEFAULT_CONSENT,
    samples: Object.freeze({
      unknownCapture: unknownPlan.captureLocal,
      unknownTransmit: unknownPlan.transmit,
      localOnlyCapture: localOnly.captureLocal,
      localOnlyTransmit: localOnly.transmit,
      uploadOnlyCapture: uploadOnly.captureLocal,
      uploadOnlyTransmit: uploadOnly.transmit,
      droppedNames: withSecrets.drop.map((d) => d.name),
      redactedNames: withSecrets.redact.map((r) => r.name),
      revokedStaleCount: revoked.stale.length,
    }),
  })
}

export const CRASH_POLICY_CHECKED = auditCrashPolicy()

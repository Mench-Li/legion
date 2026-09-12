// product/release/privacy.mjs
// ============================================================================
// PRT-903：隐私、数据处理与**模型调用**说明。
//
// spec §10 line 743–747。
//
// ## 为什么这份说明不能是手写的散文
//
// 隐私说明最常见的失效方式不是写错，而是**写完就旧了**：代码里多加一条出境通道、
// 多收一个字段，说明里一个字都不变——而它读起来依然完整。
//
//   > 一个「手写的隐私说明」，
//   > 与一个「代码里新增了一条出境通道、而说明里一个字都没变」的说明，
//   > 是同一个东西——只不过前者读起来是完整的。
//
// 所以本模块把说明**挂在代码自己的允许名单上**：
//   · 心跳要发什么，直接读 `heartbeat.mjs` 的 `ALLOWED_PAYLOAD_KEYS`；
//   · 本地存什么，直接读 `data-classes.mjs` 的台账；
//   · 通道清单一变，`assertNoUndisclosedEgress` 就会红。
//
// ## ★ 三个会安静出错的坑
//
// ### ① 「心跳默认关着」被读成「没有数据出境」
//
// `DEFAULT_HEARTBEAT_POLICY.enabled` 是 `false`，于是很容易得出"数据不出门"。
// 但模型调用是**必然**出境的——它由 DSH 发出，本仓库看不到。
//
//   > 一个「心跳关闭，因此没有数据出境」的隐私说明，
//   > 与一个「用户的目标与代码正在被送给模型供应商」的说明，是同一个东西——
//   > 只不过前者在"我们自己的通道"这个范围内是完全正确的。
//
// 所以出境通道分成**产品自有**与**委托 DSH** 两类，两类都要披露。
//
// ### ② 披露了通道，但没说**发的是什么**
//
// "我们会发送运行指标"与"我们会发送队列深度、错误率、可用率"是不同的披露。
// 后者才让人能判断自己愿不愿意。
//
// ### ③ 一个没有**控制**的通道
//
// 每个出境通道都必须说得出它的控制手段（允许名单 / 仅 https / 用户同意 /
// 仅回环）。说不出控制的通道，与没有控制是同一件事。
// ============================================================================

import { ALLOWED_PAYLOAD_KEYS, DEFAULT_HEARTBEAT_POLICY } from '../heartbeat.mjs'
import { DATA_CLASSES, DATA_CLASS_IDS } from '../lifecycle/data-classes.mjs'
import { CONSENT_PURPOSE_IDS, DEFAULT_CONSENT } from '../diagnostics/crash-report.mjs'

/** 说明版本。通道清单或字段清单变化时递增。 */
export const PRIVACY_VERSION = 'legion/privacy@1'

/**
 * 出境通道的两个大类。
 *
 * ★ 分成两类是本模块最要紧的一个设计：把"委托 DSH"那一类漏掉，
 *   会得到一份"数据不出门"的报告，而模型调用每天都在出门。
 */
export const EGRESS_KINDS = Object.freeze(['product-owned', 'delegated-dsh', 'loopback'])

/** 控制手段。每个通道至少要有一条。 */
export const EGRESS_CONTROLS = Object.freeze([
  'allow-list',      // 只许发出名单内的键
  'https-only',      // 端点必须是 https
  'user-consent',    // 需要用户事先同意
  'loopback-only',   // 只连本机
  'leaf-values-only',// 只认数/布尔/受控短串，不认对象与数组
  'size-cap',        // 有容量上限
])

/**
 * 出境通道清单。
 *
 * `fields` 为 `null` 表示"字段不由本仓库决定"——那必须**明说**，
 * 而不是留空：留空会被读成"不发字段"。
 */
export const EGRESS_CHANNELS = Object.freeze([
  Object.freeze({
    id: 'heartbeat',
    kind: 'product-owned',
    label: '运行心跳上报',
    destination: '用户配置的 https 端点',
    // ★ 字段**引用**心跳模块自己的允许名单，不在这里抄一遍。
    //   抄一遍就是造出第二份名单，它们迟早不一样。
    fieldsRef: 'heartbeat.ALLOWED_PAYLOAD_KEYS',
    fields: ALLOWED_PAYLOAD_KEYS,
    defaultEnabled: DEFAULT_HEARTBEAT_POLICY.enabled,
    controls: Object.freeze(['allow-list', 'https-only', 'user-consent', 'leaf-values-only']),
    consentPurpose: 'usage-telemetry',
    why: '这是产品**主动**把数据送出去的唯一自有通道；默认关闭，开启需同意记录',
  }),
  Object.freeze({
    id: 'model-call',
    kind: 'delegated-dsh',
    label: '模型调用',
    destination: '由 DSH 按用户配置的模型供应商决定——本仓库看不到具体目的地',
    // ★ 明说"不由本仓库决定"，而不是留 null 之外的空白。
    fieldsRef: 'runtime/context/assembler.mjs（装配后的上下文）+ 用户输入',
    fields: null,
    defaultEnabled: true,
    controls: Object.freeze(['user-consent']),
    // 这一项曾经是 `null`，于是自检报 `privacy-no-consent-purpose`——
    // 一条"要求同意"却没有对应同意事项的通道，它的同意在配置里无处可表达。
    // 为此在 `crash-report.mjs` 里补了同名的 `model-call` 同意事项。
    consentPurpose: 'model-call',
    why: '运行一次任务就会发出；送出去的是装配后的上下文与用户输入。' +
      '本仓库只负责装配，**实际投递由 DSH 完成**，因此这条通道无法由本仓库关闭或审计',
  }),
  Object.freeze({
    id: 'team-hub',
    kind: 'loopback',
    label: 'team-hub 内部调用',
    destination: '127.0.0.1 上的本机 team-hub 端口',
    fields: null,
    fieldsRef: '内部请求体（任务、审批、租约）',
    defaultEnabled: true,
    controls: Object.freeze(['loopback-only']),
    consentPurpose: null,
    why: '只在回环地址上，不出机器；列出来是因为"不出机器"必须是被证明的，不是被假设的',
  }),
  Object.freeze({
    id: 'crash-report',
    kind: 'product-owned',
    label: '崩溃报告',
    destination: '由 DSH / 开发者端点决定（上传需单独同意）',
    fieldsRef: 'product/diagnostics/crash-report.mjs（脱敏后的字段）',
    fields: null,
    defaultEnabled: false,
    controls: Object.freeze(['user-consent', 'allow-list', 'size-cap']),
    consentPurpose: 'crash-upload',
    why: '本地落盘与对外上传是两件事；上传需单独同意，且本地副本也必须在同意范围内',
  }),
])

export const EGRESS_CHANNEL_IDS = Object.freeze(EGRESS_CHANNELS.map((c) => c.id))

export const PRIVACY_CODES = Object.freeze({
  /** 通道引用的字段名单与代码实际不一致。 */
  FIELD_LIST_DRIFT: 'privacy-field-list-drift',
  /** 通道没有任何控制手段。 */
  UNCONTROLLED_CHANNEL: 'privacy-uncontrolled-channel',
  /** 代码里有出境通道但说明里没有。 */
  UNDISCLOSED_EGRESS: 'privacy-undisclosed-egress',
  /** 说明里有一条代码里没有的通道。 */
  STALE_CHANNEL: 'privacy-stale-channel',
  /** 需要同意的通道没有对应的同意事项。 */
  NO_CONSENT_PURPOSE: 'privacy-no-consent-purpose',
  /** `fields: null` 时没有说明字段从哪来。 */
  FIELDS_UNEXPLAINED: 'privacy-fields-unexplained',
  /** 本地数据分类里有未被披露的类。 */
  UNDISCLOSED_DATA_CLASS: 'privacy-undisclosed-data-class',
})

/**
 * 生成说明报告。
 *
 * @param {object} [deps]
 * @param {ReadonlyArray<object>} [deps.channels] 出境通道清单（默认用本模块自己的）
 * @param {ReadonlyArray<string>} [deps.actualPayloadKeys] 心跳实际允许的键（默认真读代码）
 * @param {ReadonlyArray<string>} [deps.observedEgress] 观测到的出境通道 id（用来查未披露）
 * @returns {object}
 */
export function privacyReport(deps = {}) {
  // ★ `channels` **可注入**是必需的，不是为了方便测试。
  //
  //   第一版把 `EGRESS_CHANNELS` 直接写死在函数里，于是三条判据
  //   （无控制手段 / 要求同意却没挂事项 / `fields: null` 却没说字段从哪来）
  //   在**真实输入上永远不可能触发**——因为那三条在源代码里都是对的，
  //   而"改对之后没有任何输入能让它们红"正是它们从未被验证过的证据。
  //
  //   > 一个「永远不会触发」的复核，与没有复核，在「它到底拦不拦得住」上是同一个东西。
  //
  //   这是探针 55④⑤⑥ **明明应用了、却没有用例变红**时暴露出来的。
  //   把表变成注入的之后，三条判据才各自有一个能喂坏值的入口。
  const channels = deps.channels ?? EGRESS_CHANNELS
  const channelIds = channels.map((c) => c.id)
  const actualKeys = deps.actualPayloadKeys ?? ALLOWED_PAYLOAD_KEYS
  const observedEgress = deps.observedEgress ?? null
  const findings = []

  // ① 字段名单漂移：通道声明的字段必须与代码实际一致。
  for (const ch of channels) {
    if (ch.fields === null) {
      // `fields: null` 必须配 `fieldsRef`，否则"不发字段"与"不知道发什么"分不开。
      if (typeof ch.fieldsRef !== 'string' || ch.fieldsRef === '') {
        findings.push(Object.freeze({
          code: PRIVACY_CODES.FIELDS_UNEXPLAINED,
          channel: ch.id,
          detail: `通道 ${ch.id} 没列字段，也没说字段从哪来——留空会被读成"不发字段"`,
        }))
      }
      continue
    }
    const declared = [...ch.fields].sort()
    const actual = [...actualKeys].sort()
    if (ch.fieldsRef === 'heartbeat.ALLOWED_PAYLOAD_KEYS' && declared.join(',') !== actual.join(',')) {
      findings.push(Object.freeze({
        code: PRIVACY_CODES.FIELD_LIST_DRIFT,
        channel: ch.id,
        detail: `通道 ${ch.id} 声明的字段与 ${ch.fieldsRef} 不一致——` +
          `说明里多出 ${declared.filter((k) => !actual.includes(k)).join('/') || '（无）'}，` +
          `代码里多出 ${actual.filter((k) => !declared.includes(k)).join('/') || '（无）'}`,
      }))
    }
  }

  // ② 每个通道都必须有控制手段。
  for (const ch of channels) {
    if (!Array.isArray(ch.controls) || ch.controls.length === 0) {
      findings.push(Object.freeze({
        code: PRIVACY_CODES.UNCONTROLLED_CHANNEL,
        channel: ch.id,
        detail: `通道 ${ch.id} 说不出控制手段——说不出控制的通道与没有控制是同一件事`,
      }))
      continue
    }
    for (const c of ch.controls) {
      if (!EGRESS_CONTROLS.includes(c)) {
        findings.push(Object.freeze({
          code: PRIVACY_CODES.UNCONTROLLED_CHANNEL,
          channel: ch.id,
          detail: `通道 ${ch.id} 引用了未知控制 ${JSON.stringify(c)}`,
        }))
      }
    }
  }

  // ③ 需要同意的通道必须挂到一个真实存在的同意事项上。
  for (const ch of channels) {
    if (!ch.controls.includes('user-consent')) continue
    if (ch.consentPurpose === null || !CONSENT_PURPOSE_IDS.includes(ch.consentPurpose)) {
      findings.push(Object.freeze({
        code: PRIVACY_CODES.NO_CONSENT_PURPOSE,
        channel: ch.id,
        detail: `通道 ${ch.id} 要求用户同意，但没挂到任何同意事项上（合法事项：${CONSENT_PURPOSE_IDS.join(' / ')}）`,
      }))
    }
  }

  // ④ ★ 反向：代码里存在的通道，说明里必须有。
  //    这是本模块唯一能挡住"后来加了一条通道没披露"的判据。
  if (observedEgress !== null) {
    for (const id of observedEgress) {
      if (!channelIds.includes(id)) {
        findings.push(Object.freeze({
          code: PRIVACY_CODES.UNDISCLOSED_EGRESS,
          channel: id,
          detail: `代码里存在出境通道 ${id}，但隐私说明里没有它——未披露的通道是这份说明最该拦的东西`,
        }))
      }
    }
    // ⑤ 以及正向：说明里列的通道，代码里也得真的有。
    for (const id of channelIds) {
      if (!observedEgress.includes(id)) {
        findings.push(Object.freeze({
          code: PRIVACY_CODES.STALE_CHANNEL,
          channel: id,
          detail: `隐私说明里列了通道 ${id}，但实际没有观测到——过期的披露同样是在误导用户`,
        }))
      }
    }
  }

  // ⑥ 本地数据分类必须全部可披露（每一类都有去留语义）。
  for (const id of DATA_CLASS_IDS) {
    if (DATA_CLASSES[id].onUninstall === undefined) {
      findings.push(Object.freeze({
        code: PRIVACY_CODES.UNDISCLOSED_DATA_CLASS,
        classId: id,
        detail: `本地数据类 ${id} 没有去留语义，无法在说明里交代它会被怎么处理`,
      }))
    }
  }

  return Object.freeze({
    version: PRIVACY_VERSION,
    channels: Object.freeze(channels.map((c) => Object.freeze({
      id: c.id, kind: c.kind, label: c.label, destination: c.destination,
      fields: c.fields === null ? null : Object.freeze([...c.fields]),
      fieldsRef: c.fieldsRef, defaultEnabled: c.defaultEnabled,
      controls: c.controls, consentPurpose: c.consentPurpose,
    }))),
    byKind: Object.freeze(Object.fromEntries(EGRESS_KINDS.map((k) => [k, channelIds.filter((id) => channels.find((c) => c.id === id).kind === k)]))),
    localDataClasses: Object.freeze(DATA_CLASS_IDS.map((id) => Object.freeze({
      id, label: DATA_CLASSES[id].label, onUninstall: DATA_CLASSES[id].onUninstall,
    }))),
    consentPurposes: CONSENT_PURPOSE_IDS,
    defaultConsent: DEFAULT_CONSENT,
    findings: Object.freeze(findings),
    // ★ 报告必须能回答"默认状态下有没有数据出境"这句话，而不只是一个开关的值。
    defaultsSummary: Object.freeze({
      ownChannelsEnabledByDefault: channels.filter((c) => c.kind === 'product-owned' && c.defaultEnabled).map((c) => c.id),
      delegatedChannelsAlwaysOn: channels.filter((c) => c.kind === 'delegated-dsh').map((c) => c.id),
      // 这一行是给"心跳关着所以没出境"那句话的正面反驳。
      egressStillHappensWithAllDefaults: channels.some((c) => c.kind === 'delegated-dsh' && c.defaultEnabled),
    }),
    ok: findings.length === 0,
  })
}

/**
 * 渲染成**给用户看的**说明。
 *
 * 与 `privacyReport` 分开：报告是给判据用的，这一段是给人读的。
 */
export function renderPrivacyNotice(report = privacyReport()) {
  const lines = []
  lines.push(`隐私与数据处理说明　${report.version}`)
  lines.push('')
  lines.push('一、会有哪些数据离开这台机器')
  lines.push('')
  const kindLabel = {
    'product-owned': '产品自有通道',
    'delegated-dsh': '委托执行引擎（DSH）的通道',
    loopback: '只在本机内（回环）',
  }
  for (const ch of report.channels) {
    lines.push(`  · ${ch.label}　[${kindLabel[ch.kind] ?? ch.kind}]`)
    lines.push(`      目的地：${ch.destination}`)
    if (ch.fields !== null) lines.push(`      字段：${ch.fields.join('、')}`)
    else lines.push(`      字段：不由本模块固定，见 ${ch.fieldsRef}`)
    lines.push(`      控制：${ch.controls.join('、')}`)
    lines.push(`      默认：${ch.defaultEnabled ? '开启' : '关闭'}`)
  }
  lines.push('')
  lines.push('二、模型调用说明')
  lines.push('')
  // ★ 这一段必须**主动**反驳"心跳关着就没出境"这个推论。
  const model = report.channels.find((c) => c.id === 'model-call')
  lines.push(`  运行任务时，装配后的上下文与你的输入会被送往你在 DSH 里配置的模型供应商。`)
  lines.push(`  这一步由 DSH 完成，${'本仓库'}既不决定目的地、也无法事后审计。`)
  if (model) lines.push(`  已披露为通道「${model.label}」。`)
  lines.push('')
  lines.push('  ⚠️ 心跳（产品自有上报）**默认关闭**，但模型调用**默认就是开的**。')
  lines.push('     "心跳关着"不等于"没有数据出境"。')
  lines.push('')
  lines.push('三、本地数据与卸载时的去留')
  lines.push('')
  for (const c of report.localDataClasses) {
    lines.push(`  · ${c.label}（${c.id}）：卸载时 ${c.onUninstall}`)
  }
  lines.push('')
  lines.push(`四、同意事项（默认：${Object.values(report.defaultConsent).every((v) => v === 'unknown') ? '全部未表态' : '见配置'}）`)
  for (const p of report.consentPurposes) lines.push(`  · ${p}`)
  lines.push('')
  if (report.findings.length > 0) {
    lines.push('⚠️ 本说明存在未闭合项：')
    for (const f of report.findings) lines.push(`  [${f.code}] ${f.detail}`)
  } else {
    lines.push('✔ 通道清单、字段名单与本地数据分类三处均已对齐。')
  }
  return lines.join('\n')
}

/**
 * 装载期自检：把三条判据各真的跑一遍，留下算出来的值。
 */
function auditPrivacy() {
  const problems = []

  // ① 正常输入下必须干净——否则说明本身就是坏的。
  const clean = privacyReport({ observedEgress: EGRESS_CHANNEL_IDS })
  if (!clean.ok) problems.push(`正常输入下说明有未闭合项：${clean.findings.map((f) => f.code).join('/')}`)

  // ② ★ 未披露的通道必须被抓住（本模块的核心理由）。
  const undeclared = privacyReport({ observedEgress: [...EGRESS_CHANNEL_IDS, 'telemetry-hidden'] })
  if (!undeclared.findings.some((f) => f.code === PRIVACY_CODES.UNDISCLOSED_EGRESS)) {
    problems.push('未披露的出境通道没有被抓住——那这份说明挡不住任何东西')
  }
  // ③ 反向：说明里多出来的通道也要报。
  const stale = privacyReport({ observedEgress: [] })
  if (!stale.findings.some((f) => f.code === PRIVACY_CODES.STALE_CHANNEL)) {
    problems.push('说明里多出来的通道没有被报出来')
  }
  // ④ 字段名单漂移必须被抓住。
  const drift = privacyReport({ actualPayloadKeys: [...ALLOWED_PAYLOAD_KEYS, 'screen_text'], observedEgress: EGRESS_CHANNEL_IDS })
  if (!drift.findings.some((f) => f.code === PRIVACY_CODES.FIELD_LIST_DRIFT)) {
    problems.push('心跳允许名单新增字段而说明未变，没有被抓住')
  }
  // ⑤ ★ "心跳默认关"不能推出"没有出境"。
  if (DEFAULT_HEARTBEAT_POLICY.enabled !== false) problems.push('心跳默认值变了，说明需重写')
  if (clean.defaultsSummary.egressStillHappensWithAllDefaults !== true) {
    problems.push('全部默认值下仍会出境这件事没有被表达出来——那说明会得出"数据不出门"的结论')
  }

  // ⑥ ★★ 三条"在真实输入上永不触发"的判据，各自用一个**注入的坏通道**证明能红。
  //
  //   这是探针 55④⑤⑥ 打不动第一版时暴露的：那三条判据的输入是模块级常量，
  //   所以它们**从来没有被验证过**。注入通道之后，这里才谈得上"证明能红"。
  //   （与 PRT-607 的 preset 表、PRT-612 的 `assertMappingConsistent` 同一条教训。）
  const mkChannel = (patch) => ({
    id: 'probe', kind: 'product-owned', label: '探针通道', destination: '探针',
    fieldsRef: 'probe', fields: null, defaultEnabled: false,
    controls: ['user-consent'], consentPurpose: 'crash-upload', ...patch,
  })
  const uncontrolled = privacyReport({
    channels: [mkChannel({ controls: [] })], observedEgress: null,
  })
  if (!uncontrolled.findings.some((f) => f.code === PRIVACY_CODES.UNCONTROLLED_CHANNEL)) {
    problems.push('无控制手段的通道没有被抓住——那"说不出控制"与"没有控制"就分不开了')
  }
  const noPurpose = privacyReport({
    channels: [mkChannel({ consentPurpose: null })], observedEgress: null,
  })
  if (!noPurpose.findings.some((f) => f.code === PRIVACY_CODES.NO_CONSENT_PURPOSE)) {
    problems.push('要求同意却没挂事项的通道没有被抓住')
  }
  const unexplained = privacyReport({
    channels: [mkChannel({ fields: null, fieldsRef: '' })], observedEgress: null,
  })
  if (!unexplained.findings.some((f) => f.code === PRIVACY_CODES.FIELDS_UNEXPLAINED)) {
    problems.push('`fields: null` 且没说字段从哪来，没有被抓住')
  }
  // 反向控制：把注入的坏值改好，那三条都必须消失——否则它们是无差别报警。
  const fixed = privacyReport({ channels: [mkChannel({})], observedEgress: null })
  if (fixed.findings.length !== 0) {
    problems.push(`修好后的注入通道仍报 ${JSON.stringify(fixed.findings.map((f) => f.code))}——那三条判据是无差别报警`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: PRIVACY_VERSION,
    channelIds: EGRESS_CHANNEL_IDS,
    kinds: EGRESS_KINDS,
    controls: EGRESS_CONTROLS,
    samples: Object.freeze({
      cleanOk: clean.ok,
      undeclaredCaught: undeclared.findings.map((f) => f.code),
      staleCaught: stale.findings.map((f) => f.code),
      driftCaught: drift.findings.map((f) => f.code),
      heartbeatDefaultEnabled: DEFAULT_HEARTBEAT_POLICY.enabled,
      egressWithAllDefaults: clean.defaultsSummary.egressStillHappensWithAllDefaults,
    }),
  })
}

export const PRIVACY_CHECKED = auditPrivacy()

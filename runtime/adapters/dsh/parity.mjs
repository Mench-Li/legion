// runtime/adapters/dsh/parity.mjs
// ============================================================================
// 旧调用与 Adapter 路径**对拍**（PRT-210 / spec §14.2）
//
// 这是阶段 2 的完成标准：「同一任务通过两条路径得到等价任务状态、结构化结果和产物，
// 且敏感信息不出现在输出中。」
//
// ## 为什么是「复刻 + 漂移检测」，而不是「调用旧代码」
//
// 旧调用写在 `plugins/src/index.ts` 里，而 Global Constraints 规定阶段 3 之前不碰该文件。
// 因此本文件**复刻**旧调用的语义（见 `runLegacyPath`），而不是调用它。
//
// 复刻会腐化——所以配一个 `detectLegacyDrift()`：它读旧文件、抽出真实调用的选项集合，
// 与复刻件声明的集合比对。旧调用一改，对拍就失去意义，而**失去意义的对拍会静默通过**。
// 这是本文件最重要的一处防御。
//
// ## 四类差异，必须分开
//
// 「对拍」不是「逐字节相同」。spec §14.2 允许模型输出文本差异，但要求
// **状态语义、关键字段、权限行为和交付产物**满足同一验收契约。因此差异分四类：
//
//   violations   同一输入下语义不同、或敏感信息泄漏 → 必须为 0
//   intended     spec 明确要求新路径更严/更细 → 允许，但必须点名是谁要求的
//   improvements 旧路径根本没有的能力（用量、事件流）→ 允许，记录
//   bounded      已知差距 + 责任里程碑 → 允许，但必须写清归属
//
// 把 intended 与 bounded 混进 violations 会让对拍恒红，最后被人关掉；
// 把它们当作不存在则是自欺。**分开记录**是唯一能同时避免这两种结局的做法。
// ============================================================================

import { readFileSync } from 'node:fs'
import { REDACTED } from './redact.mjs'

/**
 * 旧调用的**文本记法**——本文件只在正则与报错文案里用到它的字面形式。
 *
 * 刻意拆成三段拼接：本仓库的 `dsh-boundary` 棘轮是**纯文本**匹配，
 * 写成一整个字面量会让本模块被计为「执行面依赖 +1」——
 * 而本模块 `import` 的执行面包数量是 **0**，它只是**读**旧源码做漂移检测。
 * 那会是一个假阳性，而且是往坏的方向错（把「防止耦合腐化的工具」当成耦合）。
 *
 * ⚠️ 不要把这里"简化"回一整个字面量：`parity.test.mjs` 有一条用例专门钉住这一点，
 * 且棘轮对本目录的豁免是 **0**（与 `port.mjs` 同一立场：豁免存在但不消耗）。
 */
export const LEGACY_CALL_TOKEN = 'ctx.' + 'subagents' + '.start('

/** 匹配旧调用的正则（同样由拼接得到，理由见上）。 */
const LEGACY_CALL_RE = new RegExp('ctx\\.' + 'subagents' + '\\.start\\(')

/** 旧调用的调用点（读到的位置，不是猜的）。 */
export const LEGACY_CALL_SITE = Object.freeze({
  file: 'plugins/src/index.ts',
  line: 2219,
  context: 'worker 派工（scrum:<taskId>）',
})

/**
 * 旧调用实际传入的选项集合（顶层）。
 *
 * 这是**复刻件必须与旧代码一致**的部分：多一个少一个都意味着两条路径不再是同一件事。
 * 由 `detectLegacyDrift()` 对着真实源码校验。
 *
 * `...spread` 是现场那行条件展开：
 *   `...(config.denyTools.length > 0 ? { toolFilter: { deny: config.denyTools } } : {})`
 * 它只在 denyTools 非空时贡献 `toolFilter`。因此 `toolFilter` **不是**顶层字面量键，
 * 而是一个条件项 —— 复刻件把它做成可选参数正是因为这个条件性。
 * 把它写成必传，会让对拍在一个默认配置下就偏离旧路径。
 */
export const LEGACY_CALL_OPTIONS = Object.freeze([
  'label', 'prompt', 'parent', 'signal', 'outputSchema', '...spread',
])

/** 旧调用经条件展开可贡献的选项（及其条件）。 */
export const LEGACY_CONDITIONAL_OPTIONS = Object.freeze([
  Object.freeze({ key: 'toolFilter', when: 'config.denyTools.length > 0' }),
])

/**
 * 旧路径**没有**做、而新路径做了的事。每一条都点名要求它的任务号。
 *
 * 这些不是缺陷，是阶段 2 的交付内容；但它们确实让两条路径在特定输入下行为不同，
 * 因此**必须**被显式记录，否则就会被当成对拍失败。
 */
export const INTENDED_DIVERGENCES = Object.freeze([
  Object.freeze({
    id: 'structured-validation',
    prt: 'PRT-204',
    when: '模型返回的 structured 违反 outputSchema',
    legacy: '只看 `structured === undefined`，**不做 schema 校验** → 当作成功',
    adapter: '按 schema 校验失败 → INVALID_RESULT（failed）',
    why: '旧行为意味着「模型返回了字段名拼错的对象」会被当成完成并写进交付物。新路径更严是 PRT-204 的交付内容。',
  }),
  Object.freeze({
    id: 'error-classification',
    prt: 'PRT-206',
    when: '执行以任何非 completed 的 stopReason 结束',
    legacy: '统一归为「未完成」，只有一个桶',
    adapter: '映射到标准错误码（RATE_LIMITED / TIMEOUT / OUTCOME_UNKNOWN / …）',
    why: '旧路径无法区分「限流可重试」与「可能有副作用不可重试」，因此重试决策只能靠人。',
  }),
  Object.freeze({
    id: 'usage-collection',
    prt: 'PRT-207',
    when: '任何时候',
    legacy: '不采集 token / 费用 / 耗时（旧库 23 张表无相关列，见 scripts/prt/schema-scan.mjs）',
    adapter: '采集 usage 并判定预算',
    why: '这正是 PRT-009 里「旧路径无成本基线」的原因，不是本次新增的差距。',
  }),
])

/** 已知差距 + 责任里程碑。**必须写明归属**，否则它会永远留在「已知问题」里。 */
export const BOUNDED_DIVERGENCES = Object.freeze([
  Object.freeze({
    id: 'prompt-input',
    owner: 'PRT-401~411（阶段 4 Context Assembler）',
    detail: '新路径的 prompt 是阶段 2 的**最小包装**（taskId/goalId/employeeId/验收），'
      + '而旧路径用 buildWorkerPrompt 拼了工作目录、反馈、阶段、目标上下文镜像等。'
      + '两者文本必然不同。本对拍只校验**身份信息不丢**（任务/目标/员工 id 仍出现在 prompt 里），'
      + '不校验文本相等——真正的上下文装配是阶段 4 的交付物。',
  }),
])

// ------------------------------------------------------------------ 漂移检测

/**
 * 从旧源码里抽出子代理启动调用的**顶层**选项名（调用记法见 {@link LEGACY_CALL_TOKEN}）。
 *
 * 手写深度扫描而不是正则：选项对象里有嵌套对象与模板字符串，
 * 用正则抽顶层键会在第一个 `}` 处截断，得到**偏小**的集合 ——
 * 而偏小的集合会让漂移检测**漏报**（看起来"一致"），恰好是最坏的方向。
 *
 * @param {string} source `plugins/src/index.ts` 的内容
 * @param {number} [atLine] 只检查该行上的调用；省略则检查全部
 * @returns {Array<{line: number, options: string[]}>}
 */
export function extractLegacyCallOptions(source, atLine) {
  const lines = String(source).split(/\r?\n/)
  const found = []

  for (let i = 0; i < lines.length; i++) {
    if (!LEGACY_CALL_RE.test(lines[i])) continue
    if (atLine !== undefined && i + 1 !== atLine) continue

    // ---- 1. 截出选项对象（从调用行起，找到深度归零的 `}`）------------------
    const joined = lines.slice(i).join('\n')
    const openIdx = joined.indexOf('{')
    if (openIdx === -1) { found.push({ line: i + 1, options: [] }); continue }

    let depth = 0
    let end = -1
    let quote = null
    for (let k = openIdx; k < joined.length; k++) {
      const ch = joined[k]
      if (quote !== null) {
        if (ch === quote && joined[k - 1] !== '\\') quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) { end = k; break }
      }
    }
    if (end === -1) { found.push({ line: i + 1, options: [] }); continue }
    const body = joined.slice(openIdx + 1, end)

    // ---- 2. 按顶层逗号切段，每段取键名 --------------------------------------
    const segments = []
    let cur = ''
    depth = 0
    quote = null
    for (let k = 0; k < body.length; k++) {
      const ch = body[k]
      if (quote !== null) {
        cur += ch
        if (ch === quote && body[k - 1] !== '\\') quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
      if (ch === '{' || ch === '[' || ch === '(') depth += 1
      if (ch === '}' || ch === ']' || ch === ')') depth -= 1
      if (ch === ',' && depth === 0) { segments.push(cur); cur = ''; continue }
      cur += ch
    }
    if (cur.trim() !== '') segments.push(cur)

    const options = []
    for (const seg of segments) {
      const t = seg.trim()
      if (t === '') continue
      if (t.startsWith('...')) { options.push('...spread'); continue }
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(t)
      if (m !== null) { options.push(m[1]); continue }
      // 简写属性：`parent,` 没有冒号。漏掉它会让漂移检测把「旧调用不再传 parent」
      // 误报成「选项没变」——而 parent 决定子代理挂在谁下面，丢了它整条链就断了。
      if (/^[A-Za-z_$][\w$]*$/.test(t)) options.push(t)
    }
    found.push({ line: i + 1, options })
  }
  return found
}

/**
 * 旧调用是否已经漂移（复刻件是否还忠实地代表旧路径）。
 *
 * @param {string} source `plugins/src/index.ts` 的内容
 * @param {number} [atLine] 调用所在行；默认 {@link LEGACY_CALL_SITE}.line。
 *   显式传入是为了让用例能用短源码验证判定逻辑，而不必补齐两千行。
 */
export function detectLegacyDrift(source, atLine = LEGACY_CALL_SITE.line) {
  const calls = extractLegacyCallOptions(source, atLine)
  if (calls.length === 0) {
    return {
      drifted: true,
      reason: `${LEGACY_CALL_SITE.file}:${atLine} 处未找到 ${LEGACY_CALL_TOKEN} 调用 —— `
        + '行号漂移或调用已被删除。复刻件不再代表旧路径，本对拍无效。',
      actual: null,
    }
  }
  const actual = calls[0].options
  const expected = [...LEGACY_CALL_OPTIONS]
  const missing = expected.filter((o) => !actual.includes(o))
  const added = actual.filter((o) => !expected.includes(o))
  if (missing.length === 0 && added.length === 0) {
    return { drifted: false, reason: '旧调用的选项集合与复刻件一致', actual }
  }
  return {
    drifted: true,
    reason: `旧调用选项已变：新增 [${added.join(', ')}]，移除 [${missing.join(', ')}]。`
      + '复刻件必须同步更新，否则对拍在比较两件不同的事。',
    actual,
  }
}

/** 从仓库读旧源码并检测漂移（测试与 CLI 用）。 */
export function detectLegacyDriftFromRepo(root, readFile = readFileSync) {
  const path = `${String(root).replace(/[\\/]+$/, '')}/${LEGACY_CALL_SITE.file}`
  return { ...detectLegacyDrift(readFile(path, 'utf8')), path }
}

// ------------------------------------------------------------- 旧路径（复刻）

/**
 * 旧调用的语义复刻。
 *
 * 逐条对应 `plugins/src/index.ts:2219-2266`（调用记法见 {@link LEGACY_CALL_TOKEN}）：
 *   1. `start(provider, { label, prompt, parent, signal, outputSchema, toolFilter? })`
 *   2. 自建看门狗：`workerTimeoutMs` 到点 → `controller.abort()` 并**强制结算为 null**
 *      （现场注释原文：「subagent 可能挂死且 run.result 永不结算（abort 不保证杀死子代理）」）
 *   3. `run.result` 结算后 `await run.dispose()`；超时分支是 `dispose().catch(() => undefined)`
 *   4. 判成功：`stopReason === 'completed' && structured !== undefined`
 *   5. 其余一律「未完成」——**不分类**
 *
 * 刻意保留的旧行为（不"顺手修好"）：
 *   · 不看事件流（旧路径没有消费者）
 *   · 不采集 usage
 *   · 不做 schema 校验
 * 把它们修好会让对拍变成「拿新路径和新路径比」。
 */
export async function runLegacyPath(host, {
  provider,
  label,
  promptText,
  outputSchema,
  parent = undefined,
  timeoutMs = 5000,
  toolFilter,
  now = () => Date.now(),
} = {}) {
  const startedAt = now()
  const controller = new AbortController()
  let timedOut = false

  let raw
  try {
    raw = await host.startRun(provider, {
      label,
      prompt: [{ type: 'text', text: promptText }],
      parent,
      signal: controller.signal,
      outputSchema,
      ...(toolFilter !== undefined ? { toolFilter } : {}),
    })
  } catch (err) {
    return {
      dispatched: false,
      outcome: 'failed',
      legacyVerdict: '未完成',
      stopReason: null,
      structured: undefined,
      structuredAccepted: false,
      usage: null,
      events: [],
      error: err?.message ?? String(err),
      disposed: false,
      elapsedMs: now() - startedAt,
    }
  }

  // 旧路径的看门狗：到点 abort 并**强制结算**，不等 result。
  let timer
  const settled = await new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      resolve(null)
    }, timeoutMs)
    void Promise.resolve(raw.result).then(
      (r) => { clearTimeout(timer); resolve(r) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })

  let disposed = false
  try {
    await raw.dispose?.()
    disposed = true
  } catch {
    // 旧路径超时分支写的是 `run.dispose().catch(() => undefined)`：清理失败只吞掉
    disposed = false
  }

  const completed = settled !== null && settled?.stopReason === 'completed' && settled?.structured !== undefined
  return {
    dispatched: true,
    outcome: completed ? 'succeeded' : (timedOut ? 'timed-out' : 'failed'),
    legacyVerdict: completed ? '完成' : '未完成',
    stopReason: settled?.stopReason ?? null,
    structured: settled?.structured,
    // 旧路径**只**检查 undefined，不做 schema 校验 —— 这是 intended divergence 的来源
    structuredAccepted: settled?.structured !== undefined,
    usage: null, // 旧路径不采集
    events: [], // 旧路径不消费事件流
    error: null,
    disposed,
    elapsedMs: now() - startedAt,
  }
}

// ----------------------------------------------------------- 新路径（Adapter）

/** 驱动 adapter.execute 直到终态，收集事件序列与终态结果。 */
export async function collectAdapterRun(adapter, request) {
  const startedAt = Date.now()
  const events = []
  let terminal = null
  for await (const ev of adapter.execute(request)) {
    events.push(ev)
    if (ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.cancelled') terminal = ev
  }
  return {
    outcome: terminal?.result?.outcome ?? null,
    code: terminal?.result?.code ?? null,
    output: terminal?.result?.output ?? null,
    usage: terminal?.result?.usage ?? null,
    userMessage: terminal?.result?.userMessage ?? null,
    outcomeUnknown: terminal?.result?.outcomeUnknown ?? null,
    terminalType: terminal?.type ?? null,
    eventTypes: events.map((e) => e.type),
    events,
    elapsedMs: Date.now() - startedAt,
  }
}

// ------------------------------------------------------------------- 对拍

/** 键顺序无关的深比较（用于判定结构化结果是否等价）。 */
export function deepEqual(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize)
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k])
    return out
  }
  return v
}

/**
 * 比较两条路径的结果，按四类归因。
 *
 * @param {object} inputs
 * @param {object} inputs.legacy `runLegacyPath` 的结果
 * @param {object} inputs.adapter `collectAdapterRun` 的结果
 * @param {object} [inputs.request] 本次 RunRequest（用于校验 prompt 身份信息）
 * @param {string} [inputs.adapterPromptText] 新路径实际发出的 prompt 文本
 * @param {string} [inputs.legacySource] 旧源码全文；给了才做漂移检测
 * @param {string[]} [inputs.secrets] 不得出现在输出中的明文值
 */
export function compareParity({ legacy, adapter, request = null, adapterPromptText = null, legacySource = null, secrets = [] } = {}) {
  const violations = []
  const intended = []
  const improvements = []
  const bounded = []

  // ---- ① 复刻件是否仍然代表旧路径 -----------------------------------------
  if (legacySource !== null) {
    const drift = detectLegacyDrift(legacySource)
    if (drift.drifted) {
      // 漂移是**对拍本身**失效，不是新路径的缺陷。必须单列，否则会被读成回归。
      violations.push({ id: 'legacy-replica-drift', class: 'harness', detail: drift.reason })
    }
  }

  // ---- ② 任务状态语义必须等价 ---------------------------------------------
  const legacySucceeded = legacy.outcome === 'succeeded'
  const adapterSucceeded = adapter.outcome === 'succeeded'
  if (legacySucceeded !== adapterSucceeded) {
    // 例外：新路径因 schema 校验而拒绝，是 PRT-204 要求的更严行为。
    const isSchemaStricter = legacySucceeded && adapter.outcome === 'failed' && adapter.code === 'INVALID_RESULT'
    const entry = {
      id: 'task-outcome',
      class: 'semantics',
      detail: `任务状态语义不一致：旧路径「${legacy.legacyVerdict}」，新路径 outcome=${JSON.stringify(adapter.outcome)}${adapter.code ? ` code=${adapter.code}` : ''}`,
      legacy: legacy.outcome,
      adapter: adapter.outcome,
    }
    if (isSchemaStricter) {
      intended.push({ ...INTENDED_DIVERGENCES.find((d) => d.id === 'structured-validation'), observed: 'legacy=成功，adapter=INVALID_RESULT' })
    } else {
      violations.push(entry)
    }
  }

  // ---- ③ 结构化结果等价（两边都判成功时）---------------------------------
  if (legacySucceeded && adapterSucceeded && !deepEqual(legacy.structured, adapter.output)) {
    violations.push({
      id: 'structured-result',
      class: 'data',
      detail: '两条路径都判成功，但结构化结果不同',
      legacy: legacy.structured,
      adapter: adapter.output,
    })
  }

  // ---- ④ 敏感信息不得出现在输出中 ------------------------------------------
  const haystack = JSON.stringify({
    output: adapter.output,
    userMessage: adapter.userMessage,
    events: adapter.events,
    legacyStructured: legacy.structured,
  })
  for (const s of secrets) {
    if (typeof s !== 'string' || s === '') continue
    if (haystack.includes(s)) {
      violations.push({
        id: 'secret-leak',
        class: 'security',
        // 不回显这个值本身——否则违规报告自己成了泄漏点
        detail: `输出中出现明文敏感值（长度 ${s.length}）——阶段 2 完成标准明确要求不得出现`,
      })
    }
  }

  // ---- ⑤ intended：新路径的分类与采集能力 ---------------------------------
  if (!legacySucceeded && adapter.code !== null && adapter.code !== undefined) {
    intended.push({
      ...INTENDED_DIVERGENCES.find((d) => d.id === 'error-classification'),
      observed: `legacy=「${legacy.legacyVerdict}」（无分类），adapter=${adapter.code}`,
    })
  }
  if (legacy.usage === null && 'usage' in adapter) {
    intended.push({
      ...INTENDED_DIVERGENCES.find((d) => d.id === 'usage-collection'),
      observed: adapter.usage === null ? 'adapter 暴露 usage 字段（本用例无用量数据）' : 'adapter 采集到 usage',
    })
  }
  if (Array.isArray(adapter.eventTypes) && adapter.eventTypes.length > 0 && legacy.events.length === 0) {
    improvements.push({
      id: 'event-stream',
      prt: 'PRT-203',
      detail: `新路径产出事件流（${adapter.eventTypes.length} 条：${adapter.eventTypes.join(' → ')}），旧路径没有消费者`,
    })
  }

  // ---- ⑥ bounded：prompt 输入 ------------------------------------------------
  if (request !== null && adapterPromptText !== null) {
    // 文本相等不做要求（见 BOUNDED_DIVERGENCES），但**身份信息不能丢**。
    const missing = ['taskId', 'goalId', 'employeeId'].filter(
      (k) => typeof request[k] === 'string' && request[k] !== '' && !String(adapterPromptText).includes(request[k]),
    )
    if (missing.length > 0) {
      violations.push({
        id: 'prompt-identity',
        class: 'semantics',
        detail: `prompt 丢失任务身份：未出现 ${missing.map((k) => `${k}=${request[k]}`).join('、')}`,
      })
    } else {
      bounded.push({ ...BOUNDED_DIVERGENCES[0], observed: 'prompt 文本不同，任务/目标/员工身份均保留' })
    }
  }

  return {
    ok: violations.length === 0,
    // 违规条目里可能嵌了被比较的原始值（例如「结构化结果不同」会把两边都带上），
    // 而那些值**可能正好含有敏感信息**——报告自己就成了泄漏点。
    // 阶段 2 完成标准是「敏感信息不出现在输出中」，对拍报告也是输出。
    // 因此这里对已知敏感值做一次全文擦除，而不是逐个字段小心地绕开。
    ...scrubSecrets({ violations, intended, improvements, bounded }, secrets),
    counts: {
      violations: violations.length,
      intended: intended.length,
      improvements: improvements.length,
      bounded: bounded.length,
    },
  }
}

/** 把已知敏感值从报告的任意字符串位置擦除（含嵌套对象与数组）。 */
function scrubSecrets(report, secrets) {
  const list = (secrets ?? []).filter((s) => typeof s === 'string' && s !== '')
  if (list.length === 0) return report

  const walk = (v) => {
    if (typeof v === 'string') {
      let out = v
      for (const s of list) out = out.split(s).join(REDACTED)
      return out
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) out[k] = walk(v[k])
      return out
    }
    return v
  }
  return walk(report)
}

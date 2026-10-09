// services-plugin/materialize-plan.mjs
// ============================================================================
// P2（docs/DECISION-legion-owns-model-config.md）：**影子物化** —— 算出"接管后要写什么"，
// 但**一个字节都不写**。
//
// ## 这一段存在的唯一理由：先看见"接管会删掉什么"
//
// P3 会把 Legion 的目录变成 DSH 的活配置：Legion 里有的写进去、**Legion 里没有的要 unset**。
// 第二半是不可逆的那一半 —— 而它最容易在生产上第一次运行时就删掉一个**别人正在用**的供应商。
// 实测（DECISION §4）：DSH 里活着 `fjd-ds` 与 `svea-ds`，而 Legion 原本只有 `fjd-ds`；
// 如果 P3 在 P1 之前落地，第一轮就会把 `svea-ds` 从 DSH 里删掉。
//
//   > 一个"我知道我要写什么"的信心，
//   > 与一个"我知道我会**删掉**什么"的读数，
//   > 在动手之前是两件事 —— 而只有后者能拦住一个不可逆的错误。
//
// ## 本模块是**纯函数**：没有 ctx、没有网络、没有时钟
//
// 理由与 `branchScope.ts` / `configSanity.ts` 同源：判据要能直接钉住**判定本身**
// （"哪几条会被删"），而不是去读一段日志里的一行字。
//
// ## 两侧都在**同一个规范形状**上比较
//
// Legion 的 `model_providers` 与 DSH 的 `llm-pi-ai.providers.<id>` 字段不同名
// （`secretRef` ↔ `apiKeyEnv`，`displayName` ↔ `displayName`…），
// 所以本模块把两侧都归一化到 { id, displayName, api, baseURL, apiKeyEnv, models[] } 再比。
// 不这么做的后果很具体：字段名不同会让**每一轮都报"有变化"**，
// 而"永远不干净"的影子对账会让人把它当噪音关掉。
//
// ## 密钥：本模块**只处理引用名**
//
// 它一次都不读值，也不认识值。`credentialsNeeded` 报的是"这些引用名在 DSH 侧还**没配**"，
// 至于值从哪里来，是 P3 的事（P3 走 DPAPI 库取出即用，不落 team.db）。
// ============================================================================

/** 型号里参与比较的字段（与 `provider-store.mjs` 的模型白名单同一组，去掉描述性字段）。 */
const MODEL_COMPARE_FIELDS = Object.freeze(['id', 'name', 'contextWindow', 'maxTokens', 'input'])

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null
}

/** 输入模态：**排序**后比较 —— 顺序变了不是变化（`['text','image']` 与 `['image','text']` 是同一件事）。 */
function normalizeInput(v) {
  return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string'))].sort() : null
}

/**
 * 把一侧（Legion 行或 DSH 快照条目）归一化成可比较的规范形状。
 * 键序固定 —— 指纹用 `JSON.stringify`，键序变了会得到假差异。
 */
export function normalizeForCompare(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const id = str(entry.id)
  if (id === null) return null
  const models = Array.isArray(entry.models) ? entry.models : []
  const byId = new Map()
  for (const m of models) {
    const mid = str(m?.id)
    if (mid === null || byId.has(mid)) continue
    byId.set(mid, {
      id: mid,
      name: str(m.name) ?? mid,
      contextWindow: Number.isInteger(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : null,
      maxTokens: Number.isInteger(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : null,
      input: normalizeInput(m.input),
    })
  }
  return {
    id,
    displayName: str(entry.displayName) ?? id,
    api: str(entry.api),
    baseURL: str(entry.baseURL),
    // ★ 两个名字都是"引用名"：Legion 侧叫 secretRef，DSH 侧叫 apiKeyEnv。
    apiKeyEnv: str(entry.apiKeyEnv ?? entry.secretRef),
    models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function fingerprint(n) {
  return JSON.stringify([n.displayName, n.api, n.baseURL, n.apiKeyEnv, n.models])
}

/** 逐字段说清"哪几个字段不一样"—— 光说"这条变了"会让人去肉眼比对整个对象。 */
export function changedFields(before, after) {
  const out = []
  for (const key of ['displayName', 'api', 'baseURL', 'apiKeyEnv']) {
    if (before[key] !== after[key]) out.push(key)
  }
  if (JSON.stringify(before.models) !== JSON.stringify(after.models)) out.push('models')
  return out
}

/**
 * 算出"接管后要写什么"。
 *
 * @param desired  Legion 侧的目录（`GET /api/model-providers` 的 `providers`）
 * @param actual   DSH 侧的活目录（`readDshProviderSnapshot()` 的 `providers`）
 * @param actualCredentials  DSH 侧"这些引用名配没配"（`{ [ref]: boolean }`），可省
 * @returns 一份**只读**报告：`{ ok, clean, counts, create, update, delete, unchanged, credentialsNeeded }`
 *
 * `clean === true` 才意味着"接管这一轮不会改动任何东西"—— 而它要求
 * **三个集合都空**（没有要新增的、没有要改的、**没有要删的**）。
 */
export function planMaterialization({ desired = [], actual = [], actualCredentials = {} } = {}) {
  const d = new Map()
  for (const raw of desired) { const n = normalizeForCompare(raw); if (n !== null) d.set(n.id, n) }
  const a = new Map()
  // ★ 原始条目另存一份：`credentialConfigured` 在规范化时被**有意**丢掉了
  //   （它不是"要写进 DSH 的东西"），而"要不要单独写一条凭证"要读它 ——
  //   从规范化后的对象上读会永远读到 undefined，于是每一轮都报"缺凭证"。
  const rawActual = new Map()
  for (const raw of actual) {
    const n = normalizeForCompare(raw)
    if (n === null) continue
    a.set(n.id, n)
    rawActual.set(n.id, raw)
  }

  const create = []
  const update = []
  const unchanged = []
  for (const [id, want] of d) {
    const have = a.get(id)
    if (have === undefined) { create.push(id); continue }
    if (fingerprint(have) === fingerprint(want)) { unchanged.push(id); continue }
    update.push({ id, fields: changedFields(have, want) })
  }
  // ★ 这一行是 P2 的全部重点：**Legion 里没有、而 DSH 里活着的**会被删。
  const remove = [...a.keys()].filter((id) => !d.has(id)).sort()

  // 凭证：只报"这些引用名在 DSH 侧还没配"。**不认识值**。
  const credentialsNeeded = []
  for (const [id, want] of d) {
    if (want.apiKeyEnv === null) continue
    const raw = rawActual.get(id)
    // 权威顺序：调用方给的读数 > DSH 快照自己说的 > （无从判断就当已配，别报假缺）
    const configured = actualCredentials[want.apiKeyEnv] !== undefined
      ? actualCredentials[want.apiKeyEnv] === true
      : (raw === undefined ? true : raw.credentialConfigured === true)
    if (configured === false) credentialsNeeded.push(want.apiKeyEnv)
  }

  const counts = {
    create: create.length,
    update: update.length,
    delete: remove.length,
    unchanged: unchanged.length,
  }
  return Object.freeze({
    ok: true,
    clean: counts.create === 0 && counts.update === 0 && counts.delete === 0,
    counts,
    create: Object.freeze(create.slice().sort()),
    update: Object.freeze(update.slice().sort((x, y) => x.id.localeCompare(y.id))),
    delete: Object.freeze(remove),
    unchanged: Object.freeze(unchanged.slice().sort()),
    credentialsNeeded: Object.freeze([...new Set(credentialsNeeded)].sort()),
  })
}

/**
 * 把只读报告渲染成**一行**人看的读数。
 *
 * 为什么是一行：这一行每轮都会出现，多行会把守护日志里其它读数挤走；
 * 而"要删的那些 id"必须写在同一行里 —— 它是最需要被看见的字段，
 * 藏在下一行就等于没有。
 */
export function describeMaterializationPlan(plan, { actualReadOk = true, actualReason = '' } = {}) {
  if (!actualReadOk) {
    // ★ 读不到 DSH 现状时**不许说 clean**：那会把"没看"读成"没问题"。
    return `供应商影子对账：**读不到 DSH 现状**（${actualReason || '原因未知'}）→ 本次无法对账（**不是 clean**，别把它读成没有问题）`
  }
  const c = plan.counts
  const bits = [`新增 ${c.create}`, `修改 ${c.update}`, `删除 ${c.delete}`, `未变 ${c.unchanged}`]
  let line = `供应商影子对账：${bits.join(' / ')}（clean=${plan.clean}）`
  if (c.delete > 0) line += `；**接管会删掉**：${plan.delete.join(', ')}`
  if (plan.credentialsNeeded.length > 0) line += `；**缺凭证**：${plan.credentialsNeeded.join(', ')}`
  return line
}

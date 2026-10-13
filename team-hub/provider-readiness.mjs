// team-hub/provider-readiness.mjs
// ============================================================================
// 心跳里 `providers`（本机 Agent 运行时**就绪度**）的校验与规范化。
//
// ## 为什么单独一个模块
//
// 两件事必须能被判据钉住，而它们都不是路由的职责：
//   ① **形状校验**：一个坏掉的诊断字段，不允许把整条心跳带崩；
//   ② **"丢掉字段"与"丢掉心跳"的区别** —— 下面的纪律。
//
// ## ★★ 这条纪律是这张表存在的全部理由
//
// 心跳失败的代价是**这台守护被标成离线**（成员表 60 秒窗），于是对话健康降级、
// 任务不再被派给它。而 `providers` 只是**诊断信息**：没有它，一切照常。
//
//   > 一个坏掉的诊断字段，与一个坏掉的健康上报，
//   > 在**字段总是合法**的时候是同一条路径 ——
//   > 区别只在字段坏掉的那一刻：前者应该少一行信息，后者会让整台机器"下线"。
//
// 所以：形状不合法 ⇒ **返回 not-ok，由调用方丢弃这个字段、继续写心跳**。
// 绝不在校验失败时抛错（那会被上层的 try/catch 变成"心跳失败"）。
//
// 另一条：**没有 `providers` 字段是合法的**（旧守护不上报）。缺失 ≠ 坏掉。
// ============================================================================

/** 合法状态取值 —— 与 `runtime/adapters/dsh/provider-readiness.mjs` 的 READINESS_STATE 一一对应。 */
export const READINESS_STATES = Object.freeze([
  'ready', 'missing_cli', 'not_logged_in', 'no_network', 'unprobed', 'unknown',
])

/** 单个 provider 读数里允许出现的键。白名单：未知键说明两边版本不一致，宁可拒。 */
const ENTRY_KEYS = Object.freeze({
  state: (v) => typeof v === 'string' && READINESS_STATES.includes(v),
  reason: (v) => typeof v === 'string' && v.length <= 600,
  cli: (v) => typeof v === 'string' && v.length <= 32,
  auth: (v) => typeof v === 'string' && v.length <= 32,
  network: (v) => typeof v === 'string' && v.length <= 32,
  version: (v) => typeof v === 'string' && v.length <= 64,
  checkedAtMs: (v) => Number.isFinite(v),
})

export const MAX_PROVIDERS = 32

/**
 * 校验并规范化一份 provider 就绪度表。
 *
 * @returns {{ok: true, value: object} | {ok: false, reason: string}}
 *   `reason` 只用于日志/审计，**不含任何值内容**（避免把凭据类东西写进日志）。
 */
export function parseProviderReadiness(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'providers 必须是对象' }
  }
  const names = Object.keys(value)
  if (names.length === 0) return { ok: false, reason: 'providers 是空对象（应省略该字段，而不是发空）' }
  if (names.length > MAX_PROVIDERS) return { ok: false, reason: `providers 条目超过 ${MAX_PROVIDERS} 个` }

  const out = {}
  for (const name of names) {
    if (name.trim() === '' || name.length > 64) return { ok: false, reason: 'provider 名不合法' }
    const entry = value[name]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `providers.${name} 必须是对象` }
    }
    const clean = {}
    for (const [key, raw] of Object.entries(entry)) {
      const check = ENTRY_KEYS[key]
      if (check === undefined) return { ok: false, reason: `providers.${name}.${key} 不是受支持的字段` }
      if (!check(raw)) return { ok: false, reason: `providers.${name}.${key} 取值不合法` }
      clean[key] = raw
    }
    // `state` 是唯一必填项：没有结论的条目没有意义。
    if (clean.state === undefined) return { ok: false, reason: `providers.${name} 缺 state` }
    out[name] = clean
  }
  return { ok: true, value: out }
}

/** 存库前的序列化（**只存通过校验的内容**）。 */
export function serializeProviderReadiness(value) {
  const parsed = parseProviderReadiness(value)
  return parsed.ok ? JSON.stringify(parsed.value) : null
}

/**
 * 从库里读回来。
 *
 * ★ 读侧**永不抛错**：一行坏的 JSON 不该让 `/api/members` 整个 500 ——
 *   那会让界面连"谁在线"都看不到，只因为一个诊断字段坏了。
 *   读不出来就当没有（null），与"从没上报过"同一个语义。
 */
export function deserializeProviderReadiness(text) {
  if (typeof text !== 'string' || text === '') return null
  try {
    const parsed = parseProviderReadiness(JSON.parse(text))
    return parsed.ok ? parsed.value : null
  } catch { return null }
}

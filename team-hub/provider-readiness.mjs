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

/**
 * provider **自报的能力位**（DSH 描述符上的真值）。
 *
 * ★ 为什么把它跟就绪度放在一起上报：这两件事回答的是同一个问题 ——
 *   **"这台机器上这个 provider 到底能干什么"**。而它此前**无处可读**：
 *
 *     工作流面板让用户自己勾「支持工具过滤」等复选框，可 `outputSchema` 连复选框都没有，
 *     是**硬编码 `true`** 的。而 `plugins/src/index.ts` 派工时要求
 *     `frozenConfig.capabilities.outputSchema === true`，`team-hub` 认领时又要求
 *     声明与节点心跳上报的**逐位相等**。于是"provider 不支持结构化输出"这件事，
 *     用户既看不到、也表达不出来 —— 发布**成功**，然后**每一次派工都抛错**。
 *
 *   > 一个"发布成功、派工必失败"的配置，
 *   > 与一个"发布时就报错"的配置，在**用户还没派工**的时候看上去一模一样 ——
 *   > 区别只在第一次派工之后，而那时他已经在查任务为什么不动了。
 *
 * 校验口径**照抄** `harness-store.mjs` 的 `parseNodeCapabilities`（providers 那一支）：
 * 同一份能力在两条上报路径上必须同一个形状，否则"读得到"与"存得下"会分叉。
 */
const DECLARED_BOOLEAN_KEYS = Object.freeze(['outputSchema', 'toolFilter', 'cancellation'])

function checkDeclared(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '必须是对象'
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'permissionMode') {
      if (typeof raw !== 'string' || raw.trim() === '') return 'permissionMode 必须是非空字符串'
      continue
    }
    if (key === 'systemProxyMode') {
      if (!['inherit', 'system'].includes(raw)) return "systemProxyMode 只能是 'inherit' 或 'system'"
      continue
    }
    if (!DECLARED_BOOLEAN_KEYS.includes(key)) return `不支持的能力位 ${key}`
    if (typeof raw !== 'boolean') return `${key} 必须是布尔值`
  }
  // 三个布尔能力位**必须齐全**：缺一个就说明两边版本不一致，
  // 而"缺位"会被上层读成 false（= 能力不可用），把版本问题伪装成能力问题。
  for (const key of DECLARED_BOOLEAN_KEYS) {
    if (typeof value[key] !== 'boolean') return `缺 ${key}（能力位必须齐全，缺位会被读成"不支持"）`
  }
  return null
}

/** 单个 provider 读数里允许出现的键。白名单：未知键说明两边版本不一致，宁可拒。 */
const ENTRY_KEYS = Object.freeze({
  state: (v) => typeof v === 'string' && READINESS_STATES.includes(v),
  reason: (v) => typeof v === 'string' && v.length <= 600,
  cli: (v) => typeof v === 'string' && v.length <= 32,
  auth: (v) => typeof v === 'string' && v.length <= 32,
  network: (v) => typeof v === 'string' && v.length <= 32,
  version: (v) => typeof v === 'string' && v.length <= 64,
  checkedAtMs: (v) => Number.isFinite(v),
  /** 2026-10-13：provider 自报的能力位（见 `checkDeclared`）。缺失 = 本机没读到，不是"不支持"。 */
  declared: (v) => checkDeclared(v) === null,
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

  // ★★ 2026-10-13 实机修正：**逐条丢**，不再"一条坏就整份丢"。
  //
  //   第一版是 all-or-nothing：任何一个 provider 的任何一个字段不合法 ⇒ 整份 `providers` 丢掉。
  //   这是**诊断字段**上最坏的失败模式 —— 一个 provider 的怪值（比如某个 permissionMode
  //   是个没见过的串）会让**其余全部**读数一起消失，界面上表现为"这台机器什么都没探到"。
  //
  //     > 一个"因为隔壁那条坏了，于是这条也不报"的读数，
  //     > 与一个"本机确实什么都没有"的读数，在界面上是同一个样子。
  //
  //   而这条数据的用途恰恰是**让人看见真相**，所以宁可少一条，也不要一条都没有。
  //   容器形状不对（不是对象 / 空对象 / 超量）仍然整份拒 —— 那是**协议**层面的错，
  //   与"某台机器上某个 provider 报了个怪值"不是一回事。
  const out = {}
  const dropped = []
  for (const name of names) {
    const fail = (why) => { dropped.push(`${name}(${why})`) }
    if (name.trim() === '' || name.length > 64) { fail('名字不合法'); continue }
    const entry = value[name]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { fail('不是对象'); continue }
    const clean = {}
    let bad = null
    for (const [key, raw] of Object.entries(entry)) {
      const check = ENTRY_KEYS[key]
      if (check === undefined) { bad = `${key} 不是受支持的字段`; break }
      if (!check(raw)) { bad = `${key} 取值不合法`; break }
      clean[key] = raw
    }
    if (bad !== null) { fail(bad); continue }
    // `state` 是唯一必填项：没有结论的条目没有意义。
    if (clean.state === undefined) { fail('缺 state'); continue }
    out[name] = clean
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, reason: `providers 没有一条可用（丢弃：${dropped.join('、')}）` }
  }
  return { ok: true, value: out, dropped }
}

/** 存库前的序列化（**只存通过校验的内容**）。 */
export function serializeProviderReadiness(value) {
  const parsed = parseProviderReadiness(value)
  return parsed.ok ? JSON.stringify(parsed.value) : null
}

/**
 * profile 名的合法性 —— **照抄** DSH 自己的规则
 * （`packages/boot/app-boot/src/profile.ts` 的 `resolveProfileDir`）：
 * 非空、不含 `/` 与 `\`、不是 `.` / `..` / `node_modules`。
 *
 * ★ 为什么这里也要校验：这个名字会被面板拼进一条 **shell 命令**
 *   （`dsh plugin --profile <名> add …`）。一个连 DSH 都不接受的名字，
 *   拼出来必然是一条报错的命令 —— 而"一条看起来能跑的命令"正是这次要消灭的东西
 *   （判定与措辞见 `workbench/src/dshRemedy.ts`）。
 */
export function isAcceptableProfileName(value) {
  if (typeof value !== 'string') return false
  if (value === '' || value === '.' || value === '..' || value === 'node_modules') return false
  if (value.includes('/') || value.includes('\\')) return false
  return value.length <= 64
}

/** 规范化心跳里的 `profile` 字段；不合法当没上报（null），**不抛错**。 */
export function parseProfileName(value) {
  if (value === undefined || value === null) return null
  return isAcceptableProfileName(value) ? value : null
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

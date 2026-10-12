// team-hub/desktop-only.mjs
// ============================================================================
// 有些接口**按设计只存在于桌面端（本机）**。这个模块让 Hub 把这件事**说出来**，
// 而不是回一句 `404 not found`。
//
// ## 问题
//
// 工作台 SPA 由 Hub 托管在 `/workbench/`，浏览器里能登录、能用主面。
// 但它引用的 129 个 `/api/` 路径里有 **31 个**在 Hub 上**没有路由** ——
// 实测（2026-10-12，逐条打生产；四种方法都试过）：
//
//     /api/files/*  17 条   文件中心：目录根 = **本机**工作空间目录；
//                           含 `reveal`（调 **OS 文件管理器**定位）
//     /api/skills/{import,scan-dir,scan-github,sync}   4 条   扫描**本机**目录
//     /api/fs/*      3 条   home / drives / list —— **本机**盘符与目录
//     /api/web/*     3 条   服务端 fetch 代理（SSRF 防护的那一套）
//     其余           4 条   尚未逐条核实
//
// 它们在 `workbench/scripts/serve.mjs`（桌面端静态服务器）里，而那份文件头写着：
//
//     > 附加 API（同源，**仅回环地址可访问**）
//
// ## ★ 为什么**不能**把它们搬到 Hub 上
//
// Hub 监听公网。把 `/api/fs/list` 搬过去，等于让**任何能访问互联网的人**
// 列目录、读文件、写文件到**服务器**上 —— 那不是"补齐功能"，
// 那是一处**远程任意文件读写**。
//
//   > 一个"看起来只是还没接的接口"，与一个"接上去就是远程任意文件读写"的接口，
//   > 在缺失清单里长得一模一样。
//
// ## 所以要做的是"说出来"，不是"接上去"
//
// 现在浏览器里那些面板拿到的是 `404 {error: "not found: /api/files/list"}` ——
// 它读起来像**坏了**（像一处 bug），而真相是**有意不在这里做**。
//
// 这个模块回：
//
//     501 { code: 'DESKTOP_ONLY', error: '「文件中心」需要在桌面端（你本机）使用 ——
//           这里操作的是你电脑上的目录，不是服务器上的。', hint: '…' }
//
// ★ 为什么是 **501 Not Implemented**：
//   · `404` 是"没有这个接口" —— 暗示一处 bug，而这是**有意**的；
//   · `500` 是"我们不知道哪里错了" —— 而这里我们**知道**；
//   · `501` 恰恰是"服务器**不实现**这个功能" —— 与事实一字不差。
//
// ## ★★ 一条结构性保证：**绝不遮蔽真实路由**
//
// 判定只在**所有路由族都没匹配上之后**才被调用（`server.mjs` 的 404 兜底处）。
// 于是这张表可以写得**宽**（按前缀列），而不会抢走任何真实接口 ——
// 例如 `/api/web/history` 是真路由，而 `/api/web/` 在这张表里：
// 真路由先赢，兜底才有机会。
//
//   > 一个"只在没人接的时候才说话"的兜底，
//   > 与一个"可能抢走真实接口"的中间件，区别只在**调用点**。
// ============================================================================

/** 给客户端的状态码。见文件头：501 = 服务器**不实现**这个功能。 */
export const DESKTOP_ONLY_STATUS = 501

/** 具名错误码：客户端按**类型**分支，不按文案匹配。 */
export const DESKTOP_ONLY_CODE = 'DESKTOP_ONLY'

/**
 * 只存在于桌面端（本机）的功能面。
 *
 * ★ `prefix` **必须带结尾斜杠**（或与 `exact` 配套）。理由是这一类边界错误
 *   在本仓库里出现过很多次：`/api/fs/` 用 `startsWith` 配 `/api/fs` 去匹配，
 *   会**连带命中** `/api/fsharp`、`/api/fs-other` 之类的路径。
 *   带斜杠之后 `startsWith('/api/fs/')` 就不会。
 *
 * ★ `label` 要具体到**哪个功能**，不是"这个路径"：用户看到"需要在桌面端"
 *   之后还得知道**是哪件事**要在桌面端做。
 *
 * ★ `why` 只讲**为什么**（操作对象是用户的电脑），不重复"怎么办" ——
 *   后者统一由 `hint` 说。
 */
export const DESKTOP_ONLY = Object.freeze([
  Object.freeze({
    exact: '/api/fs',
    prefix: '/api/fs/',
    label: '目录选择',
    why: '它要读的是**你这台电脑**的盘符与目录（`home` / `drives` / `list`）。',
  }),
  Object.freeze({
    exact: '/api/files',
    prefix: '/api/files/',
    label: '文件中心',
    why: '它的目录根是**你本机**的工作空间目录，`reveal` 还会调用**你电脑的**文件管理器。',
  }),
  Object.freeze({
    prefix: '/api/web/',
    label: '网页助手',
    why: '它是**服务端**发起的抓取代理（带 SSRF 防护），只在回环部署里开放。',
  }),
  Object.freeze({
    exact: '/api/dsh-models',
    prefix: null,
    label: '模型列表',
    why: '它读的是**本机那份 DSH 安装**里的模型清单。',
  }),
  Object.freeze({
    prefix: '/api/skills/import',
    label: '技能导入',
    why: '它要扫描**你本机**的目录、或从外网拉取技能包。',
  }),
  Object.freeze({
    prefix: '/api/skills/scan-dir',
    label: '技能扫描',
    why: '它要扫描**你本机**的目录。',
  }),
  Object.freeze({
    prefix: '/api/skills/scan-github',
    label: '技能扫描',
    why: '它要从外网拉取技能包 —— 那一步是本机的出网动作。',
  }),
  Object.freeze({
    prefix: '/api/skills/sync',
    label: '技能同步',
    why: '它要把技能同步到**你本机**的目录。',
  }),
])

/**
 * 这条路径是不是"桌面端才有"的功能面？是的话是哪一件？
 *
 * @param {string} path 已经过前缀改写（`/hub` → 去掉）之后的路径
 * @returns {{label: string, why: string, matched: string}|null}
 */
export function desktopOnlyFor(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  for (const entry of DESKTOP_ONLY) {
    // ① 精确匹配（用于"这个路径本身就是那个功能"的情形）。
    if (typeof entry.exact === 'string' && path === entry.exact) {
      return { label: entry.label, why: entry.why, matched: entry.exact }
    }
    // ② 前缀匹配 —— **必须**用带斜杠的前缀（见 `DESKTOP_ONLY` 的注释）。
    if (typeof entry.prefix === 'string' && entry.prefix.endsWith('/') && path.startsWith(entry.prefix)) {
      return { label: entry.label, why: entry.why, matched: entry.prefix }
    }
    // ③ 前缀**不以斜杠结尾**时，退化成"等于或后面紧跟斜杠"，
    //    绝不做裸 `startsWith` —— 那是这个模块最想避免的那类边界错误。
    if (typeof entry.prefix === 'string' && !entry.prefix.endsWith('/')
      && (path === entry.prefix || path.startsWith(`${entry.prefix}/`))) {
      return { label: entry.label, why: entry.why, matched: entry.prefix }
    }
  }
  return null
}

/**
 * 参数规整。
 *
 * ★★ 这不是防御性编程的洁癖，是**这个会话里第三次**踩同一个坑：
 *   `function f({ a } = {})` 的 `= {}` 只在实参是 **`undefined`** 时生效 ——
 *   传 `null` 会直接抛 `Cannot destructure property 'a' of 'object null'`。
 *
 *   前两次：`storageReport(input = {})`、`growthReport({ samples } = {})`。
 *   三次都发生在**模块边界**上，而模块边界正是"值来自 JSON / 文件 / 别的模块"
 *   的地方 —— 也就是 `null` 真的会出现的地方。
 *
 *   > 一个只在 `undefined` 时生效的默认值，
 *   > 与一个"什么都接得住"的默认值，在代码里长得一模一样。
 */
function arg(value) {
  return (value === null || typeof value !== 'object') ? {} : value
}

/**
 * 给用户看的那句话。
 *
 * ★ 三件事缺一不可（与 `storage-health.mjs` 的 `storageMessage` 同一条纪律）：
 *   ① 这是**有意**的，不是坏了；
 *   ② **为什么** —— 它操作的是**你的**电脑；
 *   ③ 说清服务器上为什么不做。
 *
 * ★ 不许叫用户做他做不到的事，也**不许**说"请联系管理员"：
 *   管理员**修不好**这件事（它不是故障，是设计），
 *   把用户引到管理员那里只会浪费两个人的时间。
 */
export function desktopOnlyMessage(input) {
  const { label, why } = arg(input)
  const what = typeof label === 'string' && label.length > 0 ? label : '这个功能'
  const reason = typeof why === 'string' && why.length > 0 ? why : '它操作的是你本机的东西。'
  return `「${what}」需要在**桌面端**（你本机）使用 —— ${reason}`
    + '服务器上做不到这件事：那样等于把**你的**文件读写暴露给任何能访问互联网的人。'
}

/** 给客户端的 `hint`：下一步做什么（与 `message` 分工：一个解释，一个指路）。 */
export function desktopOnlyHint(input) {
  const { label } = arg(input)
  const what = typeof label === 'string' && label.length > 0 ? label : '这个功能'
  return `在装在你电脑上的 Legion 桌面端里用「${what}」；浏览器里的工作台用它做不了。`
}

/**
 * 造出要回的响应体（**纯数据**，便于判据直接断言形状）。
 *
 * @returns {{code: string, error: string, hint: string, desktopOnly: true}}
 */
export function desktopOnlyBody(match) {
  return {
    code: DESKTOP_ONLY_CODE,
    error: desktopOnlyMessage(match ?? {}),
    hint: desktopOnlyHint(match ?? {}),
    // 一个**显式**的布尔量：客户端不必靠 `code` 的字符串值去判断
    // （那是"改一个常量就静默失效"的耦合，本仓库为此吃过亏）。
    desktopOnly: true,
  }
}

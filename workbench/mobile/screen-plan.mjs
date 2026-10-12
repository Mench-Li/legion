// workbench/mobile/screen-plan.mjs
// ============================================================================
// 首屏该显示哪一块 —— 一个**纯决策**，加上几条把"别露馅"写成常量的数据。
//
// ## 修的是什么
//
// 打开页面时，`#screen-login` **没有** `hidden`（`#main` 与 `#composer` 有）。
// 于是已经登录的人：先看到一整张登录表单 → 几百毫秒后被抽走 → 才进主界面。
//
//   > 一个"先让你以为自己被登出了、再把你放进去"的首屏，
//   > 与一个"直接进去"的首屏，在功能上完全一样 ——
//   > 只不过前者每次打开都让人心里一沉。
//
// 而进主界面之后，`enterApp()` 立刻把 `#main` 亮出来、**然后**才 await 六个
// 串行请求（空间 → 任务 → 提醒 → 会话 → 消息）。那段时间内容区是**空的**，
// 弱网下看起来就是卡死。
//
// ## 三块屏，任何时候**恰好**显示一块
//
//   `'boot'`  启动探测中（骨架）
//   `'login'` 要登录
//   `'app'`   主界面
//
// 由 `document.body.dataset.screen` 承载，CSS 据此决定显示哪一块。
// 用**一个属性**而不是三处 `classList` 增删：三处各自 toggle 的那种写法，
// 漏掉一处就会同时显示两块（或者一块都不显示），而两者在截图里都是"页面坏了"。
// ============================================================================

/** 三块屏。顺序即"从等待到可用"的顺序。 */
export const SCREENS = Object.freeze(['boot', 'login', 'app'])

/** `data-screen` 的合法值吗？（写错值时 CSS 三条规则全不匹配 ⇒ 三块都不显示） */
export function isScreen(value) {
  return typeof value === 'string' && SCREENS.includes(value)
}

/**
 * 探测完成之后该落哪一屏。
 *
 * ★ 这里只有 `signedIn` 一个输入，是刻意的：**"能不能进"与"有没有会话"是
 *   同一件事**。把 `reachable` 也塞进来会造出第四种组合（"连得上但没会话"与
 *   "连不上但有会话"），而它们的正确落点都是 `'login'` —— 多一个输入只会
 *   多一条没人想清楚的路径。
 *
 *   （"连不上"要说的话由状态条承担，见 `timeline.mjs` 的文案表：
 *   `未登录 ≠ Hub 不可达`，那两件事在界面上必须分开说。）
 *
 * @param {{signedIn?: boolean}} input
 * @returns {'app' | 'login'}
 */
export function screenAfterProbe({ signedIn = false } = {}) {
  return signedIn === true ? 'app' : 'login'
}

/**
 * 头部那几个动作（页签 / 刷新 / 退出）该不该出现。
 *
 * ★ 它们原来在**登录页上也画着**（模板里就在 header 里，没有任何条件）。
 *   于是还没登录的人看到「Agent / 任务」两个页签与「刷新 / 退出」两个按钮，
 *   点了没有对应界面 —— 一组看得见、点不动的控件比没有控件更糟。
 *
 * @param {string} screen
 */
export function chromeVisible(screen) {
  return screen === 'app'
}

/**
 * 骨架的行宽（百分比）。**常量**，不是算法生成的：
 * 它只是"看起来像在加载内容"的形状，随机化没有任何好处，
 * 而固定值让截图对比（以及将来可能的视觉回归）有一条稳定基准。
 */
export const SKELETON_ROWS = Object.freeze([92, 78, 88, 64, 84, 71])

/** 启动时那行字。探测很快时它一闪而过；慢的时候它是唯一在动的信息。 */
export const BOOT_TITLE = '正在连接…'

// workbench/mobile/i18n.mjs
// ============================================================================
// 手机端的语言层：**中文原文就是 key**，英文是一张覆盖表。
//
// ## 为什么用原文当 key，而不是发明一套 `login.title` 这样的键
//
// 三个理由，每个都对应一种真实的坏法：
//
// ① **缺译时的行为**。`t('登录 Legion')` 在英文表里找不到就返回**原文**
//    （中文）—— 界面照常可用，只是那一条没翻。而键式方案缺键时返回的是
//    `login.title` 或者空串：前者把内部名字印到用户脸上，后者让按钮变成空白。
//
//    > 一个"没翻译就显示中文"的界面，与一个"没翻译就显示 `login.title`"的界面，
//    > 在覆盖率 100% 时是同一个东西。
//
// ② **不需要第二份真源**。`board.mjs` / `popup.mjs` / `timeline.mjs` 里的那些
//    标签表**已经存在**，而且被**对等判据**钉着（与桌面端 `notify.ts` 逐字相同、
//    被 `timeline.test.mjs` 用 `/未登录/` 匹配）。用原文当 key，那层投影**一个字
//    都不用改**：它继续产出中文，而翻译发生在**渲染的那一刻**。
//    换成键式，我得先把那些表改成键，再把桌面端也改成键 —— 而那是为了翻译去动
//    一个与翻译无关的对等契约。
//
// ③ **可机器核对覆盖率**。`t('…')` 的字面量可以从源码里抽出来，与英文表求差集。
//    键式方案里，漏掉的往往是"压根没写 `t()` 那一次调用" —— 那种漏法**没有任何
//    差集能发现**，因为它连键都不存在。
//
// ## 这一层不做的事
//
// 它**不改**投影层（`board.mjs` / `popup.mjs` / `timeline.mjs`）的返回值。
// 那些是"域的语言"（也是 key），把它们改成按 locale 返回会让对等判据失去锚点。
// 翻译在渲染边界做 —— 见 `app.mjs` 里 `t(...)` 的调用点。
// ============================================================================

/** 支持的语言。第一个是默认。 */
export const LOCALES = Object.freeze(['zh', 'en'])
export const DEFAULT_LOCALE = 'zh'

/** 显式键（以 `@` 开头）用于**动态文案**：带插值、没有固定原文可当 key 的那些。 */
export const DYNAMIC_KEYS = Object.freeze({
  '@attemptState': { zh: 'Attempt 状态：{state}', en: 'Attempt state: {state}' },
  '@noTasksInView': { zh: '这个视角下没有任务。（共 {n} 条，切到「全部」看）', en: 'No tasks in this view. ({n} total — switch to "All")' },
  '@rawStatus': { zh: '库里的状态：{status}', en: 'Raw status: {status}' },
  '@dispatchFailed': { zh: '请求失败（HTTP {status}）', en: 'Request failed (HTTP {status})' },
  '@deviceLabel': { zh: '手机 {platform}', en: 'Phone {platform}' },
  '@cannotReachHub': { zh: '无法连接 Hub：{message}', en: 'Cannot reach the hub: {message}' },
  '@taskDispatched': { zh: '已派任务 {taskId}：电脑上线后会领取执行。', en: 'Task {taskId} dispatched — the computer will pick it up when online.' },
  '@feedbackRecorded': { zh: '要求已记到 {taskId}，下一轮执行时生效。', en: 'Requirement recorded on {taskId}; it takes effect next run.' },
  '@unsupportedIntent': { zh: '不支持的意图：{intent}', en: 'Unsupported intent: {intent}' },
  // ★ 下面这些模板的 zh **照抄 `popup.mjs` 里的模板字符串**，逐字一致。
  //   我最初按"想象"写了 `@popupTransition` = `'{icon} {head}状态变为「{state}」{tail}'`，
  //   而 `popupText` 实际产出的是 `` `${icon} ${head}${state}${tail}` ``（**没有**"状态变为「」"）。
  //   一个与真实组合对不上的模板永远不会被用到 —— 而它看起来很正常。
  '@popupStatus': { zh: '{icon} {head}{state}{tail}', en: '{icon} {head}{state}{tail}' },
  '@popupTail': { zh: '（{who}）', en: ' ({who})' },
  '@popupHold': { zh: '🖐 {head}被拦截：守护不再自动认领{tail}', en: '🖐 {head} held: the daemon will stop claiming automatically{tail}' },
  '@popupUnhold': { zh: '🚀 {head}已放行：守护恢复自动认领{tail}', en: '🚀 {head} released: the daemon resumes claiming{tail}' },
  '@popupReassign': { zh: '🔁 {head}被转派{tail}', en: '🔁 {head} reassigned{tail}' },
  '@popupTestReport': { zh: '🧪 {head}测试报告已提交{tail}', en: '🧪 {head} test report submitted{tail}' },
  '@popupEvidence': { zh: '📦 {head}提交了证据{tail}', en: '📦 {head} submitted evidence{tail}' },
  '@popupGeneric': { zh: '{icon} {head}{tail}', en: '{icon} {head}{tail}' },
  '@notifyUnsupported': { zh: '这个浏览器不支持系统提醒；页面内的提醒照常出现。', en: 'This browser does not support system notifications; in-page alerts still work.' },
  '@notifyIosInstall': { zh: '这台设备要先「添加到主屏幕」，之后才能开启系统提醒。', en: 'On this device, add Legion to your Home Screen first, then system notifications can be enabled.' },
  '@notifyGranted': { zh: '🔔 系统提醒已开启：页面不在前台时也会通知你。', en: '🔔 System notifications are on: you will be notified while the page is in the background.' },
  '@notifyDenied': { zh: '提醒被浏览器拒绝了。请在站点设置里把「通知」改为允许，然后刷新页面。', en: 'Notifications were blocked by the browser. Allow "Notifications" in site settings, then reload the page.' },
  '@notifyPrompt': { zh: '开启系统提醒：页面不在前台时也会通知你。', en: 'Enable system notifications: get notified while the page is in the background.' },
  '@notifySendFailed': { zh: '系统提醒发送失败：{message}（页面内的提醒照常出现）', en: 'Could not send the system notification: {message} (in-page alerts still work)' },
  '@sessionExpiredHint': { zh: '会话已过期，请重新登录。', en: 'Your session expired. Please sign in again.' },
  // ★ 提醒正文是**界面文案**，而 `reason` 是任务评论里的**数据**（人或 Agent 写的），
  //   两件事必须分开：整体拼完再查表一定匹配不上任何 key，于是英文模式下
  //   弹框正文仍然是中文。这里翻 `base`、原样保留 `reason`，只让连接符按语言走。
  '@popupWithReason': { zh: '{base} —— {reason}', en: '{base} — {reason}' },
  // 多个空间时的下拉框标题（`空间：s1（owner）`）。
  '@spaceLabel': { zh: '空间：{id}（{role}）', en: 'Space: {id} ({role})' },
})

/**
 * 英文覆盖表：**中文原文 → 英文**。
 *
 * 缺项不是错误（会回落成中文），但 `i18n.test.mjs` 有一条判据把源码里所有
 * `t('…')` 的字面量与这张表求差集 —— 于是"我加了 `t()` 却忘了翻"会在 CI 变红。
 */
export const EN = Object.freeze({
  // ── 通用动作 ──────────────────────────────────────────────────────────────
  '刷新': 'Refresh',
  '退出': 'Sign out',
  '退出登录': 'Sign out',
  '登录': 'Sign in',
  '重试': 'Retry',
  '关闭': 'Close',
  '关闭提示': 'Dismiss',
  '发送': 'Send',
  '取消': 'Cancel',
  '空间': 'Space: ',

  // ── 离线待发队列（`outbox.mjs` / 横幅 / 登录屏提示）─────────────────────────
  //
  // ★ 这一组**必须在表里**，而且比别处更要紧：它们只在**断网**时出现，
  //   而断网正是用户最需要看懂屏幕上写了什么的时候。
  //   一句没翻的中文在这里的代价不是"不美观"，是"他不知道自己的字去哪了"。
  '查看': 'View',
  '删掉': 'Delete',
  '发不出去：{message}': 'Cannot send: {message}',
  '上次失败：{message}': 'Last attempt failed: {message}',
  '有一条待发消息在等你重新登录。': 'One queued message is waiting for you to sign in again.',
  '已发出去 {n} 条待发消息。': 'Sent {n} queued message(s).',
  '网络不通，这条已经放进待发队列，连上后会自动发出。':
    'No network. This message is queued and will be sent automatically once you are back online.',
  '待发队列存不进本机存储（可能是隐私模式或空间已满）。请保持这一页打开，或清一点空间。':
    'The outgoing queue could not be saved on this device (private mode, or storage is full). '
    + 'Keep this page open, or free up some space.',
  '你还有 {n} 条消息没发出去（存在这台设备上，登录并连上网络后会自动发出）。':
    'You still have {n} unsent message(s). They are stored on this device and will be sent '
    + 'automatically once you sign in and are back online.',
  // 横幅的**键**（`outboxBanner` 返回的就是这几个字面量，带占位符）。
  '{n} 条待发': '{n} queued',
  '{n} 条发不出去': '{n} could not be sent',
  '断网中，连上网络后会自动发出。': 'Offline. They will be sent automatically once you are back online.',
  '最早的一条已经等了约 {mins} 分钟。连上网络后会自动发出。':
    'The oldest has been waiting about {mins} minute(s). They will be sent once you are back online.',
  '正在重试…': 'Retrying…',
  '正在重试，最早的一条已经等了约 {mins} 分钟。':
    'Retrying; the oldest has been waiting about {mins} minute(s).',
  '这些消息服务端拒绝了，需要你处理（改一下或删掉）。':
    'The server rejected these messages. They need your attention (edit or delete).',

  // ── 时间线：作者与来源标签 ────────────────────────────────────────────────
  //
  // ★ 这几个**不在** `t('…')` 里出现：`timelineMetaFor()` 返回它们，
  //   调用处再用 `t(who)` / `t(tagText)` 翻。所以"`t()` 里的字面量"那支差集
  //   **看不见**它们 —— 第一版就漏了这五条，英文模式下时间线的作者名仍是中文。
  //   现在由一条**反向判据**盯着（见 `i18n.test.mjs` 的 UNWRAPPED_OK 清单）。
  '我': 'Me',
  '系统': 'System',
  '我说': 'I said',
  '进展': 'Progress',
  '回复': 'Reply',

  // ── 头部 / 页签 ──────────────────────────────────────────────────────────
  '任务': 'Tasks',
  '连接中…': 'Connecting…',
  '正在连接…': 'Connecting…',
  '成员选择': 'Member picker',
  '任务视角': 'Task views',
  '消息意图': 'Message intent',
  '目标 Agent': 'Target agent',
  '目标任务': 'Target task',
  '给 Agent 发消息…': 'Message the agent…',
  '开启系统提醒：页面不在前台时也会通知你': 'Enable system notifications: get notified while the page is in the background',

  // ── 登录 / 注册 ──────────────────────────────────────────────────────────
  '登录 Legion': 'Sign in to Legion',
  '注册 Legion': 'Create a Legion account',
  '注册并登录': 'Sign up and sign in',
  '已有账号，去登录': 'Have an account? Sign in',
  '注册新账号': 'Create an account',
  '用户名': 'Username',
  '口令': 'Password',
  '邀请码': 'Invite code',
  '口令至少 8 个字符。': 'At least 8 characters.',
  '用你的 Legion 账号登录。': 'Sign in with your Legion account.',
  '用你的 Legion 账号登录。Hub 地址默认取当前站点。': 'Sign in with your Legion account. The hub address defaults to this site.',
  '这台 Hub 需要邀请码。': 'This hub requires an invite code.',
  '填一个用户名与口令即可开始。': 'Pick a username and password to get started.',
  '这台 Hub 还没有初始化：请在服务器上建第一个管理员账号。': 'This hub has not been initialised: create the first admin account on the server.',

  // ── 状态条（`timeline.mjs` 的投影结果，渲染时翻译）──────────────────────
  'Hub 不可达': 'Hub unreachable',
  '未登录': 'Not signed in',
  '电脑离线': 'Computer offline',
  '运行时不可用': 'Runtime unavailable',
  '等待你确认': 'Waiting for your approval',
  '结果待确认': 'Result needs confirmation',
  '任务进行中': 'Task running',
  '电脑状态未知': 'Computer status unknown',
  '空闲': 'Idle',
  '读到的内容可能不是最新的；恢复后会按游标补齐': 'What you see may be stale; it will catch up from the cursor once reconnected',
  'Hub 正常；登录后即可查看 Agent 与任务': 'The hub is fine; sign in to see agents and tasks',
  '任务会排队等待电脑上线，不是"执行中"': 'Tasks will queue until the computer is online — this is not "running"',
  '连接正常，但这台电脑上的 Agent 现在干不了活': 'Connected, but the agent on this computer cannot work right now',
  '有一个动作需要你批准': 'An action needs your approval',
  '这次执行的结果无法自动判定，需要人工对账': 'This run cannot be judged automatically; it needs a human to reconcile',
  '电脑在线，当前没有进行中的任务': 'The computer is online and nothing is running',
  '还没有收到这台电脑的状态上报': 'No status report from this computer yet',

  // ── 详情面板（`board.mjs` 的标签表，渲染时翻译）──────────────────────────
  '询问': 'Ask',
  '问状态、要解释。**不**创建任务、不改变正在跑的执行。': 'Ask for status or an explanation. It does **not** create a task or change a running one.',
  '派任务': 'Dispatch a task',
  '新建一条任务，电脑上线后领取执行。': 'Create a task; the computer picks it up when online.',
  '追加要求': 'Add a requirement',
  '给**正在跑的那条**任务补充要求，下一次执行时生效。': 'Add a requirement to **the running task**; it takes effect on the next run.',
  '消息不能为空': 'The message cannot be empty',
  '「追加要求」需要先指定要补充的是哪条任务': '“Add a requirement” needs to know which task it applies to',
  '待办': 'Backlog',
  '进行中': 'Running',
  '待验收': 'Awaiting review',
  '受阻': 'Blocked',
  '已完成': 'Completed',
  '已取消': 'Canceled',
  '未排期': 'Unscheduled',
  '全部': 'All',
  '工作中': 'In progress',
  '待我决定': 'Needs my decision',
  '结果待确认：这次执行的结果没法自动判定，需要人工对账': 'Result unconfirmed: this run cannot be judged automatically — it needs a human to reconcile',
  '多次失败已停手：需要人看一眼再决定': 'Stopped after repeated failures: a human needs to look before it continues',
  '等你确认：有一个动作需要你批准': 'Waiting on you: an action needs your approval',
  '执行已结束，等待验收': 'The run finished and awaits review',
  '正在电脑上执行': 'Running on the computer',
  '已派给电脑，正在准备': 'Dispatched; the computer is preparing',
  '本次执行已停止': 'This run has stopped',
  '本轮执行完成': 'This round finished',
  '等电脑领取': 'Waiting for the computer to claim it',
  '受阻，需要人处理': 'Blocked; a human needs to handle it',
  '等待验收': 'Awaiting review',
  '未排期：还不该被领取': 'Unscheduled: it should not be claimed yet',
  '尚无执行记录': 'No run recorded yet',
  '高优先级': 'High priority',
  '未识别的状态': 'Unrecognised status',

  // ── 提醒（`popup.mjs` 的标签，渲染时翻译）───────────────────────────────
  '待规划': 'To plan',
  '待处理': 'To handle',
  '待你验收': 'Waiting for your review',
  '受阻（等你处理）': 'Blocked (needs you)',
  '🖐 拦截自动': '🖐 Hold automation',
  '🚀 放行自动': '🚀 Release automation',
  '🔁 转派': '🔁 Reassign',
  '🧪 测试报告': '🧪 Test report',
  '🔄 状态变更': '🔄 Status change',
  '状态变更': 'Status change',
  '🎯 目标已发布': '🎯 Goal published',
  '✅ 目标已完成': '✅ Goal completed',
  '✕ 目标已取消': '✕ Goal canceled',
  '⏸ 目标已暂停': '⏸ Goal paused',

  // ── 空态与提示 ───────────────────────────────────────────────────────────
  '这个空间下还没有 Agent。': 'No agents in this space yet.',
  '还没有消息。用下面输入框给这个 Agent 派一个任务试试。': 'No messages yet. Use the box below to dispatch a task to this agent.',
  '这个空间还没有任务。用下面输入框派一个。': 'No tasks in this space yet. Dispatch one with the box below.',
  '（电脑上线后自动开始）': ' (starts automatically once the computer is online)',
  '问这个 Agent': 'Ask this agent',
  '这个空间下还没有 Agent': 'No agents in this space',
  '这个空间还没有 Agent': 'No agents in this space yet',
  '当前没有可追加要求的活动任务': 'No running task to add a requirement to',
  '描述要做的事，电脑上线后会领取执行…': 'Describe what to do; the computer picks it up when online…',
  '给这条任务补充要求（下一轮执行时生效）…': 'Add a requirement to this task (effective next run)…',
  '问状态、要解释…': 'Ask for status or an explanation…',
  '还没有加入任何空间': 'Not a member of any space yet',
  '还没有选中 Agent': 'No agent selected yet',

  // ── 提醒与通知 ───────────────────────────────────────────────────────────
  '🔔 提醒已就绪：有任务等你处理时会弹在这里': '🔔 Alerts ready: they will pop up here when a task needs you',
  'Legion 指挥台': 'Legion Console',

  // ── 由**投影层的纯函数**产出的固定文案 ───────────────────────────────────
  //
  // ★ 这些不在 `app.mjs` 里，所以"找 `t('…')` 字面量"与"找未包 `t()` 的字面量"
  //   两支判据都看不见它们 —— 它们住在 `notify-plan.mjs` / `notice.mjs` 里，
  //   由函数返回、由渲染处翻。已补一条**闭环判据**（真的把那些函数跑一遍）。
  //
  //   注意 `开启系统提醒：…通知你。` **带句号**，而上面 HTML 属性用的那条**不带** ——
  //   差一个字符，查表就落空。生产上的活体检查照出来的就是这个。
  '开启系统提醒：页面不在前台时也会通知你。': 'Enable system notifications: get notified while the page is in the background.',
  '🔔 系统提醒已开启：页面不在前台时也会通知你。': '🔔 System notifications are on: you will be notified while the page is in the background.',
  '提醒被浏览器拒绝了。请在站点设置里把「通知」改为允许，然后刷新页面。': 'Notifications were blocked by the browser. Allow "Notifications" in site settings, then reload the page.',
  '这个浏览器不支持系统提醒；页面内的提醒照常出现。': 'This browser does not support system notifications; in-page alerts still work.',
  '这台设备要先「添加到主屏幕」，之后才能开启系统提醒。': 'On this device, add Legion to your Home Screen first, then system notifications can be enabled.',
  '会话已过期，请重新登录。': 'Your session expired. Please sign in again.',
  '请填写用户名与口令': 'Enter a username and password',
})

// ── 语言状态（模块级，唯一的可变处）────────────────────────────────────────

let current = DEFAULT_LOCALE

/** 从 BCP-47 标签取语言（`zh-CN` → `zh`，`en-US` → `en`）。不认识的回 `null`。 */
export function localeFromTag(tag) {
  if (typeof tag !== 'string' || tag.length === 0) return null
  const base = tag.toLowerCase().split('-')[0]
  return LOCALES.includes(base) ? base : null
}

/**
 * 决定用哪种语言。**优先级：用户显式选择 > 浏览器语言 > 默认。**
 *
 * ★ 用户的选择必须压过浏览器：一个人把界面切成英文，不会希望每次打开
 *   又因为系统是中文而变回去。而"显式选择"与"没选过"必须分得开 ——
 *   所以存的是 `null` 而不是空串（空串是"选过但选了个空的"）。
 *
 * @param {{saved?: string|null, navLang?: string|null}} input
 */
export function resolveLocale({ saved = null, navLang = null } = {}) {
  const fromSaved = localeFromTag(saved ?? '')
  if (fromSaved !== null) return fromSaved
  const fromNav = localeFromTag(navLang ?? '')
  if (fromNav !== null) return fromNav
  return DEFAULT_LOCALE
}

/** 当前语言。 */
export function getLocale() {
  return current
}

/** 设定当前语言（只接受受支持的值）。 */
export function setLocale(locale) {
  if (!LOCALES.includes(locale)) {
    throw new TypeError(`setLocale 收到不支持的语言：${JSON.stringify(locale)}`)
  }
  current = locale
  return current
}

/** `{name}` 形式的插值。缺的变量**原样留占位符**，不写 `undefined`。 */
export function interpolate(text, vars) {
  if (vars === null || typeof vars !== 'object') return text
  return String(text).replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  ))
}

/**
 * 翻译一段文案。
 *
 * @param {string} text 中文原文（或 `@` 开头的显式键）
 * @param {object} [vars] 插值变量
 * @param {string} [locale] 不传就用当前语言（纯函数式调用可以显式传）
 * @returns {string}
 */
export function t(text, vars = null, locale = current) {
  if (typeof text !== 'string') return text
  if (text.startsWith('@')) {
    const entry = DYNAMIC_KEYS[text]
    if (entry === undefined) return text
    return interpolate(entry[locale] ?? entry[DEFAULT_LOCALE] ?? text, vars)
  }
  if (locale === DEFAULT_LOCALE) return interpolate(text, vars)
  return interpolate(EN[text] ?? text, vars)
}

/** 语言切换器要显示的标签（用**各语言自己的说法**）。 */
export const LOCALE_LABEL = Object.freeze({ zh: '中文', en: 'English' })

/**
 * 把静态 HTML 里的文案换成当前语言。
 *
 * 约定（见 `index.html`）：
 *   · `data-i18n`              → 用 `textContent` 作为中文原文，替换它
 *   · `data-i18n-attr="title,placeholder,aria-label"` → 逐个属性翻译
 *
 * ★ 原文第一次就存进 `dataset.i18nSource`。没有它，`zh → en → zh` 切回来时
 *   会把英文当成原文再翻一次（找不到就显示英文），于是**切不回中文**。
 *
 * @param {ParentNode} root
 * @param {string} [locale]
 */
export function applyStaticI18n(root, locale = current) {
  if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return 0
  let touched = 0
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (el.dataset.i18nSource === undefined) el.dataset.i18nSource = el.textContent.trim()
    el.textContent = t(el.dataset.i18nSource, null, locale)
    touched += 1
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    const attrs = String(el.dataset.i18nAttr).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    for (const attr of attrs) {
      const storeKey = `i18nSource${attr.replace(/[^a-z]/gi, '')}`
      const now = el.getAttribute(attr)
      if (now === null) continue
      if (el.dataset[storeKey] === undefined) el.dataset[storeKey] = now
      el.setAttribute(attr, t(el.dataset[storeKey], null, locale))
      touched += 1
    }
  }
  return touched
}

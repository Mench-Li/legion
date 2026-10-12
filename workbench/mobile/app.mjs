// workbench/mobile/app.mjs
// ============================================================================
// 手机端 PWA 前端（远程 Agent 通道 S-F）
//
// 刻意**不用** React / 打包器：这个页面要在手机上以最快速度起来，
// 而 workbench 主界面（React + three.js）为桌面指挥台而生，体积与首屏都不适合。
// 这里是一个原生 ES 模块页面，随 Hub 静态托管，零构建步骤。
//
// ## 会话与游标
//
// 访问令牌存 `sessionStorage`（**不是** localStorage）：关闭标签页就没了，
// 而刷新凭据存 localStorage。这样一台被借用的手机上，"我关掉了页面"确实
// 等于"别人打不开"；而用户自己重开时靠刷新凭据无感续期。
//
// ## 断线续读
//
// SSE 用 `Last-Event-ID` 由浏览器自动续传，另有 `sinceSeq` 兜底。
// 事件帧只是**通知**，真正的内容永远回 Hub 读一遍——这样"通知丢了"不会变成
// "界面上缺了一条"，最多是"晚一会儿才看到"。
//
// ## 两个视图：看板与对话
//
// 看板回答"**这个空间里有什么事**"，对话回答"**这个 Agent 在做什么**"。
// 只给对话的手机端有一个很安静的坏处：用户看得见 Agent 说了什么，
// 却看不见任务卡在哪——而"我要下个任务"的前提恰恰是前者。
// ============================================================================
import {
  BOARD_VIEWS,
  DEFAULT_INTENT,
  DEFAULT_VIEW,
  INTENT_OPTIONS,
  applyView,
  attentionCount,
  boardColumns,
  canAppendFeedback,
  intentOf,
  viewOf,
  isWaitingForNode,
  mergeAttempts,
  planSend,
  taskLine,
  taskMeta,
} from './board.mjs'
import {
  deriveConnectionState,
  mergeTimeline,
  timelineEntry,
} from './timeline.mjs'
import { createRefresher } from './refresh-loop.mjs'
import { popupBatch, popupText, readPopupSeq, reasonFromTask, shouldUseSystemNotify, validTaskId, writePopupSeq } from './popup.mjs'
import { renderAvatar } from './avatar.mjs'
// 两个**纯决策**：提示该写哪儿、会话该不该清。抽在 `notice.mjs` 里是为了可测 ——
// 本文件在 Node 里不可 import（顶层读 `sessionStorage`），而这两个判断正是出过错的地方。
import {
  pickNoticeHost, shouldClearSession, sessionExpiredMessage, HOST_INLINE,
} from './notice.mjs'
// 系统提醒的三个纯决策（机制 / 去重标签 / 按钮表现）。抽出来是为了可测 ——
// 本文件在 Node 里不可 import，而这三个判断都不需要 DOM。
import { notifyMechanism, notificationTag, notifyButtonPlan } from './notify-plan.mjs'
// 首屏该显示哪一块。三块由 `body[data-screen]` 单点切换，见 `screen-plan.mjs` 文件头。
import { isScreen, screenAfterProbe, chromeVisible } from './screen-plan.mjs'

const $ = (id) => document.getElementById(id)
const LS_REFRESH = 'legion.mobile.refresh'
const SS_ACCESS = 'legion.mobile.access'
const LS_HUB = 'legion.mobile.hub'
const LS_SCOPE = 'legion.mobile.scope'
const LS_AGENT = 'legion.mobile.agent'

/** 一轮最多弹几条（超过时只弹最新的几条，见 popup.mjs）。 */
const POPUP_LIMIT = 3
/** 首次接入这个提醒时补告的时间窗（语义是"你刚才大概不在"，不是"曾经发生过什么"）。 */
const POPUP_REPLAY_MS = 6 * 60 * 60 * 1000
/** 弹框停留时长：手机上读一句话比桌面慢，给足。 */
const POPUP_TTL_MS = 9000
/** 「提醒已就绪」这句只对每个浏览器说一次（说多了就成了噪音）。 */
const LS_POPUP_ARMED = 'legion.mobile.popuparmed'
function popupArmedShown() {
  try { return localStorage.getItem(LS_POPUP_ARMED) === '1' } catch { return true }
}
function markPopupArmed() {
  try { localStorage.setItem(LS_POPUP_ARMED, '1') } catch { /* 存储不可用：那就每次都说，无害 */ }
}

/** Hub 地址：默认同源（部署在同一域名下），可由登录页覆盖。 */
function hubBase() {
  return localStorage.getItem(LS_HUB) ?? location.origin
}

const state = {
  access: sessionStorage.getItem(SS_ACCESS) ?? null,
  refresh: localStorage.getItem(LS_REFRESH) ?? null,
  agents: [],
  agentId: localStorage.getItem(LS_AGENT) ?? null,
  scope: localStorage.getItem(LS_SCOPE) ?? null,
  convId: null,
  timeline: [],
  /** 空间看板的任务（`/api/board`），与当前 Agent 的 Attempt 合并后渲染。 */
  tasks: [],
  cursor: null,
  conn: deriveConnectionState({ hubReachable: false }),
  sse: null,
  view: 'chat',
  intent: DEFAULT_INTENT,
  /** 任务视角（与指挥台任务中心同一条轴）。 */
  boardView: DEFAULT_VIEW,
  /**
   * 空间代际。**每切一次空间加一**。
   *
   * 异步刷新在开始时记下它、写回前再比一次：不相等就把结果**丢掉**。
   * 挡的是这个竞态——切空间时，上一个空间那次还在飞的请求返回了，
   * 把已经属于**另一个空间**的数据写进 `state.tasks`。
   *
   *   > 一个"旧空间的响应写进新空间"的界面，
   *   > 与一个"数据本来就是错的"的界面，在用户那边是同一个东西——
   *   > 只不过前者只在切得够快时出现，所以它更像个幽灵。
   */
  scopeGen: 0,
  /** 「追加要求」针对的任务 id；由看板卡片按钮或下拉框选择。 */
  targetTaskId: null,
  /**
   * 提醒弹框的游标（BUG-021）。
   *
   * 与看板那个「待我决定」徽标**不是**同一把尺子：徽标是"现在有几件事等你"，
   * 游标是"哪些事我已经弹给你看过了"。混用会两头都错——用户点一次看板，
   * 徽标清零，而"已经弹过"这件事跟看没看过毫无关系。
   */
  popupSeq: 0,
  /** 能力发现的结果。决定登录页显示"登录"还是"注册+登录"。 */
  identity: { bootstrapped: null, registration: 'closed' },
  /** `/api/identity/me` 的结果（「我的」那一页用）。 */
  authMode: 'login',
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function api(path, { method = 'GET', body = null, auth = true, retry = true } = {}) {
  const headers = {}
  if (auth && state.access) headers.authorization = `Bearer ${state.access}`
  if (body !== null) headers['content-type'] = 'application/json'
  let res
  try {
    res = await fetch(hubBase() + path, { method, headers, body: body === null ? undefined : JSON.stringify(body) })
  } catch (e) {
    setConnection({ hubReachable: false })
    throw new Error(`无法连接 Hub：${e.message}`)
  }
  if (res.status === 401 && auth && retry && state.refresh) {
    // 令牌过期与"会话被撤销"是两种情形，但都值得先试一次刷新。
    const ok = await refreshSession()
    if (ok) return api(path, { method, body, auth, retry: false })
    // ★ 刷新也失败 ⇒ 会话确实没了。**必须切回登录屏并说出来**：
    //   修复前这里只是继续往下 throw，界面停在旧样子，之后每个请求都静默 401 ——
    //   用户看到的是一个"点什么都像卡住"的应用，而真正该做的是重新登录。
    clearSession()
    showLoginScreen()
    showError(sessionExpiredMessage())
    const stale = new Error(sessionExpiredMessage())
    stale.status = res.status
    stale.code = 'SESSION_EXPIRED'
    throw stale
  }
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error ?? `HTTP ${res.status}`)
    err.code = json?.code ?? null
    err.status = res.status
    throw err
  }
  return json
}

async function refreshSession() {
  try {
    const r = await fetch(hubBase() + '/api/identity/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: state.refresh }),
    })
    const j = await r.json()
    if (!r.ok || j.ok !== true) { clearSession(); return false }
    state.access = j.accessToken
    state.refresh = j.refreshToken
    sessionStorage.setItem(SS_ACCESS, state.access)
    localStorage.setItem(LS_REFRESH, state.refresh)
    return true
  } catch { return false }
}

function clearSession() {
  state.access = null
  state.refresh = null
  sessionStorage.removeItem(SS_ACCESS)
  localStorage.removeItem(LS_REFRESH)
}

// ── 渲染：状态条 ────────────────────────────────────────────────────────────

function setConnection(input) {
  state.conn = deriveConnectionState(input)
  const el = $('status')
  el.querySelector('.dot').className = `dot ${state.conn.tone}`
  el.querySelector('.label').textContent = state.conn.label
  el.querySelector('.detail').textContent = state.conn.detail
}

// ── 渲染：对话 ──────────────────────────────────────────────────────────────

/**
 * 一条消息的作者与来源标签。
 *
 * 语义标签（`semanticType`）**直接显示**对意图最要紧的那一个：`create_task`
 * 的消息是"我在这里下过一个任务"的凭据。把它画成一个普通的气泡，
 * 用户就分不出"我说了一句话"与"我派了一个活"——而这两件事的后果完全不同。
 */
function timelineMetaFor(entry) {
  const who = entry.source === 'user' ? '我' : (entry.author || '系统')
  const tagText = entry.kind === 'create_task' ? '派任务'
    : entry.source === 'user' ? '我说'
      : entry.source === 'progress' ? '进展'
        : entry.source === 'command' ? '系统' : '回复'
  const tagClass = entry.kind === 'create_task' ? 'create_task'
    : entry.source === 'progress' ? 'progress'
      : entry.source === 'command' ? 'command' : ''
  return { who, tagText, tagClass }
}

function renderTimeline() {
  const root = $('timeline')
  if (state.timeline.length === 0) {
    const p = document.createElement('div')
    p.className = 'hint'
    p.textContent = state.agents.length === 0
      ? '这个空间下还没有 Agent。'
      : '还没有消息。用下面输入框给这个 Agent 派一个任务试试。'
    root.replaceChildren(p)
    return
  }
  const frag = document.createDocumentFragment()
  for (const e of state.timeline) {
    const wrap = document.createElement('div')
    wrap.className = 'msg'
    // ★ 来源写在 DOM 上（`data-source`），样式与"这条能不能打开任务"都读它。
    //   靠绘制顺序去猜来源会在补投历史条目时错位。
    wrap.dataset.source = e.source
    const meta = document.createElement('div')
    meta.className = 'meta'
    const { who, tagText, tagClass } = timelineMetaFor(e)
    const author = document.createElement('span')
    author.textContent = who
    meta.appendChild(author)
    const tag = document.createElement('span')
    tag.className = `tag ${tagClass}`
    tag.textContent = tagText
    meta.appendChild(tag)
    if (e.openableTask) {
      const a = document.createElement('a')
      a.className = 'taskref'
      a.href = `#task-${encodeURIComponent(e.taskId)}`
      a.textContent = e.taskId
      a.addEventListener('click', (ev) => { ev.preventDefault(); void openTask(e.taskId) })
      meta.appendChild(a)
    }
    wrap.appendChild(meta)
    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = e.body
    wrap.appendChild(body)
    if (Array.isArray(e.options) && e.options.length > 0) {
      const opts = document.createElement('div')
      opts.className = 'groups'
      for (const o of e.options) {
        const b = document.createElement('button')
        b.textContent = o
        b.addEventListener('click', () => void send(o, 'answer_question'))
        opts.appendChild(b)
      }
      wrap.appendChild(opts)
    }
    frag.appendChild(wrap)
  }
  root.replaceChildren(frag)
  $('main').scrollTop = $('main').scrollHeight
}

// ── 渲染：看板 ──────────────────────────────────────────────────────────────

/** 视角 chip：与指挥台任务中心同一条轴。见 board.mjs 的 BOARD_VIEWS。 */
function renderBoardViews() {
  const box = $('board-views')
  box.replaceChildren()
  for (const v of BOARD_VIEWS) {
    const b = document.createElement('button')
    b.textContent = v.label
    b.setAttribute('aria-selected', String(state.boardView === v.id))
    b.addEventListener('click', () => { state.boardView = v.id; renderBoardViews(); renderBoard() })
    box.appendChild(b)
  }
}

function renderBoard() {
  const root = $('task-groups')
  const shown = applyView(state.tasks, state.boardView)
  const frag = document.createDocumentFragment()
  let any = false

  if (state.boardView !== 'all') {
    // ★ 选中某个视角时给**平铺列表**，不按状态分列。
    //
    // 视角已经把状态收窄过一次了（比如「待我决定」= in_review + blocked），
    // 再分列会得到两列各一条，而手机上那两列的高度加起来比列表还高——
    // 信息量没增加，滚动距离翻了倍。
    const box = document.createElement('div')
    box.className = 'group'
    const h = document.createElement('h2')
    h.textContent = viewOf(state.boardView)?.label ?? ''
    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(shown.length)
    h.appendChild(n)
    box.appendChild(h)
    if (shown.length === 0) {
      const p = document.createElement('div')
      p.className = 'hint'
      p.textContent = `这个视角下没有任务。（共 ${state.tasks.length} 条，切到「全部」看）`
      box.appendChild(p)
    }
    for (const t of shown) box.appendChild(taskCard(t))
    frag.appendChild(box)
    root.replaceChildren(frag)
    return
  }

  const { columns, unknown } = boardColumns(shown)
  for (const col of columns) {
    if (col.count === 0) continue
    any = true
    const box = document.createElement('div')
    box.className = 'group'
    const h = document.createElement('h2')
    h.textContent = col.title
    const n = document.createElement('span')
    n.className = 'n'
    n.textContent = String(col.count)
    h.appendChild(n)
    box.appendChild(h)
    for (const t of col.tasks) box.appendChild(taskCard(t))
    frag.appendChild(box)
  }
  if (unknown.length > 0) {
    any = true
    const box = document.createElement('div')
    box.className = 'group'
    const h = document.createElement('h2')
    // 不认识的状态照实说。悄悄丢掉的后果是"状态机加了状态、手机上少了任务"。
    h.textContent = '未识别的状态'
    box.appendChild(h)
    for (const t of unknown) {
      const card = taskCard(t)
      card.querySelector('.s').textContent = `库里的状态：${t.status}`
      box.appendChild(card)
    }
    frag.appendChild(box)
  }
  if (!any) {
    const p = document.createElement('div')
    p.className = 'hint'
    p.textContent = '这个空间还没有任务。用下面输入框派一个。'
    frag.appendChild(p)
  }
  root.replaceChildren(frag)
}

function taskCard(t) {
  const card = document.createElement('div')
  card.className = 'task'
  card.id = `card-${t.id}`
  const name = document.createElement('div')
  name.className = 't'
  name.textContent = `${t.id} ${t.title ?? ''}`
  card.appendChild(name)
  const s = document.createElement('div')
  s.className = 's'
  s.textContent = taskLine(t)
  // 「等电脑领取」是**等待**不是**执行中**。不标出来的话，用户在电脑关机时
  // 会以为任务在跑，于是等下去。
  if (isWaitingForNode(t)) s.textContent += '（电脑上线后自动开始）'
  card.appendChild(s)
  const m = document.createElement('div')
  m.className = 'm'
  m.textContent = taskMeta(t)
  if (m.textContent.length > 0) card.appendChild(m)
  const acts = document.createElement('div')
  acts.className = 'acts'
  // ★ 「追加要求」只给**还没结束**的任务。
  //
  // 已结束的任务上放这个按钮，按下去必然失败（服务端以 TASK_TERMINAL 拒）——
  // 而一个必然失败的按钮是最坏的一种：用户会以为是自己哪里点错了，
  // 或者反复试。要改已完成的活，那是**新任务**，不是追加要求。
  if (canAppendFeedback(t)) {
    const b1 = document.createElement('button')
    b1.textContent = '追加要求'
    b1.addEventListener('click', () => { chooseTaskForFeedback(t.id); focusComposer('feedback') })
    acts.appendChild(b1)
  }
  const b2 = document.createElement('button')
  b2.textContent = '问这个 Agent'
  b2.addEventListener('click', () => {
    const owner = state.agents.find((a) => a.role === (t.role ?? t.soldier))
    if (owner !== undefined) void selectAgent(owner.agentId)
    showView('chat')
  })
  acts.appendChild(b2)
  card.appendChild(acts)
  return card
}

/** 高亮某条任务的卡片（派单/追加之后，让用户看得见它落在哪）。 */
function highlightTask(taskId) {
  const el = $(`card-${taskId}`)
  if (el === null) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.style.borderColor = 'var(--accent)'
  setTimeout(() => { el.style.borderColor = '' }, 2500)
}

async function openTask(taskId) {
  showView('tasks')
  await refreshTasks()
  highlightTask(taskId)
}

// ── 渲染：目标选择（Agent / 任务）──────────────────────────────────────────

function renderTargets() {
  const sel = $('agent-select')
  sel.replaceChildren()
  if (state.agents.length === 0) {
    const o = document.createElement('option')
    o.textContent = '这个空间下还没有 Agent'
    o.value = ''
    sel.appendChild(o)
    sel.disabled = true
  } else {
    sel.disabled = false
    for (const a of state.agents) {
      const o = document.createElement('option')
      o.value = a.agentId
      o.textContent = `${a.name}（${a.role}）`
      if (a.agentId === state.agentId) o.selected = true
      sel.appendChild(o)
    }
  }
  // ★ 成员选择不能只有 <option> 纯文本：<option> 装不下图形，手机上的成员列表
  //   会与桌面的「人形头像 + 名字」不是同一个东西——那等于「人性化头像」在手机上没做。
  //   这里补一条头像药丸条：每个成员一个内联 SVG 人形 + 名字，点选即切换；
  //   原生 select 仍保留做无障碍/兜底。
  const chips = $('agent-chips')
  if (chips !== null) {
    chips.replaceChildren()
    chips.classList.toggle('hidden', state.agents.length === 0)
    for (const a of state.agents) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = a.agentId === state.agentId ? 'agent-chip selected' : 'agent-chip'
      chip.title = `${a.name}（${a.role}）`
      chip.innerHTML = renderAvatar(a.avatar, 22)
      chip.appendChild(document.createTextNode(a.name))
      chip.addEventListener('click', () => { void selectAgent(a.agentId) })
      chips.appendChild(chip)
    }
  }
  // 聊天风格里要一眼看到**在跟谁说话**（web 的 .chat-head 就是干这个的）。
  const head = $('agent-picker')
  const cur = state.agents.find((a) => a.agentId === state.agentId) ?? null
  if (cur === null) {
    head.textContent = state.agents.length === 0 ? '这个空间还没有 Agent' : ''
    head.className = 'hint'
  } else {
    head.className = 'viewtitle'
    const avatar = document.createElement('span')
    avatar.className = 'agent-picker-avatar'
    avatar.innerHTML = renderAvatar(cur.avatar, 24)
    head.replaceChildren(avatar, document.createTextNode(`${cur.name}　`))
    const r = document.createElement('span')
    r.className = 'tag'
    r.textContent = cur.role
    head.appendChild(r)
  }

  const tsel = $('task-select')
  tsel.replaceChildren()
  const active = state.tasks.filter((t) => !['done', 'canceled'].includes(String(t.status)))
  for (const t of active) {
    const o = document.createElement('option')
    o.value = t.id
    o.textContent = `${t.id} ${t.title ?? ''}`.slice(0, 40)
    if (t.id === state.targetTaskId) o.selected = true
    tsel.appendChild(o)
  }
  // 「追加要求」必须选一条任务；没有活动任务时把这一条意图**关掉**而不是
  // 让它发出去被服务端拒——一个按下去必然失败的按钮是最坏的一种。
  const feedbackBtn = $('intents').querySelector('[data-intent="feedback"]')
  if (feedbackBtn !== null) {
    const usable = active.length > 0
    feedbackBtn.disabled = !usable
    feedbackBtn.title = usable ? '' : '当前没有可追加要求的活动任务'
  }
  if (state.targetTaskId === null && active.length > 0) state.targetTaskId = active[0].id
}

/** 意图 chip：点一下切换，并把后果写在下面一行。 */
function renderIntents() {
  const box = $('intents')
  box.replaceChildren()
  for (const o of INTENT_OPTIONS) {
    const b = document.createElement('button')
    b.textContent = o.label
    b.dataset.intent = o.id
    b.setAttribute('aria-pressed', String(state.intent === o.id))
    b.addEventListener('click', () => focusComposer(o.id))
    box.appendChild(b)
  }
  const cur = intentOf(state.intent) ?? INTENT_OPTIONS[0]
  $('intent-hint').textContent = cur.hint
  const needsTask = cur.needsTask === true
  $('task-select').classList.toggle('hidden', !needsTask)
  // 意图决定"这句话会不会变成任务"，所以它必须影响占位符——用户不该靠
  // 记住 chip 的位置来判断自己正在做什么。
  $('composer-input').placeholder = cur.id === 'create_task'
    ? '描述要做的事，电脑上线后会领取执行…'
    : cur.id === 'feedback' ? '给这条任务补充要求（下一轮执行时生效）…' : '问状态、要解释…'
}

function focusComposer(intent) {
  state.intent = intent
  renderIntents()
  renderTargets()
  $('composer-input').focus()
}

function chooseTaskForFeedback(taskId) {
  state.targetTaskId = taskId
  const tsel = $('task-select')
  for (const o of tsel.options) o.selected = o.value === taskId
}

// ── 视图切换 ────────────────────────────────────────────────────────────────

/**
 * 两个视图：**Agent** 与 **任务**。
 *
 * 手机端此前有三个（看板 / 对话 / 我的）。砍掉「我的」不是因为它没用，
 * 而是因为用户对手机端的定义很清楚：**看着我的人干活**。
 * 账号管理（改口令 / 设备 / 邀请码）在桌面端与网页端都有更合适的落点，
 * 放在手机上只会让主路径多一个岔口。
 */
function showView(view) {
  state.view = view
  $('view-chat').classList.toggle('hidden', view !== 'chat')
  $('view-tasks').classList.toggle('hidden', view !== 'tasks')
  $('tab-chat').setAttribute('aria-selected', String(view === 'chat'))
  $('tab-tasks').setAttribute('aria-selected', String(view === 'tasks'))
  if (view === 'tasks') void refreshTasks()
}

async function refreshStatus() {
  try {
    const s = await api('/api/identity/status', { auth: false })
    state.identity = {
      bootstrapped: s.bootstrapped === true,
      // 老 Hub 没有这个字段时按 `closed` 处理：**不要**因为字段缺失就把
      // 注册入口显示出来——那会在一个不支持注册的服务端上给用户一个死按钮。
      registration: typeof s.registration === 'string' ? s.registration : 'closed',
    }
    if (s.bootstrapped === false) $('bootstrap-hint').hidden = false
    renderAuth()
    return true
  } catch {
    // **不吞**：返回值决定界面说"Hub 不可达"还是"未登录"。
    // 原来这里 `catch { /* 登录页自己会报 */ }` 把结果丢了，于是 main() 在末尾
    // 一律报"Hub 不可达"——即使刚刚这条请求是成功的。
    // 用户看到"服务器挂了"会去重启服务器，而其实只需要登录。
    return false
  }
}

/**
 * 登录页：显示"登录"还是"注册+登录"。
 *
 * 判据是**服务端说它支持什么**，不是前端猜。`closed` 时注册入口整个不出现——
 * 一个点下去会被 403 的按钮，比没有这个按钮更坏。
 */
function renderAuth() {
  const canRegister = state.identity.registration === 'open' || state.identity.registration === 'invite'
  const registerBtn = $('btn-register')
  registerBtn.classList.toggle('hidden', !canRegister)
  const registering = state.authMode === 'register'
  $('auth-title').textContent = registering ? '注册 Legion' : '登录 Legion'
  $('btn-login').textContent = registering ? '注册并登录' : '登录'
  registerBtn.textContent = registering ? '已有账号，去登录' : '注册新账号'
  $('password-hint').classList.toggle('hidden', !registering)
  $('register-invite-row').classList.toggle('hidden', !(registering && state.identity.registration === 'invite'))
  $('auth-hint').textContent = registering
    ? (state.identity.registration === 'invite' ? '这台 Hub 需要邀请码。' : '填一个用户名与口令即可开始。')
    : '用你的 Legion 账号登录。Hub 地址默认取当前站点。'
  $('auth-switch').textContent = canRegister ? '' : ''
}

async function selectAgent(agentId) {
  if (agentId === state.agentId) return
  state.agentId = agentId
  localStorage.setItem(LS_AGENT, agentId)
  state.timeline = []
  state.cursor = null
  renderTargets()
  await openConversation()
}

async function openConversation() {
  // ★ 守卫不只是 `agentId !== null`，还要问"它属于**当前**这个空间吗"。
  //
  // 实测踩过：localStorage 里存着上一个空间的 agentId，而当前空间（比如一个
  // 刚建好、还没编队的）一个 Agent 都没有。那时 `refreshTasks` 的"修正 agentId"
  // 那一步因为 `state.agents.length > 0` 的前提不成立而跳过，于是这里带着一个
  // **别的空间的** id 去开会话——服务端正确地回「该空间不存在此 Agent」，
  // 而界面只留下一行 console.warn，用户看到的是"聊天坏了"。
  //
  //   > 一个"带着上一个空间的 id 去请求"的界面，
  //   > 与一个"这个空间还没有 Agent"的界面，在用户那边都表现为"空的"——
  //   > 只不过前者在控制台里有一行没人看的警告。
  if (state.agentId === null) return
  if (!state.agents.some((a) => a.agentId === state.agentId)) return
  const c = await api('/api/agent-conversations', { method: 'POST', body: { agentId: state.agentId, scope: state.scope, by: 'mobile' } })
  state.convId = c.convId
  await refreshTimeline()
  void connectStream()
}

async function refreshTimeline() {
  if (state.convId === null) return
  const gen = state.scopeGen
  const conv = state.convId
  // 读当前投影（**不是**从事件流拼出来）：事件只是通知，真相在 Hub。
  const r = await api(`/api/chat/messages?conv=${conv}&scope=${encodeURIComponent(state.scope)}&limit=200`)
  // 同上：切了空间或换了会话，这批消息就不该往界面上写。
  if (gen !== state.scopeGen || conv !== state.convId) return
  const entries = (r.messages ?? []).map(timelineEntry)
  const merged = mergeTimeline(state.timeline, entries)
  state.timeline = merged.entries
  state.cursor = merged.cursor
  renderTimeline()
}

/**
 * 看板刷新：**两个端点**各取一半。
 *
 * `/api/board` 给空间里所有任务（含别的岗位的），`/api/agent-detail` 给当前
 * Agent 的 Attempt。只用前者会看不见"执行到哪一步"，只用后者会看不见别的岗位
 * 的任务——而"这个空间里有什么事"正是看板要回答的那个问题。
 */
async function refreshTasks() {
  if (state.scope === null) return
  const gen = state.scopeGen
  // ★ 用 `/api/agents?scope=` 一次拿全**这个空间里每个 Agent 的 tasks**，
  //   而不是只问当前那一个（`/api/agent-detail`）。
  //
  //   为什么：`/api/board` 给的是空间里**所有**任务，但它不带 Attempt；
  //   只补当前 Agent 的话，**别的岗位的任务在手机上看不出「等电脑领取」还是
  //   「正在执行」**——而那正是最要紧的那条口径（把人送去做错决定的那种）。
  //   `service.list()` 走的 `detail()` 里本来就带 `attempt`，所以覆盖全部 Agent
  //   与覆盖一个 Agent 花的是**同样一次**请求。
  //
  // ★ `compact=1`（2026-10-10 实测后加的）：完整看板响应 4071.6KB，其中 `patches` 占 3498KB
  //   （每个任务存着完整 git diff），而手机这张看板只读 id/title/status/role/soldier/priority。
  //   不过隧道时那是"45 秒 / 直接超时"，加了 compact 之后是三百多 KB。
  //   > 一个"把 git diff 也发给手机"的接口，与一个"看板要 45 秒才出来"，是同一件事的两面。
  const board = await api(`/api/board?scope=${encodeURIComponent(state.scope)}&compact=1`)
  const agents = await api(`/api/agents?scope=${encodeURIComponent(state.scope)}`)
  // ★ 空间在这一段里被切走了 → 这批数据已经不属于当前界面，丢掉。
  if (gen !== state.scopeGen) return
  state.agents = agents.agents ?? []
  if (state.agents.length > 0 && !state.agents.some((a) => a.agentId === state.agentId)) {
    state.agentId = state.agents[0].agentId
    localStorage.setItem(LS_AGENT, state.agentId)
  }
  const detail = state.agents.flatMap((a) => a.tasks ?? [])
  state.tasks = mergeAttempts(Array.isArray(board) ? board : (board.tasks ?? []), detail)
  renderBoardViews()
  renderBoard()
  renderTargets()
  const badge = attentionCount(state.tasks)
  const tab = $('tab-tasks')
  const old = tab.querySelector('.badge')
  if (old !== null) old.remove()
  if (badge > 0) {
    const b = document.createElement('span')
    b.className = 'badge'
    b.textContent = String(badge)
    tab.appendChild(b)
  }

  const presence = await api('/api/devices/presence').catch(() => ({ presence: [] }))
  const anyOnline = (presence.presence ?? []).some((p) => p.online === true)
  const active = state.tasks.find((t) => !['done', 'canceled'].includes(String(t.status)))
  setConnection({
    hubReachable: true,
    // 没有设备时是"未知"而不是"离线"：`presence` 里没有行不代表电脑关了，
    // 也可能只是它还没配过对。
    nodeOnline: (presence.presence ?? []).length === 0 ? null : anyOnline,
    activeTaskState: active?.attempt?.state ?? null,
  })
}

/**
 * 空间切换。
 *
 * 判据是 `/api/identity/me` 给的 `roles`——**用户在哪些空间里有角色**。
 * 此前 `LS_SCOPE` 只在进入应用时设过一次，于是多空间用户在手机上只能用第一个
 * 空间，而这一点在界面上**没有任何痕迹**：他看到的看板是对的，只是不是他想看的
 * 那一个。
 *
 * 只有一个空间时渲染成一句纯文字（不给一个只有一个选项的下拉框——
 * 那会让人以为别处还有得选）。
 */
async function refreshSpaces() {
  const info = await api('/api/identity/me').catch(() => null)
  const roles = info?.roles ?? []
  if (roles.length === 0) {
    $('board-scope').textContent = '还没有加入任何空间'
    return
  }
  const spaces = roles.map((r) => ({ id: r.space, role: r.role }))
  if (state.scope === null || !spaces.some((s) => s.id === state.scope)) {
    state.scope = spaces[0].id
    localStorage.setItem(LS_SCOPE, state.scope)
  }
  const host = $('board-scope')
  if (spaces.length === 1) {
    host.replaceChildren(document.createTextNode(`空间：${spaces[0].id}（${spaces[0].role}）`))
    return
  }
  const sel = document.createElement('select')
  for (const s of spaces) {
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = `${s.id}（${s.role}）`
    if (s.id === state.scope) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => { void switchScope(sel.value) })
  host.replaceChildren(document.createTextNode('空间：'), sel)
}

/** 换空间要**重置一切与它绑定的东西**：Agent、会话、时间线、游标、事件流。 */
async function switchScope(scope) {
  // 先加代际：此后所有**已经在飞**的刷新写回时都会被丢掉。见 `state.scopeGen`。
  state.scopeGen += 1
  state.scope = scope
  localStorage.setItem(LS_SCOPE, scope)
  state.agentId = null
  state.convId = null
  state.timeline = []
  state.cursor = null
  state.tasks = []
  state.targetTaskId = null
  // ★ 换空间换一把弹框游标：否则新空间的第一批历史会被当成"刚发生的"弹出来。
  state.popupSeq = readPopupSeq(scope)
  // 上一个空间的提醒不该留在屏幕上（它属于另一个空间的任务）。
  const host = $('popup-host')
  host.replaceChildren()
  host.classList.add('hidden')
  stopStream()
  $('board-views').replaceChildren()
  $('task-groups').replaceChildren()
  await refreshSpaces()
  await refreshTasks()               // 它会顺带刷新 state.agents
  await openConversation()
}

// ── 发送 ────────────────────────────────────────────────────────────────────

async function send(text, intentOverride = null) {
  const intent = intentOverride ?? state.intent
  let plan
  try {
    plan = planSend({
      intent,
      body: text,
      // 「追加要求」的目标：下拉框是权威（用户可能刚改过），state 只是初值。
      taskId: intentOf(intent)?.needsTask === true ? ($('task-select').value || state.targetTaskId) : null,
    })
  } catch (e) {
    showLoginError(e.message)
    return
  }
  if (state.convId === null) { showLoginError('还没有选中 Agent'); return }
  $('btn-send').disabled = true
  try {
    const r = await api('/api/agent-messages', {
      method: 'POST',
      body: {
        conv: state.convId, scope: state.scope, by: 'mobile', body: plan.body, intent: plan.intent.id,
        ...(plan.taskId === null ? {} : { target: { taskId: plan.taskId } }),
        // 客户端幂等键：网络重试不会重复创建消息（服务端按 scope+actor+requestId 去重）。
        clientRequestId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    })
    $('composer-input').value = ''
    await refreshTimeline()
    // 派了任务就切到看板并高亮它——"我派的活去哪了"必须在同一屏回答，
    // 否则用户只能自己猜它有没有生效。
    if (plan.intent.id === 'create_task') {
      showView('tasks')
      await refreshTasks()
      if (typeof r?.taskId === 'string') highlightTask(r.taskId)
      showNotice(`已派任务 ${r?.taskId ?? ''}：电脑上线后会领取执行。`)
    } else if (plan.intent.id === 'feedback') {
      showNotice(`要求已记到 ${plan.taskId}，下一轮执行时生效。`)
    }
  } catch (e) {
    showLoginError(e.message)
  } finally {
    $('btn-send').disabled = false
  }
}

// ── 提示的去处：登录页内联盒子 / 全局浮层 ────────────────────────────────────
//
// ★ 这一节修的是一个实测过的形状：`#login-error` 与 `#login-notice` 住在
//   `#screen-login` **里面**，而 `enterApp()` 会把登录页整体 `hidden`。
//   于是登录之后发生的每一条失败——发消息失败、500、断网、会话被撤销——
//   都写进了一个 `display:none` 的盒子：**用户一条都看不到**，
//   而界面看起来一切正常。
//
//   > 一个"把错误写进一个隐藏盒子"的界面，
//   > 与一个"什么都不报错"的界面，在用户眼里是同一个东西。
//
//   分流判据是**登录页此刻是否可见**（`notice.mjs` 的 `pickNoticeHost`）——
//   不按错误类型分流：类型分不出"用户这会儿看不看得见"。

/** 登录页此刻是否可见。**从 DOM 读**，不缓存 —— 它随时会被 `enterApp` 改掉。 */
function loginScreenVisible() {
  const el = $('screen-login')
  return el !== null && !el.classList.contains('hidden')
}

/** `#toast-host` 上那条提示的收尾定时器（新提示要顶掉旧的）。 */
let toastTimer = null
/** 当前提示的「重试」动作（`null` = 没有可重试的东西，按钮藏起来）。 */
let toastRetry = null

function hideToast() {
  if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null }
  toastRetry = null
  const host = $('toast-host')
  if (host === null) return
  host.classList.add('hidden')
  const retry = $('toast-retry')
  if (retry !== null) retry.classList.add('hidden')
}

/**
 * 全局浮层提示。`tone` 只有两档：`'error'`（红边）与 `'notice'`（绿边）。
 * 有 `retry` 时给一个「重试」按钮 —— 修复前**没有任何重试入口**：
 * 断网时点「刷新」毫无反应，用户只能猜。
 */
function toast(message, { tone = 'error', retry = null, ms = 0 } = {}) {
  const host = $('toast-host')
  if (host === null) return
  $('toast-text').textContent = message
  host.classList.toggle('notice', tone === 'notice')
  host.classList.remove('hidden')
  toastRetry = typeof retry === 'function' ? retry : null
  const btn = $('toast-retry')
  if (btn !== null) btn.classList.toggle('hidden', toastRetry === null)
  if (toastTimer !== null) clearTimeout(toastTimer)
  // `ms = 0` = 不自动消失：**错误要留在屏幕上等用户处理**，
  // 而"8 秒后自己消失的错误"在用户低头看别处时就是没出现过。
  toastTimer = ms > 0 ? setTimeout(hideToast, ms) : null
}

/**
 * 统一的提示出口。所有"要告诉用户一句话"的地方都走这里，
 * 于是"用户看不看得见"只由一个判据决定。
 */
function showError(message, { retry = null } = {}) {
  const host = pickNoticeHost({ loginScreenVisible: loginScreenVisible() })
  if (host === HOST_INLINE) {
    const box = $('login-error')
    box.textContent = message
    box.classList.remove('hidden')
    setTimeout(() => { box.classList.add('hidden') }, 8000)
    return
  }
  toast(message, { tone: 'error', retry })
}

/** 回执（成功类）。与错误同一套去处判据，只是语气不同。 */
function showNotice(message) {
  const host = pickNoticeHost({ loginScreenVisible: loginScreenVisible() })
  if (host === HOST_INLINE) {
    const box = $('login-notice')
    box.textContent = message
    box.classList.remove('hidden')
    setTimeout(() => { box.classList.add('hidden') }, 6000)
    return
  }
  toast(message, { tone: 'notice', ms: 6000 })
}

// ── 提醒弹框（BUG-021 的手机一半）──────────────────────────────────────────
//
// ## 为什么手机端比电脑端更需要它
//
// 电脑端至少有侧栏徽标在视线里；手机端用户多半**不在看这个页面**——
// 他把手机放在兜里或桌上，而"任务停下来等你验收"这件事，只有主动来点开才看得见。
//
//   > 一个"任务页签上有个小红点"的手机端，
//   > 与一个"到点了会在你手机上弹一条"的手机端，
//   > 在用户把手机放下的那段时间里，是两个东西。
//
// ## 判据在哪
//
// 弹什么/不弹什么、文案怎么写、游标怎么走，全在 `popup.mjs`（纯函数，有判据，
// 并且与桌面端有一对一的对等判据）。这里只做三件事：取数、渲染、推进游标。

/** 角色 → 中文名（编队里带 `name`；不认得就退回 role 原文，**不猜**）。 */
function whoFor(member) {
  const role = String(member ?? '')
  if (role.length === 0) return null
  const hit = state.agents.find((a) => a.role === role)
  return hit !== undefined && typeof hit.name === 'string' && hit.name.length > 0 ? hit.name : role
}

/**
 * 弹一条纯文本提醒（也用于"已开启系统提醒"这类回执）。
 *
 * ★ 不用 `notice()`：那个写的是 `#login-notice`，它活在**登录页**里——
 *   登录之后整屏都隐藏了，于是"已开启系统提醒"这句确认会写进一个没人看得见的地方。
 *   一个"点了按钮什么都没发生"的按钮，用户会以为它坏了。
 */
function showPopupText(text, onClick = null) {
  const host = $('popup-host')
  if (host === null) return
  const card = document.createElement('button')
  card.className = 'popup'
  if (onClick === null) card.classList.add('plain')
  card.textContent = text
  if (onClick !== null) card.addEventListener('click', () => { card.remove(); if (host.children.length === 0) host.classList.add('hidden'); onClick() })
  host.prepend(card)
  host.classList.remove('hidden')
  setTimeout(() => {
    card.remove()
    if (host.children.length === 0) host.classList.add('hidden')
  }, POPUP_TTL_MS)
}

/** 弹一条任务提醒：可点（去任务详情），到时自己走。`reason` 可选（"为什么停在这"）。 */
function showPopup(p, reason = null) {
  const tid = validTaskId(p.row?.taskId)
  const base = popupText(p.row, whoFor(p.row?.member))
  const text = reason === null ? base : `${base} —— ${reason}`
  // 点一下就去处理它 —— 一条叫你过来的消息如果点不动，
  // 你还得自己翻到任务页找那一条，那正是这条提醒本想省掉的一步。
  showPopupText(text, tid !== null ? () => { void openTask(tid) } : () => showView('tasks'))
  return text
}

/**
 * 取"**为什么停在这**"（最多 POPUP_LIMIT 次请求；弹框本来就少）。
 *
 * 实测起因：T-199 弹出来只说「待你验收」，而它真实原因是
 * 「自动合入失败，等待人工处理」—— 一个是点验收，一个是解冲突，动作完全不同。
 */
async function reasonForPopupRow(row) {
  const tid = validTaskId(row?.taskId)
  if (tid === null) return null
  try {
    return reasonFromTask(await api(`/api/task?id=${encodeURIComponent(tid)}`))
  } catch {
    return null
  }
}

/**
 * 取一批审计事件、挑出该弹的、推进游标。
 *
 * ★ 数据源与桌面端**同一个**（`/api/activity`，audit 派生）：
 *   SSE 帧只当"有动静"的信号（见 connectStream），真正的判断都走这一条，
 *   这样"弹框"和"看板/时间线"读到的是同一份事实，不会出现
 *   "弹了但看板上没有它"这种自相矛盾的界面。
 *
 * ★ BUG-022：从前这里 `if (state.scope === null) return`。**"还没解析出空间"**
 *   与"我不想被提醒"是两件事——桌面端同一个空档就是将军"没看到弹框"的原因之一。
 */
async function refreshPopups() {
  const gen = state.scopeGen
  const qs = state.scope === null
    ? 'limit=200'
    : `scope=${encodeURIComponent(state.scope)}&limit=200`
  const rows = await api(`/api/activity?${qs}`).catch(() => null)
  if (rows === null || gen !== state.scopeGen) return
  const list = Array.isArray(rows) ? rows : (rows.events ?? [])
  const wasFresh = state.popupSeq <= 0
  const { popups, lastSeq } = popupBatch(list, state.popupSeq, POPUP_LIMIT, {
    nowMs: Date.now(),
    replayWindowMs: POPUP_REPLAY_MS,
  })
  if (lastSeq !== state.popupSeq) {
    state.popupSeq = lastSeq
    writePopupSeq(state.scope, lastSeq)
  }
  if (wasFresh && popups.length === 0 && !popupArmedShown()) {
    // 首次接入且当下无事可提醒：说一句它已经武装好了。
    // 否则用户分不清"它没在工作"与"确实没事" —— 那正是这次投诉的根源。
    markPopupArmed()
    showPopupText('🔔 提醒已就绪：有任务等你处理时会弹在这里')
  }
  for (const p of popups) {
    const reason = await reasonForPopupRow(p.row)
    if (gen !== state.scopeGen) return
    // 页面不在前台时，页面里的弹框**看不见** —— 那是系统通知唯一能补的位。
    // （边界：这只在页面还活着时有效；页面被彻底关掉要靠 Web Push，本次没做。）
    void notifySystem(p.row?.taskId ?? null, showPopup(p, reason))
  }
}

// ── 系统通知（页面不在前台时的那一半）──────────────────────────────────────
//
// 决策函数在 `popup.mjs`（纯模块，能被判据钉住；app.mjs 顶层读浏览器存储，
// 在 Node 里 import 会抛，所以不可测的东西不放这里）。这里只做副作用。

function systemNotifySupported() {
  return typeof Notification !== 'undefined'
}

function systemNotifyPermission() {
  return systemNotifySupported() ? Notification.permission : 'unsupported'
}

/** 授权只能在**用户手势**里请求；绝不自动请求（自动弹授权框会被拒，拒一次就回不来）。 */
async function requestSystemNotifyPermission() {
  if (!systemNotifySupported()) return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return systemNotifyPermission()
  }
}

/**
 * 发一条系统提醒。
 *
 * ★ 机制由 `notify-plan.mjs` 的 `notifyMechanism` 决定，**优先 Service Worker**：
 *   Android Chrome 上 `new Notification()` 会抛 `Illegal constructor`，
 *   iOS 16.4+ 的 Web Push 同样只能走 SW 通知 —— 移动端**只有这一条路**。
 *   修复前只用了构造器，而异常被 `catch` 吞掉：界面写着「🔔 已开启系统提醒」，
 *   实际上一条也收不到。
 *
 *   > 一个"点了开启、得到确认、然后一条也收不到"的功能，
 *   > 与一个"还没做"的功能，在用户眼里是同一个东西。
 *
 * ★ 失败**必须有出口**：修复前是 `catch { return false }`，之后没有任何人管它。
 *
 * @param {string|null} taskId 去重标签的依据（**任务号**，不是文案）
 * @param {string} body
 * @returns {Promise<boolean>} 是否真的发出去了
 */
async function notifySystem(taskId, body) {
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  if (!shouldUseSystemNotify({ hidden, permission: systemNotifyPermission() })) return false

  const supported = typeof Notification !== 'undefined'
  const registration = await readyServiceWorker()
  const mechanism = notifyMechanism({ swReady: registration !== null, supported })
  if (mechanism === 'none') return false

  const tag = notificationTag(taskId, body)
  const title = 'Legion 指挥台'
  try {
    if (mechanism === 'service-worker') {
      await registration.showNotification(title, { body, tag, data: { taskId: taskId ?? null } })
      return true
    }
    const n = new Notification(title, { body, tag })
    n.onclick = () => { try { window.focus() } catch { /* 某些壳里不允许 */ } n.close() }
    return true
  } catch (e) {
    // ★ 不静默：这一条以前是 `return false`，于是"发不出去"与"没开启"在界面上
    //   完全一样。现在说出来，并说明页面内的提醒不受影响。
    showError(`系统提醒发送失败：${e?.message ?? e}（页面内的提醒照常出现）`)
    return false
  }
}

/**
 * `navigator.serviceWorker.ready`，但**不无限等**：SW 还没接管时那条 promise
 * 会一直挂着，而调用方要的是"现在能不能用 SW 发"。超时就当没有 ——
 * 退回构造器（桌面端仍然能发），而不是让提醒静默消失。
 */
async function readyServiceWorker(timeoutMs = 1500) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
  try {
    const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), timeoutMs) })
    const reg = await Promise.race([navigator.serviceWorker.ready, timeout])
    return reg !== null && typeof reg?.showNotification === 'function' ? reg : null
  } catch {
    return null
  }
}

/**
 * 头部那个「🔔」按钮：**始终可见**，按状态给一句能照着做的话。
 *
 * ★ 修复前的判据是 `!(supported && permission === 'default')` —— 只有"支持且还没问过"
 *   才出现。于是用户点了「不允许」→ 按钮**消失**、没有解释、也再没有入口改回来。
 *
 *   > 一个"被拒绝之后就消失"的授权入口，
 *   > 与一个"从来没提供过"的功能，在用户眼里是同一个东西。
 */
function renderNotifyButton() {
  const btn = $('btn-notify')
  if (btn === null) return
  // ★ 只在主界面出现：登录页上它能做的最多是"为还没登录的状态开启提醒"，
  //   而提醒只在登录后才会响 —— 那是一组看得见、点不出效果的控件。
  //   （`body:not([data-screen=app])` 那几条 CSS 管着页签/刷新/退出；
  //     这一个归脚本管，所以两处都要认 `chromeVisible` 这同一个判据。）
  if (!chromeVisible(currentScreen())) { btn.classList.add('hidden'); return }
  const plan = notifyButtonPlan({
    supported: systemNotifySupported(),
    permission: systemNotifyPermission(),
    // iOS 上"已加到主屏幕"与"还在浏览器标签里"是两种能力，文案要分开说。
    standalone: typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)')?.matches === true
        || navigator.standalone === true),
  })
  btn.classList.toggle('hidden', !plan.visible)
  btn.title = plan.message
  // 不可点（已授权/被拒/不支持）时用 `aria-disabled` 而不是 `disabled`：
  // 仍然要能点开看那句话，只是不该再去请求授权。
  btn.setAttribute('aria-disabled', plan.actionable ? 'false' : 'true')
  btn.dataset.notifyActionable = plan.actionable ? '1' : '0'
}

// ── 事件流 ──────────────────────────────────────────────────────────────────

/**
 * 合并刷新。**在模块里建一次**，不是每次连流都建一个——
 * 两个 refresher 就是两套计时器与两份"在飞"记账，合并就失效了
 * （而它失效的样子是"请求数没降下来"，不是报错）。
 */
const refreshLoop = createRefresher({
  run: async () => {
    await refreshTimeline()
    await refreshTasks()
    // ★ 弹框挂在同一个合并刷新里，不单开计时器：
    //   一条任务在跑时进展事件连着来，单开一个"每次事件都取一次审计"的路径
    //   会把手机流量和电量都吃掉（而它换来的只是把同一条提醒弹三遍）。
    await refreshPopups()
  },
})

/**
 * 订阅进展流。
 *
 * ## 为什么不再把令牌放在查询串里
 *
 * `EventSource` 不能自定义请求头，所以这条路原来把**访问令牌**塞在 URL 里。
 * 而查询串会进反代的访问日志、浏览器历史、Referer——那里放一枚 15 分钟、
 * 覆盖全部 API 的令牌，等于把主钥匙抄在门口。
 *
 *   > 一个"把主令牌写在 URL 里"的订阅，与一个"没有鉴权"的订阅，
 *   > 在日志被读走那天是同一个东西——只不过前者在代码里看起来是"已经鉴权了"。
 *
 * 换成**一次性票据**（`?ticket=`）：只用一次、只活 60 秒、只对订阅有效。
 *
 * ## 因此重连要自己接管
 *
 * 票据是一次性的，而 `EventSource` 自带的重连会原样重发那个 URL——自带重连
 * 在这里**必然失败**，而且失败得很安静（界面停在"正在重连"，服务端一串 401）。
 * 所以 `onerror` 里先 `close()` 掐掉自带重连，自己退避后重连并**新签一张**。
 */
let streamClosed = false
let streamRetry = 0
let streamTimer = null

async function mintTicket() {
  const r = await api('/api/events/ticket', { method: 'POST', body: {} })
  return typeof r?.ticket === 'string' ? r.ticket : null
}

function scheduleReconnect() {
  if (streamClosed || streamTimer !== null) return
  // 指数退避、封顶 30 秒：一个连不上的订阅不该变成每秒一次的锤击。
  const delay = Math.min(30000, 1000 * 2 ** Math.min(streamRetry, 5))
  streamRetry += 1
  streamTimer = setTimeout(() => { streamTimer = null; void connectStream() }, delay)
}

async function connectStream() {
  if (state.sse !== null) { try { state.sse.close() } catch { /* 已关 */ } state.sse = null }
  streamClosed = false
  let ticket = null
  try { ticket = await mintTicket() } catch { /* 签不出来：按"连不上"处理，退避后重试 */ }
  if (streamClosed) return
  const params = new URLSearchParams({ scope: state.scope, kind: 'mobile' })
  if (state.cursor !== null) params.set('sinceSeq', String(state.cursor))
  // 参数名是 `ticket`，**不是** `token`：两者是不同的东西，
  // 共用一个名字会让人在 URL 上分不出"这一串是哪一种"。
  if (ticket !== null) params.set('ticket', ticket)
  const es = new EventSource(`${hubBase()}/api/events?${params}`)
  state.sse = es
  es.onopen = () => { streamRetry = 0 }
  es.onmessage = () => {
    // ★ 事件帧只当通知：内容一律回 Hub 读。这样"事件丢了"最多是晚一会儿看到，
    //   而不是界面上一段缺失。
    //
    // 但**不能每一帧都去读一遍**：一帧 = 5 个请求（时间线 1 + 看板 3 + 审计 1），
    // 而一条任务在跑时进展事件是连着来的。交给 `refreshLoop` 合并成
    // 静默期内一次，并保证**结尾那一次一定跑**。见 `refresh-loop.mjs`。
    //
    // ★ 提醒弹框（BUG-021）骑在同一次合并刷新里，所以它**不额外开一条取数路径**：
    //   否则一帧一次审计请求，换来的只是把同一条提醒弹三遍。
    refreshLoop.request()
  }
  es.onerror = () => {
    // 先掐掉自带重连（它会拿同一张已作废的票据重试），再自己排一次。
    try { es.close() } catch { /* 已关 */ }
    if (state.sse === es) state.sse = null
    setConnection({ hubReachable: false })
    scheduleReconnect()
  }
}

/** 停止订阅（登出、切空间时用）。不排重连。 */
function stopStream() {
  streamClosed = true
  if (streamTimer !== null) { clearTimeout(streamTimer); streamTimer = null }
  if (state.sse !== null) { try { state.sse.close() } catch { /* 已关 */ } state.sse = null }
}

// ── 登录 / 注册 ─────────────────────────────────────────────────────────────

function showLoginError(message) {
  // ★ 名字保留（登录页那几处调用点读起来仍然通顺），但**去处已经不由它决定**：
  //   走 `showError` 的统一判据。修复前它无条件写 `#login-error`，
  //   而登录后那个盒子是 `display:none` 的 —— 见本文件顶部「提示的去处」那一节。
  showError(message)
}

async function postIdentity(path, body) {
  const r = await fetch(hubBase() + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || j?.ok !== true) {
    const err = new Error(j?.error ?? `请求失败（HTTP ${r.status}）`)
    err.code = j?.code ?? null
    throw err
  }
  return j
}

async function doLogin() {
  const name = $('login-name').value.trim()
  const password = $('login-password').value
  const registering = state.authMode === 'register'
  if (name.length === 0 || password.length === 0) { showLoginError('请填写用户名与口令'); return }
  $('btn-login').disabled = true
  try {
    const j = registering
      // 服务端把"注册并登录"做成**一个**事务性动作：建用户与发会话要么都成、
      // 要么都不成。分成两步的版本会在中间失败时留下一个"注册成功但登不进"的账号。
      ? await postIdentity('/api/identity/register', {
        name, password,
        // 空间**只在已经知道一个**时才带上：服务端在只有一个空间时会自己解析，
        // 多个空间时会具名拒绝并让人说清是哪一个。硬编码 'default' 的版本在
        // 一个不叫 default 的 Hub 上必然失败，而失败信息只有"空间不存在"。
        ...(state.scope === null ? {} : { space: state.scope }),
        code: $('register-invite').value.trim() || undefined,
        label: `手机 ${navigator.platform ?? ''}`.trim(),
      })
      : await postIdentity('/api/identity/login', { name, password, label: `手机 ${navigator.platform ?? ''}`.trim() })
    state.access = j.accessToken
    state.refresh = j.refreshToken
    sessionStorage.setItem(SS_ACCESS, state.access)
    localStorage.setItem(LS_REFRESH, state.refresh)
    await enterApp(j)
  } catch (e) {
    showLoginError(e.message)
  } finally {
    $('btn-login').disabled = false
  }
}

/**
 * 切到某一块屏。**唯一的**入口 —— 三块的可见性只由 `body[data-screen]` 决定。
 *
 * ★ 修复前这里是两处各自 `classList.add/remove('hidden')`（`showLoginScreen` 与
 *   `enterApp` 各一份，一共六次操作）。那种写法的问题不是啰嗦，是**漏一次就错**：
 *   少 remove 一块会同时显示两块，少 add 一块会一块都不显示，而两者在截图上
 *   都是"页面坏了"。现在只有这一个写入点。
 */
function setScreen(screen) {
  if (!isScreen(screen)) {
    // 写错值 ⇒ 三条 CSS 规则全不匹配 ⇒ 三块都不显示。当场炸比白屏好查。
    throw new TypeError(`setScreen 收到未知的屏：${JSON.stringify(screen)}`)
  }
  document.body.dataset.screen = screen
  // 头部那几个动作的可见性跟着屏走。页签/刷新/退出由 CSS 按 `data-screen` 收
  // （见 index.html），而「🔔」是**脚本**控制的，所以这里要重画一次 ——
  // 否则登录页上会挂着一个点不出任何效果的提醒按钮。
  renderNotifyButton()
}

/** 当前是哪一块屏（读 `data-screen`，不另存一份状态）。 */
function currentScreen() {
  return document.body.dataset.screen ?? null
}

/**
 * 切回登录屏（`enterApp` 的逆向）。
 *
 * ★ 为什么需要它：会话在**使用中途**失效时（刷新令牌过期、被管理员撤销、
 *   换了设备），修复前界面**停在原地**，之后每个请求都静默 401 ——
 *   用户看到的是一个"点什么都像卡住"的应用，而该做的事是重新登录。
 *   把登录屏切回来，本身就是最清楚的一句提示。
 */
function showLoginScreen() {
  setScreen('login')
  $('title').textContent = 'Legion'
  // 浮层要收掉：它可能压着登录表单，而登录表单此刻才是用户该看的东西。
  hideToast()
}

async function enterApp(me) {
  // ★ 这里**不**先落主界面：那六个串行请求（空间→任务→提醒→会话→消息）跑完之前
  //   内容区是空的，修复前就是"先亮主区、再 await"，弱网下看起来像卡死。
  //   留在启动屏（它有骨架）直到有东西可显示 —— 顺序是刻意的。
  $('title').textContent = `Legion · ${me.name ?? ''}`
  // 空间：**由 refreshSpaces 统一解析**（它读 /api/identity/me 的 roles，
  // 并在多于一个时渲染成可切换的下拉框）。原来在这里自己算一次，
  // 于是"能换空间"这件事没有任何落点。
  setConnection({ hubReachable: true, nodeOnline: null })
  renderIntents()
  renderNotifyButton()
  try {
    await refreshSpaces()
    // 空间定下来之后才知道该读哪一把弹框游标（游标是 per scope 的）。
    state.popupSeq = readPopupSeq(state.scope)
    await refreshTasks()
    // ★ 提醒要**立刻**跑一次，不能等下一次刷新循环：
    //   首次接入这个提醒的人（或刚换了手机）最需要马上知道"现在有谁在等我"——
    //   而那一刻恰恰是"什么都还没发生、SSE 也不会来帧"的时候。
    await refreshPopups()
    await openConversation()
  } catch (e) {
    // 空间没有 Agent 不是致命错误：界面照常显示，让用户去任务页看。
    console.warn('初始化失败', e)
  } finally {
    // ★ 无论成功失败都**必须**落主界面。停在启动骨架上一个错误都没有，
    //   比落进去少几块内容糟得多 —— 前者是"页面坏了"，后者只是"还没加载完"。
    //   用 `finally` 而不是在末尾写一行：末尾那行会被将来任何一处 `return` 跳过。
    setScreen('app')
  }
  // 登录后落在 **Agent**（聊天）——那是这个产品的主功能；
  // 「任务」是查账的地方，不是入口。
  showView('chat')
}

function doLogout() {
  void api('/api/identity/logout', { method: 'POST', body: {} }).catch(() => { })
  clearSession()
  stopStream()
  location.reload()
}

// ── 启动 ────────────────────────────────────────────────────────────────────

function bind() {
  $('btn-login').addEventListener('click', () => { void doLogin() })
  // 全局浮层的两个动作。修复前这个浮层不存在，于是"重试"这个动作无处可放 ——
  // 断网时点「刷新」毫无反应，用户只能自己猜该干什么。
  $('toast-close').addEventListener('click', hideToast)
  $('toast-retry').addEventListener('click', () => {
    const action = toastRetry
    hideToast()
    if (action !== null) void action()
  })
  $('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') void doLogin() })
  $('register-invite').addEventListener('keydown', (e) => { if (e.key === 'Enter') void doLogin() })
  $('btn-register').addEventListener('click', () => {
    state.authMode = state.authMode === 'register' ? 'login' : 'register'
    $('login-error').classList.add('hidden')
    renderAuth()
  })
  $('btn-logout').addEventListener('click', doLogout)
  // 系统提醒授权：请求必须在**用户手势**里发，所以只能挂在一个真实点击上。
  //
  // ★ 现在按钮**始终可见**，所以要按 `notifyButtonPlan` 的状态分流：
  //   · 已授权 / 被拒 / 不支持 → **不请求**（被拒之后再问，浏览器会立刻返回 denied，
  //     点了等于没点），改为把那句"该去哪儿改"的话说出来；
  //   · 只有"还没问过"才真去请求。
  $('btn-notify').addEventListener('click', () => {
    const plan = notifyButtonPlan({
      supported: systemNotifySupported(),
      permission: systemNotifyPermission(),
    })
    if (!plan.actionable) {
      // 用浮层而不是页面内弹框：这条按钮在头部，用户点它是想要一个**解释**，
      // 而解释必须落在他正在看的地方（页面内的提醒弹框可能被输入区挡着）。
      showNotice(plan.message)
      return
    }
    void requestSystemNotifyPermission().then((p) => {
      renderNotifyButton()
      showNotice(notifyButtonPlan({ supported: true, permission: p }).message)
    })
  })
  // 用户显式点：立刻跑，不走去抖（他在等结果，不该再等 400ms）。
  $('btn-refresh').addEventListener('click', () => { refreshLoop.now() })
  $('btn-send').addEventListener('click', () => { void send($('composer-input').value) })
  $('composer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send($('composer-input').value) }
  })
  $('composer-input').addEventListener('input', (e) => {
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`
  })
  $('tab-tasks').addEventListener('click', () => showView('tasks'))
  $('tab-chat').addEventListener('click', () => showView('chat'))
  $('agent-select').addEventListener('change', (e) => { void selectAgent(e.target.value) })
  $('task-select').addEventListener('change', (e) => { state.targetTaskId = e.target.value })
  // ★ 网络恢复时**去问**，而不是把读数重置成"未知"。
  //
  // 原来这里写的是 `setConnection({ hubReachable: true, nodeOnline: null })`,
  // 而 `nodeOnline: null` 渲染出来正是「电脑状态未知」。于是手机切一次
  // WiFi↔4G、或锁屏唤醒（都会触发 `online`），状态就变成"未知"，并且
  // **一直停在那里**——直到下一次 refreshTasks（SSE 来帧 / 手动刷新 / 切标签）
  // 才恢复。用户看到的是一个凭空出现、又迟迟不走的"未知"。
  //
  //   > 一个"网络回来了就把读数抹成未知"的处理，
  //   > 与一个"网络回来了就当电脑也掉了"的处理，在用户那边都是错的信息——
  //   > 只不过前者看起来更谨慎。
  //
  // 网络恢复意味着**现在能问了**，所以就去问：`refreshLoop.now()` 会重跑
  // refreshTasks，由它按真实 presence 定读数（在线/离线/未知）。
  // 拿不到时会落到 `.catch`，那时才该说不可达。
  window.addEventListener('online', () => { refreshLoop.now() })
  // 离线这条是**事实**：连不上 Hub 时读到的任何东西都不是最新的，如实说。
  window.addEventListener('offline', () => { setConnection({ hubReachable: false }) })
}

/**
 * 注册 Service Worker，让页面可安装为 PWA。
 *
 * 只在**安全上下文**注册：`navigator.serviceWorker` 在 http:// 下不可用
 * （localhost 除外）。这不是可以绕过的限制——PWA 的"可安装"本身就要求可信
 * HTTPS，那正是部署阶段坚持要签证书的原因。
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return
  navigator.serviceWorker.register('./sw.js').catch((e) => {
    console.warn('[mobile] Service Worker 注册失败（页面仍可用，只是不能安装为 PWA）', e)
  })
}

async function main() {
  bind()
  registerServiceWorker()
  renderIntents()
  renderNotifyButton()
  // ★ 起点是**启动屏**，不是登录屏。
  //
  //   修复前模板里 `#screen-login` 没有 `hidden`，于是已经登录的人每次打开都先
  //   看到一整张登录表单、几百毫秒后被抽走 ——
  //   > 一个"先让你以为自己被登出了、再把你放进去"的首屏，
  //   > 与一个"直接进去"的首屏，在功能上完全一样。
  setScreen('boot')
  try {
    const reachable = await refreshStatus()
    // ★ 只有"Hub **答复了**但拒绝"才算会话没了（`shouldClearSession`：看有没有
    //   数字 `status`）。修复前这里是裸 `catch { clearSession() }` ——
    //   于是**断网重开页面**就会把 localStorage 里那把 refresh 令牌删掉，
    //   逼用户重新输口令。地铁、电梯、锁屏唤醒都会命中，而那是手机上
    //   最高频的失败路径。
    //
    //   > 把"我连不上"读成"你被登出了"，代价是用户重新打一遍密码；
    //   > 而这两件事在 `catch` 里长得一模一样。
    if (state.access !== null) {
      // 已有会话：直接进（令牌可能过期，`api` 会自动刷新一次）。
      try {
        const me = await api('/api/identity/me')
        await enterApp({ name: me.user?.name })
        return
      } catch (err) {
        if (shouldClearSession(err)) clearSession()
        else setConnection({ hubReachable: false })
      }
    }
    if (state.refresh !== null && await refreshSession()) {
      try {
        const me = await api('/api/identity/me')
        await enterApp({ name: me.user?.name })
        return
      } catch (err) {
        if (shouldClearSession(err)) clearSession()
        else setConnection({ hubReachable: false })
      }
    }
    // ★ 没登录 ≠ Hub 不可达。用 `refreshStatus()` 的真实结果决定措辞——
    //   一个把"你还没登录"说成"服务器连不上"的界面，会把用户送去查网络。
    setConnection(reachable ? { hubReachable: true, signedIn: false } : { hubReachable: false })
  } finally {
    // ★ 兜底：`enterApp` 成功时已经落在 `'app'`，这里不动；任何**没落屏**的
    //   退出路径（上面两个 `return` 之外的异常、将来新加的分支）都会到这里 ——
    //   停在启动屏上一个错误都没有，比落在登录屏糟得多，因为用户不知道该做什么。
    if (currentScreen() === 'boot') setScreen(screenAfterProbe({ signedIn: false }))
  }
}

if (typeof document !== 'undefined' && document.getElementById('screen-login') !== null) {
  void main()
}

export { state, doLogin, refreshTimeline, refreshTasks, send, focusComposer, mergeTimeline, timelineEntry, taskLine, boardColumns }

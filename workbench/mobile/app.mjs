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

const $ = (id) => document.getElementById(id)
const LS_REFRESH = 'legion.mobile.refresh'
const SS_ACCESS = 'legion.mobile.access'
const LS_HUB = 'legion.mobile.hub'
const LS_SCOPE = 'legion.mobile.scope'
const LS_AGENT = 'legion.mobile.agent'

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
  view: 'board',
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
  /** 能力发现的结果。决定登录页显示"登录"还是"注册+登录"。 */
  identity: { bootstrapped: null, registration: 'closed' },
  /** `/api/identity/me` 的结果（「我的」那一页用）。 */
  account: null,
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
    // 令牌过期与"会话被撤销"是两种情形，但都值得先试一次刷新；
    // 刷新失败时会话确实没了，那时再回到登录页。
    const ok = await refreshSession()
    if (ok) return api(path, { method, body, auth, retry: false })
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
  showView('board')
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

function showView(view) {
  state.view = view
  $('view-board').classList.toggle('hidden', view !== 'board')
  $('view-chat').classList.toggle('hidden', view !== 'chat')
  $('view-account').classList.toggle('hidden', view !== 'account')
  // 输入框只在前两个视图有意义：在「我的」里让它挡着半个屏幕，
  // 用户会以为"在这儿打字也能派任务"。
  $('composer').classList.toggle('hidden', view === 'account')
  $('tab-board').setAttribute('aria-selected', String(view === 'board'))
  $('tab-chat').setAttribute('aria-selected', String(view === 'chat'))
  $('tab-account').setAttribute('aria-selected', String(view === 'account'))
  if (view === 'board') void refreshTasks()
  if (view === 'account') void refreshAccount()
}

// ── 我的（账号）──────────────────────────────────────────────────────────────
//
// 账号体系里**只有这一页能自己完成的事**，恰恰是最要紧的那两件：
// 改口令、发邀请。放到指挥台去做的版本会让"我在手机上怀疑账号被盗"
// 必须先去开电脑——而那时候用户最需要的是一个能立刻执行的按钮。

async function refreshAccount() {
  const info = await api('/api/identity/me').catch(() => null)
  if (info === null) return
  const isAdmin = info.systemRole === 'admin'
  state.account = { name: info.user?.name ?? '', isAdmin, roles: info.roles ?? [] }
  $('account-who').textContent =
    `${info.user?.name ?? ''}　${isAdmin ? '系统管理员' : '普通成员'}\n` +
    `空间：${(info.roles ?? []).map((r) => `${r.space}（${r.role}）`).join('、') || '还没有加入任何空间'}`
  $('reg-mode').textContent = state.identity.registration === 'open' ? '开放注册'
    : state.identity.registration === 'invite' ? '需要邀请码' : '仅限邀请'
  // 邀请入口只给系统管理员。对普通成员显示一个必然 403 的按钮，
  // 比不显示更坏——他会以为是自己哪里点错了。
  $('invite-group').classList.toggle('hidden', !isAdmin)
  const hubUrl = hubBase()
  $('about-hub').textContent = `Hub：${hubUrl}\n协议版本：1　注册策略：${state.identity.registration}`

  const s = await api('/api/identity/sessions').catch(() => null)
  // `current` 由**服务端**给的那一个 id 判出来，不靠"最近使用时间最晚的就是我"——
  // 那在另一台刚用过的设备上会指错人，而这一页上的每个按钮都会真踢掉一个会话。
  const currentId = s?.currentSessionId ?? null
  // 已撤销的会话不再列：它们既踢不动（撤销是幂等的）也不该继续占着屏幕。
  const list = (s?.sessions ?? []).filter((x) => x.revoked !== true)
  $('session-count').textContent = String(list.length)
  const root = $('sessions')
  root.replaceChildren()
  if (list.length === 0) {
    const p = document.createElement('div')
    p.className = 'hint'
    p.textContent = '没有可显示的会话。'
    root.appendChild(p)
    return
  }
  for (const session of list) {
    const card = document.createElement('div')
    card.className = 'task'
    const t = document.createElement('div')
    t.className = 't'
    t.textContent = session.label || '未命名设备'
    card.appendChild(t)
    const sub = document.createElement('div')
    sub.className = 's'
    sub.textContent = `登录于 ${session.createdAt ?? '—'}　最近使用 ${session.lastSeenAt ?? '—'}`
    card.appendChild(sub)
    if (session.sessionId === currentId) {
      const me = document.createElement('div')
      me.className = 'm'
      me.textContent = '这台设备（现在）'
      card.appendChild(me)
    } else {
      const acts = document.createElement('div')
      acts.className = 'acts'
      const b = document.createElement('button')
      b.textContent = '退出这台'
      b.addEventListener('click', async () => {
        b.disabled = true
        try {
          await api('/api/identity/sessions/revoke', { method: 'POST', body: { sessionId: session.sessionId } })
          await refreshAccount()
        } catch (e) { notice(`撤销失败：${e.message}`) } finally { b.disabled = false }
      })
      acts.appendChild(b)
      card.appendChild(acts)
    }
    root.appendChild(card)
  }
}

async function changePassword() {
  const current = $('pw-current').value
  const next = $('pw-new').value
  if (current.length === 0 || next.length === 0) { showLoginError('请填写当前口令与新口令'); return }
  $('btn-change-pw').disabled = true
  try {
    const r = await api('/api/identity/password', { method: 'POST', body: { currentPassword: current, newPassword: next } })
    $('pw-current').value = ''
    $('pw-new').value = ''
    // 把"别处被踢掉"说出来：用户做这件事的动机多半就是怀疑别人在用他的账号，
    // 而"改成功了"与"改成功了并且那个人已经掉线"是两句不同的话。
    notice(`口令已改。其它设备上的 ${r.revokedOtherSessions ?? 0} 个登录已退出，这台仍然有效。`)
    await refreshAccount()
  } catch (e) {
    showLoginError(e.message)
  } finally {
    $('btn-change-pw').disabled = false
  }
}

async function createInvite() {
  const space = state.scope ?? 'default'
  $('btn-invite').disabled = true
  try {
    const r = await api('/api/identity/invites', {
      method: 'POST', body: { space, role: $('invite-role').value },
    })
    $('invite-code').value = r.code ?? ''
    $('invite-out').classList.remove('hidden')
    notice(`邀请码已生成，只能用一次；对方在注册页填它即可加入「${space}」。`)
  } catch (e) {
    showLoginError(e.message)
  } finally {
    $('btn-invite').disabled = false
  }
}

// ── 数据 ────────────────────────────────────────────────────────────────────

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
  connectStream()
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
  const board = await api(`/api/board?scope=${encodeURIComponent(state.scope)}`)
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
  const tab = $('tab-board')
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
  if (state.sse !== null) { try { state.sse.close() } catch { /* 已关 */ } state.sse = null }
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
      showView('board')
      await refreshTasks()
      if (typeof r?.taskId === 'string') highlightTask(r.taskId)
      notice(`已派任务 ${r?.taskId ?? ''}：电脑上线后会领取执行。`)
    } else if (plan.intent.id === 'feedback') {
      notice(`要求已记到 ${plan.taskId}，下一轮执行时生效。`)
    }
  } catch (e) {
    showLoginError(e.message)
  } finally {
    $('btn-send').disabled = false
  }
}

function notice(message) {
  const box = $('login-notice')
  box.textContent = message
  box.classList.remove('hidden')
  setTimeout(() => { box.classList.add('hidden') }, 6000)
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
  },
})

function connectStream() {
  if (state.sse !== null) { try { state.sse.close() } catch { /* 已关 */ } }
  const params = new URLSearchParams({ scope: state.scope, kind: 'mobile' })
  if (state.cursor !== null) params.set('sinceSeq', String(state.cursor))
  // EventSource 无法自定义请求头，所以令牌走查询串（服务端的 `QUERY_TOKEN_PATHS`
  // 只对 SSE 与投递读数放开这一条）。
  params.set('token', state.access)
  const es = new EventSource(`${hubBase()}/api/events?${params}`)
  state.sse = es
  es.onmessage = () => {
    // ★ 事件帧只当通知：内容一律回 Hub 读。这样"事件丢了"最多是晚一会儿看到，
    //   而不是界面上一段缺失。
    //
    // 但**不能每一帧都去读一遍**：一帧 = 4 个请求（时间线 1 + 看板 3），
    // 而一条任务在跑时进展事件是连着来的。交给 `refreshLoop` 合并成
    // 静默期内一次，并保证**结尾那一次一定跑**。见 `refresh-loop.mjs`。
    refreshLoop.request()
  }
  es.onerror = () => {
    // EventSource 自带重连；这里只更新状态显示，不去手工重连（两套重连会互相打断）。
    setConnection({ hubReachable: false })
  }
}

// ── 登录 / 注册 ─────────────────────────────────────────────────────────────

function showLoginError(message) {
  const box = $('login-error')
  box.textContent = message
  box.classList.remove('hidden')
  setTimeout(() => { box.classList.add('hidden') }, 8000)
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

async function enterApp(me) {
  $('screen-login').classList.add('hidden')
  $('main').classList.remove('hidden')
  $('composer').classList.remove('hidden')
  $('title').textContent = `Legion · ${me.name ?? ''}`
  // 空间：**由 refreshSpaces 统一解析**（它读 /api/identity/me 的 roles，
  // 并在多于一个时渲染成可切换的下拉框）。原来在这里自己算一次，
  // 于是"能换空间"这件事没有任何落点。
  setConnection({ hubReachable: true, nodeOnline: null })
  renderIntents()
  try {
    await refreshSpaces()
    await refreshTasks()
    await openConversation()
  } catch (e) {
    // 空间没有 Agent 不是致命错误：界面照常显示，让用户去任务页看。
    console.warn('初始化失败', e)
  }
  showView('board')
}

function doLogout() {
  void api('/api/identity/logout', { method: 'POST', body: {} }).catch(() => { })
  clearSession()
  if (state.sse !== null) { try { state.sse.close() } catch { /* 已关 */ } state.sse = null }
  location.reload()
}

// ── 启动 ────────────────────────────────────────────────────────────────────

function bind() {
  $('btn-login').addEventListener('click', () => { void doLogin() })
  $('login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') void doLogin() })
  $('register-invite').addEventListener('keydown', (e) => { if (e.key === 'Enter') void doLogin() })
  $('btn-register').addEventListener('click', () => {
    state.authMode = state.authMode === 'register' ? 'login' : 'register'
    $('login-error').classList.add('hidden')
    renderAuth()
  })
  $('btn-logout').addEventListener('click', doLogout)
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
  $('tab-board').addEventListener('click', () => showView('board'))
  $('tab-chat').addEventListener('click', () => showView('chat'))
  $('tab-account').addEventListener('click', () => showView('account'))
  $('btn-change-pw').addEventListener('click', () => { void changePassword() })
  $('btn-invite').addEventListener('click', () => { void createInvite() })
  $('btn-logout-2').addEventListener('click', doLogout)
  $('agent-select').addEventListener('change', (e) => { void selectAgent(e.target.value) })
  $('task-select').addEventListener('change', (e) => { state.targetTaskId = e.target.value })
  window.addEventListener('online', () => { setConnection({ hubReachable: true, nodeOnline: null }) })
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
  const reachable = await refreshStatus()
  if (state.access !== null) {
    // 已有会话：直接进（令牌可能过期，`api` 会自动刷新一次）。
    try {
      const me = await api('/api/identity/me')
      await enterApp({ name: me.user?.name })
      return
    } catch { clearSession() }
  }
  if (state.refresh !== null && await refreshSession()) {
    try {
      const me = await api('/api/identity/me')
      await enterApp({ name: me.user?.name })
      return
    } catch { clearSession() }
  }
  // ★ 没登录 ≠ Hub 不可达。用 `refreshStatus()` 的真实结果决定措辞——
  //   一个把"你还没登录"说成"服务器连不上"的界面，会把用户送去查网络。
  setConnection(reachable ? { hubReachable: true, signedIn: false } : { hubReachable: false })
}

if (typeof document !== 'undefined' && document.getElementById('screen-login') !== null) {
  void main()
}

export { state, doLogin, refreshTimeline, refreshTasks, send, focusComposer, mergeTimeline, timelineEntry, taskLine, boardColumns }

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
// ============================================================================
import {
  TIMELINE_CODES,
  deriveConnectionState,
  mergeTimeline,
  pendingTasks,
  timelineEntry,
} from './timeline.mjs'

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
  tasks: [],
  cursor: null,
  conn: deriveConnectionState({ hubReachable: false }),
  sse: null,
  view: 'chat',
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

// ── 渲染 ────────────────────────────────────────────────────────────────────

function setConnection(input) {
  state.conn = deriveConnectionState(input)
  const el = $('status')
  el.querySelector('.dot').className = `dot ${state.conn.tone}`
  el.querySelector('.label').textContent = state.conn.label
  el.querySelector('.detail').textContent = state.conn.detail
}

function renderTimeline() {
  const root = $('timeline')
  const frag = document.createDocumentFragment()
  for (const e of state.timeline) {
    const wrap = document.createElement('div')
    wrap.className = 'msg'
    // ★ 来源写在 DOM 上（`data-source`），样式与"这条能不能打开任务"都读它。
    //   靠绘制顺序去猜来源会在补投历史条目时错位。
    wrap.dataset.source = e.source
    const meta = document.createElement('div')
    meta.className = 'meta'
    const author = document.createElement('span')
    author.textContent = e.source === 'user' ? '我' : (e.author || '系统')
    meta.appendChild(author)
    const tag = document.createElement('span')
    tag.className = `tag ${e.source === 'progress' ? 'progress' : e.source === 'command' ? 'command' : ''}`
    tag.textContent = e.source === 'user' ? '我说' : e.source === 'progress' ? '进展' : e.source === 'command' ? '系统' : '回复'
    meta.appendChild(tag)
    if (e.openableTask) {
      const a = document.createElement('a')
      a.className = 'taskref'
      a.href = `#task-${encodeURIComponent(e.taskId)}`
      a.textContent = e.taskId
      a.addEventListener('click', (ev) => { ev.preventDefault(); showView('tasks') })
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
        b.addEventListener('click', () => send(o))
        opts.appendChild(b)
      }
      wrap.appendChild(opts)
    }
    frag.appendChild(wrap)
  }
  root.replaceChildren(frag)
  if (state.timeline.length === 0) {
    const p = document.createElement('div')
    p.className = 'hint'
    p.textContent = '还没有消息。'
    root.replaceChildren(p)
  }
  $('main').scrollTop = $('main').scrollHeight
}

function renderAgents() {
  const picker = $('agent-picker')
  picker.replaceChildren()
  if (state.agents.length === 0) {
    picker.textContent = '这个空间下还没有 Agent。'
    return
  }
  const sel = document.createElement('select')
  for (const a of state.agents) {
    const o = document.createElement('option')
    o.value = a.agentId
    o.textContent = `${a.name}（${a.role}）`
    if (a.agentId === state.agentId) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', async () => {
    state.agentId = sel.value
    localStorage.setItem(LS_AGENT, state.agentId)
    state.timeline = []
    state.cursor = null
    await openConversation()
  })
  picker.appendChild(sel)
}

function renderTasks() {
  const root = $('task-groups')
  const g = pendingTasks(state.tasks)
  const sections = [
    ['需要你处理', g.awaiting, 'warn'],
    ['执行中', g.running, 'busy'],
    ['排队等待', g.queued, 'muted'],
  ]
  const frag = document.createDocumentFragment()
  let any = false
  for (const [title, list, tone] of sections) {
    if (list.length === 0) continue
    any = true
    const box = document.createElement('div')
    box.className = 'group'
    const h = document.createElement('h2')
    h.textContent = `${title}（${list.length}）`
    box.appendChild(h)
    for (const t of list) {
      const card = document.createElement('div')
      card.className = 'task'
      const name = document.createElement('div')
      name.className = 't'
      name.textContent = `${t.id} ${t.title ?? ''}`
      card.appendChild(name)
      const s = document.createElement('div')
      s.className = 's'
      // 展示"任务状态 + 本轮 Attempt 状态"两件事，并明确它们不是同一件事。
      s.textContent = `任务：${t.status ?? '—'}　本轮：${t.attempt?.state ?? '尚无执行记录'}`
      if (tone === 'muted' && (t.attempt?.state ?? null) === null) s.textContent += '（等电脑领取）'
      card.appendChild(s)
      box.appendChild(card)
    }
    frag.appendChild(box)
  }
  if (!any) {
    const p = document.createElement('div')
    p.className = 'hint'
    p.textContent = '没有待办任务。'
    frag.appendChild(p)
  }
  root.replaceChildren(frag)
}

function showView(view) {
  state.view = view
  $('view-chat').classList.toggle('hidden', view !== 'chat')
  $('view-tasks').classList.toggle('hidden', view !== 'tasks')
  $('composer').classList.toggle('hidden', view !== 'chat')
  $('tab-chat').setAttribute('aria-selected', String(view === 'chat'))
  $('tab-tasks').setAttribute('aria-selected', String(view === 'tasks'))
  if (view === 'tasks') void refreshTasks()
}

// ── 数据 ────────────────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const s = await api('/api/identity/status', { auth: false })
    if (s.bootstrapped === false) $('bootstrap-hint').hidden = false
    return true
  } catch {
    // **不吞**：返回值决定界面说"Hub 不可达"还是"未登录"。
    // 原来这里 `catch { /* 登录页自己会报 */ }` 把结果丢了，于是 main() 在末尾
    // 一律报"Hub 不可达"——即使刚刚这条请求是成功的。
    // 用户看到"服务器挂了"会去重启服务器，而其实只需要登录。
    return false
  }
}

async function loadAgents() {
  const r = await api(`/api/agents?scope=${encodeURIComponent(state.scope)}`)
  state.agents = r.agents ?? []
  if (state.agents.length > 0 && !state.agents.some((a) => a.agentId === state.agentId)) {
    state.agentId = state.agents[0].agentId
    localStorage.setItem(LS_AGENT, state.agentId)
  }
  renderAgents()
}

async function openConversation() {
  if (state.agentId === null) return
  const c = await api('/api/agent-conversations', { method: 'POST', body: { agentId: state.agentId, scope: state.scope, by: 'mobile' } })
  state.convId = c.convId
  await refreshTimeline()
  connectStream()
}

async function refreshTimeline() {
  if (state.convId === null) return
  // 读当前投影（**不是**从事件流拼出来）：事件只是通知，真相在 Hub。
  const r = await api(`/api/chat/messages?conv=${state.convId}&scope=${encodeURIComponent(state.scope)}&limit=200`)
  const entries = (r.messages ?? []).map(timelineEntry)
  const merged = mergeTimeline(state.timeline, entries)
  state.timeline = merged.entries
  state.cursor = merged.cursor
  renderTimeline()
}

async function refreshTasks() {
  if (state.agentId === null) return
  const r = await api(`/api/agent-detail?agentId=${encodeURIComponent(state.agentId)}&scope=${encodeURIComponent(state.scope)}`)
  state.tasks = r.agent?.tasks ?? []
  const active = state.tasks.find((t) => !['done', 'canceled'].includes(t.status))
  const presence = await api('/api/devices/presence').catch(() => ({ presence: [] }))
  const anyOnline = (presence.presence ?? []).some((p) => p.online === true)
  setConnection({
    hubReachable: true,
    // 没有设备时是"未知"而不是"离线"：`presence` 里没有行不代表电脑关了，
    // 也可能只是它还没配过对。
    nodeOnline: (presence.presence ?? []).length === 0 ? null : anyOnline,
    activeTaskState: active?.attempt?.state ?? null,
  })
  renderTasks()
}

async function send(text, intent = 'ask') {
  if (state.convId === null || text.trim().length === 0) return
  $('btn-send').disabled = true
  try {
    await api('/api/agent-messages', {
      method: 'POST',
      body: {
        conv: state.convId, scope: state.scope, by: 'mobile', body: text.trim(), intent,
        // 客户端幂等键：网络重试不会重复创建消息（服务端按 scope+actor+requestId 去重）。
        clientRequestId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    })
    $('composer-input').value = ''
    await refreshTimeline()
  } catch (e) {
    showLoginError(e.message)
  } finally {
    $('btn-send').disabled = false
  }
}

// ── 事件流 ──────────────────────────────────────────────────────────────────

function connectStream() {
  if (state.sse !== null) { try { state.sse.close() } catch { /* 已关 */ } }
  const params = new URLSearchParams({ scope: state.scope, kind: 'mobile' })
  if (state.cursor !== null) params.set('sinceSeq', String(state.cursor))
  // EventSource 无法自定义请求头，所以令牌走查询串（服务端的 `QUERY_TOKEN_PATHS`
  // 只对 SSE 与投递读数放开这一条）。
  params.set('token', state.access)
  const es = new EventSource(`${hubBase()}/api/events?${params}`)
  state.sse = es
  es.onopen = () => { }
  es.onmessage = () => {
    // ★ 事件帧只当通知：内容一律回 Hub 读。这样"事件丢了"最多是晚一会儿看到，
    //   而不是界面上一段缺失。
    void refreshTimeline().catch(() => { })
    void refreshTasks().catch(() => { })
  }
  es.onerror = () => {
    // EventSource 自带重连；这里只更新状态显示，不去手工重连（两套重连会互相打断）。
    setConnection({ hubReachable: false })
  }
}

// ── 登录 ────────────────────────────────────────────────────────────────────

function showLoginError(message) {
  const box = $('login-error')
  box.textContent = message
  box.classList.remove('hidden')
}

async function doLogin() {
  const name = $('login-name').value.trim()
  const password = $('login-password').value
  if (name.length === 0 || password.length === 0) { showLoginError('请填写用户名与口令'); return }
  $('btn-login').disabled = true
  try {
    const r = await fetch(hubBase() + '/api/identity/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, password, label: `手机 ${navigator.platform ?? ''}`.trim() }),
    })
    const j = await r.json()
    if (!r.ok || j.ok !== true) { showLoginError(j?.error ?? `登录失败（HTTP ${r.status}）`); return }
    state.access = j.accessToken
    state.refresh = j.refreshToken
    sessionStorage.setItem(SS_ACCESS, state.access)
    localStorage.setItem(LS_REFRESH, state.refresh)
    await enterApp(j)
  } catch (e) {
    showLoginError(`无法连接 Hub：${e.message}`)
  } finally {
    $('btn-login').disabled = false
  }
}

async function enterApp(me) {
  $('screen-login').classList.add('hidden')
  $('main').classList.remove('hidden')
  $('title').textContent = `Legion · ${me.name ?? ''}`
  // 空间：优先用户自己上次选的，否则用他有权限的第一个。
  if (state.scope === null) {
    const info = await api('/api/identity/me')
    state.scope = info.roles?.[0]?.space ?? 'default'
    localStorage.setItem(LS_SCOPE, state.scope)
  }
  setConnection({ hubReachable: true, nodeOnline: null })
  try {
    await loadAgents()
    await openConversation()
    await refreshTasks()
  } catch (e) {
    // 空间没有 Agent 不是致命错误：界面照常显示，让用户去任务页看。
    console.warn('初始化失败', e)
  }
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
  $('btn-logout').addEventListener('click', doLogout)
  $('btn-refresh').addEventListener('click', () => { void refreshTimeline(); void refreshTasks() })
  $('btn-send').addEventListener('click', () => { void send($('composer-input').value) })
  $('composer-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send($('composer-input').value) }
  })
  $('composer-input').addEventListener('input', (e) => {
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`
  })
  $('tab-chat').addEventListener('click', () => showView('chat'))
  $('tab-tasks').addEventListener('click', () => showView('tasks'))
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

export { state, doLogin, refreshTimeline, mergeTimeline, timelineEntry, pendingTasks, TIMELINE_CODES }

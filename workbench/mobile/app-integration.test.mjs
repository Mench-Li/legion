// workbench/mobile/app-integration.test.mjs
// ============================================================================
// app.mjs 的**接线**判据：真的把源码跑起来，而不是只对纯函数断言。
//
// 为什么需要这一层（T-213 审查抓到的三个缺陷全在接线层）：
//   · 换 Agent 时没有强制滚底、历史被算成“新消息”；
//   · 全部看板切页签回来丢了当前列的滚动位置；
//   · pointercancel / 多指仍然提交切列并留下 --drag 偏移。
//
// 这三个判断都在 interaction.mjs 之外：纯函数本身是对的，错在调用链。
// app.mjs 顶层读 sessionStorage，在 Node 里直接 import 会抛，所以这里用
// node:vm + 一个极小的内存 DOM 桩把它跑起来。桩只实现被调用到的 DOM 表面，
// 不模拟浏览器；布局读数由测试直接设定（scrollHeight/clientHeight）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

import * as boardMod from './board.mjs'
import * as timelineMod from './timeline.mjs'
import * as refreshMod from './refresh-loop.mjs'
import * as popupMod from './popup.mjs'
import * as avatarMod from './avatar.mjs'
import * as noticeMod from './notice.mjs'
import * as notifyMod from './notify-plan.mjs'
import * as screenMod from './screen-plan.mjs'
import * as i18nMod from './i18n.mjs'
import * as outboxMod from './outbox.mjs'
import * as readCacheMod from './read-cache.mjs'
import * as interactionMod from './interaction.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_SOURCE = readFileSync(join(HERE, 'app.mjs'), 'utf8').replace(/\r\n/g, '\n')

const DEPS = {
  board: boardMod,
  timeline: timelineMod,
  'refresh-loop': refreshMod,
  popup: popupMod,
  avatar: avatarMod,
  notice: noticeMod,
  'notify-plan': notifyMod,
  'screen-plan': screenMod,
  i18n: i18nMod,
  outbox: outboxMod,
  'read-cache': readCacheMod,
  interaction: interactionMod,
}

// ── 极小的内存 DOM ──────────────────────────────────────────────────────────

function makeClassList(el) {
  const tokens = () => String(el.className).split(/\s+/).filter(Boolean)
  return {
    add: (...names) => { el.className = [...new Set([...tokens(), ...names])].join(' ') },
    remove: (...names) => { el.className = tokens().filter((n) => !names.includes(n)).join(' ') },
    toggle: (name, force) => {
      const on = force === undefined ? !tokens().includes(name) : force === true
      el.className = on ? [...new Set([...tokens(), name])].join(' ') : tokens().filter((n) => n !== name).join(' ')
      return on
    },
    contains: (name) => tokens().includes(name),
  }
}

function makeStyle() {
  const props = new Map()
  return {
    setProperty: (k, v) => props.set(k, String(v)),
    getPropertyValue: (k) => props.get(k) ?? '',
    removeProperty: (k) => props.delete(k),
  }
}

function matches(el, selector) {
  const s = selector.trim()
  if (s === '') return false
  if (s.startsWith('.')) return el.classList.contains(s.slice(1))
  if (s.startsWith('#')) return el.id === s.slice(1)
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s)
  if (attr !== null) {
    const value = el.getAttribute(attr[1])
    return attr[2] === undefined ? value !== null : value === attr[2]
  }
  return el.tagName === s.toUpperCase()
}

function matchesAny(el, selectorList) {
  return selectorList.split(',').some((s) => matches(el, s))
}

function createHarness() {
  const all = []
  const documentListeners = new Map()
  const timelineHooks = { onRender: null }
  const data = {
    messages: [],
    agents: [],
    tasks: [],
    roles: [{ space: 's1', role: 'owner' }, { space: 's2', role: 'owner' }],
  }
  let convSeq = 0
  const fetchCalls = []
  let active = null

  class FakeText {
    constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null }
  }

  class FakeElement {
    constructor(tag = 'div') {
      this.nodeType = 1
      this.tagName = String(tag).toUpperCase()
      this.children = []
      this.parentNode = null
      this.id = ''
      this.className = ''
      this.classList = makeClassList(this)
      this.style = makeStyle()
      this.dataset = {}
      this.attributes = new Map()
      this._text = ''
      this._html = ''
      this._handlers = new Map()
      this._captured = new Set()
      this.scrollTop = 0
      this.scrollHeight = 0
      this.clientHeight = 0
      this.disabled = false
      this.hidden = false
      this.inert = false
      this.tabIndex = 0
      this.offsetParent = {}
      this.title = ''
      this.value = ''
      this.selected = false
      all.push(this)
    }

    get textContent() { return this._text + this.children.map((c) => c.textContent ?? '').join('') }
    set textContent(v) { this.children = []; this._text = v === null || v === undefined ? '' : String(v) }
    get innerHTML() { return this._html }
    set innerHTML(v) { this._html = String(v); this.children = []; this._text = '' }

    appendChild(node) {
      if (node instanceof FakeFragment) {
        for (const child of [...node.children]) this.appendChild(child)
        node.children = []
        return node
      }
      node.parentNode = this
      this.children.push(node)
      return node
    }

    replaceChildren(...nodes) {
      this.children = []
      this._text = ''
      this._html = ''
      for (const node of nodes) this.appendChild(node)
      if (this.id === 'timeline' && timelineHooks.onRender !== null) timelineHooks.onRender(this)
    }

    removeChild(node) {
      this.children = this.children.filter((c) => c !== node)
      node.parentNode = null
      return node
    }

    remove() {
      if (this.parentNode !== null) this.parentNode.removeChild(this)
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
    removeAttribute(name) { this.attributes.delete(name) }
    hasAttribute(name) { return this.attributes.has(name) }

    addEventListener(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, [])
      this._handlers.get(type).push(fn)
    }

    removeEventListener(type, fn) {
      const list = this._handlers.get(type) ?? []
      this._handlers.set(type, list.filter((x) => x !== fn))
    }

    emit(type, event) {
      for (const fn of this._handlers.get(type) ?? []) fn(event)
    }

    setPointerCapture(id) { this._captured.add(id) }
    releasePointerCapture(id) { this._captured.delete(id) }
    hasPointerCapture(id) { return this._captured.has(id) }

    focus() { active = this }
    blur() { if (active === this) active = null }
    scrollIntoView() { }

    closest(selector) {
      let node = this
      while (node !== null && node !== undefined) {
        if (node.nodeType === 1 && matchesAny(node, selector)) return node
        node = node.parentNode
      }
      return null
    }

    querySelectorAll(selector) {
      const out = []
      const walk = (el) => {
        for (const child of el.children) {
          if (child.nodeType !== 1) continue
          if (matchesAny(child, selector)) out.push(child)
          walk(child)
        }
      }
      walk(this)
      return out
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }

  class FakeFragment extends FakeElement {
    constructor() {
      super('#fragment')
      this.nodeType = 11
    }
  }

  const doc = {
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    get activeElement() { return active },
    set activeElement(v) { active = v },
    getElementById(id) {
      // 源码末尾用这个 id 判断“页面是否真的在浏览器里”；桩里必须返回 null，
      // 否则 main() 会跑起来，测试就不再是被测函数而是整个启动流程。
      if (id === 'screen-login') return null
      for (let i = all.length - 1; i >= 0; i -= 1) {
        if (all[i].id === id) return all[i]
      }
      const el = new FakeElement('div')
      el.id = id
      return el
    },
    createElement(tag) { return new FakeElement(tag) },
    createDocumentFragment() { return new FakeFragment() },
    createTextNode(text) { return new FakeText(text) },
    contains(el) { return all.includes(el) },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, [])
      documentListeners.get(type).push(fn)
    },
    removeEventListener() { },
  }
  doc.body.dataset.screen = 'app'

  // 状态条渲染会 querySelector('.dot'/'.label'/'.detail')，先把它们挂好。
  const status = doc.getElementById('status')
  for (const cls of ['dot', 'label', 'detail']) {
    const child = doc.createElement('span')
    child.className = cls
    status.appendChild(child)
  }

  function makeStorage() {
    const map = new Map()
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      clear: () => map.clear(),
    }
  }

  const location = {
    origin: 'http://127.0.0.1',
    protocol: 'http:',
    hostname: '127.0.0.1',
    pathname: '/mobile/',
    search: '',
    hash: '',
    reload() { },
  }
  const navigator = {
    language: 'zh-CN',
    platform: 'test',
    standalone: false,
    onLine: true,
    serviceWorker: { register: async () => ({}), ready: Promise.resolve({}) },
  }
  const windowObj = {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: null,
    matchMedia: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }),
    addEventListener() { },
    removeEventListener() { },
    focus() { },
  }

  const response = (value, statusCode = 200) => ({
    ok: statusCode < 400,
    status: statusCode,
    async text() { return value === null || value === undefined ? '' : JSON.stringify(value) },
    async json() { return value },
  })

  const fetchStub = async (url, opts = {}) => {
    const parsed = new URL(String(url))
    const path = parsed.pathname
    fetchCalls.push({ path, method: opts.method ?? 'GET' })
    if (path === '/api/agent-conversations') { convSeq += 1; return response({ convId: 'conv-' + convSeq }) }
    if (path === '/api/events/ticket') return response({ ticket: 'ticket-1' })
    if (path === '/api/chat/messages') return response({ messages: data.messages })
    if (path === '/api/identity/me') return response({ user: { userId: 'u1', name: 'U' }, roles: data.roles })
    if (path === '/api/board') return response(data.tasks)
    if (path === '/api/agents') return response({ agents: data.agents })
    if (path === '/api/devices/presence') return response({ presence: [] })
    if (path === '/api/activity') return response({ items: [] })
    return response({})
  }

  class FakeEventSource {
    constructor(url) { this.url = url; this.closed = false; this.onopen = null; this.onmessage = null; this.onerror = null }
    close() { this.closed = true }
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch: fetchStub,
    EventSource: FakeEventSource,
    document: doc,
    window: windowObj,
    navigator,
    location,
    history: { replaceState() { } },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    Element: FakeElement,
    HTMLElement: FakeElement,
    Node: FakeElement,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)

  // 把 app.mjs 的静态 import 改写成从 __deps 取；顶层 export 去掉。
  const source = APP_SOURCE
    .replace(/^import\s*\{([\s\S]*?)\}\s*from\s*'\.\/([\w-]+)\.mjs'\s*$/gm,
      (_, names, mod) => 'const {' + names + '} = __deps[' + JSON.stringify(mod) + ']')
    .replace(/^export\s*\{[^}]*\}\s*$/m, '')
  // ★ 每个导出都用 typeof 保护：破坏性验证要拿**修复前**的 app.mjs 跑同一批判据，
  //   那时新加的函数还不存在。用 typeof 而不是直接引用，缺函数时是"断言失败"，
  //   而不是整个 harness 抛 ReferenceError（后者会假装抓到了、其实什么都没测）。
  const EXPORTS = [
    'selectAgent', 'openConversation', 'refreshTimeline', 'showView', 'renderBoard',
    'renderBoardViews', 'setBoardPage', 'switchScope', 'bindBoardGestures',
    'closeTaskSheet', 'openTaskSheet', 'resetConversationView', 'cancelBoardGesture',
    'saveTasksScroll', 'applyTimelineScroll', 'updateNewMessagePill',
  ]
  const returnSource = 'return { state'
    + EXPORTS.map((name) => ',\n  ' + name + ': typeof ' + name + ' === \'function\' ? ' + name + ' : undefined').join('')
    + ' };'
  const factory = vm.runInNewContext(
    '(function (__deps) {\n' + source + '\n' + returnSource + '\n})',
    context,
    { filename: 'app.mjs' },
  )
  const app = factory(DEPS)

  const main = doc.getElementById('main')
  const timeline = doc.getElementById('timeline')
  const root = doc.getElementById('task-groups')
  timelineHooks.onRender = (el) => {
    // 桩里的“布局”：消息越多，main 越高。测试只需要一个单调、可预期的读数。
    main.scrollHeight = 200 + el.children.length * 120
  }
  main.clientHeight = 500

  const pointer = (pointerId, clientX, clientY, target) => ({
    pointerId,
    pointerType: 'touch',
    buttons: 0,
    clientX,
    clientY,
    target,
    preventDefault() { },
    stopPropagation() { },
  })

  return {
    app,
    doc,
    data,
    main,
    timeline,
    root,
    fetchCalls,
    pointer,
    cardTarget() { return doc.createElement('article') },
    messages(count) {
      data.messages = Array.from({ length: count }, (_, i) => ({
        id: 'm-' + i,
        body: '消息 ' + i,
        createdAt: '2026-10-22T00:00:00.000Z',
        meta: { source: 'agent' },
      }))
      return data.messages
    },
    agents(two = true) {
      data.agents = two
        ? [{ agentId: 'a1', name: '甲', role: 'coder' }, { agentId: 'a2', name: '乙', role: 'coder' }]
        : [{ agentId: 'a1', name: '甲', role: 'coder' }]
      return data.agents
    },
    tasks() {
      data.tasks = [
        { id: 'T-1', title: '一', status: 'in_review', role: 'coder', priority: 'P1' },
        { id: 'T-2', title: '二', status: 'todo', role: 'coder', priority: 'P2' },
      ]
      return data.tasks
    },
  }
}

// ── ① 新会话必须滚底，历史不算“新消息” ────────────────────────────────────

test('★★★ 启动屏预加载历史：落主界面后才滚底，历史不计新消息', async () => {
  const h = createHarness()
  const { app, doc, main } = h
  doc.body.dataset.screen = 'boot'
  app.state.view = 'chat'
  app.state.scope = 's1'
  app.state.agentId = 'a1'
  app.state.agents = h.agents(false)
  h.messages(16)

  await app.openConversation()
  assert.equal(app.state.pendingNewMessages, 0, '启动屏预载的历史不算新消息')
  assert.equal(app.state.chatFollowPending, true, '隐藏时还不能消耗首次跟底')

  doc.body.dataset.screen = 'app'
  app.showView('chat')
  assert.equal(app.state.chatFollowPending, false)
  assert.equal(main.scrollTop, main.scrollHeight, '落屏后首次可见应在最新消息')
  assert.equal(app.state.pendingNewMessages, 0)
})

test('★★★ 切换 Agent：清旧 DOM、滚到底、历史不计入 pending', async () => {
  const h = createHarness()
  const { app, main, timeline } = h
  app.state.view = 'chat'
  app.state.scope = 's1'
  app.state.agentId = 'a1'
  app.state.agents = h.agents(true)
  h.messages(20)
  // 旧会话的布局：用户停在半截（这正是审查复现的读数）。
  main.scrollHeight = 1800
  main.scrollTop = 200
  timeline.replaceChildren()
  for (let i = 0; i < 5; i += 1) timeline.appendChild(h.doc.createElement('div'))

  await app.selectAgent('a2')

  assert.equal(app.state.timeline.length, 20, '新会话的 20 条历史要显示出来')
  assert.equal(app.state.pendingNewMessages, 0, '历史不是新消息')
  assert.equal(app.state.chatFollowPending, false, '已经在可见状态落过底')
  assert.equal(main.scrollTop, main.scrollHeight, '新会话必须落在最新一条（滚底）')
  assert.equal(timeline.children.length, 20, '旧 DOM 被新会话替换，不是叠在上面')
})

test('★★★ 对话不可见时换 Agent：切回对话再落底，不把任务页滚动拽走', async () => {
  const h = createHarness()
  const { app, main } = h
  app.state.view = 'tasks'
  app.state.scope = 's1'
  app.state.agentId = 'a1'
  app.state.agents = h.agents(true)
  h.messages(15)
  main.scrollHeight = 2400
  main.scrollTop = 555

  await app.selectAgent('a2')
  assert.equal(main.scrollTop, 555, '加载发生在任务页签，不许动看板滚动')
  assert.equal(app.state.pendingNewMessages, 0, '不可见的对话也不该累计浮标')
  assert.equal(app.state.chatFollowPending, true, '等对话可见再落底')

  app.showView('chat')
  assert.equal(app.state.chatFollowPending, false)
  assert.equal(main.scrollTop, main.scrollHeight, '第一次可见时必须滚到底')
})

test('★★★ 切换空间：新会话同样落底（不是恢复到顶部）', async () => {
  const h = createHarness()
  const { app, main } = h
  app.state.view = 'chat'
  app.state.scope = 's1'
  app.state.agentId = 'a1'
  app.state.agents = h.agents(true)
  h.messages(12)
  main.scrollHeight = 1600
  main.scrollTop = 300

  await app.switchScope('s2')

  assert.equal(app.state.scope, 's2')
  assert.equal(app.state.chatScrollTop, 0, '旧空间的阅读位置不许带过来')
  assert.equal(app.state.pendingNewMessages, 0)
  assert.equal(main.scrollTop, main.scrollHeight, '新空间是新会话，落在最新一条')
})

// ── ② 全部看板切页签往返保留当前列位置 ─────────────────────────────────────

test('★★★ 全部看板：切到对话再切回，当前列位置不丢', () => {
  const h = createHarness()
  const { app, main } = h
  app.state.view = 'tasks'
  app.state.boardView = 'all'
  app.state.boardPage = 0
  app.state.scope = null // 避免 showView 触发 refreshTasks，位置断言只测保存/恢复
  app.state.tasks = h.tasks()
  main.scrollHeight = 2400
  main.clientHeight = 500
  app.renderBoard()
  main.scrollTop = 360

  app.showView('chat')
  assert.equal(app.state.tasksScrollTop, 360, '离开任务页时保存当前列位置')
  assert.equal(app.state.tasksScrollPageId, 'in_review')
  assert.equal(app.state.columnScroll.in_review, 360, '同步进 columnScroll（不再只依赖切列时的旧值）')

  app.showView('tasks')
  assert.equal(app.state.scrollRestorePending, 'tasks')
  app.renderBoard()
  assert.equal(main.scrollTop, 360, '切回来回到离开时的位置，而不是 0')
})

test('★★ 恢复时列已经变了：退回该列自己的位置，不硬套另一列的像素', () => {
  const h = createHarness()
  const { app, main } = h
  app.state.view = 'tasks'
  app.state.boardView = 'all'
  app.state.scope = null
  app.state.tasks = h.tasks()
  app.renderBoard()
  main.scrollHeight = 2400
  main.clientHeight = 500
  app.state.tasksScrollTop = 900
  app.state.tasksScrollPageId = 'done'
  app.state.columnScroll.todo = 120
  app.state.boardPage = 1
  app.state.scrollRestorePending = 'tasks'
  app.renderBoard()
  assert.equal(main.scrollTop, 120, '页索引夹到 todo 时用 todo 的位置')
})

// ── ③ 手势取消 / 多指：回弹且无副作用 ──────────────────────────────────────

function gestureSetup() {
  const h = createHarness()
  const { app, main } = h
  app.state.view = 'tasks'
  app.state.boardView = 'all'
  app.state.boardPage = 0
  app.state.scope = null
  app.state.tasks = h.tasks()
  app.renderBoard()
  app.bindBoardGestures()
  main.clientHeight = 500
  main.scrollHeight = 2400
  return h
}

test('★★★ pointercancel：只回弹，不切列，不残留 --drag', () => {
  const h = gestureSetup()
  const { app, root } = h
  const track = h.doc.getElementById('board-track')
  const target = h.cardTarget()

  root.emit('pointerdown', h.pointer(1, 300, 300, target))
  root.emit('pointermove', h.pointer(1, 200, 300, target))
  assert.equal(track.style.getPropertyValue('--drag'), '-100px', '跟手位移先要出现')

  root.emit('pointercancel', h.pointer(1, 200, 300, target))
  assert.equal(app.state.boardPage, 0, '取消不提交切列')
  assert.equal(app.state.gesture, null, '手势状态被清掉')
  assert.equal(track.style.getPropertyValue('--drag'), '0px', '轨道复位，不留半截偏移')
})

test('★★★ 多指：第二根手指按下即作废，两个手指结束都不切列', () => {
  const h = gestureSetup()
  const { app, root } = h
  const track = h.doc.getElementById('board-track')
  const target = h.cardTarget()

  root.emit('pointerdown', h.pointer(1, 300, 300, target))
  root.emit('pointermove', h.pointer(1, 200, 300, target))
  root.emit('pointerdown', h.pointer(2, 260, 300, target))
  assert.equal(app.state.gesture, null, '第二指按下后第一段手势作废')
  assert.equal(track.style.getPropertyValue('--drag'), '0px')

  root.emit('pointercancel', h.pointer(1, 200, 300, target))
  root.emit('pointerup', h.pointer(2, 260, 300, target))
  assert.equal(app.state.boardPage, 0, '多指操作无副作用')
})

test('★★ 正常 pointerup 仍然提交（取消修复不许把功能一起关掉）', () => {
  const h = gestureSetup()
  const { app, root } = h
  const target = h.cardTarget()
  root.emit('pointerdown', h.pointer(1, 300, 300, target))
  root.emit('pointermove', h.pointer(1, 200, 300, target))
  root.emit('pointerup', h.pointer(1, 200, 300, target))
  assert.equal(app.state.boardPage, 1, '跨过阈值就该切到下一列')
  const track = h.doc.getElementById('board-track')
  assert.equal(track.style.getPropertyValue('--drag'), '0px', '提交后轨道也要复位')
})

test('★★ 切页签时统一清理手势，不留 transform', () => {
  const h = gestureSetup()
  const { app, root } = h
  const track = h.doc.getElementById('board-track')
  const target = h.cardTarget()
  root.emit('pointerdown', h.pointer(1, 300, 300, target))
  root.emit('pointermove', h.pointer(1, 200, 300, target))
  assert.equal(app.state.gesture !== null, true)

  app.showView('chat')
  assert.equal(app.state.gesture, null, '切页签要清手势')
  assert.equal(track.style.getPropertyValue('--drag'), '0px', '切页签要复位轨道')
})

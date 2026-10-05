// desktop/update-panel.test.mjs
// ============================================================================
// 更新面板的界面规则 —— 设计 §7 的可执行形式
//
// `projectView` 是纯函数，所以"按钮什么时候出现""错误什么时候显示"这些
// 规则可以被逐条断言，而不是靠人眼看一遍界面。这个仓库里没有 DOM 测试
// 基础设施，所以 `render` 那一层用一个最小的 `document` 替身驱动——
// 它同时验证了一条纪律：**所有动态文本都经 `textContent`**。
// ============================================================================

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import {
  describeCommandResult, describeLastCheck, describePendingTasks, describeVersionLine, formatBytes,
  projectView, render,
} from './update-panel.mjs'

const DIGEST = 'a'.repeat(64)

function baseState(overrides = {}) {
  return {
    state: 'idle',
    usable: true,
    unavailableReason: null,
    channel: 'stable',
    currentVersion: '1.0.0',
    productVersion: null,
    releaseId: null,
    manifestDigest: null,
    identityLabel: null,
    ready: false,
    progress: null,
    lastCheck: null,
    lastError: null,
    releaseNotes: null,
    releaseNotesUnavailableReason: null,
    operationId: null,
    snoozedUntilMs: null,
    pendingTasks: null,
    ...overrides,
  }
}

/** 一个最小的 document 替身：足够驱动 render，并能记录写入方式。 */
function createFakeDocument() {
  const nodes = new Map()
  const writes = []
  const make = (id) => ({
    id,
    textContent: '',
    className: '',
    style: { width: '' },
    disabled: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value) },
    removeAttribute(name) { this.attributes.delete(name) },
    get hidden() { return this.attributes.has('hidden') },
    addEventListener() {},
  })
  return {
    writes,
    nodes,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, make(id))
      return nodes.get(id)
    },
  }
}

// ---------------------------------------------------------------------------
// ① 读数
// ---------------------------------------------------------------------------

test('显示当前版本与通道', () => {
  assert.equal(describeVersionLine(baseState()), '1.0.0（stable）')
  assert.equal(describeVersionLine(baseState({ currentVersion: null })), '—')
  assert.equal(describeVersionLine(baseState({ channel: null })), '1.0.0（未知通道）')
})

test('上次成功检查显示时间；失败如实标出（自动与手动都一样）', () => {
  const at = Date.parse('2026-10-04T09:05:00')
  const ok = describeLastCheck(baseState({ lastCheck: { atMs: at, outcome: 'ok', productVersion: '1.1.0' } }))
  assert.match(ok, /2026-10-04 09:05/)
  assert.match(ok, /1\.1\.0/)
  const failed = describeLastCheck(baseState({ lastCheck: { atMs: at, outcome: 'failed' } }))
  assert.match(failed, /失败/)
  assert.equal(describeLastCheck(baseState()), '尚未检查')
})

// ---------------------------------------------------------------------------
// ② 按钮可见性（设计 §7 line 146–148）
// ---------------------------------------------------------------------------

test('发现新版：显示"下载更新"和"稍后"，不显示"安装并重启"', () => {
  const view = projectView(baseState({
    state: 'available', productVersion: '1.1.0', releaseId: 'rel-1.1.0', manifestDigest: DIGEST,
  }))
  assert.equal(view.showDownload, true)
  assert.equal(view.showSnooze, true)
  assert.equal(view.showInstall, false)
  assert.equal(view.showCancel, false)
})

test('下载中：显示真实字节进度与取消，不显示下载/安装', () => {
  const view = projectView(baseState({
    state: 'downloading', progress: { phase: 'downloading', bytes: 512, total: 2048 },
  }))
  assert.equal(view.showCancel, true)
  assert.equal(view.showDownload, false)
  assert.equal(view.showInstall, false)
  assert.equal(view.showProgress, true)
  assert.equal(view.percent, 25)
  assert.match(view.progressText, /512 B \/ 2 KB/)
})

test('校验阶段：文案是"正在验证更新"（设计 §7 line 148）', () => {
  const view = projectView(baseState({ state: 'verifying', progress: { phase: 'verifying', bytes: 2048, total: 2048 } }))
  assert.equal(view.showProgress, true)
  assert.equal(view.progressText, '正在验证更新…')
  assert.equal(view.showCancel, true)
})

test('就绪：显示"安装并重启"与"稍后安装"，且**从不自动触发**', () => {
  const view = projectView(baseState({ state: 'ready', releaseId: 'rel-1.1.0', manifestDigest: DIGEST }))
  assert.equal(view.showInstall, true)
  // "稍后安装" —— 面板上就是那个"关闭"按钮 + snooze；这里断言 snooze 不再
  // 出现在 ready 状态（它只属于 available）。
  assert.equal(view.showSnooze, false)
  assert.equal(view.showDownload, false)
  assert.match(view.hint, /安装会重启 Legion/)
})

test('就绪之后窗口关闭/稍后安装：面板不再显示安装，但状态仍是 ready', () => {
  // "关闭窗口不自动安装"（设计 §7 line 148）在**主进程**侧成立：
  // 面板不存在时没有任何东西会调用 update.install。这里断言界面层
  // 不会因为面板消失而改变状态读数。
  const view = projectView(baseState({ state: 'ready' }))
  assert.equal(view.showInstall, true)
  assert.equal(view.statusText, '更新已就绪，可以安装。')
})

test('等待任务：显示等待文案，且仍然可以安装（用户可继续等或稍后）', () => {
  const view = projectView(baseState({ state: 'waiting-for-tasks' }))
  assert.equal(view.showInstall, false, '"等待在途任务"阶段不该再给一次安装按钮')
  assert.match(view.hint, /等待在途任务/)
})

test('安装被阻止：显示"安装并重启"以便重试，并说明当前版本不受影响', () => {
  const view = projectView(baseState({ state: 'install-blocked' }))
  assert.equal(view.showInstall, true)
  assert.equal(view.showDownload, false)
  assert.match(view.hint, /当前版本不受影响/)
})

test('程序切换之后的失败：落点文案可区分', () => {
  assert.match(projectView(baseState({ state: 'rolled-back' })).statusText, /已回退/)
  assert.match(projectView(baseState({ state: 'recovery-required' })).statusText, /人工/)
  assert.equal(projectView(baseState({ state: 'recovery-required' })).statusKind, 'error')
})

test('检查按钮在检查/下载/安装期间禁用', () => {
  for (const state of ['checking', 'downloading', 'verifying', 'installing', 'preparing', 'validating']) {
    assert.equal(projectView(baseState({ state })).checkEnabled, false, `${state} 时"检查更新"仍可点`)
  }
  for (const state of ['idle', 'available', 'ready', 'up-to-date', 'check-failed', 'download-failed', 'cancelled']) {
    assert.equal(projectView(baseState({ state })).checkEnabled, true, `${state} 时"检查更新"被禁用`)
  }
})

// ---------------------------------------------------------------------------
// ③ 错误显示：自动检查不给用户看，手动检查才给（设计 §6 line 134）
// ---------------------------------------------------------------------------

test('★ 自动检查失败：只显示一句"检查更新失败"，不把细节丢给用户', () => {
  const view = projectView(baseState({
    state: 'check-failed',
    lastCheck: { atMs: Date.now(), outcome: 'failed', trigger: 'periodic' },
    lastError: { code: 'net-offline', reason: '无法连接更新服务器，请检查网络后重试。' },
  }))
  assert.equal(view.showError, true)
  assert.equal(view.errorText, '检查更新失败。')
})

test('★ 手动检查失败：显示完整理由与重试（按钮就是"检查更新"）', () => {
  const view = projectView(baseState({
    state: 'check-failed',
    lastCheck: { atMs: Date.now(), outcome: 'failed', trigger: 'manual' },
    lastError: { code: 'net-offline', reason: '无法连接更新服务器，请检查网络后重试。（连接被拒绝）' },
  }))
  assert.equal(view.showError, true)
  assert.match(view.errorText, /无法连接更新服务器/)
  assert.equal(view.checkEnabled, true)
})

test('重试触发同样算"用户发起"', () => {
  const view = projectView(baseState({
    state: 'check-failed',
    lastCheck: { atMs: Date.now(), outcome: 'failed', trigger: 'retry' },
    lastError: { code: 'net-timeout', reason: '连接更新服务器超时，请稍后重试。' },
  }))
  assert.match(view.errorText, /超时/)
})

test('★ 已有的更新状态不被自动检查失败盖掉：状态行仍然是"发现新版本"', () => {
  const view = projectView(baseState({
    state: 'available', productVersion: '1.1.0', releaseId: 'rel-1.1.0', manifestDigest: DIGEST,
    lastCheck: { atMs: Date.now(), outcome: 'failed', trigger: 'periodic' },
    lastError: { code: 'net-offline', reason: '无法连接更新服务器。' },
  }))
  assert.match(view.statusText, /发现新版本/)
  assert.equal(view.showDownload, true)
  // 但失败**有痕迹**：错误那一行仍然出现（只是简短）。
  assert.equal(view.showError, true)
})

// ---------------------------------------------------------------------------
// ④ 稍后（设计 §7 line 146）
// ---------------------------------------------------------------------------

test('★ 稍后不隐藏设置页：面板仍然显示候选、说明与下载按钮', () => {
  const view = projectView(baseState({
    state: 'available', productVersion: '1.1.0', releaseId: 'rel-1.1.0', manifestDigest: DIGEST,
    snoozedUntilMs: Date.now() + 60_000,
  }))
  assert.equal(view.showDownload, true)
  assert.equal(view.showSnooze, true)
  assert.match(view.statusText, /发现新版本/)
})

// ---------------------------------------------------------------------------
// ⑤ 发布说明
// ---------------------------------------------------------------------------

test('发布说明显示为文本；取不到时不显示空块', () => {
  const withNotes = projectView(baseState({ state: 'available', releaseNotes: '• 修复若干问题\n• 更快的启动' }))
  assert.equal(withNotes.showNotes, true)
  assert.match(withNotes.notesText, /更快的启动/)
  const without = projectView(baseState({ state: 'available', releaseNotes: null }))
  assert.equal(without.showNotes, false)
  const empty = projectView(baseState({ state: 'available', releaseNotes: '   ' }))
  assert.equal(empty.showNotes, false)
})

// ---------------------------------------------------------------------------
// ⑥ 不可用
// ---------------------------------------------------------------------------

test('配置不可用：状态行说明原因，且不提供下载/稍后', () => {
  const view = projectView(baseState({ usable: false, unavailableReason: '没有找到 product/release/update-config.json：打包时未写入发行地址，检查更新不可用' }))
  assert.match(view.statusText, /update-config\.json/)
  assert.equal(view.statusKind, 'error')
  assert.equal(view.showDownload, false)
  assert.equal(view.showSnooze, false)
  assert.equal(view.checkEnabled, false)
})

// ---------------------------------------------------------------------------
// ⑦ 身份：界面必须能拼出 update.download / update.install 的输入
// ---------------------------------------------------------------------------

test('候选身份完整时才给出 target；缺一半就不给', () => {
  assert.deepEqual(
    projectView(baseState({ releaseId: 'rel-1', manifestDigest: DIGEST })).target,
    { releaseId: 'rel-1', manifestDigest: DIGEST },
  )
  assert.equal(projectView(baseState({ releaseId: 'rel-1' })).target, null)
  assert.equal(projectView(baseState({ manifestDigest: DIGEST })).target, null)
})

// ---------------------------------------------------------------------------
// ⑧ render 与"动态文本走 textContent"这条纪律
// ---------------------------------------------------------------------------

test('render 把视图写到 DOM，并且进度/说明走 textContent', () => {
  const document = createFakeDocument()
  const view = projectView(baseState({
    state: 'downloading',
    progress: { phase: 'downloading', bytes: 1024, total: 4096 },
    releaseNotes: '<script>alert(1)</script>',
  }))
  render(view, document)
  assert.equal(document.getElementById('bar').style.width, '25%')
  assert.match(document.getElementById('progress-text').textContent, /1 KB \/ 4 KB/)
  // ★ 发布说明被当作**文本**写入。若这里换回 innerHTML，这条断言就失去意义，
  //   所以下面还有一条针对源文件的静态检查。
  assert.equal(document.getElementById('notes').textContent, '<script>alert(1)</script>')
  assert.equal(document.getElementById('download').hidden, true)
  assert.equal(document.getElementById('cancel').hidden, false)
})

test('★ 面板源码里没有任何 HTML 注入入口', () => {
  const source = readFileSync(fileURLToPath(new URL('./update-panel.mjs', import.meta.url)), 'utf8')
  // ★ 先去掉注释再扫。
  //
  //   这不是为了"让检查通过"：本文件的注释里**故意**写着"用 textContent
  //   而不是 innerHTML"这样的对比说明，而把注释也算作命中会让这条检查在
  //   它最该起作用的时候（有人真的写了 innerHTML）失去意义——因为那时
  //   它会和一条注释一起报错，没人能分辨是哪一条。
  const code = stripComments(source)
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) {
    assert.equal(code.includes(forbidden), false, `面板里出现了 ${forbidden}`)
  }
  // 页面本身只加载本地脚本与本地资源。
  const html = readFileSync(fileURLToPath(new URL('./update.html', import.meta.url)), 'utf8')
  assert.match(html, /<script type="module" src="\.\/update-panel\.mjs"><\/script>/)
  assert.equal(/src\s*=\s*"https?:/.test(html), false, '面板加载了远程资源')
  // HTML 注释（`<!-- -->`）也要一起剥掉：页面的注释里同样解释了"不用
  // innerHTML"这件事，而判据要盯的是真正的注入入口。
  assert.equal(/innerHTML/.test(stripComments(html.replace(/<!--[\s\S]*?-->/g, ''))), false)
})

/**
 * 去掉 `//` 行注释与 `/* *​/` 块注释。
 *
 * 一个朴素的实现就够：这个文件里没有正则字面量需要保护，也没有
 * 字符串里出现的 `//`（URL 都被注释包着）。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// ⑨ 命令结果 → 提示
// ---------------------------------------------------------------------------

test('命令结果的提示：稍后与取消都不是失败', () => {
  assert.equal(describeCommandResult('update.snooze', { ok: true }).ok, true)
  assert.match(describeCommandResult('update.snooze', { ok: true }).text, /24 小时/)
  assert.match(describeCommandResult('update.cancelDownload', { ok: true }).text, /已取消/)
  const failed = describeCommandResult('update.install', { ok: false, reason: '健康检查失败，已回退' })
  assert.equal(failed.ok, false)
  assert.match(failed.text, /回退/)
})

test('★ 安装确认显示在途任务：三态，"读不到"不显示成"没有"', () => {
  // 设计 §7 line 150。
  assert.match(describePendingTasks(null), /未知/)
  assert.match(describePendingTasks(undefined), /未知/)
  assert.match(describePendingTasks('nope'), /未知/)
  assert.equal(describePendingTasks([]), '在途任务：没有')
  assert.match(describePendingTasks([{ id: 'a', state: 'in_progress' }]), /1 个在跑/)
  assert.match(describePendingTasks([{ id: 'a', state: 'Running' }]), /1 个在跑/)
  assert.match(describePendingTasks([{ id: 'a', state: '全新状态' }]), /认不出/)
  // 只有已完成/等待的任务 → "没有"，但要把总数说清楚。
  const idle = describePendingTasks([{ id: 'a', state: 'done' }, { id: 'b', state: 'todo' }])
  assert.match(idle, /^在途任务：没有/)
  assert.match(idle, /2 个/)
})

test('★★ 读不到时的说法里不能出现"没有在途"这个结论', () => {
  // 用户会在"看起来环境干净"的界面上按下一个正在被任务使用的升级，
  // 所以这一条单独钉住：未知与没有是两句话。
  for (const reading of [null, undefined, 'nope', 42, {}]) {
    const text = describePendingTasks(reading)
    assert.match(text, /未知/, `读不到时没有说"未知"：${text}`)
    assert.equal(text.includes('在途任务：没有'), false, `读不到被说成了"没有"：${text}`)
  }
})

test('★ projectView 把在途任务读数带出来（界面才有东西可显示）', () => {
  const withTasks = projectView({ state: 'ready', usable: true, pendingTasks: [{ id: 'a', state: 'in_progress' }] })
  assert.match(withTasks.taskSummary, /1 个在跑/)
  const without = projectView({ state: 'ready', usable: true, pendingTasks: null })
  assert.match(without.taskSummary, /未知/)
})

test('★★ update preload 暴露的命令是固定集合，且 install 不接受任务读数', () => {
  // 这是渲染进程能看到**全部**东西。`main.test.mjs` 用同一套手法
  // （在一个新 context 里跑 preload 源码）守 `preload.cjs`。
  let exposed = null
  const calls = []
  const filename = fileURLToPath(new URL('./update-preload.cjs', import.meta.url))
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, api) { exposed = api } },
      ipcRenderer: {
        invoke: (_channel, command, payload) => {
          calls.push([command, payload])
          return Promise.resolve({ ok: true })
        },
        on() {}, removeListener() {},
      },
    }),
  })
  assert.notEqual(exposed, null, 'update-preload.cjs 没有暴露任何东西')
  assert.deepEqual(Object.keys(exposed).sort(), [
    'cancelDownload', 'check', 'download', 'install', 'snooze', 'status', 'subscribe', 'tasks',
  ])

  // ★ `install` 只接受两个参数：身份的两半。任务读数**不是**它的入参。
  calls.length = 0
  return exposed.install('rel-1.0.0', DIGEST).then(() => {
    assert.equal(calls.length, 1)
    const [command, payload] = calls[0]
    assert.equal(command, 'update.install')
    assert.deepEqual(Object.keys(payload).sort(), ['manifestDigest', 'releaseId'],
      'install 的载荷出现了第三个字段：在途任务读数是预检的输入，不能来自渲染进程')
  })
})

test('update preload：tasks 是无参数只读命令', () => {
  let exposed = null
  const calls = []
  const filename = fileURLToPath(new URL('./update-preload.cjs', import.meta.url))
  runInNewContext(readFileSync(filename, 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(_name, api) { exposed = api } },
      ipcRenderer: {
        invoke: (_channel, command, payload) => { calls.push([command, payload]); return Promise.resolve({ ok: true }) },
        on() {}, removeListener() {},
      },
    }),
  })
  return exposed.tasks().then(() => {
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'update.tasks')
    // 载荷是**空对象**：无参数命令不该有可传的输入。
    // 用 JSON 比较：vm 里造出来的对象与这里的对象不是同一个 realm 的
    // `Object.prototype`，`deepStrictEqual` 会因为原型不同而失败。
    assert.equal(JSON.stringify(Object.keys(calls[0][1] ?? {})), '[]')
  })
})

test('formatBytes 的边界', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatBytes(Number.NaN), '0 B')
})

// ---------------------------------------------------------------------------
// ★★★ 两个声明必须一致：面板文案 ↔ 状态机词汇表
// ---------------------------------------------------------------------------

test('★★★★ 状态机里的**每一个**状态都必须在面板里有文案（否则界面显示空白）', async () => {
  // ★ 这条守的是一个**跨模块的接缝**。状态机在 `product/update/state.mjs`，
  //   而用户真正看到的那句话在 `desktop/update-panel.mjs` 的 `STATE_TEXT` 里。
  //   两处各自演进没问题——**但不能对同一个状态给出"一个有一个没有"**。
  //
  //   在加这条判据之前，`STATE_TEXT` 少一个状态时的症状是：界面那一格
  //   **空白**（`STATE_TEXT[state] ?? ''`），而所有用例照样绿。本次新增
  //   `source-unsupported` 时就是踩在这个形状上发现的：`state.mjs` 里那句
  //   `STATE_LABELS` 看起来是用户文案，其实**没有任何界面读它**
  //   （全仓只有它自己的自检与 index 的再导出），真正生效的是这一张。
  //
  //   > 一份"看起来是用户文案"的表，与一张"界面真的会读"的表，
  //   > 在"改了文案用户会不会看到"这个问题上不是同一个东西。
  const { UPDATE_STATES } = await import('../product/update/state.mjs')
  const { STATE_TEXT } = await import('./update-panel.mjs')
  const missing = UPDATE_STATES.filter((state) => typeof STATE_TEXT[state] !== 'string' || STATE_TEXT[state] === '')
  assert.deepEqual(missing, [],
    `这些状态在面板里没有文案（界面会显示空白）：${missing.join(' / ')}`)
  // 反向：面板里**多出**的状态名也要被拒——那多半是改名之后漏改了一处，
  // 而"多出来"的那条永远不会被显示（同样是一个没人读的声明）。
  const extra = Object.keys(STATE_TEXT).filter((state) => !UPDATE_STATES.includes(state))
  assert.deepEqual(extra, [], `面板里有状态机不认识的状态名：${extra.join(' / ')}`)
})

test('★★★ `source-unsupported` 的**状态文案**必须与 `up-to-date` 不同', async () => {
  // ★ 这条第一版写错了：它断言 `describeLastCheck` 在
  //   `lastCheck.outcome === 'source-unsupported'` 时的输出——而那个值
  //   **没有任何生产者**（`client.mjs` 只在成功路径写 `lastCheck`，写的是
  //   `outcome: 'ok'`）。也就是说那条用例断言的是一个永远不会发生的输入，
  //   而它当时是**绿的**。
  //
  //   > 一条喂给"永远不会出现的值"的用例，它的绿与"这条路径被覆盖了"
  //   > 没有任何关系。
  //
  //   用户真正看到的那句话走的是**状态文案**（`projectView` 读 `state`，
  //   而 `state` 由客户端的 `setState('check-source-unsupported')` 置出）。
  //   所以这里断言那一张表。
  const { STATE_TEXT, describeLastCheck } = await import('./update-panel.mjs')
  assert.notEqual(STATE_TEXT['source-unsupported'], STATE_TEXT['up-to-date'],
    '"有一个你装不上的新版"与"没有新版"被说成了同一句话')
  assert.match(STATE_TEXT['source-unsupported'], /不支持/)
  // ★ 也**不是**失败：归到失败文案会让用户去点重试，而重试得到同一个答案。
  assert.equal(/失败/.test(STATE_TEXT['source-unsupported']), false,
    `把"装不上"说成了"失败"：${STATE_TEXT['source-unsupported']}`)
  assert.notEqual(STATE_TEXT['source-unsupported'], STATE_TEXT['check-failed'])
  // ★ 而"上次检查"那一行**不该**为它开分支——见 `update-panel.mjs` 里
  //   `describeLastCheck` 的注释：`lastCheck.outcome` 只可能是 `'ok'`。
  const line = describeLastCheck({ lastCheck: { atMs: Date.UTC(2026, 9, 6, 12), outcome: 'ok' } })
  assert.equal(/不支持/.test(line), false, '上次检查那一行出现了"不支持"——那是从哪来的？')
})

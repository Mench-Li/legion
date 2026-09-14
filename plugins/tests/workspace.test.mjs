// PRT-315 切片 4：workspace / worktree 隔离（`plugins/src/workspace.ts`）
//
// ## 这个文件为什么在本批才可能出现
//
// `prepareWorktree` 此前是 `index.ts` 的 `spaceWorker()` 闭包里的一个函数——它从闭包隐式捕获
// `config` / `log` / `runGit` / `activity` / `spaceBinding` / `worktreeRootFor` / `repoRootFor` /
// `ensurePrePushGuard`，而它的**调用者**（`runWorker`）是那个 3000 行闭包里的派工循环。
// 要想单测「建 / 复用 / 重新挂载」这三条分支里的任何一条，唯一的办法是**把整个守护跑起来**
// 并真的在磁盘上建出 git 仓库——所以此前只有端到端用例覆盖主路径，
// 而「残留空壳清理」这条**只有崩过才会走到**的分支，一条用例都没有。
//
//   > 一个"只有把整个守护跑起来、并且真的崩过一次"才能验证的分支，
//   > 与一个"根本没有这条分支"，在没有事故的时候是同一个东西——
//   > 只不过前者会在真出事的那一次，第一次被执行。
//
// 拆出来之后，这个文件用**替身 `runGit` + 真实临时目录**驱动全部分支：
// 不建 git 仓库、不碰真仓库，但 argv 与调用顺序逐字断言。
//
// ## 本文件**不**重复验证"搬得对不对"
//
// 「搬过来的代码与原 `index.ts` 里内联的那几段逐字相同」由构建期脚本
// `_prt-handoff/prt315d-compare.mjs` 验证（按锚点抽出旧块、与新模块归一化对拍，
// 只放行 4 条已声明的注入改写规则）。本文件只管**行为**。
//
// ## 诚实边界（写在这里，免得被读成"真 git 也验过了"）
//
// `runGit` 是**替身**：本文件证明的是"我们发出了哪些 argv、在这个返回值下走哪条分支"，
// **不**证明真实 `git worktree add` / `git rev-parse` 的行为，也不证明 `rmSync` 在真实
// worktree 上的后果。真实副作用的覆盖来自继承来的端到端用例
// （`worker-regression.test.mjs` 里 isolate 那几条会真在磁盘上建 worktree）。
// 另外 `writeFileSync(..., { mode: 0o755 })` 的**权限位**在 Windows 上不生效，
// 本文件只断言脚本内容，不断言 mode。
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWorkspace } from '../lib/workspace.js'

/** 真实的 fetch：`stubFetch` 要还原到的那个（不是"上一个替身"）。 */
const REAL_FETCH = globalThis.fetch

// ── 夹具 ─────────────────────────────────────────────────────────────────────

/**
 * 组装一个被测 workspace 模块。
 *
 * ★ 绑定状态挂在 `h.state` 上，而模块拿到的是 `{ get, set }` 访问器——
 * 这正是 `index.ts` 的接线形态（`let spaceBinding` + 两个箭头）。用例改 `h.state.value`
 * 等于复现 `refreshSpaceBinding()` 的真实赋值，而不是"改了一个模块根本没读的字段"
 * （切片 2/3 都踩过这一类假绿：`const { hubPost } = deps` 之后改 `deps.hubPost` 毫无影响）。
 *
 * ★ `runGit` 默认实现只模拟**分支存在性**与 `rev-parse` 的失败口径：
 * `rev-parse --verify` 按 `over.branchExists` 返回，`rev-parse --show-toplevel` 返回 128
 * （非仓库），其余一律成功。要模拟 git 的**目录副作用**（`worktree add` 真的建出目录）
 * 用 `over.onGit` 返回一个结果，返回 `undefined` 即落回默认实现。
 *
 * 真实临时目录是必需的：被测代码用 `existsSync` / `rmSync` / `mkdirSync` / `writeFileSync`
 * 判断"复用还是重建"、并装 pre-push 钩子。**不进 git**：`runGit` 全是替身。
 */
function harness(over = {}) {
  const root = over.root ?? mkdtempSync(join(tmpdir(), 'legion-ws-'))
  const state = over.state ?? { value: over.binding ?? null }
  const calls = []
  const logs = []
  const activities = []
  const sets = []
  const deps = {
    config: {
      repoRoot: over.repoRoot ?? root,
      workspace: over.workspace ?? join(root, 'space-dir'),
      ...(over.worktreeRoot !== undefined ? { worktreeRoot: over.worktreeRoot } : {}),
    },
    log: (m) => { logs.push(m) },
    runGit: async (repoRoot, args) => {
      calls.push({ repoRoot, args: [...args] })
      if (over.gitThrows) throw new Error('git 挂了')
      if (typeof over.onGit === 'function') {
        const r = over.onGit({ repoRoot, args: [...args], n: calls.length })
        if (r !== undefined) return r
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return over.branchExists
          ? { code: 0, out: `${args[2]}\n`, err: '' }
          : { code: 1, out: '', err: 'fatal: Needed a single revision' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { code: 128, out: '', err: 'fatal: not a git repository' }
      }
      return { code: 0, out: '', err: '' }
    },
    scope: over.scope ?? 'app',
    useHub: () => over.useHub ?? false,
    hubUrl: () => over.hubUrl ?? 'http://hub.local',
    binding: {
      get: () => state.value,
      set: (b) => { sets.push(b); state.value = b },
    },
    activity: (kind, taskId, text) => { activities.push({ kind, taskId, text }) },
  }
  const ws = createWorkspace(deps)
  return { ws, deps, calls, logs, activities, sets, state, root, over, config: deps.config }
}

/** 夹具 + 临时目录清理（用例结束删树）。 */
function tmp(t, over = {}) {
  const h = harness(over)
  t.after(() => rmSync(h.root, { recursive: true, force: true }))
  return h
}

/** 只取 argv 数组（逐字断言用）。 */
const argv = (h) => h.calls.map(c => c.args)

/** 装一个假的 fetch，并在用例结束后还原**真实** fetch（`refreshSpaceBinding` 用全局 fetch）。 */
function stubFetch(t, handler) {
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(url)
    const r = handler(url)
    if (r === undefined) return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => r }
  }
  t.after(() => { globalThis.fetch = REAL_FETCH })
  return urls
}

/** `worktree add` 成功的替身：按 argv 形态建出目录 + `.git`（模拟 git 的目录副作用）。 */
function gitCreatesWorktree() {
  return ({ args }) => {
    if (args[0] !== 'worktree' || args[1] !== 'add') return undefined
    const dir = args[2] === '-b' ? args[4] : args[2]
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/w/T-1\n')
    return { code: 0, out: '', err: '' }
  }
}

const GUARD_LOG = '已安装 pre-push 守卫（拦截 w/* 分支 push）'

// ── 静态契约 ─────────────────────────────────────────────────────────────────

test('模块出口齐全：六个方法都在（钩子安装是内部实现，不对外导出）', (t) => {
  const h = tmp(t)
  for (const k of ['refreshSpaceBinding', 'repoRootFor', 'workspaceFor', 'worktreeRootFor', 'prepareWorktree', 'commitWorktree']) {
    assert.equal(typeof h.ws[k], 'function', `缺少出口 ${k}`)
  }
  // 出参即全部：没有可被别处顺手读写的模块级状态。
  assert.deepEqual(Object.keys(h.ws).sort(), ['commitWorktree', 'prepareWorktree', 'refreshSpaceBinding', 'repoRootFor', 'workspaceFor', 'worktreeRootFor'])
  assert.equal(h.ws.ensurePrePushGuard, undefined, 'ensurePrePushGuard 只被 prepareWorktree 调用，不对调用方导出')
})

// ── 1. 根解析：无绑定回退注入配置 ─────────────────────────────────────────────

test('无绑定：repoRootFor/workspaceFor 回退注入配置，worktreeRootFor 由 repoRoot 派生', (t) => {
  const h = tmp(t)
  assert.equal(h.state.value, null)
  assert.equal(h.ws.repoRootFor(), h.config.repoRoot)
  assert.equal(h.ws.workspaceFor(), h.config.workspace)
  assert.equal(h.ws.worktreeRootFor(), join(h.config.repoRoot, '.legion-worktrees'))
})

test('显式配置 worktreeRoot 时优先用它（不再拼 .legion-worktrees）', (t) => {
  const explicit = join(tmpdir(), 'legion-ws-explicit-root')
  const h = tmp(t, { worktreeRoot: explicit })
  assert.equal(h.ws.worktreeRootFor(), explicit)
  // 与绑定无关：显式配置是**最高优先**的那一项，短路口在 repoRootFor 之前
  h.state.value = { localDir: 'C:/space', repoRoot: 'C:/repo', remoteUrl: '' }
  assert.equal(h.ws.worktreeRootFor(), explicit)
})

test('有绑定：三项全部按绑定解析（隔离仓库根 = 绑定的 repoRoot）', (t) => {
  const h = tmp(t, { binding: { localDir: 'C:/space', repoRoot: 'C:/repo', remoteUrl: 'https://x' } })
  assert.equal(h.ws.repoRootFor(), 'C:/repo')
  assert.equal(h.ws.workspaceFor(), 'C:/space')
  assert.equal(h.ws.worktreeRootFor(), join('C:/repo', '.legion-worktrees'))
})

test('★ 绑定走取值函数不是快照：构造后换绑定，三项立刻跟着变', (t) => {
  // `spaceBinding` 在 `index.ts` 里是 `let`，`refreshSpaceBinding()` 每轮扫单会**重新赋值**。
  // 快照住它的模块会**一直用注入默认仓库**——症状是"空间明明绑定了本地文件夹，
  // worktree 还是建在注入的 repoRoot 下"，日志里只有一行"绑定刷新"，看不出错。
  //   > 一个"构造时快照了绑定"的模块，
  //   > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
  //   > 只不过前者会在绑定变化之后，安静地继续按旧的来。
  const h = tmp(t)
  assert.equal(h.ws.repoRootFor(), h.config.repoRoot)

  h.state.value = { localDir: 'C:/space', repoRoot: 'C:/repo', remoteUrl: '' } // —— 与 refreshSpaceBinding 的真实赋值同形
  assert.equal(h.ws.repoRootFor(), 'C:/repo', '★ 换绑定之后必须立刻用新仓库根')
  assert.equal(h.ws.workspaceFor(), 'C:/space')
  assert.equal(h.ws.worktreeRootFor(), join('C:/repo', '.legion-worktrees'))
})

test('★ 两个实例各自持有绑定：一个空间换绑定不得影响另一个空间', (t) => {
  // `superviseSpaces()` 在**同一进程**里按空间 mount 多个 `spaceWorker`，它们共用一个模块注册表。
  // 绑定若做成模块级变量，空间 A 的仓库根会盖掉空间 B 的——worktree 建进别的仓库，且不报错。
  //   > 一个"每实例一份"的访问器，
  //   > 与一个"每进程一份"的模块级变量，在只有一个守护实例的部署里是同一个东西——
  //   > 只不过多空间部署下，后者会让第二个空间的 worktree 建进第一个空间的仓库。
  const a = tmp(t, { binding: { localDir: 'C:/a', repoRoot: 'C:/repo-a', remoteUrl: '' } })
  const b = tmp(t, { binding: { localDir: 'C:/b', repoRoot: 'C:/repo-b', remoteUrl: '' } })
  assert.equal(a.ws.repoRootFor(), 'C:/repo-a')
  assert.equal(b.ws.repoRootFor(), 'C:/repo-b')

  a.state.value = null // 空间 A 的绑定被清掉
  assert.equal(a.ws.repoRootFor(), a.config.repoRoot)
  assert.equal(b.ws.repoRootFor(), 'C:/repo-b', '★ 空间 B 的绑定不得被空间 A 的赋值带走')
  assert.equal(b.ws.workspaceFor(), 'C:/b')
})

// ── 2. refreshSpaceBinding：hub → 绑定的解析与落位 ───────────────────────────

test('hub 未启用：一发请求都不发，绑定保持原值', async (t) => {
  const h = tmp(t, { useHub: false })
  const urls = stubFetch(t, () => undefined)
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(urls, [])
  assert.deepEqual(h.sets, [])
  assert.deepEqual(h.logs, [])
  assert.equal(h.state.value, null)
})

test('★ hub 命中 localDir：按 /api/spaces 解析绑定，仓库根取所属仓库的 toplevel', async (t) => {
  const h = tmp(t, {
    useHub: true,
    hubUrl: 'http://hub.local',
    onGit: ({ args }) => (args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? { code: 0, out: 'C:/real-repo\n', err: '' } : undefined),
  })
  const urls = stubFetch(t, () => ({ spaces: [{ id: 'app', localDir: 'C:/real-repo/sub', remoteUrl: ' https://git/x ' }] }))
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(urls, ['http://hub.local/api/spaces'])
  assert.deepEqual(argv(h), [['rev-parse', '--show-toplevel']])
  assert.equal(h.calls[0].repoRoot, 'C:/real-repo/sub', '探测 toplevel 用**所选目录**作 cwd')
  assert.deepEqual(h.sets, [{ localDir: 'C:/real-repo/sub', repoRoot: 'C:/real-repo', remoteUrl: 'https://git/x' }])
  assert.equal(h.state.value.repoRoot, 'C:/real-repo')
  assert.deepEqual(h.logs, ['空间仓库绑定：scope=app → 本地文件夹=C:/real-repo/sub（隔离仓库根=C:/real-repo；远程=https://git/x）'])
})

test('命中 localDir 但不在 git 仓库里（rev-parse 失败）→ 沿用所选目录当仓库根', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => ({ spaces: [{ id: 'app', localDir: 'C:/plain-dir' }] })) // 默认替身：show-toplevel → code 128
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(h.sets, [{ localDir: 'C:/plain-dir', repoRoot: 'C:/plain-dir', remoteUrl: '' }])
  assert.equal(h.logs[0], '空间仓库绑定：scope=app → 本地文件夹=C:/plain-dir（隔离仓库根=C:/plain-dir；远程=仅本地 / 不进共享仓库）')
})

test('scope 未命中 / localDir 为空 → 绑定被置 null 并记"未配置"', async (t) => {
  const h = tmp(t, { useHub: true, binding: { localDir: 'C:/old', repoRoot: 'C:/old', remoteUrl: '' } })
  stubFetch(t, () => ({ spaces: [{ id: 'other', localDir: 'C:/x' }] }))
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(h.sets, [null])
  assert.equal(h.state.value, null)
  assert.deepEqual(h.logs, [`空间仓库绑定：scope=app 未配置，沿用注入默认仓库（repoRoot=${h.config.repoRoot}）`])

  // localDir 只有空白字符 → 同样视为未配置（已有绑定也会被清掉）
  const h2 = tmp(t, { useHub: true, binding: { localDir: 'C:/old', repoRoot: 'C:/old', remoteUrl: '' } })
  stubFetch(t, () => ({ spaces: [{ id: 'app', localDir: '   ' }] }))
  await h2.ws.refreshSpaceBinding()
  assert.equal(h2.state.value, null)
  assert.deepEqual(h2.sets, [null])
})

test('★ 值没变就不写、也不记日志（比较 localDir / repoRoot 两项）', async (t) => {
  // 每轮扫单都调一次刷新；"没变也记一行日志"会把守护日志刷成噪音，
  // "没变也 set"则会让下游每次都看到"变了"。
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => ({ spaces: [{ id: 'app', localDir: 'C:/same' }] }))
  await h.ws.refreshSpaceBinding()
  assert.equal(h.sets.length, 1)
  assert.equal(h.logs.length, 1)

  await h.ws.refreshSpaceBinding() // § 同一份返回
  assert.equal(h.sets.length, 1, '★ 值没变不得再 set')
  assert.equal(h.logs.length, 1, '★ 值没变不得再记日志')

  // repoRoot 变了（同一 localDir，但探测到的 toplevel 不同）→ 必须重写
  const h2 = tmp(t, {
    useHub: true,
    onGit: ({ args, n }) => (args[1] === '--show-toplevel' ? (n === 1 ? { code: 128, out: '', err: '' } : { code: 0, out: 'C:/toplevel\n', err: '' }) : undefined),
  })
  stubFetch(t, () => ({ spaces: [{ id: 'app', localDir: 'C:/same' }] }))
  await h2.ws.refreshSpaceBinding()
  assert.equal(h2.sets.length, 1)
  await h2.ws.refreshSpaceBinding()
  assert.equal(h2.sets.length, 2, 'localDir 相同但 repoRoot 变了 → 必须重写绑定')
  assert.equal(h2.logs.length, 2)
})

test('hub 请求抛错 → 吞掉并记日志，绑定保持原值（下轮再试）', async (t) => {
  const h = tmp(t, { useHub: true, binding: { localDir: 'C:/kept', repoRoot: 'C:/kept', remoteUrl: '' } })
  globalThis.fetch = async () => { throw new Error('hub 挂了') }
  t.after(() => { globalThis.fetch = REAL_FETCH })
  await assert.doesNotReject(h.ws.refreshSpaceBinding())
  assert.deepEqual(h.logs, ['空间仓库绑定刷新失败（沿用注入默认）：Error: hub 挂了'])
  assert.equal(h.state.value.repoRoot, 'C:/kept', '刷新失败不得把已有绑定清掉')
  assert.deepEqual(h.sets, [])
})

test('hub 返回非 200 → 直接返回，绑定不动、不记日志', async (t) => {
  const h = tmp(t, { useHub: true })
  stubFetch(t, () => undefined) // ok:false
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(h.sets, [])
  assert.deepEqual(h.logs, [])
})

test('★ hubUrl / useHub 也是取值函数：构造后改写立刻生效，不是快照', async (t) => {
  const h = tmp(t, { useHub: false, hubUrl: 'http://old' })
  const urls = stubFetch(t, () => ({ spaces: [] }))
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(urls, [], 'hub 未启用：不发')

  h.over.useHub = true // —— 与 detectHub() 的真实改写同形
  h.over.hubUrl = 'http://new'
  await h.ws.refreshSpaceBinding()
  assert.deepEqual(urls, ['http://new/api/spaces'], '★ 探测到 hub / 换地址之后必须立刻用新值')
})

// ── 3. prepareWorktree：新建 ─────────────────────────────────────────────────

test('★ 全新任务：rev-parse 探测分支 → worktree add -b（argv 逐字）', async (t) => {
  const h = tmp(t, { branchExists: false })
  const dir = join(h.ws.worktreeRootFor(), 'T-1')
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, dir)
  assert.deepEqual(argv(h), [
    ['rev-parse', '--verify', 'w/T-1'],
    ['worktree', 'add', '-b', 'w/T-1', dir, 'HEAD'],
  ])
  assert.equal(h.calls[0].repoRoot, h.ws.repoRootFor())
  assert.equal(h.calls[1].repoRoot, h.ws.repoRootFor())
  assert.deepEqual(h.activities, [{ kind: 'worktree', taskId: 'T-1', text: `隔离 worktree 就绪：${dir}（分支 w/T-1）` }])
  // 第一步永远是装守卫（幂等），第二步才判断目录
  assert.deepEqual(h.logs, [GUARD_LOG])
})

test('★ git 一律在**绑定的**仓库里执行，目录也建在绑定仓库根下', async (t) => {
  const h = tmp(t, { branchExists: false })
  const boundRoot = join(h.root, 'bound-repo') // 落在临时目录里，守卫会真的建出 .git/hooks（用完随临时树删掉）
  h.state.value = { localDir: join(h.root, 'space'), repoRoot: boundRoot, remoteUrl: '' }
  const dir = join(boundRoot, '.legion-worktrees', 'T-7')
  assert.notEqual(boundRoot, h.config.repoRoot, '夹具里两者必须不同，下面那条断言才有意义')

  const out = await h.ws.prepareWorktree('T-7')
  assert.equal(out, dir)
  assert.deepEqual(argv(h), [
    ['rev-parse', '--verify', 'w/T-7'],
    ['worktree', 'add', '-b', 'w/T-7', dir, 'HEAD'],
  ])
  assert.deepEqual(h.calls.map(c => c.repoRoot), [boundRoot, boundRoot], '★ 必须用绑定的仓库根，不是注入的 config.repoRoot')
  assert.equal(existsSync(join(boundRoot, '.git', 'hooks', 'pre-push')), true, '守卫装在**绑定仓库**里（也走 repoRootFor）')
  assert.deepEqual(h.logs, [GUARD_LOG])
  assert.equal(h.activities[0].text, `隔离 worktree 就绪：${dir}（分支 w/T-7）`)
})

test('显式 worktreeRoot：目录建在配置的根下（argv 里的 dir 逐字）', async (t) => {
  const wtRoot = join(tmpdir(), 'legion-ws-wtroot')
  const h = tmp(t, { branchExists: false, worktreeRoot: wtRoot })
  const dir = join(wtRoot, 'T-9')
  const out = await h.ws.prepareWorktree('T-9')
  assert.equal(out, dir)
  assert.deepEqual(argv(h)[1], ['worktree', 'add', '-b', 'w/T-9', dir, 'HEAD'])
})

// ── 4. prepareWorktree：复用 / 重新挂载 ──────────────────────────────────────

test('★ 复用既有 worktree：一发 git 命令都不发（argv 为空），且不动目录内容', async (t) => {
  const h = tmp(t)
  const dir = join(h.ws.worktreeRootFor(), 'T-1')
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, 'WIP.txt'), '上一轮未提交的改动\n')

  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, dir)
  assert.deepEqual(argv(h), [], '★ 复用 = 不重建：不得发 worktree add（更不得 remove）')
  assert.equal(readFileSync(join(dir, 'WIP.txt'), 'utf8'), '上一轮未提交的改动\n')
  assert.deepEqual(h.activities, [{ kind: 'worktree', taskId: 'T-1', text: `复用既有 worktree：${dir}（分支 w/T-1）` }])
  assert.deepEqual(h.logs, [GUARD_LOG, `T-1 复用既有 worktree：${dir}`])
})

test('★ 两次派工同一个任务：第二次复用第一次建的目录，WIP 还在、git 一次都不再发', async (t) => {
  const h = tmp(t, { branchExists: false, onGit: gitCreatesWorktree() })
  const first = await h.ws.prepareWorktree('T-1')
  assert.equal(first, join(h.ws.worktreeRootFor(), 'T-1'))
  assert.deepEqual(argv(h), [['rev-parse', '--verify', 'w/T-1'], ['worktree', 'add', '-b', 'w/T-1', first, 'HEAD']])
  writeFileSync(join(first, 'WIP.txt'), '第一轮的部分产出\n')

  const second = await h.ws.prepareWorktree('T-1')
  assert.equal(second, first)
  assert.equal(h.calls.length, 2, '★ 第二次不得再发任何 git 命令')
  assert.equal(readFileSync(join(first, 'WIP.txt'), 'utf8'), '第一轮的部分产出\n', '★ 复用不得丢掉上一轮的部分改动')
  assert.equal(h.activities[1].text, `复用既有 worktree：${first}（分支 w/T-1）`)
})

test('★ 目录被清了但分支还在：从分支重新挂载（argv 不带 -b）', async (t) => {
  const h = tmp(t, { branchExists: true })
  const dir = join(h.ws.worktreeRootFor(), 'T-1')
  assert.equal(existsSync(dir), false)
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, dir)
  assert.deepEqual(argv(h), [
    ['rev-parse', '--verify', 'w/T-1'],
    ['worktree', 'add', dir, 'w/T-1'],
  ], '★ 重新挂载不得带 -b（带 -b 会因分支已存在而失败，把上一轮的 WIP 分支整个丢掉）')
  assert.deepEqual(h.activities, [{ kind: 'worktree', taskId: 'T-1', text: `复用分支 w/T-1：${dir}` }])
})

test('★ 残留空壳（目录在、.git 不在）：真删掉再重建 —— 这条只有崩过才会走到', async (t) => {
  // 场景：上次 daemon 在 `mkdir` 之后、`git worktree add` 之前死掉，或 add 半途失败，
  // 留下一个**非 worktree 的目录壳**。git worktree add 会因"目录非空"直接失败，
  // 于是每一轮派工都失败、任务永远开不了工——所以这里必须真的清掉。
  const h = tmp(t, { branchExists: false })
  const dir = join(h.ws.worktreeRootFor(), 'T-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stale.txt'), '崩溃残留\n')

  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, dir)
  assert.equal(existsSync(join(dir, 'stale.txt')), false, '★ 残留壳必须被清掉（否则 git worktree add 会一直失败）')
  assert.deepEqual(argv(h), [
    ['rev-parse', '--verify', 'w/T-1'],
    ['worktree', 'add', '-b', 'w/T-1', dir, 'HEAD'],
  ], '清理发生在 rev-parse 之前：先清壳，再判断分支')
  assert.deepEqual(h.activities, [{ kind: 'worktree', taskId: 'T-1', text: `隔离 worktree 就绪：${dir}（分支 w/T-1）` }])
})

test('★ 残留空壳 + 分支仍在：清壳之后走"从分支挂载"（不是新建）', async (t) => {
  const h = tmp(t, { branchExists: true })
  const dir = join(h.ws.worktreeRootFor(), 'T-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stale.txt'), '崩溃残留\n')
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, dir)
  assert.equal(existsSync(join(dir, 'stale.txt')), false)
  assert.deepEqual(argv(h)[1], ['worktree', 'add', dir, 'w/T-1'])
  assert.equal(h.activities[0].text, `复用分支 w/T-1：${dir}`)
})

// ── 5. prepareWorktree：失败一律返回 null，由调用方回退 ──────────────────────

test('★ 新建失败 → null + 日志，且不记"就绪"事件', async (t) => {
  const h = tmp(t, {
    branchExists: false,
    onGit: ({ args }) => (args[0] === 'worktree' ? { code: 128, out: '', err: '  fatal: could not create  \n' } : undefined),
  })
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, null)
  assert.deepEqual(h.activities, [], '★ 失败不得记"worktree 就绪"（看板会把回退读成隔离成功）')
  assert.deepEqual(h.logs, [GUARD_LOG, 'T-1 worktree 创建失败：fatal: could not create'])
})

test('★ 从分支挂载失败 → null + 专门的日志串（与新建失败区分开）', async (t) => {
  const h = tmp(t, {
    branchExists: true,
    onGit: ({ args }) => (args[0] === 'worktree' ? { code: 128, out: 'already exists\n', err: '' } : undefined),
  })
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, null)
  assert.deepEqual(h.activities, [])
  assert.deepEqual(h.logs, [GUARD_LOG, 'T-1 从分支 w/T-1 挂载 worktree 失败：already exists'], 'err 为空时用 out（两者都空才是空串）')
})

test('★ git 抛异常 → 吞掉、返回 null、不抛给调用方', async (t) => {
  const h = tmp(t, { gitThrows: true })
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, null)
  assert.deepEqual(h.logs, [GUARD_LOG, 'T-1 prepareWorktree 异常：Error: git 挂了'])
})

test('★ 失败不让调用方"静默继续"：runWorker 的 4 行回退照抄，cwd 回到 workspaceFor()', async (t) => {
  // `index.ts` 的 runWorker 是：
  //     let cwd = workspaceFor()
  //     if (config.isolate) { worktreeDir = await prepareWorktree(t.id); if (worktreeDir !== null) cwd = worktreeDir }
  // 这里把那 4 行照抄一遍，钉住"null = 回退"这条契约：失败时 cwd 必须还是工作目录，
  // 而且不得留下半成品目录（否则下一轮会把它当成"既有 worktree"复用）。
  const h = tmp(t, {
    branchExists: false,
    onGit: ({ args }) => (args[0] === 'worktree' ? { code: 128, out: '', err: 'fatal: nope' } : undefined),
  })
  let cwd = h.ws.workspaceFor()
  let worktreeDir = null
  if (true /* config.isolate */) {
    worktreeDir = await h.ws.prepareWorktree('T-1')
    if (worktreeDir !== null) cwd = worktreeDir
  }
  assert.equal(worktreeDir, null)
  assert.equal(cwd, h.ws.workspaceFor(), '★ 失败必须回退到 workspace 目录（不得把 null 当目录用）')
  assert.deepEqual(h.activities, [], '失败不得留下"worktree 就绪"事件')
  assert.equal(existsSync(join(h.ws.worktreeRootFor(), 'T-1')), false, '★ 失败后不得留下半成品目录（下一轮会当成既有 worktree 复用）')
})

// ── 6. pre-push 守卫（prepareWorktree 的第一步，幂等）────────────────────────

test('★ 全新仓库：装 pre-push 守卫，脚本内容与放行/拦截口径逐字写入', async (t) => {
  const h = tmp(t, { branchExists: false })
  await h.ws.prepareWorktree('T-1')
  const hook = join(h.root, '.git', 'hooks', 'pre-push')
  assert.equal(existsSync(hook), true)
  const body = readFileSync(hook, 'utf8')
  assert.match(body, /^#!\/bin\/sh/)
  assert.match(body, /# legion worktree guard：禁止 push worktree 分支（w\/\*）；普通分支放行/)
  assert.match(body, /refs\/heads\/w\/\*\) echo "legion: worktree 分支 w\/\* 禁止 push（须经 promote 合并回主分支）" >&2; exit 1/)
  assert.match(body, /\nexit 0\n$/)
  assert.deepEqual(h.logs, [GUARD_LOG])
})

test('★ 守卫幂等：已装过（含 marker）→ 不重写、不记日志', async (t) => {
  const h = tmp(t, { branchExists: false })
  const hook = join(h.root, '.git', 'hooks', 'pre-push')
  mkdirSync(join(h.root, '.git', 'hooks'), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\n# legion worktree guard：我自己的版本\n')
  await h.ws.prepareWorktree('T-1')
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\n# legion worktree guard：我自己的版本\n', '★ 已装过不得覆盖（可能是将军手改过的版本）')
  assert.deepEqual(h.logs, [])
})

test('★ 已有自定义 pre-push（不含 marker）→ 不动它，只记一行提示', async (t) => {
  const h = tmp(t, { branchExists: false })
  const hook = join(h.root, '.git', 'hooks', 'pre-push')
  mkdirSync(join(h.root, '.git', 'hooks'), { recursive: true })
  writeFileSync(hook, '#!/bin/sh\necho 我的自定义钩子\n')
  await h.ws.prepareWorktree('T-1')
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\necho 我的自定义钩子\n')
  assert.deepEqual(h.logs, ['检测到已有自定义 pre-push 钩子，跳过安装守卫（请自行确保 w/* 分支不被 push）'])
})

test('★ 守卫安装失败 → 吞掉、记日志，worktree 流程照常继续（守卫只是尽力而为）', async (t) => {
  const h = tmp(t, { branchExists: false })
  mkdirSync(join(h.root, '.git'), { recursive: true })
  writeFileSync(join(h.root, '.git', 'hooks'), '这是个文件，不是目录\n') // 让 mkdirSync(hooksDir) 抛 EEXIST
  const dir = join(h.ws.worktreeRootFor(), 'T-1')
  const out = await h.ws.prepareWorktree('T-1')
  assert.equal(out, dir, '★ 守卫失败不得让 worktree 建不起来')
  assert.match(h.logs[0], /^pre-push 守卫安装失败：Error: EEXIST/, `首行应为安装失败日志：${h.logs[0]}`)
  assert.deepEqual(h.activities, [{ kind: 'worktree', taskId: 'T-1', text: `隔离 worktree 就绪：${dir}（分支 w/T-1）` }])
})

// ── 7. commitWorktree：把改动提交回 w/<id> ───────────────────────────────────

test('★ commitWorktree argv 逐字：add -A 然后 commit -m "T-1：<摘要>"（cwd = 传入的 dir）', async (t) => {
  const h = tmp(t)
  const ok = await h.ws.commitWorktree('T-1', 'C:/wt/T-1', '完成登录页')
  assert.equal(ok, true)
  assert.deepEqual(argv(h), [
    ['add', '-A'],
    ['commit', '-m', 'T-1：完成登录页'],
  ])
  assert.deepEqual(h.calls.map(c => c.repoRoot), ['C:/wt/T-1', 'C:/wt/T-1'], '★ 提交必须在 worktree 里执行，不是仓库根')
  assert.deepEqual(h.logs, [])
})

test('★ add 失败 → false + 日志，并且**不再发 commit**', async (t) => {
  const h = tmp(t, { onGit: ({ args }) => (args[0] === 'add' ? { code: 1, out: '', err: '  fatal: add 挂了  ' } : undefined) })
  const ok = await h.ws.commitWorktree('T-1', 'C:/wt/T-1', 's')
  assert.equal(ok, false)
  assert.deepEqual(argv(h), [['add', '-A']], '★ add 失败必须短路，不得继续 commit')
  assert.deepEqual(h.logs, ['T-1 git add 失败：fatal: add 挂了'])
})

test('★ commit 失败 → false + 日志用 (err || out)（err 空时退到 out）', async (t) => {
  const h = tmp(t, { onGit: ({ args }) => (args[0] === 'commit' ? { code: 1, out: 'nothing to commit\n', err: '' } : undefined) })
  const ok = await h.ws.commitWorktree('T-1', 'C:/wt/T-1', 's')
  assert.equal(ok, false)
  assert.deepEqual(argv(h), [['add', '-A'], ['commit', '-m', 'T-1：s']])
  assert.deepEqual(h.logs, ['T-1 git commit 失败：nothing to commit'])
})

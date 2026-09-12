// orchestrator/workspace/workspace.test.mjs
// ============================================================================
// workspace / worktree 管理（PRT-306）的用例
//
// 这一组问的是「下一次执行在哪个目录里改文件」。判错的后果**都不是报错**：
//   - 工作区按 Task 而不是按 Attempt 分配 → 重试继承上一次的半成品改动，
//     于是"上次改坏了"的东西这次看起来是"已经改好了"，任务在错误的基础上"通过"；
//   - worktree 落在仓库内部 → 它出现在主仓库的 git status 里，
//     另一个 worker 的 `git add -A` 把它整棵树提交走；
//   - 回收时"尽力清理" → 删掉一次尝试唯一的一份未提交成果。
//
// 因此用例的重点在**拒绝**：拒绝不安全 id、拒绝嵌套布局、拒绝覆盖陌生目录、
// 拒绝回收脏工作区、拒绝把"git 说成功"当成"工作区可用"。
//
// 大部分用例跑**真 git**（在临时目录里 init 一个仓库）：`git worktree` 的语义
// 太容易记错，用假 git 测等于在测自己的想象。少数拒绝路径用注入的假 git，
// 因为那些情形（登记表里没有它、读不出状态）很难用真 git 摆出来。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import {
  INTENT_SUFFIX,
  WORKSPACE_ERRORS,
  WorkspaceError,
  createWorkspace,
  defaultRunGit,
  encodeId,
  inspectSlot,
  parseWorktreeList,
  planWorkspace,
  readIntent,
  reclaimWorkspace,
  worktreeDirt,
  worktreeStages,
} from './index.mjs'

const GIT = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch { return false }
})()
const skipIfNoGit = GIT ? false : '本机没有 git'

let root = ''
let repoDir = ''
let baseDir = ''

/** 在一个临时目录里建一个真仓库（一个有提交的主分支）。 */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'README.md'), '# repo\n', 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return dir
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'legion-ws-'))
  repoDir = makeRepo(join(root, 'repo'))
  // 基准目录在仓库**外面**（真实布局：DataDir/worktrees）。
  baseDir = join(root, 'data', 'worktrees')
  mkdirSync(baseDir, { recursive: true })
})

after(() => { rmSync(root, { recursive: true, force: true }) })

const attemptIds = { n: 0 }
function plan(extra = {}) {
  attemptIds.n += 1
  return planWorkspace({
    repoDir, worktreeBaseDir: baseDir,
    scope: extra.scope ?? 'default',
    taskId: extra.taskId ?? `T-${attemptIds.n}`,
    attemptId: extra.attemptId ?? `att-${attemptIds.n}`,
    baseRef: extra.baseRef ?? 'HEAD',
    ...extra,
  })
}

test('① 工作区**按 Attempt** 分配：同一任务的重试拿到不同的槽位', () => {
  // 这是本模块最核心的一条。按 Task 分配时，重试会继承上一次的半成品改动——
  // 于是"上次改坏了"的东西这次看起来是"已经改好了"。
  const a1 = plan({ taskId: 'T-same', attemptId: 'att:T-same:1' })
  const a2 = plan({ taskId: 'T-same', attemptId: 'att:T-same:2' })
  assert.notEqual(a1.slotDir, a2.slotDir, '两次尝试不得共用同一个目录')
  // 真实的 Attempt id 是 `att:<taskId>:<n>`，**含冒号**，而冒号在 Windows 上是
  // 非法文件名字符。因此 id 必须先被编码——不能指望它恰好干净。
  // （只看最后一段：绝对路径的盘符本身就带冒号，`C:\…`。）
  assert.ok(!a1.slotDir.split(/[\\/]/).pop().includes(':'), `目录名不得含冒号：${a1.slotDir}`)
  assert.ok(!a1.branch.split('/').pop().includes(':'), `分支名不得含冒号：${a1.branch}`)
  assert.match(a1.slotDir, /att%3AT-same%3A1$/)
  assert.match(a2.slotDir, /att%3AT-same%3A2$/)
  assert.match(a1.branch, /att%3AT-same%3A1$/)
  assert.match(a1.intentFile, new RegExp(`att%3AT-same%3A1${INTENT_SUFFIX.replace('.', '\\.')}$`))
  // 意图文件与槽位**同级**，不在槽位里面：放在里面就得先 mkdir 槽位，
  // 而 `git worktree add` 拒绝往已存在的目录里建工作区。
  // （不能用字符串前缀判断——`X` 是 `X.intent.json` 的前缀。要比父目录。）
  assert.equal(dirname(a1.intentFile), a1.taskDir, '意图文件必须与槽位同级')
  assert.equal(dirname(a1.slotDir), a1.taskDir, '槽位直接落在 taskDir 下')
  assert.ok(!a1.intentFile.startsWith(a1.slotDir + sep), '意图文件不得落进槽位目录里')
})

test('① id 编码是单射的：不同的 id 永不撞进同一个目录', () => {
  // "把冒号替换成连字符"那种做法会撞：`att:T-1:2` 与 `att-T-1-2` 变成同一个名字，
  // 而它们可能是两条不同的尝试。
  assert.equal(encodeId('att:T-1:2'), 'att%3AT-1%3A2')
  assert.notEqual(encodeId('att:T-1:2'), encodeId('att-T-1-2'))
  // `%` 自身必须被转义，否则 (a) 与 (b) 会撞
  assert.notEqual(encodeId('a%3A'), encodeId('a:'))
  assert.equal(encodeId('a%3A'), 'a%253A')
  // 尾部加点在 Windows 上会被静默截断，于是 `a.` 与 `a` 会指同一个目录
  assert.notEqual(encodeId('a.'), encodeId('a'))
  assert.equal(encodeId('a.'), 'a._')
  // 常规 id 原样保留
  assert.equal(encodeId('T-1'), 'T-1')
  assert.equal(encodeId('scope_1'), 'scope_1')
})

test('① 真建一个 worktree，并且能在里面干活；意图文件先落盘', { skip: skipIfNoGit }, () => {
  const p = plan({ taskId: 'T-1', attemptId: 'att-1' })
  const ws = createWorkspace(p)
  assert.equal(ws.kind, 'worktree')
  assert.equal(ws.reused, false)
  assert.ok(existsSync(join(p.slotDir, 'README.md')), '工作区应当是仓库在 baseRef 上的一份检出')
  // 意图文件记着"谁认领了这个槽位"——只记路径的话，崩后重扫答不上它是哪条尝试的
  const intent = readIntent(p.intentFile)
  assert.equal(intent.taskId, 'T-1')
  assert.equal(intent.attemptId, 'att-1')
  assert.equal(intent.branch, p.branch)
  // 在里面改文件是真的改（不影响主仓库）
  writeFileSync(join(p.slotDir, 'work.txt'), 'hello\n', 'utf8')
  assert.ok(existsSync(join(p.slotDir, 'work.txt')))
  assert.ok(!existsSync(join(repoDir, 'work.txt')), '工作区里的改动不得出现在主仓库')
  assert.deepEqual(worktreeDirt(p.slotDir, { runGit: defaultRunGit }), ['?? work.txt'])
})

test('① 幂等：同一 Attempt 重跑会复用它自己建的工作区', { skip: skipIfNoGit }, () => {
  // 崩在"建完之后、执行之前"是正常路径，重扫时重放同一次准备。
  const p = plan({ taskId: 'T-2', attemptId: 'att-2' })
  const first = createWorkspace(p)
  assert.equal(first.reused, false)
  const again = createWorkspace(p)
  assert.equal(again.reused, true, '重跑必须复用，而不是报错或再建一个')
  assert.equal(again.slotDir, first.slotDir)
  assert.equal(again.branch, first.branch)
})

test('② 拒绝嵌套布局：worktree 落在仓库内部会让主仓库的 git status 看见它', () => {
  // 两个方向都要拒。worktree 在仓库里时，另一个 worker 的 `git add -A`
  // 会把它整棵树提交走——本模块不靠"记得加 .gitignore"来防这件事。
  for (const bad of [join(repoDir, 'wt'), join(repoDir, '.data', 'wt'), repoDir]) {
    assert.throws(() => planWorkspace({ repoDir, worktreeBaseDir: bad, scope: 'default', taskId: 'T-1', attemptId: 'a-1' }),
      (e) => e instanceof WorkspaceError && e.code === WORKSPACE_ERRORS.REF_OVERLAP,
      `base=${bad} 必须被拒绝`)
  }
  // 反方向：仓库落在基准目录内部同样拒绝
  assert.throws(
    () => planWorkspace({ repoDir: join(baseDir, 'repo2'), worktreeBaseDir: baseDir, scope: 'default', taskId: 'T-1', attemptId: 'a-1' }),
    (e) => e.code === WORKSPACE_ERRORS.REF_OVERLAP)
})

test('② 拒绝相对路径（相对路径按 worker 的 cwd 解析，两个 worker 会各用一套）', () => {
  assert.throws(() => planWorkspace({ repoDir: 'repo', worktreeBaseDir: baseDir, scope: 's', taskId: 'T-1', attemptId: 'a-1' }),
    (e) => e.code === WORKSPACE_ERRORS.REF_NOT_ABSOLUTE)
  assert.throws(() => planWorkspace({ repoDir, worktreeBaseDir: 'data/wt', scope: 's', taskId: 'T-1', attemptId: 'a-1' }),
    (e) => e.code === WORKSPACE_ERRORS.REF_NOT_ABSOLUTE)
})

test('② 拒绝不安全 id：`..` 与路径分隔符会把工作区指到基准目录之外', () => {
  // 注意"拒绝"的是两类：路径分隔符与纯点点。**冒号不拒**（它被编码），
  // 因为真实的 Attempt id 就含冒号。
  for (const bad of ['../../etc', 'a/b', 'a\\b', '', '.', '..', 'x'.repeat(201)]) {
    assert.throws(
      () => planWorkspace({ repoDir, worktreeBaseDir: baseDir, scope: 'default', taskId: bad, attemptId: 'a-1' }),
      (e) => e.code === WORKSPACE_ERRORS.REF_UNSAFE_ID,
      `taskId=${JSON.stringify(bad)} 必须被拒绝`)
  }
  for (const bad of ['..', 'a/b', '', '.']) {
    assert.throws(
      () => planWorkspace({ repoDir, worktreeBaseDir: baseDir, scope: 'default', taskId: 'T-1', attemptId: bad }),
      (e) => e.code === WORKSPACE_ERRORS.REF_UNSAFE_ID)
    assert.throws(
      () => planWorkspace({ repoDir, worktreeBaseDir: baseDir, scope: bad, taskId: 'T-1', attemptId: 'a-1' }),
      (e) => e.code === WORKSPACE_ERRORS.REF_UNSAFE_ID)
  }
  // 带冒号的真实 id 必须被接受（否则整个模块对真实数据不可用）
  assert.ok(planWorkspace({ repoDir, worktreeBaseDir: baseDir, scope: 'default', taskId: 'T-1', attemptId: 'att:T-1:3' }).slotDir)
})

test('② 没配置仓库时**抛错，不降级**成原地执行', () => {
  // 降级会让两个 worker 在同一个目录里改同一份文件，
  // 而这种冲突不报错——它表现为"改的东西莫名不见了"。
  for (const bad of [null, undefined, '', 42, {}]) {
    assert.throws(
      () => planWorkspace({ repoDir: bad, worktreeBaseDir: baseDir, scope: 's', taskId: 'T-1', attemptId: 'a-1' }),
      (e) => e.code === WORKSPACE_ERRORS.REF_NOT_CONFIGURED, `repoDir=${JSON.stringify(bad)} 必须被拒绝`)
  }
  assert.throws(
    () => planWorkspace({ repoDir, worktreeBaseDir: null, scope: 's', taskId: 'T-1', attemptId: 'a-1' }),
    (e) => e.code === WORKSPACE_ERRORS.REF_NOT_CONFIGURED)
})

test('③ 拒绝覆盖陌生槽位：绝不删掉别人的东西', { skip: skipIfNoGit }, () => {
  // 槽位里有内容、但不是我们登记的 worktree。清理它可能删掉
  // 另一次尝试唯一的一份成果——而它没有别的副本。
  const p = plan({ taskId: 'T-3', attemptId: 'att-3' })
  mkdirSync(p.slotDir, { recursive: true })
  writeFileSync(join(p.slotDir, 'someone-elses-work.txt'), 'precious\n', 'utf8')

  assert.throws(() => createWorkspace(p),
    (e) => e instanceof WorkspaceError && e.code === WORKSPACE_ERRORS.REF_FOREIGN_SLOT)
  assert.ok(existsSync(join(p.slotDir, 'someone-elses-work.txt')), '拒绝时不得删掉那个文件')

  // 回收同样拒绝
  assert.throws(() => reclaimWorkspace(p), (e) => e.code === WORKSPACE_ERRORS.REF_UNKNOWN_SLOT)
  assert.ok(existsSync(join(p.slotDir, 'someone-elses-work.txt')), '回收拒绝时也不得删')
})

test('③ 空槽位（上次崩在这里留下的空壳）可以安全重建', { skip: skipIfNoGit }, () => {
  const p = plan({ taskId: 'T-4', attemptId: 'att-4' })
  mkdirSync(p.slotDir, { recursive: true })
  writeFileSync(p.intentFile, '{"kind":"legion-workspace-intent"}', 'utf8')
  const ws = createWorkspace(p)
  assert.equal(ws.reused, false)
  assert.ok(existsSync(join(p.slotDir, 'README.md')))
})

test('③ 建失败了要收拾自己刚造的残壳，且不留悬空登记', { skip: skipIfNoGit }, () => {
  // 失败后留着残壳，下次 `git worktree add` 就会报"已存在"，
  // 于是这个槽位永久性地坏掉——而它看起来只是"又失败了一次"。
  const p = plan({ taskId: 'T-4b', attemptId: 'att-4b' })
  const failing = ({ args }) => {
    if (args[0] === 'worktree' && args[1] === 'list') return defaultRunGit({ cwd: repoDir, args })
    if (args[0] === 'worktree' && args[1] === 'add') {
      // 模拟"建了一半就死"：造出目录再失败
      mkdirSync(p.slotDir, { recursive: true })
      writeFileSync(join(p.slotDir, 'half.txt'), 'x', 'utf8')
      return { status: 128, stdout: '', stderr: 'fatal: 模拟失败', error: null }
    }
    return defaultRunGit({ cwd: repoDir, args })
  }
  assert.throws(() => createWorkspace(p, { runGit: failing }), (e) => e.code === WORKSPACE_ERRORS.GIT_FAILED)
  assert.ok(!existsSync(p.slotDir), '失败后不得留下残壳，否则这个槽位永久坏掉')
  // 用真的 git 再建一次必须成功
  const ok = createWorkspace(p)
  assert.equal(ok.reused, false)
  assert.ok(existsSync(join(p.slotDir, 'README.md')))
  reclaimWorkspace(p)
})

test('④ 回收拒绝脏工作区，并列出会被丢掉的改动', { skip: skipIfNoGit }, () => {
  // 那次尝试的成果可能只有这一份，而它没进过任何提交。
  // "尽力清理"在这里等于静默丢数据。
  const p = plan({ taskId: 'T-5', attemptId: 'att-5' })
  createWorkspace(p)
  writeFileSync(join(p.slotDir, 'uncommitted.txt'), 'the only copy\n', 'utf8')

  assert.throws(() => reclaimWorkspace(p),
    (e) => e instanceof WorkspaceError && e.code === WORKSPACE_ERRORS.REF_DIRTY && /uncommitted\.txt/.test(e.message))
  assert.ok(existsSync(join(p.slotDir, 'uncommitted.txt')), '拒绝时那份改动必须还在')
  // force 也**不能**越过脏检查
  assert.throws(() => reclaimWorkspace(p, { force: true }),
    (e) => e.code === WORKSPACE_ERRORS.REF_DIRTY,
    'force 不得越过脏检查——那正是"尽力清理"要禁的事')
  assert.ok(existsSync(join(p.slotDir, 'uncommitted.txt')))
})

test('④ 干净工作区可以回收；回收后槽位与登记都不留', { skip: skipIfNoGit }, () => {
  const p = plan({ taskId: 'T-6', attemptId: 'att-6' })
  createWorkspace(p)
  const r = reclaimWorkspace(p)
  assert.equal(r.ok, true)
  assert.equal(r.action, 'removed-worktree')
  assert.equal(r.discardedChanges, 0)
  assert.ok(!existsSync(p.slotDir), '槽位目录应当被清掉')
  // 登记也摘掉了：留着一条指向空路径的登记会让后续 `git worktree add` 报"已存在"
  const listed = parseWorktreeList(defaultRunGit({ cwd: repoDir, args: ['worktree', 'list', '--porcelain'] }).stdout)
  assert.ok(!listed.includes(p.slotDir), '登记表里不得留下悬空条目')
  // 回收之后再回收是幂等的
  assert.equal(reclaimWorkspace(p).action, 'nothing-to-do')
})

test('④ 已提交的改动照样能回收（脏检查只看未提交部分）', { skip: skipIfNoGit }, () => {
  const p = plan({ taskId: 'T-7', attemptId: 'att-7' })
  createWorkspace(p)
  writeFileSync(join(p.slotDir, 'committed.txt'), 'ok\n', 'utf8')
  execFileSync('git', ['add', '-A'], { cwd: p.slotDir, stdio: 'pipe' })
  execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'work'],
    { cwd: p.slotDir, stdio: 'pipe' })
  assert.deepEqual(worktreeDirt(p.slotDir, { runGit: defaultRunGit }), [], '提交之后应当是干净的')
  assert.equal(reclaimWorkspace(p).ok, true)
})

test('⑤ 「git 说成功」不等于「工作区可用」：登记表里没有就要报错', () => {
  // 起了但干不了活，绝不能看起来像成功——没有登记，回收与恢复都找不到这个目录。
  const fakeRunGit = ({ args }) => {
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: 'worktree /somewhere/else\n', stderr: '', error: null }
    if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: 'Preparing worktree\n', stderr: '', error: null }
    return { status: 0, stdout: '', stderr: '', error: null }
  }
  const p = plan({ taskId: 'T-8', attemptId: 'att-8' })
  assert.throws(() => createWorkspace(p, { runGit: fakeRunGit }),
    (e) => e.code === WORKSPACE_ERRORS.REF_WORKTREE_FAILED && /登记表里没有/.test(e.message))
})

test('⑤ git 退出码非 0 → 具名错误，别把 stderr 吞掉', () => {
  const fakeRunGit = ({ args }) => {
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '', stderr: '', error: null }
    return { status: 128, stdout: '', stderr: 'fatal: not a git repository', error: null }
  }
  const p = plan({ taskId: 'T-9', attemptId: 'att-9' })
  assert.throws(() => createWorkspace(p, { runGit: fakeRunGit }),
    (e) => e.code === WORKSPACE_ERRORS.GIT_FAILED && /not a git repository/.test(e.message))
})

test('⑤ git 起不来（没有 git 可执行文件）→ 具名错误', () => {
  const fakeRunGit = () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn git ENOENT') })
  const p = plan({ taskId: 'T-10', attemptId: 'att-10' })
  assert.throws(() => createWorkspace(p, { runGit: fakeRunGit }),
    (e) => e.code === WORKSPACE_ERRORS.GIT_FAILED && /ENOENT/.test(e.message))
})

test('⑤ 读不出改动状态时拒绝回收（不能假定它干净）', () => {
  // "以为没东西"却删掉成果，是这条路径上唯一的灾难。
  const fakeRunGit = ({ args }) => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      const p = plan({ taskId: 'T-11', attemptId: 'att-11' })
      return { status: 0, stdout: `worktree ${p.slotDir}\n`, stderr: '', error: null }
    }
    return { status: 128, stdout: '', stderr: 'boom', error: null }
  }
  const p = planWorkspace({ repoDir, worktreeBaseDir: baseDir, scope: 'default', taskId: 'T-11b', attemptId: 'att-11b' })
  // 让 list 返回这个槽位，但 status 失败
  const git = ({ args }) => {
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: `worktree ${p.slotDir}\n`, stderr: '', error: null }
    return { status: 128, stdout: '', stderr: 'boom', error: null }
  }
  void fakeRunGit
  assert.throws(() => reclaimWorkspace(p, { runGit: git }),
    (e) => e.code === WORKSPACE_ERRORS.REF_UNKNOWN_SLOT && /读不出它的改动状态/.test(e.message))
})

test('⑥ parseWorktreeList 解析 porcelain 输出', () => {
  const stdout = [
    'worktree D:/x/repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree D:/x/data/worktrees/default/T-1/att-1',
    'HEAD def456',
    'branch refs/heads/legion/default/T-1/att-1',
    '',
  ].join('\n')
  const got = parseWorktreeList(stdout, 'win32')
  assert.equal(got.length, 2)
  assert.match(got[1], /T-1[\\/]att-1$/)
  assert.deepEqual(parseWorktreeList('', 'win32'), [])
  assert.deepEqual(parseWorktreeList(null, 'win32'), [])
})

test('⑥ inspectSlot 四种状态', { skip: skipIfNoGit }, () => {
  const p = plan({ taskId: 'T-12', attemptId: 'att-12' })
  assert.equal(inspectSlot(p.slotDir, { runGit: defaultRunGit, repoDir }).kind, 'absent')
  mkdirSync(p.slotDir, { recursive: true })
  assert.equal(inspectSlot(p.slotDir, { runGit: defaultRunGit, repoDir }).kind, 'empty')
  writeFileSync(join(p.slotDir, 'x.txt'), 'x', 'utf8')
  assert.equal(inspectSlot(p.slotDir, { runGit: defaultRunGit, repoDir }).kind, 'foreign')
  rmSync(join(p.slotDir, 'x.txt'))
  createWorkspace(p)
  assert.equal(inspectSlot(p.slotDir, { runGit: defaultRunGit, repoDir }).kind, 'our-worktree')
})

test('⑦ worktreeStages：接到 worker 上，返回证据并把工作区交出来', { skip: skipIfNoGit }, async () => {
  const stages = worktreeStages({ repoDir, worktreeBaseDir: baseDir, scope: 'sp1' })
  const res = await stages.prepareWorkspace({ taskId: 'T-13', attemptId: 'att-13' })
  assert.equal(res.kind, 'worktree', 'kind 会被写进 Attempt 证据')
  assert.equal(res.reused, false)
  assert.match(res.slotDir, /sp1[\\/]T-13[\\/]att-13$/)
  assert.ok(existsSync(join(res.slotDir, 'README.md')))
  // 回收：干净，应当成功
  const reclaimed = await stages.reclaimAll()
  assert.equal(reclaimed.length, 1)
  assert.equal(reclaimed[0].ok, true)
  assert.ok(!existsSync(res.slotDir))
})

test('⑦ worktreeStages：脏工作区的回收失败**被如实报出来**，不是抛掉', { skip: skipIfNoGit }, async () => {
  // 静默吞掉回收失败，会让"没清干净"变成一件没人知道的事。
  const stages = worktreeStages({ repoDir, worktreeBaseDir: baseDir, scope: 'sp1' })
  const res = await stages.prepareWorkspace({ taskId: 'T-14', attemptId: 'att-14' })
  writeFileSync(join(res.slotDir, 'keep.txt'), 'x', 'utf8')
  const reclaimed = await stages.reclaimAll()
  assert.equal(reclaimed[0].ok, false)
  assert.equal(reclaimed[0].code, WORKSPACE_ERRORS.REF_DIRTY)
  assert.ok(existsSync(join(res.slotDir, 'keep.txt')), '那份改动必须还在')
  // 收尾：清掉，免得影响后续
  await stages.reclaimAll({ force: false }).catch(() => {})
  rmSync(res.slotDir, { recursive: true, force: true })
  execFileSync('git', ['worktree', 'prune'], { cwd: repoDir, stdio: 'pipe' })
})

test('⑦ worktreeStages：没配置仓库时**抛错**，不静默退回原地执行', { skip: skipIfNoGit }, async () => {
  // 静默降级会让 Attempt 的证据写着"有隔离"而实际没有——最坏的一种"看起来有"。
  const stages = worktreeStages({ repoDir: null, worktreeBaseDir: baseDir, scope: 'sp1' })
  await assert.rejects(
    () => stages.prepareWorkspace({ taskId: 'T-15', attemptId: 'att-15' }),
    (e) => e.code === WORKSPACE_ERRORS.REF_NOT_CONFIGURED)
})

test('⑧ 两个 worker 同时在同一仓库上准备不同的任务 → 互不干扰', { skip: skipIfNoGit }, async () => {
  // 这是"隔离"这件事的最终判据。写在同一个文件名里：
  // 没有隔离时后写的那份会覆盖前一份，而两边都不会报错。
  const a = worktreeStages({ repoDir, worktreeBaseDir: baseDir, scope: 'sp1' })
  const b = worktreeStages({ repoDir, worktreeBaseDir: baseDir, scope: 'sp1' })
  const ra = await a.prepareWorkspace({ taskId: 'T-16', attemptId: 'att-16a' })
  const rb = await b.prepareWorkspace({ taskId: 'T-16', attemptId: 'att-16b' })
  assert.notEqual(ra.slotDir, rb.slotDir)
  writeFileSync(join(ra.slotDir, 'shared.txt'), 'from-A\n', 'utf8')
  writeFileSync(join(rb.slotDir, 'shared.txt'), 'from-B\n', 'utf8')
  assert.equal(readFileSync(join(ra.slotDir, 'shared.txt'), 'utf8'), 'from-A\n', 'A 的文件不得被 B 覆盖')
  assert.equal(readFileSync(join(rb.slotDir, 'shared.txt'), 'utf8'), 'from-B\n')
  assert.ok(!existsSync(join(repoDir, 'shared.txt')), '改动不得漏进主仓库')
  rmSync(ra.slotDir, { recursive: true, force: true })
  rmSync(rb.slotDir, { recursive: true, force: true })
})

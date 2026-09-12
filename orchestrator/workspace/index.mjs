// orchestrator/workspace/index.mjs
// ============================================================================
// workspace / worktree 管理（PRT-306）
//
// 为什么需要它：状态机要求一次 Attempt 必须走过 `PreparingWorkspace`，
// 而在本模块之前那一阶段是 `inPlaceStages()` 的**空实现**——两个 worker 认领
// 同一个仓库的两条任务时，它们在**同一个目录**里改文件。由此产生的失败都不是
// 报错，而是"看起来成功"：
//
//   - 士兵 A 改了一半的文件被士兵 B 的 `git add -A` 提交走；
//   - 一条失败重试的任务继承了上一次尝试留在目录里的半成品改动，于是"通过"了；
//   - 崩后重扫时，没人知道"上一次尝试在哪个目录里干过活"。
//
// 因此本模块的三条纪律，每条都对应上面一种失败：
//   ① **工作区按 Attempt 分配，不按 Task**（重试拿到干净的新目录）；
//   ② **先写意图文件，再做副作用**（崩在中间留下的是"我要建这个"而不是一片空白）；
//   ③ **删除是拒绝边界**（有未提交改动就拒绝回收，绝不 best-effort 清理）。
//
// 目录落在 `DataDir/worktrees/...` 而不是 `Workspace/`：spec §6.11 把
// `Workspace/` 定义为「用户授权的项目目录」，而 worktree 是运行面派生的中间产物。
// 顺带解决一个真实缺陷——worktree 若落在仓库内部，它会出现在**主仓库**的
// `git status` 里，于是另一个 worker 的 `git add -A` 会把它一起提交走。
// 本模块直接拒绝这种嵌套布局，不靠"记得加 .gitignore"。
// ============================================================================

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** worktree 意图文件的后缀（与槽位目录**同级**，见 planWorkspace 的说明）。 */
export const INTENT_SUFFIX = '.intent.json'

/** 本模块的具名错误码。 */
export const WORKSPACE_ERRORS = Object.freeze({
  // ── 规划期的拒绝（不碰文件系统）──
  REF_NOT_ABSOLUTE: 'REF_NOT_ABSOLUTE',
  REF_UNSAFE_ID: 'REF_UNSAFE_ID',
  REF_OVERLAP: 'REF_OVERLAP',
  REF_NOT_CONFIGURED: 'REF_NOT_CONFIGURED',
  // ── 建工作区时的拒绝 ──
  REF_FOREIGN_SLOT: 'REF_FOREIGN_SLOT',
  REF_WORKTREE_FAILED: 'REF_WORKTREE_FAILED',
  // ── 回收时的拒绝 ──
  REF_DIRTY: 'REF_DIRTY',
  REF_UNKNOWN_SLOT: 'REF_UNKNOWN_SLOT',
  // ── 工具本身失败 ──
  GIT_FAILED: 'GIT_FAILED',
})

export class WorkspaceError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
    Object.assign(this, extra)
  }
}

/**
 * 一个 id 是否可以被编码成一个安全的路径片段。
 *
 * 拒绝的两类与"编码"分得很清楚：
 *   - **路径分隔符**（`/`、`\`）与**纯点点**（`.`、`..`）一律**拒绝**，不编码。
 *     它们出现在 id 里说明调用方传的是路径而不是 id，编码只会把这个错误
 *     变成一个"看起来正常但指向别处"的目录。
 *   - 其余字符（含 **冒号**）允许，由 `encodeId` 转义。
 *
 * 冒号必须允许，因为运行面的 Attempt id **就是** `att:<taskId>:<attemptNo>`
 * （`run-store.mjs` 的 `att:${taskId}:${attemptNo}`）——而冒号在 Windows 上
 * 是非法文件名字符。所以"id 直接当目录名"这条路根本走不通，
 * 必须有一个显式的编码步骤，而不是指望 id 恰好干净。
 */
const FORBIDDEN_ID_RE = /[\\/]/

function requireSafeId(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_UNSAFE_ID,
      `${field} 不能用作路径片段：${JSON.stringify(value)}`)
  }
  if (value.length > 200) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_UNSAFE_ID,
      `${field} 过长（${value.length} 字符，上限 200）：${JSON.stringify(value.slice(0, 40))}…`)
  }
  if (FORBIDDEN_ID_RE.test(value)) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_UNSAFE_ID,
      `${field} 含路径分隔符：${JSON.stringify(value)}。` +
      '带分隔符的 id 说明调用方传的是**路径**而不是 id；' +
      '编码它只会把这个错误变成一个"看起来正常但指向别处"的目录')
  }
  if (value === '.' || value === '..') {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_UNSAFE_ID,
      `${field} 是 ${JSON.stringify(value)}：它会把工作区指到父目录/当前目录，` +
      '而那不是报错，是**写到了别的仓库里**')
  }
  return value
}

/**
 * 把一个 id 编码成安全的路径片段：`[A-Za-z0-9._-]` 原样保留，其余转义为 `%XX`。
 *
 * 编码是**单射**的（`%` 自身会被转成 `%25`），因此两个不同的 id 永远不会
 * 撞进同一个目录——用"把冒号替换成连字符"那种做法时，
 * `att:T-1:2` 与 `att-T-1-2` 会撞在一起，而它们可能是两条不同的尝试。
 */
export function encodeId(id) {
  const bytes = Buffer.from(String(id), 'utf8')
  let out = ''
  for (const b of bytes) {
    const c = String.fromCharCode(b)
    if (/[A-Za-z0-9._-]/.test(c)) out += c
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  // Windows 上尾部是点或空格的目录名会被静默截断（`a.` 与 `a` 是同一个目录），
  // 于是两个不同的 id 会撞在一起。尾部加点/空格时补一个下划线。
  return /[. ]$/.test(out) ? out + '_' : out
}

/** 规范化并去掉尾部分隔符，方便比较包含关系。 */
function normalizeDir(p, platform) {
  const s = resolve(p)
  const seps = platform === 'win32' ? /[\\/]+$/ : /\/+$/
  return s.replace(seps, '') || s
}

/** `child` 是否等于 `parent` 或落在它里面（按路径分段比较，不是字符串前缀）。 */
function contains(parent, child, platform) {
  const a = normalizeDir(parent, platform).toLowerCase()
  const b = normalizeDir(child, platform).toLowerCase()
  if (a === b) return true
  return b.startsWith(a + sep) || b.startsWith(a + '/')
}

/**
 * 规划一个工作区：算出路径、分支名，并把所有**布局层面的拒绝**在碰文件系统之前做完。
 *
 * 纯函数（不读盘、不跑 git），因此布局规则可以被穷举测试——
 * 而这些规则决定"下一次执行在哪里改文件"，判错不报错。
 *
 * 返回 `{ repoDir, worktreeBaseDir, slotDir, branch, intentFile, baseRef }`。
 */
export function planWorkspace({
  repoDir, worktreeBaseDir, scope, taskId, attemptId,
  baseRef = 'HEAD', platform = process.platform,
} = {}) {
  if (typeof repoDir !== 'string' || repoDir === '') {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_NOT_CONFIGURED,
      '没有配置仓库目录（repoDir）。**不降级**成原地执行：' +
      '那会让两个 worker 在同一个目录里改同一份文件，而这种冲突不报错——' +
      '它表现为"改的东西莫名不见了"或"别人的半成品被提交走了"。' +
      '确实要原地执行时，请显式使用 inPlaceStages()')
  }
  if (typeof worktreeBaseDir !== 'string' || worktreeBaseDir === '') {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_NOT_CONFIGURED,
      '没有配置 worktree 基准目录（worktreeBaseDir）；缺省应为 <DataDir>/worktrees')
  }
  // 相对路径会按 worker 的 cwd 解析，而 worker 可以从任何目录启动。
  // 后果是两个 worker 悄悄用了两个不同的基准目录，而它们都"看起来正常"。
  if (!isAbsolute(repoDir)) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_NOT_ABSOLUTE,
      `repoDir 必须是绝对路径：${repoDir}。相对路径按 worker 的 cwd 解析，` +
      '从不同目录启动的 worker 会静默使用不同的仓库')
  }
  if (!isAbsolute(worktreeBaseDir)) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_NOT_ABSOLUTE,
      `worktreeBaseDir 必须是绝对路径：${worktreeBaseDir}`)
  }
  // 嵌套布局：worktree 落在仓库内部时，它会出现在**主仓库**的 git status 里，
  // 于是另一个 worker 的 `git add -A` 会把它整棵树提交走。
  // 两个方向都拒绝：互相包含时，"哪个是仓库"就不再是明摆着的了。
  if (contains(repoDir, worktreeBaseDir, platform) || contains(worktreeBaseDir, repoDir, platform)) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_OVERLAP,
      `worktree 基准目录与仓库目录重叠（repo=${repoDir}，base=${worktreeBaseDir}）。` +
      'worktree 落在仓库内部会出现在主仓库的 git status 里，' +
      '另一个 worker 的 `git add -A` 会把它整棵树提交走——本模块不靠"记得加 .gitignore"来防这件事')
  }

  const s = encodeId(requireSafeId(scope, 'scope'))
  const t = encodeId(requireSafeId(taskId, 'taskId'))
  // **按 Attempt 分配**：重试拿到一个干净的新目录。
  // 按 Task 分配时，重试会继承上一次的半成品改动——于是"上次改坏了"的东西
  // 这次看起来是"已经改好了"，任务在错误的基础上"通过"。
  const a = encodeId(requireSafeId(attemptId, 'attemptId'))
  const taskDir = join(normalizeDir(worktreeBaseDir, platform), s, t)
  const slotDir = join(taskDir, a)
  // 意图文件放在槽位**同级**，不放在里面。放在里面就必须先 `mkdir` 槽位，
  // 而 `git worktree add` 拒绝往一个已存在的目录里建工作区
  // （实测 `fatal: '…' already exists`）——于是"先写意图"这条纪律
  // 会把建工作区这件事本身弄坏。同级则两不相扰：git 自己创建槽位目录。
  return Object.freeze({
    repoDir: normalizeDir(repoDir, platform),
    worktreeBaseDir: normalizeDir(worktreeBaseDir, platform),
    // 三个 id 原样带上：意图文件要把"谁认领了这个槽位"写清楚。
    // 只记路径的话，崩后重扫看到一个槽位却答不上"它是哪条尝试的"——
    // 于是只能猜（猜"没主的，删掉吧"就会删掉别人的成果）。
    scope: s, taskId: t, attemptId: a,
    rawIds: Object.freeze({ scope, taskId, attemptId }),
    taskDir,
    slotDir,
    branch: `legion/${s}/${t}/${a}`,
    intentFile: join(taskDir, `${a}${INTENT_SUFFIX}`),
    baseRef: typeof baseRef === 'string' && baseRef !== '' ? baseRef : 'HEAD',
  })
}

/** 默认的 git 执行器。可注入，因此拒绝路径能被确定性地测试。 */
export function defaultRunGit({ cwd, args, spawn = spawnSync }) {
  const r = spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return Object.freeze({
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ?? null,
  })
}

function gitOrThrow(runGit, { cwd, args }) {
  const r = runGit({ cwd, args })
  if (r.error !== null && r.error !== undefined) {
    throw new WorkspaceError(WORKSPACE_ERRORS.GIT_FAILED,
      `git ${args.join(' ')} 起不来：${r.error.message ?? r.error}`)
  }
  if (r.status !== 0) {
    throw new WorkspaceError(WORKSPACE_ERRORS.GIT_FAILED,
      `git ${args.join(' ')} 退出码 ${r.status}：${(r.stderr || r.stdout || '').trim()}`)
  }
  return r.stdout
}

/** 解析 `git worktree list --porcelain` 的输出，得到已登记的工作区路径。 */
export function parseWorktreeList(stdout, platform = process.platform) {
  const out = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue
    const p = line.slice('worktree '.length).trim()
    if (p !== '') out.push(normalizeDir(p, platform))
  }
  return out
}

/**
 * 这个槽位上现在是什么？
 *
 *   `absent`        目录不存在
 *   `empty`         目录存在但空
 *   `our-worktree`  已登记的、就是本槽位的 worktree（重试复用）
 *   `foreign`       有东西，但不是本槽位的 worktree（**拒绝**，绝不删）
 */
export function inspectSlot(slotDir, { runGit, repoDir, platform = process.platform }) {
  const target = normalizeDir(slotDir, platform)
  const listed = parseWorktreeList(gitOrThrow(runGit, { cwd: repoDir, args: ['worktree', 'list', '--porcelain'] }), platform)
  if (listed.includes(target)) return Object.freeze({ kind: 'our-worktree', registered: true })
  if (!existsSync(slotDir)) return Object.freeze({ kind: 'absent', registered: false })
  let entries = []
  try { entries = readdirSync(slotDir) } catch { entries = [] }
  return Object.freeze({
    kind: entries.length === 0 ? 'empty' : 'foreign',
    registered: false,
    entries,
  })
}

/**
 * 建一个隔离的工作区（真的是 `git worktree add`）。
 *
 * 顺序是设计好的：**先写意图文件，再做副作用**。
 * 崩在中间时留下的是"我要在这个槽位建工作区"这条记录，
 * 而不是一片空白——恢复扫描据此知道这个槽位被认领过。
 *
 * 幂等：同一 Attempt 重跑（崩在建完之后、执行之前）会命中 `our-worktree` 并复用。
 * `reused: true` 是**实质信息**，不是装饰——它说明执行阶段看到的是上一次
 * 留下的目录内容。
 */
export function createWorkspace(plan, { runGit = defaultRunGit, platform = process.platform } = {}) {
  const before = inspectSlot(plan.slotDir, { runGit, repoDir: plan.repoDir, platform })
  if (before.kind === 'our-worktree') {
    const intent = readIntent(plan.intentFile)
    return Object.freeze({
      kind: 'worktree', reused: true, slotDir: plan.slotDir, branch: plan.branch,
      baseRef: plan.baseRef, intentFile: plan.intentFile, intent,
      note: '这个槽位已经是本次 Attempt 的工作区（崩后重跑），复用它而不是新建',
    })
  }
  if (before.kind === 'foreign') {
    // 删除是**不可逆**的。这里宁可让任务失败并交给人，也不"清理一下再建"：
    // 那个目录里可能是另一次尝试尚未提交的成果，而它没有别的副本。
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_FOREIGN_SLOT,
      `工作区槽位 ${plan.slotDir} 里已有内容，但它不是本次尝试登记的工作区：${before.entries.slice(0, 8).join('、')}` +
      (before.entries.length > 8 ? ` 等 ${before.entries.length} 项` : '') +
      '。**拒绝覆盖**：清理它可能删掉另一次尝试唯一的一份成果',
      { slotDir: plan.slotDir, entries: before.entries })
  }
  if (before.kind === 'empty') {
    // 空目录 git 也不接受（它会报 already exists）。这是我们自己留下的空壳
    // ——不是别人的成果（里面什么都没有），删掉是安全的。
    rmSync(plan.slotDir, { recursive: true, force: true })
  }

  // ① 先落意图。放在槽位的**同级**，因此这里不需要创建槽位目录
  // ——`git worktree add` 要自己创建它。
  mkdirSync(plan.taskDir, { recursive: true })
  const intent = {
    kind: 'legion-workspace-intent',
    scope: plan.scope, taskId: plan.taskId, attemptId: plan.attemptId,
    raw: plan.rawIds,
    slotDir: plan.slotDir, branch: plan.branch, baseRef: plan.baseRef,
    repoDir: plan.repoDir,
    atMs: Date.now(),
  }
  writeFileSync(plan.intentFile, JSON.stringify(intent, null, 2), 'utf8')

  // ② 再做副作用。
  let stdout
  try {
    stdout = gitOrThrow(runGit, {
      cwd: plan.repoDir,
      args: ['worktree', 'add', '-b', plan.branch, plan.slotDir, plan.baseRef],
    })
  } catch (e) {
    // 失败了就收拾**我们自己刚刚造出来的**残壳：那是本次调用的一部分，
    // 里面不可能有别人尚未提交的成果（上一次 inspectSlot 已经确认槽位不存在或是空的）。
    // 这与 reclaim 的"拒绝边界"不矛盾——reclaim 面对的是**别人**的目录。
    // 同时 prune 掉可能留下的悬空登记，否则下次 `git worktree add` 会报"已存在"。
    try { rmSync(plan.slotDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    try { runGit({ cwd: plan.repoDir, args: ['worktree', 'prune'] }) } catch { /* 尽力 */ }
    throw e instanceof WorkspaceError ? e : new WorkspaceError(WORKSPACE_ERRORS.REF_WORKTREE_FAILED, String(e?.message ?? e))
  }

  // ③ 核验：git 退出码 0 **不等于**工作区真的可用。
  // 「起了但干不了活」绝不能看起来像成功——这里重新读一次登记表，
  // 因为缺失的登记会让回收与恢复都找不到这个目录。
  const after = inspectSlot(plan.slotDir, { runGit, repoDir: plan.repoDir, platform })
  if (after.kind !== 'our-worktree') {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_WORKTREE_FAILED,
      `git worktree add 报告成功，但登记表里没有 ${plan.slotDir}（实际：${after.kind}）。` +
      '「建起来了但干不了活」不能算成功：没有登记，回收与恢复都找不到这个目录。' +
      `git 输出：${String(stdout ?? '').trim().slice(0, 200)}`,
      { slotDir: plan.slotDir, actual: after.kind })
  }
  return Object.freeze({
    kind: 'worktree', reused: false, slotDir: plan.slotDir, branch: plan.branch,
    baseRef: plan.baseRef, intentFile: plan.intentFile, intent,
    note: '按 Attempt 隔离的工作区',
  })
}

/** 读意图文件；缺失或坏掉时返回 null（不抛——它只是线索，不是事实源）。 */
export function readIntent(intentFile) {
  try {
    return JSON.parse(readFileSync(intentFile, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 工作区里有没有尚未提交的东西。
 *
 * `--porcelain` 同时覆盖已跟踪的改动与未跟踪的文件（`??`），两者都算脏。
 * 只看已跟踪改动会漏掉"新建了一堆文件但还没 add"这种最常见的情形。
 */
export function worktreeDirt(slotDir, { runGit }) {
  const stdout = gitOrThrow(runGit, { cwd: slotDir, args: ['status', '--porcelain'] })
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
}

/**
 * 回收一个工作区。**删除是不可逆的，因此这里全是拒绝。**
 *
 * 拒绝的三种情形，各对应一个真实的损失：
 *   ① 槽位不存在 / 不是已登记的 worktree → 拒绝（`REF_UNKNOWN_SLOT`）：
 *      不知道自己在删什么的时候不要删。
 *   ② 有未提交改动 → 拒绝（`REF_DIRTY`，带上文件清单）：
 *      那次尝试的成果可能只有这一份，而它没进过任何提交。
 *   ③ 登记表不在（仓库被移动/删除）→ 拒绝：删不掉登记就删不干净，
 *      留下一条指向空路径的登记会让后续 `git worktree add` 报"已存在"。
 *
 * `force` 只透传给 `git worktree remove`（它另有用途：被 lock 的工作区、含子模块的
 * 工作区）。它**不能**越过脏检查——那正是"best-effort 清理"要禁的事：
 * 一个布尔开关不该成为丢掉别人唯一一份成果的入口。要丢弃，先显式提交，
 * 或由人在文件系统上处理；本模块不提供这条捷径。
 */
export function reclaimWorkspace(plan, { runGit = defaultRunGit, platform = process.platform, force = false } = {}) {
  const state = inspectSlot(plan.slotDir, { runGit, repoDir: plan.repoDir, platform })
  if (state.kind === 'absent') {
    return Object.freeze({ ok: true, action: 'nothing-to-do', slotDir: plan.slotDir })
  }
  if (state.kind === 'empty') {
    // 空壳（没有工作成果）：可以安全删。
    rmSync(plan.slotDir, { recursive: true, force: true })
    rmSync(plan.intentFile, { force: true })
    return Object.freeze({ ok: true, action: 'removed-empty-slot', slotDir: plan.slotDir })
  }
  if (state.kind === 'foreign') {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_UNKNOWN_SLOT,
      `拒绝回收 ${plan.slotDir}：里面有内容，但它不是已登记的 worktree（${state.entries.slice(0, 8).join('、')}）。` +
      '不知道在删什么的时候不要删',
      { slotDir: plan.slotDir, entries: state.entries })
  }

  // 到这里它确实是本次尝试的已登记工作区。
  let dirt
  try {
    dirt = worktreeDirt(plan.slotDir, { runGit })
  } catch (e) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_UNKNOWN_SLOT,
      `拒绝回收 ${plan.slotDir}：读不出它的改动状态（${e?.message ?? e}）。` +
      '读不出状态时不能假定它干净——那正是"以为没东西"却删掉成果的路径',
      { slotDir: plan.slotDir })
  }
  if (dirt.length > 0) {
    throw new WorkspaceError(WORKSPACE_ERRORS.REF_DIRTY,
      `拒绝回收 ${plan.slotDir}：有 ${dirt.length} 处未提交的改动被删掉就没有副本了：\n` +
      dirt.slice(0, 12).map((l) => `  ${l}`).join('\n') +
      (dirt.length > 12 ? `\n  …另有 ${dirt.length - 12} 处` : '') +
      '\n要真的丢弃，请先显式提交或由人工确认——本模块不提供"尽力清理"，' +
      '`force` 也不行：一个布尔开关不该成为丢掉别人唯一一份成果的入口',
      { slotDir: plan.slotDir, dirty: dirt })
  }

  gitOrThrow(runGit, { cwd: plan.repoDir, args: ['worktree', 'remove', ...(force === true ? ['--force'] : []), plan.slotDir] })
  // 登记摘掉之后再收拾残留（意图文件、以及 git 可能留下的空壳）。
  rmSync(plan.slotDir, { recursive: true, force: true })
  rmSync(plan.intentFile, { force: true })
  return Object.freeze({ ok: true, action: 'removed-worktree', slotDir: plan.slotDir, branch: plan.branch, discardedChanges: dirt.length })
}

/**
 * 把工作区阶段接到 worker 上。
 *
 * 返回 `{ prepareWorkspace, reclaim }`，形状与 `inPlaceStages()` 相同，
 * 因此 `REQUIRED_STAGE_KEYS` 的检查照旧通过。
 *
 * **配置不全时抛错，不降级。** `createWorker` 的契约是"三个阶段都必需"，
 * 而静默退回原地执行会让 Attempt 的证据写着 `kind: 'worktree'`
 * 而实际上没有隔离——那是最坏的一种"看起来有"。
 * 确实要原地执行时，调用方应当显式用 `inPlaceStages()`（那是一个具名的调用点）。
 */
export function worktreeStages({
  repoDir = null,
  worktreeBaseDir = null,
  scope = 'default',
  baseRef = 'HEAD',
  runGit = defaultRunGit,
  sourceOf = (lease) => lease,
  platform = process.platform,
  logger = () => {},
} = {}) {
  const built = []
  return Object.freeze({
    /**
     * 本实现**声明**自己提供隔离。`createWorker` 据此把 `workspaceMode` 写成
     * `enabled`，而不是去猜「有没有 prepareWorkspace」——`inPlaceStages()`
     * 同样提供这个函数，但它没有隔离。让"提供者自己声明"是唯一能分清两者的做法。
     */
    workspaceIsolation: 'worktree',
    async prepareWorkspace(lease) {
      const src = sourceOf(lease) ?? {}
      const plan = planWorkspace({
        repoDir, worktreeBaseDir, scope,
        taskId: src.taskId, attemptId: src.attemptId,
        baseRef, platform,
      })
      const ws = createWorkspace(plan, { runGit, platform })
      built.push({ plan, ws })
      logger(`${src.attemptId ?? '?'} 工作区就绪：${ws.slotDir}（${ws.reused ? '复用' : '新建'}，分支 ${ws.branch}）`)
      return {
        kind: 'worktree',
        slotDir: ws.slotDir,
        branch: ws.branch,
        baseRef: ws.baseRef,
        reused: ws.reused,
        intentFile: ws.intentFile,
        note: ws.note,
      }
    },
    /** 最近一次准备好的槽位（诊断与用例用）。没有过就返回 null。 */
    lastSlot() {
      return built.length === 0 ? null : built[built.length - 1].ws.slotDir
    },
    /** 回收本次 worker 建过的所有工作区；脏的会被拒绝并如实报出来。 */
    async reclaimAll({ force = false } = {}) {
      const results = []
      for (const { plan } of built) {
        try {
          results.push(reclaimWorkspace(plan, { runGit, platform, force }))
        } catch (e) {
          results.push({ ok: false, slotDir: plan.slotDir, code: e?.code ?? 'UNKNOWN', message: String(e?.message ?? e) })
        }
      }
      built.length = 0
      return results
    },
  })
}

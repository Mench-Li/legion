// ============================================================================
// PRT-705 的运行记录与孤儿进程清理
//
// spec §6.10 把「优雅关闭与僵尸进程清理」列为 Launcher 必须提供的能力。
// 优雅关闭（SIGTERM → 宽限 → 杀**进程树**）已经在 `supervisor.mjs` 里做了。
// 这里补的是**另一半**，也是更难的一半。
//
// ── 问题 ──
//
// `stop()` 只能清理**它自己还活着时**启动的那些进程。如果 Launcher 自己被
// 强杀（任务管理器结束进程、断电、崩溃），它的子进程会活下来继续占端口。
// 下一次启动时：
//
//   · 端口占用检查报 `PORT_IN_USE`：「请关闭占用它的进程」；
//   · 而用户打开任务管理器，看到的是几个**没有任何标识的 node.exe**。
//
// 真实原因是「上一次 Legion 没退干净」，但现在的提示把它和「一个不相干的
// 程序占了这个端口」说成了同一句话。两条路的处置完全不同：
// 前者应当由产品自己收拾，后者**绝对不能碰**。
//
//   > 一个把"我上次没退干净"与"别人占了这个端口"说成同一句话的提示，
//   > 把一件产品该自己收拾的事，变成了一件要用户去猜的事。
//
// ── 做法 ──
//
// 启动时把「我们起了哪些 pid、每一个的映像名是什么」写进 DataDir，
// 正常停止时删掉。下次启动读它，逐个判。
//
// ── 这里最容易犯的、也是唯一真正危险的那个错 ──
//
// **PID 会被系统回收。**
//
// 记录里写着 `pid=4321`。那个进程退出了，系统把 4321 分配给了用户的编辑器。
// 如果按号码去杀，我们杀掉的是编辑器。这不是"清理得不干净"，
// 这是**毁掉一个不相干的程序**，而且不可撤销。
//
// 所以本模块的绝对纪律是：
//
//   · **★ 绝不按 pid 号码杀。** 必须先用映像名确认"这确实是我们起的那个"；
//   · 映像名对不上 → 判 `recycled`，**无论调用方怎么要求都不杀**；
//   · 映像名读不出来 → 判 `unknown`，默认不杀（要杀得显式 `allowUnverified`）；
//   · "读不出来"与"对不上"与"已经没了"是**三个不同的结论**，分开报。
//
//   > 一个按号码去杀的清理动作，与一个随机杀进程的动作，
//   > 在"会不会误伤"上是同一个东西——只是前者看起来有理有据。
// ============================================================================
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 记录格式版本。**读不认识的版本要拒绝，不要猜。** */
export const RUN_RECORD_VERSION = 'legion/launcher-run@1'

/** 记录文件名。放在 DataDir 根下——它是"这次运行"的状态，不是某个进程的。 */
export const RUN_RECORD_FILENAME = 'launcher-run.json'

export const RUN_RECORD_CODES = Object.freeze({
  /** 记录读不出来（权限、IO）。**不是**「没有记录」。 */
  RECORD_UNREADABLE: 'RUN_RECORD_UNREADABLE',
  /** 记录在，但不是本模块认识的形状/版本。 */
  RECORD_CORRUPT: 'RUN_RECORD_CORRUPT',
  /** 记录写不下去。下一次启动就认不出这次的残留。 */
  RECORD_WRITE_FAILED: 'RUN_RECORD_WRITE_FAILED',
  /** 上一次运行的进程还活着。 */
  ORPHANS_FOUND: 'ORPHANS_FOUND',
  /** 某个 pid 已经被系统回收给了别的程序。**这才是必须显式报出来的那种。** */
  PID_RECYCLED: 'PID_RECYCLED',
  /** 想清理但身份没确认，按纪律拒绝。 */
  SWEEP_REFUSED: 'SWEEP_REFUSED',
  /** 清理时杀失败。 */
  SWEEP_FAILED: 'SWEEP_FAILED',
})

/** 记录里每个进程必须有的字段。多一个少一个都算坏记录。 */
export const RUN_RECORD_FIELDS = Object.freeze(['key', 'pid', 'image'])

/** 记录路径。`dataDir` 为空时返回 null——**不猜位置**。 */
export function runRecordPath(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') return null
  return join(dataDir, RUN_RECORD_FILENAME)
}

/**
 * 造一条记录。纯函数。
 *
 * `image` 是**映像名**（Windows 上 `tasklist` 那一列的 `node.exe` 之类）。
 * 它是本模块里唯一能用来区分"我们的进程"与"一个碰巧拿到同一个号码的
 * 别的程序"的东西——没有它，整个模块就退化成"按号码杀"。
 */
export function buildRunRecord({ runId, launcherPid = null, startedAt, processes, now = () => new Date().toISOString() } = {}) {
  return Object.freeze({
    version: RUN_RECORD_VERSION,
    runId: String(runId ?? ''),
    launcherPid: typeof launcherPid === 'number' ? launcherPid : null,
    startedAt: startedAt ?? now(),
    processes: Object.freeze((Array.isArray(processes) ? processes : []).map((p) => Object.freeze({
      key: String(p?.key ?? ''),
      pid: typeof p?.pid === 'number' ? p.pid : null,
      image: typeof p?.image === 'string' && p.image !== '' ? p.image : null,
    }))),
  })
}

/**
 * 校验一条记录的形状。
 *
 * 认不出的记录**不能用**：一条写了一半的记录（比如断电时正在写）会让我们
 * 以为"只有两个进程要清"，而实际上有五个。宁可报"记录坏了、不知道上次
 * 起了什么"，也不要按一条残缺记录去清理。
 */
export function validateRunRecord(value) {
  const problems = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['记录不是一个对象'] }
  }
  if (value.version !== RUN_RECORD_VERSION) {
    problems.push(`记录版本不认识：${JSON.stringify(value.version)}（本模块只认 ${RUN_RECORD_VERSION}）`)
  }
  if (!Array.isArray(value.processes)) {
    problems.push('记录缺少 processes 数组')
  } else {
    for (const [i, p] of value.processes.entries()) {
      if (p === null || typeof p !== 'object') { problems.push(`processes[${i}] 不是对象`); continue }
      for (const f of RUN_RECORD_FIELDS) {
        if (!(f in p)) problems.push(`processes[${i}] 缺少字段「${f}」`)
      }
      if ('pid' in p && p.pid !== null && !Number.isInteger(p.pid)) {
        problems.push(`processes[${i}].pid 不是整数：${JSON.stringify(p.pid)}`)
      }
    }
  }
  return { ok: problems.length === 0, problems }
}

/** 读记录。返回 `{record, diagnostics}`；**任何失败都返回 `record: null`**。 */
export function readRunRecord(file, { fs = { readFileSync, existsSync } } = {}) {
  const diagnostics = []
  if (typeof file !== 'string' || file === '') {
    return { record: null, diagnostics }
  }
  let text = null
  try {
    if (fs.existsSync(file) !== true) return { record: null, diagnostics }
    text = String(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    // **「读不出来」不是「没有记录」。** 当成没有的话，我们会在一个
    // 「不知道上次起了什么」的状态下，按"很干净"去处理。
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.RECORD_UNREADABLE,
      message: `上一次运行的记录读不出来（${e?.code ?? e?.name ?? 'Error'}）：` +
        '**这不等于"上次没有残留进程"**，只是我们无从判断。请人工确认端口是否被占。',
    }))
    return { record: null, diagnostics }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.RECORD_CORRUPT,
      message: '上一次运行的记录不是合法 JSON（很可能是上次退出时正在写）。' +
        '**不能按一条残缺记录去清理**：它可能少列了进程，按它清理会留下真正的残留。',
    }))
    return { record: null, diagnostics }
  }
  const check = validateRunRecord(parsed)
  if (!check.ok) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.RECORD_CORRUPT,
      message: `上一次运行的记录形状不对：${check.problems.join('；')}。` +
        '**不能按它去清理**（它可能少列了进程）。请人工确认端口是否被占。',
    }))
    return { record: null, diagnostics }
  }
  return { record: parsed, diagnostics }
}

/** 写记录。失败**不抛**——写不下去不该拦住启动，但必须报出来。 */
export function writeRunRecord(file, record, { fs = { writeFileSync } } = {}) {
  if (typeof file !== 'string' || file === '') {
    return { ok: false, diagnostic: null }
  }
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
    return { ok: true, diagnostic: null }
  } catch (e) {
    return {
      ok: false,
      diagnostic: Object.freeze({
        severity: 'warn', code: RUN_RECORD_CODES.RECORD_WRITE_FAILED,
        message: `这次运行的进程记录写不下去（${e?.code ?? e?.name ?? 'Error'}）。` +
          '**后果是：如果 Legion 这次被强杀，下一次启动就认不出这些残留进程**——' +
          '它们会继续占着端口，而提示只会说"端口被其他进程占用"。',
      }),
    }
  }
}

/** 删记录。失败不抛（删不掉只意味着下次多判一轮，那些 pid 早就没了）。 */
export function clearRunRecord(file, { fs = { rmSync } } = {}) {
  if (typeof file !== 'string' || file === '') return false
  try { fs.rmSync(file, { force: true }); return true } catch { return false }
}

/**
 * 逐个判断记录里的 pid 现在是什么。
 *
 * `isAlive(pid)` 与 `imageOf(pid)` 都是注入的：真实实现见 `createProcessProbe`。
 * 这样这个函数（本模块唯一的判断核心）不需要真的去杀任何东西就能测。
 *
 * 四种结论，**互不替代**：
 *
 *   · `gone`     — 已经不在了。正常情况，什么都不用做。
 *   · `verified` — 活着，且映像名与我们记录的一致。**很可能是我们的。**
 *   · `recycled` — 活着，但映像名对不上：**这个号码已经被系统给了别的程序。**
 *   · `unknown`  — 活着，但映像名读不出来。**不知道它是谁。**
 *
 * `recycled` 与 `unknown` 都不许杀；`unknown` 只有在调用方显式
 * `allowUnverified` 时才杀。`recycled` **无论如何都不杀**。
 */
export async function classifyRecordedPids(record, { isAlive, imageOf } = {}) {
  const entries = []
  for (const p of Array.isArray(record?.processes) ? record.processes : []) {
    if (p?.pid === null || p?.pid === undefined) {
      entries.push(Object.freeze({ key: p?.key ?? '', pid: null, recordedImage: p?.image ?? null, actualImage: null, status: 'gone' }))
      continue
    }
    let alive = false
    try { alive = (await isAlive?.(p.pid)) === true } catch { alive = false }
    if (!alive) {
      entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: p.image ?? null, actualImage: null, status: 'gone' }))
      continue
    }
    let actualImage = null
    try { actualImage = await imageOf?.(p.pid) } catch { actualImage = null }
    if (typeof actualImage !== 'string' || actualImage === '') {
      entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: p.image ?? null, actualImage: null, status: 'unknown' }))
      continue
    }
    // 记录里没有映像名时，我们**没有任何依据**说这个 pid 还是我们的。
    // 这不是"乐观地当它是我们的"，而是"承认我们不知道"。
    if (typeof p.image !== 'string' || p.image === '') {
      entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: null, actualImage, status: 'unknown' }))
      continue
    }
    const status = actualImage.toLowerCase() === p.image.toLowerCase() ? 'verified' : 'recycled'
    entries.push(Object.freeze({ key: p.key ?? '', pid: p.pid, recordedImage: p.image, actualImage, status }))
  }
  return Object.freeze(entries)
}

/**
 * 把分类结果变成**用户能据此做决定**的诊断。
 *
 * 分三条报，因为三条的处置完全不同：
 *   · 有 `verified` → 「这些是我们上次留下的」+ 可以清（`--sweep-orphans`）；
 *   · 有 `recycled` → 「这个号码现在是别的程序在用，**我们没有动它**」；
 *   · 有 `unknown`  → 「读不出它是谁，**我们也没有动它**」。
 *
 * `recycled` 那一条必须是 `warn` 而不是静默：用户可能正因为端口被占而
 * 在排查，而这条恰好解释了"为什么端口占用提示帮不上忙"。
 */
export function orphanDiagnostics(entries) {
  const diagnostics = []
  const verified = entries.filter((e) => e.status === 'verified')
  const recycled = entries.filter((e) => e.status === 'recycled')
  const unknown = entries.filter((e) => e.status === 'unknown')

  if (verified.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.ORPHANS_FOUND,
      pids: Object.freeze(verified.map((e) => e.pid)),
      message: `上一次 Legion 运行留下的 ${verified.length} 个进程还活着：` +
        verified.map((e) => `${e.key}(pid=${e.pid})`).join('、') +
        '。它们很可能还占着端口，这就是"端口被占用"的真实原因。' +
        '用 `--sweep-orphans` 清理（我们会先核对映像名再动手）。',
    }))
  }
  if (recycled.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.PID_RECYCLED,
      pids: Object.freeze(recycled.map((e) => e.pid)),
      message: `记录里的 ${recycled.length} 个 pid 现在**是别的程序**在用，我们没有动它们：` +
        recycled.map((e) => `pid=${e.pid} 记的是 ${e.recordedImage}，现在是 ${e.actualImage}`).join('；') +
        '。系统回收并重新分配了这些号码——这正说明**"按号码杀进程"是会误伤别人的**。' +
        '这些进程本身不需要处理。',
    }))
  }
  if (unknown.length > 0) {
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.SWEEP_REFUSED,
      pids: Object.freeze(unknown.map((e) => e.pid)),
      message: `记录里的 ${unknown.length} 个 pid 还活着，但**读不出它们是什么程序**，我们没有动它们：` +
        unknown.map((e) => `pid=${e.pid}`).join('、') +
        '。没有映像名就无法确认这号码还是不是我们的——请人工确认。',
    }))
  }
  return Object.freeze(diagnostics)
}

/**
 * 清理。**只杀 `verified`。**
 *
 * `unknown` 要杀必须显式 `allowUnverified: true`；`recycled` 无论传什么
 * **都不会杀**——那是"号码已经被别人拿走了"，杀它等于毁掉一个不相干的程序。
 *
 * 返回值把"杀了谁、没杀谁、为什么"分开列，因为**"没杀"与"杀失败"
 * 对用户是两件事**：前者是我们的纪律，后者是需要他去处理的故障。
 */
export async function sweepOrphans(entries, { killTree, allowUnverified = false } = {}) {
  const killed = []
  const refused = []
  const failed = []
  const diagnostics = []

  for (const e of entries) {
    if (e.status === 'gone') continue
    if (e.status === 'recycled') {
      refused.push(Object.freeze({ key: e.key, pid: e.pid, reason: 'pid-recycled' }))
      continue
    }
    if (e.status === 'unknown' && allowUnverified !== true) {
      refused.push(Object.freeze({ key: e.key, pid: e.pid, reason: 'identity-unknown' }))
      continue
    }
    let ok = false
    try { ok = (await killTree?.(e.pid)) === true } catch { ok = false }
    if (ok) killed.push(Object.freeze({ key: e.key, pid: e.pid, image: e.actualImage ?? e.recordedImage ?? null }))
    else {
      failed.push(Object.freeze({ key: e.key, pid: e.pid }))
      diagnostics.push(Object.freeze({
        severity: 'warn', code: RUN_RECORD_CODES.SWEEP_FAILED,
        message: `清理进程 ${e.key}(pid=${e.pid}) 失败。它可能仍占着端口——` +
          '**这条失败不代表它还在，也不代表它已经没了**，请用端口占用检查确认。',
      }))
    }
  }

  if (refused.length > 0) {
    const recycledCount = refused.filter((r) => r.reason === 'pid-recycled').length
    const unknownCount = refused.filter((r) => r.reason === 'identity-unknown').length
    diagnostics.push(Object.freeze({
      severity: 'warn', code: RUN_RECORD_CODES.SWEEP_REFUSED,
      message: `有 ${refused.length} 个进程**没有被清理**：` +
        (recycledCount > 0 ? `${recycledCount} 个的 pid 已被系统回收给别的程序` : '') +
        (recycledCount > 0 && unknownCount > 0 ? '，' : '') +
        (unknownCount > 0 ? `${unknownCount} 个读不出是什么程序` : '') +
        '。这不是失败，是我们的纪律：**没有确认身份就不动手**。' +
        (recycledCount > 0 ? '按号码去杀会杀掉一个不相干的程序，而且不可撤销。' : ''),
    }))
  }

  return Object.freeze({
    killed: Object.freeze(killed),
    refused: Object.freeze(refused),
    failed: Object.freeze(failed),
    diagnostics: Object.freeze(diagnostics),
  })
}

/**
 * 真实的进程探针（可注入 spawn，便于用例不真的起进程）。
 *
 * `isAlive` 用 `process.kill(pid, 0)`：它不发信号，只做存在性检查。
 * `ESRCH` = 不在了；`EPERM` = 在，但不是我们能动的（也算"在"）。
 *
 * `imageOf` 走系统自带的 `tasklist` / `ps`——**这是本模块里唯一能拿到
 * 映像名的途径**，而映像名是"能不能安全清理"的全部依据。
 */
export function createProcessProbe({
  spawnImpl,
  platform = process.platform,
  killImpl = (pid, sig) => process.kill(pid, sig),
} = {}) {
  return Object.freeze({
    isAlive(pid) {
      if (!Number.isInteger(pid)) return false
      try { killImpl(pid, 0); return true } catch (e) { return e?.code !== 'ESRCH' }
    },

    async imageOf(pid) {
      if (!Number.isInteger(pid) || typeof spawnImpl !== 'function') return null
      const [cmd, args] = platform === 'win32'
        ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
        : ['ps', ['-p', String(pid), '-o', 'comm=']]
      return await new Promise((resolve) => {
        let out = ''
        let done = false
        const finish = (v) => { if (!done) { done = true; resolve(v) } }
        try {
          const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
          child.stdout?.on?.('data', (d) => { out += String(d) })
          child.once('error', () => finish(null))
          child.once('exit', () => finish(parseImage(out, platform)))
        } catch { finish(null) }
      })
    },
  })
}

/**
 * 从 `tasklist` / `ps` 的输出里取映像名。
 *
 * 取不到就返回 `null`——**不要退回 pid 或空串**：一个看起来像映像名的
 * 东西如果其实是别的东西，会让分类判成 `recycled` 或 `verified`，
 * 而这两个结论都会导致"动手"。`null` 只会导致"不动手"。
 */
export function parseImage(text, platform = process.platform) {
  const s = String(text ?? '').trim()
  if (s === '') return null
  if (platform === 'win32') {
    // CSV：`"node.exe","1234","Console","1","100,000 K"`
    const m = s.match(/^"([^"]+)"/)
    if (m) return m[1]
    // 认不出的形状：**不要**把整行当映像名
    return null
  }
  const first = s.split('\n')[0].trim()
  return first === '' ? null : first
}

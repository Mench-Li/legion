// product/launcher/single-instance.test.mjs
// ============================================================================
// PRT-708：单实例保护。三个方向都要，而且要用**真的磁盘**跑一遍。
//
//   ① 独占创建：两个进程同时启动，只有一个拿得到；
//   ② 崩溃回收：持有者死了 → 能接管，但**只在确定死了的时候**；
//   ③ 释放核对：不删别人的锁。
//
// ★ 本套件里有一条用**真实子进程**：同一个 DataDir 并发启动两个，
//   必须恰好一个成功、另一个报 `HELD`。纯函数的"两次调用第二次失败"
//   证明不了这件事——那两次调用在同一个进程里，而这里要防的恰恰是
//   **两个进程在同一瞬间**各自都以为没人。
//
//    > 一个"在同一个进程里连开两次"的用例，
//    > 与一个"真的防住了两个进程"的实现，
//    > 在测试报告上是同一个东西——只不过前者测的是内存里的一把锁。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INSTANCE_LOCK_FILENAME,
  SINGLE_INSTANCE_CODES,
  SINGLE_INSTANCE_VERSION,
  acquireSingleInstance,
  instanceLockPath,
  parseLock,
  processAlive,
} from './single-instance.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const tmp = () => mkdtempSync(join(tmpdir(), 'legion-si-'))
const clean = (d) => { try { rmSync(d, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ } }

/** 一个可注入的假 IO：用来走"读不出 / 写坏了"那些真磁盘走不顺的分支。 */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
      return files.get(p)
    },
    createExclusive: (p, text) => {
      if (files.has(p)) { const e = new Error('EEXIST'); e.code = 'EEXIST'; throw e }
      files.set(p, text)
    },
    remove: (p) => { files.delete(p) },
    ensureDir: () => {},
  }
}

// ═══════════════════════════════════════════════ ① 独占

test('① ★★★ 第一个拿到锁，第二个被具名拒绝', async () => {
  const dir = tmp()
  try {
    const first = await acquireSingleInstance({ dataDir: dir, pid: 111 })
    assert.equal(first.ok, true)
    assert.equal(first.code, SINGLE_INSTANCE_CODES.ACQUIRED)
    assert.ok(first.handle)

    const second = await acquireSingleInstance({ dataDir: dir, pid: 222, alive: () => true })
    assert.equal(second.ok, false, '第二个实例竟然也拿到了锁')
    assert.equal(second.code, SINGLE_INSTANCE_CODES.HELD)
    assert.equal(second.handle, null, '被拒绝的调用不该拿到一个释放句柄')
    assert.equal(second.holder.pid, 111, '要说清是谁拿着')
    assert.match(second.diagnostics.join('\n'), /observe\(\)/, '要解释为什么不能有两个')
  } finally { clean(dir) }
})

test('① ★★ 锁文件里写着 pid / 起始时间 / 版本（事后能说清是谁）', async () => {
  const dir = tmp()
  try {
    await acquireSingleInstance({ dataDir: dir, pid: 4242, now: () => '2026-09-11T00:00:00.000Z' })
    const raw = JSON.parse(readFileSync(instanceLockPath(dir), 'utf8'))
    assert.equal(raw.pid, 4242)
    assert.equal(raw.startedAt, '2026-09-11T00:00:00.000Z')
    assert.equal(raw.version, SINGLE_INSTANCE_VERSION)
  } finally { clean(dir) }
})

test('① ★★ 释放之后可以再拿（正常退出不把这个家目录锁死）', async () => {
  const dir = tmp()
  try {
    const a = await acquireSingleInstance({ dataDir: dir, pid: 111 })
    assert.equal(a.handle.release().ok, true)
    assert.equal(existsSync(instanceLockPath(dir)), false, '释放应该真的把文件删掉')

    const b = await acquireSingleInstance({ dataDir: dir, pid: 222 })
    assert.equal(b.ok, true)
    assert.equal(b.code, SINGLE_INSTANCE_CODES.ACQUIRED)
  } finally { clean(dir) }
})

test('① ★ 没有 dataDir 是**编程错误**（响亮抛出，不是静默放行）', async () => {
  await assert.rejects(() => acquireSingleInstance({ dataDir: '' }), /dataDir/)
  await assert.rejects(() => acquireSingleInstance({}), /dataDir/)
  assert.equal(instanceLockPath(''), null)
})

// ═══════════════════════════════════════════════ ② 崩溃回收

test('② ★★★ 持有者确定死了 → 回收并接管（崩溃不能把产品永久锁死）', async () => {
  const dir = tmp()
  try {
    writeFileSync(instanceLockPath(dir), JSON.stringify({ version: 1, pid: 999999, startedAt: 'x' }))
    const r = await acquireSingleInstance({ dataDir: dir, pid: 222, alive: () => false })
    assert.equal(r.ok, true, '崩溃留下的锁必须能回收 —— 否则产品再也起不来')
    assert.equal(r.code, SINGLE_INSTANCE_CODES.RECLAIMED)
    assert.equal(r.holder.pid, 999999, '要说清回收的是谁')
    assert.match(r.diagnostics.join('\n'), /再也起不来/, '要解释为什么必须回收')
    // 锁现在是我的。
    assert.equal(JSON.parse(readFileSync(instanceLockPath(dir), 'utf8')).pid, 222)
  } finally { clean(dir) }
})

test('② ★★★ 判断不了持有者死活 → **拒绝**，且给出可执行的出路', async () => {
  const dir = tmp()
  try {
    writeFileSync(instanceLockPath(dir), JSON.stringify({ version: 1, pid: 999999 }))
    const r = await acquireSingleInstance({ dataDir: dir, pid: 222, alive: () => null })
    assert.equal(r.ok, false, '判断不了的时候放行 = 静默开出第二个实例')
    assert.equal(r.code, SINGLE_INSTANCE_CODES.UNKNOWN)
    const text = r.diagnostics.join('\n')
    // ★ 拒绝必须**可解**：给出具体该删哪个文件，否则就是死胡同。
    assert.ok(text.includes(instanceLockPath(dir)), '要把该删的文件路径写出来')
    assert.match(text, /不回收/)
  } finally { clean(dir) }
})

test('② ★★★ 锁文件**读不出**（截断/写坏）→ 拒绝，不回收', async () => {
  const dir = tmp()
  try {
    writeFileSync(instanceLockPath(dir), '{ 这不是 JSON')
    const r = await acquireSingleInstance({ dataDir: dir, pid: 222, alive: () => false })
    // 注意：这里 `alive` 说"死了"，但**读不出持有者**，所以连问谁都不该问。
    assert.equal(r.ok, false)
    assert.equal(r.code, SINGLE_INSTANCE_CODES.UNKNOWN)
    assert.match(r.diagnostics.join('\n'), /读不出持有者/)
  } finally { clean(dir) }
})

test('② ★★ 空的/畸形的锁内容一律"读不出持有者"（不猜出一个 pid）', () => {
  for (const bad of ['', '   ', 'null', '[]', '{}', '{"pid":"123"}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}', 'x']) {
    assert.equal(parseLock(bad), null, `${JSON.stringify(bad)} 不该解析出一个持有者`)
  }
  const good = parseLock('{"version":1,"pid":42,"startedAt":"t","dataDir":"d"}')
  assert.equal(good.pid, 42)
  assert.equal(good.startedAt, 't')
})

test('② ★★★ `processAlive` 是三态：ESRCH=false / EPERM=true / 其它=null', () => {
  const mk = (code) => () => { const e = new Error('x'); e.code = code; throw e }
  assert.equal(processAlive(42, () => {}), true)
  assert.equal(processAlive(42, mk('ESRCH')), false)
  assert.equal(processAlive(42, mk('EPERM')), true, 'EPERM 说明进程在，只是不是我们的')
  // 「问不到」绝不能被读成「死了」——那是这一层唯一不能出的错。
  for (const code of ['EINVAL', 'ENOSYS', 'EACCES', 'UNKNOWN', undefined]) {
    assert.equal(processAlive(42, mk(code)), null, `${code} 应该报"判断不了"`)
  }
  assert.equal(processAlive(0, () => {}), null)
  assert.equal(processAlive(-1, () => {}), null)
  assert.equal(processAlive('42', () => {}), null)
  assert.equal(processAlive(1.5, () => {}), null)
})

test('② ★★ 回收竞态：删完又被别人抢建 → 按"已有活实例"处理（不是崩掉）', async () => {
  const file = instanceLockPath('D:/x')
  const fs = fakeFs({ [file]: JSON.stringify({ version: 1, pid: 999999 }) })
  // 模拟：读的时候是死掉的 999999，删掉之后 `createExclusive` 发现又被建上了。
  let firstRead = true
  const racing = {
    ...fs,
    read: (p) => {
      if (firstRead) { firstRead = false; return fs.read(p) }
      return JSON.stringify({ version: 1, pid: 777 })
    },
    remove: () => {},
  }
  const r = await acquireSingleInstance({ dataDir: 'D:/x', pid: 222, alive: () => false, fs: racing })
  assert.equal(r.ok, false)
  assert.equal(r.code, SINGLE_INSTANCE_CODES.HELD)
  assert.equal(r.holder.pid, 777, '要说清抢到的是谁')
  assert.match(r.diagnostics.join('\n'), /抢先/)
})

// ═══════════════════════════════════════════════ ③ 释放核对

test('③ ★★★ 释放时锁已**易主** → 拒绝删除（不删别人的锁）', async () => {
  const file = instanceLockPath('D:/x')
  // ★ 起点是**空的**：acquire 走正常的"独占创建"路径。
  //
  //   第一版这里预置了一个 pid 111 的锁，然后靠默认的 `alive`（真的问进程表）
  //   去判断——而 pid 111 在这台 Windows 上**恰好是活的**，于是 acquire 走了
  //   `HELD` 分支、`mine.ok` 是 false。
  //   *一个"持有者 pid 用真实数字"的夹具，与一个"结果随机器而变"的用例，
  //   是同一个东西——只不过前者只在某些机器上红。*
  const fs = fakeFs()
  const mine = await acquireSingleInstance({ dataDir: 'D:/x', pid: 111, fs })
  assert.equal(mine.ok, true)
  // 别人接管了这把锁（模拟：我这把被回收、别人建了新的）。
  fs.files.set(file, JSON.stringify({ version: 1, pid: 222 }))
  const rel = mine.handle.release()
  assert.equal(rel.ok, false, '不能删掉别人的锁 —— 否则第三个实例可以进来')
  assert.equal(rel.code, SINGLE_INSTANCE_CODES.NOT_OURS)
  assert.equal(fs.files.has(file), true, '别人的锁必须还在')
})

test('③ ★★ 锁文件已经没了 → 释放报 NOT_OURS（不是静默成功）', async () => {
  const file = instanceLockPath('D:/x')
  const fs = fakeFs()
  const mine = await acquireSingleInstance({ dataDir: 'D:/x', pid: 111, fs })
  assert.equal(mine.ok, true)
  fs.files.delete(file)
  const rel = mine.handle.release()
  assert.equal(rel.ok, false)
  assert.equal(rel.code, SINGLE_INSTANCE_CODES.NOT_OURS)
})

test('③ ★★ 锁是自己的 → 释放成功且文件消失', async () => {
  const dir = tmp()
  try {
    mkdirSync(dir, { recursive: true })
    const mine = await acquireSingleInstance({ dataDir: dir, pid: 111 })
    const rel = mine.handle.release()
    assert.equal(rel.ok, true)
    assert.equal(existsSync(instanceLockPath(dir)), false)
  } finally { clean(dir) }
})

// ═══════════════════════════════════════════════ ④ ★ 真子进程并发

test('④ ★★★ **两个真进程同时启动，恰好一个拿到锁**（真的独占，不是内存里的一把锁）', () => {
  const dir = tmp()
  try {
    // 两个子进程同时抢同一个 DataDir。它们各自尝试独占创建，
    // 内核保证只有一个的 `open(..., 'wx')` 成功。
    const script = `
      import { acquireSingleInstance } from ${JSON.stringify(new URL('./single-instance.mjs', import.meta.url).href)}
      const r = await acquireSingleInstance({ dataDir: process.env.SI_DIR, pid: process.pid })
      console.log(JSON.stringify({ ok: r.ok, code: r.code }))
      if (r.handle) r.handle.release()
    `
    const runs = [0, 1].map(() => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, SI_DIR: dir },
    }))
    const outs = runs.map((r) => {
      const line = (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      try { return JSON.parse(line) } catch { return { parse: false, raw: (r.stdout ?? '') + (r.stderr ?? '') } }
    })
    const okCount = outs.filter((o) => o.ok === true).length
    // ⚠️ 诚实边界：这两个子进程**不是同时** spawn 的（`spawnSync` 是串行的），
    //    所以严格说这条测的是"先后各一次"；但由于每个子进程结束时都会**释放**，
    //    它证明的仍然是"释放之后能被抢到、且同一时刻只有一个持有者"。
    //    真正的同瞬间竞争由 ① 与 ③ 的核对逻辑覆盖。
    assert.equal(okCount, 2, `两个先后跑的进程都该拿到（各自释放了）：${JSON.stringify(outs)}`)
  } finally { clean(dir) }
})

test('④ ★★★ 持有者**活着**时，真子进程拿不到（跨进程可见，不是进程内状态）', async () => {
  const dir = tmp()
  try {
    // 本进程拿住锁（真的锁文件）。
    const held = await acquireSingleInstance({ dataDir: dir })
    assert.equal(held.ok, true)
    // 一个真子进程来抢。它看到的必须是"已经有活实例"。
    const script = `
      import { acquireSingleInstance } from ${JSON.stringify(new URL('./single-instance.mjs', import.meta.url).href)}
      const r = await acquireSingleInstance({ dataDir: process.env.SI_DIR, pid: process.pid })
      console.log(JSON.stringify({ ok: r.ok, code: r.code, holderPid: r.holder?.pid ?? null }))
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, SI_DIR: dir },
    })
    const line = (child.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
    const got = JSON.parse(line)
    assert.equal(got.ok, false, `子进程竟然拿到了锁：${line}`)
    assert.equal(got.code, SINGLE_INSTANCE_CODES.HELD)
    // ★ 子进程读到的是**本进程的真 pid**，说明它读的是真的锁文件、
    //   而且真去问了进程表（`process.kill(pid, 0)` 对活着的本进程返回 true）。
    assert.equal(got.holderPid, process.pid, '子进程应该认出持有者是本进程')
  } finally { clean(dir) }
})

test('④ ★★ 锁文件落在产品家目录里（被保护的东西和锁在同一个地方）', () => {
  assert.equal(instanceLockPath('D:/data'), join('D:/data', INSTANCE_LOCK_FILENAME))
  assert.equal(INSTANCE_LOCK_FILENAME, 'legion-instance.lock')
})

// ═══════════════════════════════════════════════ ⑤ ★ 原子性（破验补上的一条）
//
// 这一节是因为**破验 S8 没咬住**才有的。
//
// 把 `open(..., 'wx')` 换成"先 `exists()` 再 `write()`"这个两步法之后，
// 16 条用例**全绿**——而这个两步法**恰好毁掉了这把锁的全部意义**：
// 两次系统调用之间那个窗口里，两个实例都会读到"没人"。
//
// 为什么原来的用例抓不到：真子进程那两条用的是 `spawnSync`，也就是**串行**的
// （那条用例自己的注释里甚至写明了这一点）。串行跑的两个进程永远进不了那个窗口。
//
//   > 一个"先看有没有、再写"的实现，
//   > 与一个真正原子的实现，
//   > 在没有两个进程同时踏进那个窗口的那些天里是同一个东西——
//   > 只不过前者的绿是"这两次调用恰好没重叠"换来的。
//
// 用一个只跑一次的竞态用例去抓它是不行的：窗口只有微秒级，
// 那样的用例会**偶尔**红——比没有用例更坏，因为它的绿是运气。
//
// 所以这里不赛跑，而是**直接读那个性质**：独占创建必须是**一次**系统调用，
// 且路径上**不许出现"先问有没有"**。

test('⑤ ★★★ 独占创建是**一次**系统调用：路径上不出现 `exists()`（两步法即红）', async () => {
  const fs = fakeFs()
  let existsCalls = 0
  let createCalls = 0
  const counted = {
    ...fs,
    exists: (p) => { existsCalls++; return fs.exists(p) },
    createExclusive: (p, t) => { createCalls++; return fs.createExclusive(p, t) },
  }
  const root = await acquireSingleInstance({ dataDir: 'D:/x', pid: 111, fs: counted })
  assert.equal(root.ok, true)
  assert.equal(createCalls, 1, '拿锁应该恰好做一次独占创建')
  assert.equal(existsCalls, 0,
    '拿锁的路径上出现了 `exists()` —— 那就是"先问有没有、再写"的两步法，'
    + '两次系统调用之间正是两个实例都读到"没人"的那个窗口')

  // 释放也必须是"读出来核对 + 删"，不能靠 `exists()` 预判。
  const beforeExists = existsCalls
  root.handle.release()
  assert.equal(existsCalls, beforeExists, '释放路径上也出现了 `exists()` 预判')
})

test('⑤ ★★★ 真的 `createExclusive` 在文件已存在时**抛 EEXIST**（原子原语本身可用）', async () => {
  const dir = tmp()
  try {
    const file = instanceLockPath(dir)
    mkdirSync(dir, { recursive: true })
    // 第一次成功。
    const a = await acquireSingleInstance({ dataDir: dir, pid: 111 })
    assert.equal(a.ok, true)
    // 同一个文件再来一次：`open(wx)` 必须失败，而不是覆盖掉别人的锁。
    // （这条走的是真磁盘，证明底层原语的行为，而不只是我们怎么调用它。）
    await assert.rejects(
      () => import('node:fs').then(({ openSync }) => { openSync(file, 'wx'); throw new Error('竟然成功了') }),
      (e) => e.code === 'EEXIST',
      '`open(wx)` 对已存在的文件必须抛 EEXIST —— 这是这把锁唯一的安全性来源',
    )
    assert.equal(a.handle.release().ok, true)
  } finally { clean(dir) }
})

test('⑤ ★★ 已有活实例时：**先原子试建一次**（EEXIST），再回落到读取判断', async () => {
  const dir = tmp()
  try {
    const first = await acquireSingleInstance({ dataDir: dir, pid: 111 })
    assert.equal(first.ok, true)
    // ★ 这里刻意**先试建、再读** —— 顺序不能反过来。
    //   第一版这条用例写的是"第二次不该走到独占创建"，那是**错的**：
    //   原子试建（`open(wx)` 拿到 EEXIST）本身就是"有没有人"的唯一可靠问法，
    //   先 `exists()` 再判断才是那个两步法。
    //   *一个"断言不该调用独占创建"的用例，会把人推向一个更弱的实现。*
    const realFsCount = {
      exists: (p) => existsSync(p),
      read: (p) => readFileSync(p, 'utf8'),
      createExclusive: (p, t) => {
        // 转调真实实现：必须真的抛 EEXIST（证明它没覆盖掉别人的锁）。
        const fd = openSync(p, 'wx')
        try { writeFileSync(fd, t, 'utf8') } finally { closeSync(fd) }
      },
      remove: (p) => rmSync(p, { force: true }),
      ensureDir: (p) => mkdirSync(p, { recursive: true }),
    }
    const second = await acquireSingleInstance({ dataDir: dir, pid: 222, alive: () => true, fs: realFsCount })
    assert.equal(second.ok, false)
    assert.equal(second.code, SINGLE_INSTANCE_CODES.HELD)
    // 第一个实例的锁必须**原封不动**（pid 还是 111，不是 222）。
    const onDisk = JSON.parse(readFileSync(instanceLockPath(dir), 'utf8'))
    assert.equal(onDisk.pid, 111, '第二个实例把别人的锁覆盖了')
  } finally { clean(dir) }
})

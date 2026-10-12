// team-hub/storage-health.test.mjs
// ============================================================================
// 存储健康的纯决策。
//
// 守的是一句话：**磁盘满的时候，用户不该看到一句他自己修不了的英文错误**，
// 而运维不该在事故发生的那一天才发现没人监控过磁盘。
//
// 这一族里最要紧的两条：
//   ① 认得出存储错误（且**只**认得出它）—— 两个方向的误判各自造成一种静默伤害；
//   ② 阈值用**绝对字节**并按库大小缩放 —— 因为备份需要一份等大的自由空间。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { codeOnly } from '../scripts/lib/code-only.mjs'

import {
  STORAGE_STATUS, STORAGE_CODE, STORAGE_RETRY_AFTER_SEC, BACKUP_HEADROOM_FACTOR, WARN_HEADROOM_FACTOR,
  WARN_MIN_FREE_BYTES, CRITICAL_MIN_FREE_BYTES, SQLITE_CODES, SYSTEM_CODES,
  classifyStorageError, storageMessage, diskLevel, storageReport, storageErrorShape, levelSummary,
} from './storage-health.mjs'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

// ── ① ★★★ 认得出来 ────────────────────────────────────────────────────────

test('★★★ 真实的 SQLITE_FULL（errcode 13）必须被认出来', () => {
  // ★ 这份读数来自**实测**（`PRAGMA max_page_count` 确定性复现，2026-10-12）：
  //   `{ code: 'ERR_SQLITE_ERROR', errcode: 13, message: 'database or disk is full' }`
  const r = classifyStorageError({ code: 'ERR_SQLITE_ERROR', errcode: 13, message: 'database or disk is full' })
  assert.equal(r.storage, true)
  assert.equal(r.kind, 'full')
  assert.equal(r.via, 'errcode', '有 errcode 时应当优先按它判（那是稳定接口）')
})

test('★★★ 只有消息（errcode 被别的层丢了）也要认得出来', () => {
  // HTTP 适配层、重抛、跨进程传递都可能把 `errcode` 丢掉，只剩一句原文。
  for (const msg of [
    'database or disk is full',
    'DATABASE OR DISK IS FULL',
    'Error: database or disk is full',
    'no space left on device',
  ]) {
    const r = classifyStorageError({ message: msg })
    assert.equal(r.storage, true, `${msg} 应当被认出来`)
    assert.equal(r.kind, 'full')
    assert.equal(r.via, 'message')
  }
})

test('★★★ 系统的 ENOSPC / 配额用尽也认得出来（走 code）', () => {
  for (const code of ['ENOSPC', 'EDQUOT']) {
    const r = classifyStorageError({ code, message: 'write failed' })
    assert.equal(r.storage, true, `${code} 应当被认出来`)
    assert.equal(r.kind, 'full', `${code} 归类为"满"`)
    assert.equal(r.via, 'code')
  }
  // 小写也认（Node 的 code 一般是全大写，但别的层可能改过）。
  assert.equal(classifyStorageError({ code: 'enospc' }).storage, true)
})

test('★★★ 只读 / I/O / 打不开 各自成类（要采取的动作不同）', () => {
  assert.equal(classifyStorageError({ errcode: 8 }).kind, 'readonly')
  assert.equal(classifyStorageError({ code: 'EROFS' }).kind, 'readonly')
  assert.equal(classifyStorageError({ errcode: 10 }).kind, 'io')
  assert.equal(classifyStorageError({ errcode: 14 }).kind, 'io')
  assert.equal(classifyStorageError({ errcode: 7 }).kind, 'io')
  assert.equal(classifyStorageError({ message: 'attempt to write a readonly database' }).kind, 'readonly')
  assert.equal(classifyStorageError({ message: 'disk I/O error' }).kind, 'io')
  assert.equal(classifyStorageError({ message: 'unable to open database file' }).kind, 'io')
})

test('★★★ 字符串输入也认（有的层把错误当字符串传）', () => {
  const r = classifyStorageError('database or disk is full')
  assert.equal(r.storage, true)
  assert.equal(r.kind, 'full')
  assert.equal(r.via, 'message')
})

// ── ② ★★★ 认不出来时**不许**猜 ──────────────────────────────────────────────

test('★★★ 普通输入错误**绝不能**被当成存储问题', () => {
  // ★ 这是本模块最要紧的一条反向判据。
  //
  //   一个诱人的偷懒是"拿不准就当成存储问题"（因为反向误判的后果看起来更重）。
  //   那个方向同样有害、而且更隐蔽：一个真实的输入错误会被报成"服务器存储问题"，
  //   客户端于是**永远重试**、永不停止，而用户永远看不到"你的消息有问题"。
  //
  //   > 两个方向的误判各自造成一种静默伤害：
  //   > 一边是用户的字被永久卡住，另一边是一个永远修不好的队列。
  //   > 所以答案是**精确识别**，不是偏向任何一侧。
  const notStorage = [
    { code: 'ERR_SQLITE_ERROR', message: '消息正文不能为空' },
    { message: '缺少参数 body' },
    { message: '消息正文超长（上限 8000 字符）' },
    { code: 'ERR_SQLITE_CONSTRAINT', message: 'UNIQUE constraint failed: hub_users.name' },
    { message: '无权访问空间「default」' },
    { code: 'ENOENT', message: 'no such file or directory' },   // 文件不存在 ≠ 磁盘满
    { code: 'ERR_INVALID_ARG_TYPE', message: 'The "x" argument must be of type string' },
    { message: 'database is locked' },                          // 锁竞争是另一件事，见边界
    { message: 'no such column: taskId' },
    { message: '' },
  ]
  for (const e of notStorage) {
    const r = classifyStorageError(e)
    assert.equal(r.storage, false, `${JSON.stringify(e)} 不该被当成存储问题`)
    assert.equal(r.kind, null)
  }
})

test('★★★ 空 / 畸形输入不抛，且判成"不是存储问题"', () => {
  for (const bad of [null, undefined, 0, 42, true, NaN, [], () => {}]) {
    assert.doesNotThrow(() => classifyStorageError(bad), `${String(bad)} 抛了`)
    assert.equal(classifyStorageError(bad).storage, false)
  }
})

test('★★ `errcode` 是个不认识的数字时不许瞎归类', () => {
  // 19 = SQLITE_CONSTRAINT（扩展码）。它是**业务**错误，不是存储问题。
  assert.equal(classifyStorageError({ errcode: 19, message: 'UNIQUE constraint failed' }).storage, false)
  assert.equal(classifyStorageError({ errcode: 999 }).storage, false)
  // 而且 `errcode` 是垃圾时不能因为"读不出来"就去猜。
  assert.equal(classifyStorageError({ errcode: 'x', message: 'UNIQUE constraint failed' }).storage, false)
})

test('★ 只有认识的 SQLite 主码在表里（别的都得走"不认"这条路）', () => {
  for (const key of Object.keys(SQLITE_CODES)) {
    assert.ok(Number.isFinite(Number(key)), `SQLITE_CODES 的键必须是数字：${key}`)
  }
  assert.deepEqual(Object.keys(SQLITE_CODES).map(Number).sort((a, b) => a - b), [7, 8, 10, 13, 14],
    '只列这三类（内存不足 / 只读 / I/O / 满 / 打不开）—— 表一变，上面的判据要跟着变')
  assert.ok(Object.keys(SYSTEM_CODES).length > 0)
})

// ── ③ ★★★ 给用户的那句话 ──────────────────────────────────────────────────

test('★★★ 不许把原始 SQLite 英文透给用户', () => {
  const msg = storageMessage({ kind: 'full' })
  assert.doesNotMatch(msg, /database|disk is full|SQLITE/i, '不许出现原始英文/SQLite 字样')
  assert.doesNotMatch(msg, /undefined|\[object/)
})

test('★★★ 不许叫用户做他做不到的事', () => {
  // 对一个手机用户说"请清理磁盘空间"，他只会去清自己手机的存储 —— 那毫无用处。
  const msg = storageMessage({ kind: 'full' })
  assert.doesNotMatch(msg, /请清理|请删除|清空磁盘/, '存储空间是**服务器**的，用户清不了')
})

test('★★★ 必须说清三件事：是服务器的问题 · 不是这条消息的问题 · 会被自动重试', () => {
  const msg = storageMessage({ kind: 'full' })
  assert.match(msg, /服务器/, '要说清是**服务器**的存储')
  assert.match(msg, /不是你的消息有问题/, '要替用户排除"是不是我写错了"')
  assert.match(msg, /重试/, '要告诉他不用自己重发')
  assert.match(msg, /管理员/, '要给出唯一有效的出路')
})

test('★★ 三类存储问题说三句不同的话（用户能据此判断严重程度）', () => {
  const full = storageMessage({ kind: 'full' })
  const ro = storageMessage({ kind: 'readonly' })
  const io = storageMessage({ kind: 'io' })
  assert.notEqual(full, ro)
  assert.notEqual(full, io)
  assert.match(full, /已满/)
  assert.match(ro, /不可写/)
  assert.match(io, /故障/)
  // 而三句都要有那三件事。
  for (const m of [full, ro, io]) {
    assert.match(m, /服务器/)
    assert.match(m, /不是你的消息有问题/)
    assert.match(m, /重试/)
  }
})

test('★ 未知 kind 回落到"空间已满"那句（不出现 undefined）', () => {
  for (const k of [undefined, null, 'nope', 0]) {
    const m = storageMessage({ kind: k })
    assert.doesNotMatch(m, /undefined|null/)
    assert.match(m, /服务器/)
  }
})

// ── ④ ★★★ 状态码与错误码 ──────────────────────────────────────────────────

test('★★★ 状态码必须是 503 而不是 400（这是本模块存在的第一个理由）', () => {
  // 400 = 客户端请求有错，含义是"别重试了，改你的请求"。
  // 而磁盘满是**服务端**问题，改请求永远没用 —— 清出空间才有用。
  assert.equal(STORAGE_STATUS, 503)
  assert.notEqual(STORAGE_STATUS, 400)
  assert.notEqual(STORAGE_STATUS, 500, '500 是"未知的内部错误"，而这个我们**知道**是什么')
})

test('★★★ 错误码必须与其它码都不同（客户端按类型分支）', () => {
  assert.equal(STORAGE_CODE, 'STORAGE_UNAVAILABLE')
  assert.match(STORAGE_CODE, /^[A-Z_]+$/)
  // 与限速 / 配额那两个码必须分开：三者要采取的动作完全不同。
  assert.notEqual(STORAGE_CODE, 'IDENTITY_RATE_LIMITED')
  assert.notEqual(STORAGE_CODE, 'ACCOUNT_QUOTA_EXCEEDED')
})

// ── ⑤ ★★★ 阈值：绝对字节 + 按库大小缩放 ────────────────────────────────────

test('★★★ 备份需要一份**等大的**自由空间（这是阈值的存在理由）', () => {
  // `product/server/backup.mjs` 走 `VACUUM INTO` —— 它写一份完整的副本。
  // 所以在写入失败**之前**，备份会先失败。
  assert.equal(BACKUP_HEADROOM_FACTOR, 2)
  // ⚠️ 库要**大于绝对下限的一半**，否则测的是下限而不是倍数关系 ——
  //    第一版我用了 100MiB（2× = 200MiB < 256MiB 的下限），于是"刚好 2×"
  //    被判成 critical，看起来像实现错了，其实是我的期望没算上绝对下限。
  const db = 1 * GiB
  // 逐档走一遍边界（这样"哪一档对应哪个倍数"是**读得出来**的，不用去猜实现）。
  assert.equal(diskLevel({ freeBytes: 2 * db - 1, dbBytes: db }), 'critical', '少于一份副本 → 备份都做不成')
  assert.equal(diskLevel({ freeBytes: 2 * db, dbBytes: db }), 'warn', '刚好能做一份副本 → 警戒')
  assert.equal(diskLevel({ freeBytes: 10 * db - 1, dbBytes: db }), 'warn', '不到 10× → 仍在警戒')
  assert.equal(diskLevel({ freeBytes: 10 * db, dbBytes: db }), 'ok', '≥10× → 充足')
})

test('★★★ 同一个余量，对"大库"危险、对"小库"充足（判据随库缩放）', () => {
  // 这正是"用百分比"做不到的事：5% 的 1T 是 51G（多余），5% 的 100M 是 5M（不够）。
  // 余量取 2GiB，**高于所有绝对下限** —— 否则测的是下限而不是缩放。
  const free = 2 * GiB
  assert.equal(diskLevel({ freeBytes: free, dbBytes: 1 * MiB }), 'ok', '小库 + 2G 余量：够')
  assert.equal(diskLevel({ freeBytes: free, dbBytes: 2 * GiB }), 'critical', '大库 + 2G 余量：危险')
  // 而且中间还有一档：库大到"备份快做不成"但还没到"随时会失败"。
  assert.equal(diskLevel({ freeBytes: free, dbBytes: 500 * MiB }), 'warn',
    '10×500MiB = 5GiB 的警戒线 > 2GiB 余量 > 2×500MiB = 1GiB 的危险线 → warn')
})

test('★★★ 空库也有绝对下限（否则 WAL 都可能写不下）', () => {
  // 库是空的（dbBytes=0）时，两个下限必须**仍然生效** ——
  // 一个"库小就永远 ok"的实现会让一台空库的 Hub 在盘满时毫无预警。
  assert.equal(diskLevel({ freeBytes: CRITICAL_MIN_FREE_BYTES - 1, dbBytes: 0 }), 'critical')
  assert.equal(diskLevel({ freeBytes: CRITICAL_MIN_FREE_BYTES, dbBytes: 0 }), 'warn', '过了危险线还没到警戒线')
  assert.equal(diskLevel({ freeBytes: WARN_MIN_FREE_BYTES - 1, dbBytes: 0 }), 'warn')
  assert.equal(diskLevel({ freeBytes: WARN_MIN_FREE_BYTES, dbBytes: 0 }), 'ok')
})

test('★★★ 读不到余量时报 `unknown`，**不是** `ok`', () => {
  // ★ 把"不知道"报成"正常"，正是那种让运维在事故当天才发现没人监控的默认。
  for (const bad of [undefined, null, NaN, 'x', -1]) {
    assert.equal(diskLevel({ freeBytes: bad, dbBytes: 1000 }), 'unknown', `freeBytes=${String(bad)} 必须报 unknown`)
  }
  assert.equal(diskLevel(), 'unknown')
  assert.equal(diskLevel({}), 'unknown')
  assert.equal(diskLevel(null), 'unknown')
  // ★ 反向：一个**真的**充足的读数不许被报成 unknown（否则上面几条恒真）。
  assert.equal(diskLevel({ freeBytes: 100 * GiB, dbBytes: 1 * MiB }), 'ok')
})

test('★★ 三档的顺序是 critical < warn < ok（不许倒）', () => {
  const db = 100 * MiB
  // 1MiB < 危险线(max(256MiB, 200MiB)=256MiB)；
  // 512MiB 在危险线与警戒线(max(1GiB, 1GiB)=1GiB) 之间；
  // 100GiB 远超两者。
  const levels = [1 * MiB, 512 * MiB, 100 * GiB].map((free) => diskLevel({ freeBytes: free, dbBytes: db }))
  assert.deepEqual(levels, ['critical', 'warn', 'ok'])
})

test('★★ 库大小为垃圾时按 0 处理（仍然用绝对下限）', () => {
  for (const bad of [undefined, null, NaN, -5, 'x']) {
    const lv = diskLevel({ freeBytes: CRITICAL_MIN_FREE_BYTES + 1, dbBytes: bad })
    assert.equal(lv, 'warn', `dbBytes=${String(bad)} 时应当按绝对下限判`)
  }
})

// ── ⑥ ★★★ 运维读数 ────────────────────────────────────────────────────────

test('★★★ 读数必须把主库与 WAL **分开**报（只看主库会严重低估）', () => {
  // 实测这台服务器上 WAL 曾比主库还大（1.1MB vs 4.2MB）。
  const r = storageReport({ dbBytes: 3 * MiB, walBytes: 4 * MiB, freeBytes: 100 * GiB, totalBytes: 59 * GiB })
  assert.equal(r.dbBytes, 3 * MiB)
  assert.equal(r.walBytes, 4 * MiB)
  assert.equal(r.totalUsedBytes, 7 * MiB, '真实占用 = 主库 + WAL')
})

test('★★★ 读数必须含**备份年龄**（备份会先于写入失败）', () => {
  // ★ 盘满会先把备份打坏，而"备份停止工作"这件事**只有在需要恢复的那一天才会被发现**。
  const fresh = storageReport({ dbBytes: MiB, walBytes: 0, freeBytes: 100 * GiB, backupAgeMs: 2 * 3600 * 1000 })
  assert.equal(fresh.backupStale, false)
  const old = storageReport({ dbBytes: MiB, walBytes: 0, freeBytes: 100 * GiB, backupAgeMs: 72 * 3600 * 1000 })
  assert.equal(old.backupStale, true)
})

test('★★★ **读不到备份年龄**要算陈旧（"没有备份"就是陈旧）', () => {
  // 反过来的默认（读不到就当新鲜）会把"备份从来没跑过"报成一切正常。
  for (const bad of [undefined, null, NaN, 'x']) {
    assert.equal(storageReport({ dbBytes: MiB, freeBytes: 100 * GiB, backupAgeMs: bad }).backupStale, true,
      `backupAgeMs=${String(bad)} 必须算陈旧`)
  }
})

test('★★ 读数给出"还需要清出多少"（比一个百分比更能指导行动）', () => {
  const db = 100 * MiB
  const r = storageReport({ dbBytes: db, walBytes: 0, freeBytes: 10 * MiB, totalBytes: 59 * GiB })
  // ⚠️ 危险线是 `max(256MiB 绝对下限, 2×100MiB)` = **256MiB**（绝对下限更大），
  //    不是 200MiB —— 第一版我的期望漏了这个 `max`。
  assert.equal(r.neededBytes, CRITICAL_MIN_FREE_BYTES - 10 * MiB)
  assert.equal(r.neededBytes, 246 * MiB)
  // 余量充足时不需要任何东西。
  assert.equal(storageReport({ dbBytes: db, freeBytes: 100 * GiB }).neededBytes, 0)
  // ★ 反向：`neededBytes` 不许在余量充足时是个正数（那会让运维去清一个够用的盘）。
  assert.ok(storageReport({ dbBytes: 1 * MiB, freeBytes: 100 * GiB }).neededBytes === 0)
})

test('★★ 读数里的 level 与 diskLevel 是同一个判断（不是各算一遍）', () => {
  for (const free of [1 * MiB, 200 * MiB, 100 * GiB]) {
    const db = 10 * MiB
    assert.equal(storageReport({ dbBytes: db, freeBytes: free }).level, diskLevel({ freeBytes: free, dbBytes: db }))
  }
})

test('★ 读数畸形输入不抛（它由文件系统读数拼出来，可能缺项）', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.doesNotThrow(() => storageReport(bad))
  }
  const r = storageReport(null)
  assert.equal(r.level, 'unknown')
  assert.equal(r.freeBytes, null)
  assert.equal(typeof r.dbBytes, 'number')
})

// ── ⑦ ★★★ 结论那句话 ──────────────────────────────────────────────────────

test('★★★ 四档各有各的说法，且 `unknown` 必须说"没有在监控"', () => {
  const keys = ['ok', 'warn', 'critical', 'unknown'].map((l) => levelSummary(l).key)
  assert.equal(new Set(keys).size, 4, '四句话必须互不相同')
  assert.match(levelSummary('unknown').key, /没有\*\*在监控|没有在监控|读不到/)
  assert.match(levelSummary('critical').key, /写入|备份/)
  assert.match(levelSummary('warn').key, /备份/)
})

test('★ 未知档位回落到 `unknown` 那句话（不出现 undefined）', () => {
  for (const bad of [undefined, null, 'nope', 0]) {
    const s = levelSummary(bad)
    assert.doesNotThrow(() => s.key)
    assert.doesNotMatch(s.key, /undefined/)
  }
})

test('★ 反例守卫：上面的"互不相同"判据不是恒真', () => {
  // 一个"四句都不同"的判据在有人把四句写成同一句时必须红。
  const same = ['ok', 'warn', 'critical', 'unknown'].map(() => ({ key: '同一句' }))
  assert.equal(new Set(same.map((s) => s.key)).size, 1, '反例：同一个 key 必须被算出只有 1 种')
  // 而真实现必须 > 1。
  assert.ok(new Set(['ok', 'warn', 'critical', 'unknown'].map((l) => levelSummary(l).key)).size > 1)
})

// ── ⑨ ★★★ 接线（在 `server.mjs` 里）：整形必须在**共用的收口处** ──────────────
//
// ## 为什么这一节是**结构性**的（按源码断言），而不是端到端
//
// 写路径那一条是端到端的（`storage-full-http.test.mjs`）。但 `handle()` 的
// **最外层 catch** 覆盖不到：所有 e2e 的存储错误都经由 `withTx`，而"运行中把库
// 弄坏"这个做法**读不出来** —— SQLite 有**页缓存**，已缓存的页不会重读文件。
// 实测：把库文件第 2 页起全写成 `0xFF` 之后，读路径仍然返回 200。
//
//   > 一个"造不出失败"的覆盖，与一个"根本不会失败"的实现，读数上分不出来。
//
// 所以最外层 catch 用**源码结构**钉住：它必须调用 `storageErrorShape`。
// 这一节盯的是"那条路还在不在"，不是"它算得对不对"（算法由上面那些判据管）。
//
// ## 它为什么仍然值得
//
// 上一轮在 `app.mjs` 上量过：一批"证明决策算得对"的判据，与一批"证明那个决策
// 真的被用上了"的判据，在接线完好时是同一个东西 —— 只不过前者在**线没接上**
// 的时候仍然全绿。
// ★ 剥掉注释再扫（`codeOnly`）—— 判据要在源码里找名字，而写实现的人
//   **正好也会在自己的注释里提到那个名字**。这个坑已经绊到过四次，
//   所以用 `scripts/lib/code-only.mjs` 那个共用实现，不再各抄一份。
const SERVER = codeOnly(readFileSync(new URL('./server.mjs', import.meta.url), 'utf8'))

test('★★★ `withTx`（所有写的事务边界）必须在 catch 里整形', () => {
  const i = SERVER.indexOf('function withTx(')
  assert.ok(i > 0, '找不到 withTx')
  // 取到下一个顶层函数之前的那一段。
  const seg = SERVER.slice(i, SERVER.indexOf('\nfunction nextId(', i))
  assert.ok(seg.includes('storageErrorShape(e)'),
    'withTx 的 catch 必须调用 storageErrorShape —— 26 个写路由族靠它拿到 503，'
    + '每族各改一遍必然漏（而漏掉的那一族就是我修不到的那一族）')
  assert.ok(/statusCode: shape\.status/.test(seg),
    'withTx 必须把整形后的状态码挂到 statusCode 上（handleWrite 读的是它）')
  assert.ok(/code: shape\.code/.test(seg), '必须挂上具名错误码')
})

test('★★★ `handle()` 的**最外层 catch** 也必须整形（兜底那些不走 withTx 的路径）', () => {
  const i = SERVER.indexOf('async function handle(req, res, stripPrefix)')
  assert.ok(i > 0, '找不到 handle')
  const seg = SERVER.slice(i)
  assert.ok(seg.includes('storageErrorShape(e)'),
    '最外层 catch 也必须整形 —— 读路径/启动期/直接 db.exec 的存储错误会从这里出去，'
    + '不整形就是一句原始英文 + 500')
  // 而且不许退回"裸 500 + 原始消息"。
  assert.ok(/json\(res, shape\.status/.test(seg), '最外层 catch 必须用整形后的状态码回响应')
})

test('★★★ 整形只在这**两处**（多一处就是多一个会漂的副本）', () => {
  // 一个"每族各接一遍"的实现，会在某一天多出第 3、第 4 处 —— 而它们必然漂。
  //
  // ⚠️ 计数必须**排除注释**：`server.mjs` 里有一句解释性的注释也提到这个名字，
  //    第一版把注释也算进去了，于是判据在**正确实现**上变红。
  // 已经是剥过注释的源码（`codeOnly`）。
  const codeLines = SERVER.split('\n').map((t) => t.trim())
  const calls = codeLines.filter((t) => /storageErrorShape\(/.test(t) && !/^import/.test(t))
  const imports = codeLines.filter((t) => /^import\b|storageErrorShape,/.test(t) && /storageErrorShape/.test(t))
  assert.equal(calls.length, 2,
    `storageErrorShape 只该被调用 2 次（withTx 与最外层 catch），实际 ${calls.length} 次：\n  ${calls.join('\n  ')}`)
  assert.ok(imports.length >= 1, '必须 import 进来')
})

test('★ 反例守卫：上面那几条结构判据不是恒真', () => {
  // 用一个必然不存在的针验证"在源码里找子串"真的会红。
  const probe = (needle) => SERVER.includes(needle)
  assert.equal(probe('storageErrorShape('), true, '正例：这个真的存在')
  assert.equal(probe('thisStringIsNotInServerAtAll98765'), false, '反例：不存在的针必须为 false')
})

// ── ⑧ ★★★ 整形：把原始错误变成"客户端该看到的形状" ─────────────────────────

test('★★★ 真实的 SQLITE_FULL 被整形成 503 + 具名码 + 中文消息', () => {
  const s = storageErrorShape({ code: 'ERR_SQLITE_ERROR', errcode: 13, message: 'database or disk is full' })
  assert.ok(s !== null, '必须整形（这正是修复前漏掉的那一步）')
  assert.equal(s.status, STORAGE_STATUS)
  assert.equal(s.status, 503)
  assert.equal(s.code, STORAGE_CODE)
  assert.equal(s.kind, 'full')
  assert.match(s.message, /服务器/)
  assert.doesNotMatch(s.message, /database or disk is full/, '原始英文不许透出去')
  assert.ok(Number.isFinite(s.retryAfterSec) && s.retryAfterSec >= 1)
})

test('★★★ 不是存储问题的错误**不许**被整形（保持原有行为）', () => {
  // ★ 反向判据。见文件头：两个方向的误判各自造成一种静默伤害，
  //   所以这里只整形**认得出来**的那些。
  for (const e of [
    { code: 'ERR_SQLITE_ERROR', message: '消息正文不能为空' },
    { message: '缺少参数 body' },
    { code: 'ERR_SQLITE_CONSTRAINT', errcode: 19, message: 'UNIQUE constraint failed' },
    new Error('无权访问空间「default」'),
    null, undefined, 'nope', 42,
  ]) {
    assert.equal(storageErrorShape(e), null, `${JSON.stringify(e)} 不该被整形`)
  }
})

test('★★★ 幂等：已经整过形的错误不再整一次（嵌套事务会包两层）', () => {
  const once = storageErrorShape({ errcode: 13, message: 'database or disk is full' })
  assert.ok(once !== null)
  // 第二层事务拿到的是一个已整形的 error（它带 STORAGE_CODE）。
  const shaped = Object.assign(new Error(once.message), { code: once.code, statusCode: once.status })
  assert.equal(storageErrorShape(shaped), null, '已整形的错误必须原样穿过，不许翻成双份')
})

test('★★★ 反例守卫：上面那条幂等判据**是有前提的**，前提变了它必须红', () => {
  // ★ 这条把幂等判据的前提写清楚，免得它变成"恒真"。
  //
  //   现在它能过，是因为整形后的错误（**中文消息** + **自定义码**）本来就
  //   不被识别表认出来 —— 而不是因为有一句 `if (code === STORAGE_CODE) return null`
  //   挡着（那一句确实存在，但把它删掉判据**仍然绿**：我在破坏性验证里量过）。
  //
  //   所以真正的守卫是**识别表本身不含 `STORAGE_UNAVAILABLE`**。
  //   将来有人把它加进去（比如"顺手把具名错误码也当成可识别的存储信号"），
  //   这条会红 —— 那时才需要那句显式的守卫，或者一个不同的整形策略。
  const src = readFileSync(new URL('./storage-health.mjs', import.meta.url), 'utf8')
  assert.equal(
    /STORAGE_UNAVAILABLE\s*:\s*'/.test(src), false,
    'STORAGE_UNAVAILABLE 不许出现在识别表里 —— 那会让"整形过的错误"被再整形一次（双份消息）。'
    + '要加它，就必须同时保证 storageErrorShape 对它的幂等性，并把这条判据改成断言那个行为。',
  )
  // 而识别表本身必须仍然认得出真信号（否则上面那条前提就成了"什么都不认"）。
  assert.deepEqual(Object.keys(SQLITE_CODES).map(Number).sort((a, b) => a - b), [7, 8, 10, 13, 14])
})

test('★★ `Retry-After` 是个正整数，且它**不是**一个时间承诺', () => {
  assert.ok(Number.isInteger(STORAGE_RETRY_AFTER_SEC) && STORAGE_RETRY_AFTER_SEC >= 1)
  const s = storageErrorShape({ errcode: 13 })
  assert.equal(s.retryAfterSec, STORAGE_RETRY_AFTER_SEC)
})

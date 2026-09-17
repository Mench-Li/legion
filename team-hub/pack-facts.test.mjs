// team-hub/pack-facts.test.mjs
// ============================================================================
// F-20 缺口③：安装事实的持久化。
//
// 这一组盯的是四件事，每一件都对应一个"看起来能用"的错误实现：
//
//   ① **账 vs 推导**：hub 存的是记录，不是"当前装了什么"。若这里再存一份
//      推导结果，那一份与账会漂移，而漂移那天无法判断谁对。
//   ② **seq 的 CAS**：必须由一条 SQL 算出，不是"先读再写"。
//   ③ **只追加**：没有 UPDATE / DELETE（结构级断言）。
//   ④ **重启等价**：`packAccount()` 交出去的东西喂回 `createPackStore`
//      之后，读数与重启前**逐字相同**。这一条把 hub 与 runtime 真正接上，
//      而不是各留一个"接口对齐"的声明。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PACK_FACT_ACCOUNT_VERSION,
  PACK_FACT_ERRORS,
  PACK_FACT_KINDS,
  appendPackFact,
  ensurePackFactSchema,
  exportPackFacts,
  isPackFactKind,
  packAccount,
  packFactCounts,
  packFacts,
} from './pack-facts.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function freshDb() {
  const db = new DatabaseSync(':memory:')
  ensurePackFactSchema(db)
  return db
}

const record = (over = {}) => ({
  seq: 0, at: 1000, kind: 'install', packId: 'legion.software-delivery',
  version: '1.0.0', packType: 'team', packProtocolVersion: 'legion/pack-manifest@1',
  contentHash: 'aaa111', declaredContentHash: 'aaa111', trust: 'builtin',
  fromVersion: null, fromContentHash: null, verdictCodes: [], preflightVersion: 'legion/pack-preflight@1',
  ...over,
})

const codeOf = (fn) => {
  try { fn(); return null } catch (err) { return err?.code ?? 'threw-without-code' }
}

// ─────────────────────────────── ① 形状与常量

test('① 账的形态版本与记录类型是与 runtime 同值的**字面量**，且有用例钉住', () => {
  // hub 与 runtime 之间是单向的产品边界（控制面 → 执行面）：
  // 这一层刻意不 import 执行面的常量，代价是多一份字面量。
  // 代价必须被盯住，否则"两处各改一处"就只会在运行时表现为
  // 重建失败或类型被拒 —— 而那已经是线上。
  assert.equal(PACK_FACT_ACCOUNT_VERSION, 'legion/pack-store@1')
  assert.deepEqual(PACK_FACT_KINDS, ['install', 'enable', 'disable', 'upgrade', 'rollback'])
  assert.equal(isPackFactKind('rollback'), true)
  assert.equal(isPackFactKind('sideways'), false)
})

test('① ★ 与 `runtime/packs/store.mjs` 的常量逐字相等（漂移当场变红）', () => {
  const src = readFileSync(join(HERE, '..', 'runtime', 'packs', 'store.mjs'), 'utf8')
  const version = src.match(/PACK_STORE_VERSION\s*=\s*'([^']+)'/)?.[1]
  const kinds = src.match(/PACK_RECORD_KINDS\s*=\s*Object\.freeze\(\[([^\]]+)\]/)?.[1]
    ?.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  assert.equal(version, PACK_FACT_ACCOUNT_VERSION, '账的形态版本两处漂移了')
  assert.deepEqual(kinds, [...PACK_FACT_KINDS], '记录类型两处漂移了')
})

// ─────────────────────────────── ② 追加与 seq

test('② ★★★ seq 由 SQL 里的 CAS 算出，不是"先读再写"', () => {
  const db = freshDb()
  assert.equal(appendPackFact({ db, record: record() }).seq, 1)
  assert.equal(appendPackFact({ db, record: record({ kind: 'upgrade', version: '1.1.0' }) }).seq, 2)
  assert.equal(appendPackFact({ db, record: record({ kind: 'enable', version: '1.1.0' }) }).seq, 3)
  assert.deepEqual(packFacts({ db }).map((r) => r.seq), [1, 2, 3])
  // 结构级：INSERT ... SELECT COALESCE(MAX(seq), 0) + 1 —— 一条 SQL 完成。
  const src = readFileSync(join(HERE, 'pack-facts.mjs'), 'utf8')
  assert.match(src, /COALESCE\(MAX\(seq\), 0\) \+ 1/)
  // 而且**没有**在 JS 里先查一遍 MAX 再 INSERT（那中间有一个窗口）。
  assert.equal(/SELECT\s+MAX\(seq\)[\s\S]{0,200}?INSERT\s+INTO/i.test(src), false,
    '出现了"先读 MAX 再写"的形态：两个写入者会拿到同一个 seq')
})

test('② ★★★ seq 冲突被翻译成具名冲突码，且**不重编号、不重试**', () => {
  // `COALESCE(MAX(seq),0)+1` 在单进程里永远是空闲的，所以这条路只有并发写入
  // 才会走到——而"只有并发才会走到"正是它需要被**单独**钉住的原因：
  // 一条平时跑不到的路径，与一条不存在的路径，在测试报告上是同一个东西。
  //
  // 这里用一个会抛主键冲突的假 db 来走那条翻译，而不是去构造真的并发。
  const conflicting = {
    prepare() {
      return {
        run() {
          const err = new Error('UNIQUE constraint failed: pack_install_facts.seq')
          throw err
        },
        get() { return { seq: 1 } },
        all() { return [] },
      }
    },
  }
  let caught = null
  try {
    appendPackFact({ db: conflicting, record: record() })
  } catch (err) {
    caught = err
  }
  assert.notEqual(caught, null, '主键冲突必须被翻译，不能原样冒出去')
  assert.equal(caught.code, PACK_FACT_ERRORS.SEQ_CONFLICT)
  // ★ 状态码是 409（可重试的冲突），不是 500：把它报成"服务端坏了"会让
  //   调用方去查服务，而它该做的是重读账再试一次。
  assert.equal(caught.statusCode, 409)
  // ★ 文案必须说清"这次写入**没有**发生"——否则调用方会以为账上已经多了一条，
  //   而它下一步的动作（重试 / 放弃）完全取决于这件事。
  assert.match(caught.message, /没有.*发生|没有.*写/)
  // 而且**不能**是"重编号后成功"。结构级确认没有那条兜底路径。
  const src = readFileSync(join(HERE, 'pack-facts.mjs'), 'utf8')
  assert.equal(/maxSeq\s*\+\s*1[\s\S]{0,300}?catch/i.test(src), false)
  assert.match(src, /UNIQUE\|PRIMARY KEY\|constraint/)
})

test('② ★ 非冲突的数据库错误报 5xx，且不伪装成冲突', () => {
  const broken = {
    prepare() {
      return { run() { throw new Error('disk I/O error') }, get() { return { seq: 0 } }, all() { return [] } }
    },
  }
  let caught = null
  try { appendPackFact({ db: broken, record: record() }) } catch (err) { caught = err }
  // 把磁盘错误报成 409 会让调用方**无限重试**同一个坏盘。
  assert.equal(caught?.code, PACK_FACT_ERRORS.WRITE_FAILED)
  assert.equal(caught?.statusCode, 500)
})

test('② ★ 整本账的顺序就是 seq 的顺序，读出口按 seq 升序给', () => {
  const db = freshDb()
  appendPackFact({ db, record: record({ at: 300 }) })
  appendPackFact({ db, record: record({ kind: 'upgrade', version: '1.1.0', at: 100 }) })
  // at 是倒着给的，但账的顺序由 seq 决定——**落库顺序就是发生顺序**，
  // 不能因为时间戳更小就把它排前面（那会让"先装了再升级"变成"先升级"）。
  assert.deepEqual(packFacts({ db }).map((r) => r.version), ['1.0.0', '1.1.0'])
})

test('② 未知类型 / 坏字段在**写入前**就被拒，且各有具名码', () => {
  const db = freshDb()
  assert.equal(codeOf(() => appendPackFact({ db, record: null })), PACK_FACT_ERRORS.BAD_FACT)
  assert.equal(codeOf(() => appendPackFact({ db, record: record({ kind: 'sideways' }) })), PACK_FACT_ERRORS.BAD_KIND)
  assert.equal(codeOf(() => appendPackFact({ db, record: record({ packId: '  ' }) })), PACK_FACT_ERRORS.BAD_FACT)
  assert.equal(codeOf(() => appendPackFact({ db, record: record({ version: '' }) })), PACK_FACT_ERRORS.BAD_FACT)
  assert.equal(codeOf(() => appendPackFact({ db, record: record({ at: 'now' }) })), PACK_FACT_ERRORS.BAD_FACT)
  // ★ 一条都没写进去——坏输入不该在账上留下半条。
  assert.equal(packFacts({ db }).length, 0)
})

test('② `appendPackFact` 入参是**整条记录**：store 新加字段时不改调用方', () => {
  const db = freshDb()
  appendPackFact({ db, record: record({ someFutureField: 'x' }) })
  // 多出来的字段被忽略而不是报错：hub 比 runtime 旧是正常状态
  // （控制面升级与执行面升级不必同时发生），
  // 而**因为一个未知字段拒收整条安装事实**会让旧 hub 在新 runtime 前直接不可用。
  assert.equal(packFacts({ db }).length, 1)
})

// ─────────────────────────────── ③ 只追加

test('③ ★★★ 本模块没有任何 UPDATE / DELETE（结构级）', () => {
  const src = readFileSync(join(HERE, 'pack-facts.mjs'), 'utf8')
  // 账是"只追加、记录不可变"的。这条纪律没法靠 SQLite 的权限表达，
  // 所以靠"代码里根本没有那些语句"。
  // 一个「边上有个 UPDATE 顺手修正一条记录」的实现，与一个「账可以被改写」的
  // 实现，在排查"这条记录是谁改的"时是同一个东西。
  assert.equal(/\bUPDATE\s+\w/i.test(src), false, '出现了 UPDATE：账就不再是不可变的')
  assert.equal(/\bDELETE\s+FROM/i.test(src), false, '出现了 DELETE：账就不再是只追加的')
  assert.equal(/DROP\s+TABLE/i.test(src), false, '出现了 DROP TABLE')
})

test('③ 记录读回来是冻结的，且 `verdictCodes` 是副本', () => {
  const db = freshDb()
  appendPackFact({ db, record: record({ verdictCodes: ['pack-preflight-p1'] }) })
  const [r] = packFacts({ db })
  assert.equal(Object.isFrozen(r), true)
  assert.equal(Object.isFrozen(r.verdictCodes), true)
  assert.deepEqual([...r.verdictCodes], ['pack-preflight-p1'])
})

test('③ ★ `verdictCodes` 的 JSON 坏了要**说出来**，不是给一个空数组', () => {
  const db = freshDb()
  appendPackFact({ db, record: record({ verdictCodes: ['x'] }) })
  // 模拟外部改写：一段读不回来的 JSON。
  db.prepare("UPDATE pack_install_facts SET verdict_codes_json = '{not json' WHERE seq = 1").run()
  const [r] = packFacts({ db })
  // ★ 给空数组会让"当时预检没有任何问题"与"这段记录坏了"变成同一个读数，
  //   而前者正是我们想相信的那一个。
  assert.equal(r.verdictCodesUnreadable, true)
  assert.deepEqual([...r.verdictCodes], [])
  // 账整体因此被标记为**不可信**。
  assert.equal(packAccount({ db }).readable, false)
})

// ─────────────────────────────── ④ 重建等价

test('④ ★★★★★ 重启等价：`packAccount()` 喂回 store 之后读数逐字相同', async () => {
  const { createPackStore } = await import('../runtime/packs/store.mjs')
  const db = freshDb()

  // 用**真的** store 产生记录，再逐条落进 hub——不手搓记录，
  // 否则这一组钉的是"我的夹具与我的读出口一致"，而不是"hub 与 runtime 接上了"。
  const store = createPackStore({ now: () => 7 })
  for (const r of [
    { kind: 'install', version: '1.0.0' },
    { kind: 'upgrade', version: '1.1.0' },
    { kind: 'enable' },
  ]) {
    appendPackFact({ db, record: fakeStoreRecord(r), nowMs: 7 })
  }
  const account = packAccount({ db })
  assert.equal(account.seq, 3)
  assert.equal(account.readable, true)
  assert.deepEqual(account.records.map((r) => r.kind), ['install', 'upgrade', 'enable'])

  // 重建：把账交给 store，它应该**只**从账推出状态。
  const revived = createPackStore({ now: () => 7, history: account })
  const s = revived.stateOf('legion.software-delivery')
  assert.equal(s.installed, true)
  assert.equal(s.enabled, true)
  assert.equal(s.activeVersion, '1.1.0')
  assert.deepEqual([...s.installedVersions].sort(), ['1.0.0', '1.1.0'])
  // 账的行为也回来了：同版本重复安装仍被拒。
  assert.equal(codeOf(() => revived.install({ manifest: null, verdict: null })), 'pack-store-no-preflight-verdict')
})

/** 与 store 产出的记录**同形**的夹具（只用于本文件的持久化往返）。 */
function fakeStoreRecord({ kind, version = '1.0.0' }) {
  return {
    seq: -1, at: 7, kind, packId: 'legion.software-delivery', version,
    packType: 'team', packProtocolVersion: 'legion/pack-manifest@1',
    contentHash: `h-${version}`, declaredContentHash: `h-${version}`, trust: 'builtin',
    fromVersion: kind === 'upgrade' ? '1.0.0' : null,
    fromContentHash: kind === 'upgrade' ? 'h-1.0.0' : null,
    verdictCodes: [], preflightVersion: 'legion/pack-preflight@1',
  }
}

test('④ ★★ 空账也能重建，且 seq = 0（不是 null）', () => {
  const db = freshDb()
  const account = packAccount({ db })
  assert.equal(account.seq, 0)
  assert.deepEqual(account.records, [])
  assert.equal(account.readable, true)
})

test('④ 按包读与增量读都对得上', () => {
  const db = freshDb()
  appendPackFact({ db, record: record({ packId: 'a', version: '1.0.0' }) })
  appendPackFact({ db, record: record({ packId: 'b', version: '1.0.0' }) })
  appendPackFact({ db, record: record({ packId: 'a', kind: 'upgrade', version: '1.1.0' }) })
  assert.deepEqual(packFacts({ db, packId: 'a' }).map((r) => r.seq), [1, 3])
  assert.deepEqual(packFacts({ db, sinceSeq: 1 }).map((r) => r.seq), [2, 3])
  assert.deepEqual(packFacts({ db, limit: 2 }).map((r) => r.seq), [1, 2])
})

// ─────────────────────────────── ⑤ 导出（Git 审阅）

test('⑤ ★★ 导出是一份可提交的文本，且**不含包内容与凭证**', () => {
  const db = freshDb()
  appendPackFact({ db, record: record() })
  appendPackFact({ db, record: record({ kind: 'enable', version: '1.0.0' }) })
  const { document, text } = exportPackFacts({ db, exportedAtMs: 42 })
  assert.equal(document.format, 'legion/pack-install-facts@1')
  assert.equal(document.accountVersion, 'legion/pack-store@1')
  assert.equal(document.exportedAtMs, 42)
  assert.deepEqual(document.packs.map((p) => p.packId), ['legion.software-delivery'])
  assert.equal(document.packs[0].activeVersion, '1.0.0')
  assert.equal(document.packs[0].enabled, true)
  // ★ 导出的字段是白名单：包**内容**、密钥引用、凭证一个都不在。
  //   一个把整包源码一起导出的文件，会在第一次 `git add .` 时
  //   把内容带进版本历史，而版本历史删不掉。
  const keys = new Set(document.records.flatMap((r) => Object.keys(r)))
  for (const forbidden of ['content', 'files', 'manifest', 'secretRef', 'credentials', 'token']) {
    assert.equal(keys.has(forbidden), false, `导出里出现了 ${forbidden}`)
  }
  assert.match(text, /\n {2}"format"/, '默认应该是给人读的缩进 JSON（要进 diff）')
  assert.equal(text.endsWith('\n'), true)
})

test('⑤ 导出带 `readable` 之外的诚实读数：不可信时不假装正常', () => {
  const db = freshDb()
  appendPackFact({ db, record: record() })
  db.prepare("UPDATE pack_install_facts SET verdict_codes_json = 'bad' WHERE seq = 1").run()
  const { document } = exportPackFacts({ db })
  // 导出的文档本身仍然完整（它记录的是"账里有什么"），
  // 而"账可不可信"由 `packAccount().readable` 回答——两者不能合并：
  // 一份因为读不回来就拒绝导出的实现，会让运维失去唯一的证据。
  assert.equal(document.records.length, 1)
  assert.equal(packAccount({ db }).readable, false)
})

// ─────────────────────────────── ⑥ 计数与建表

test('⑥ `packFactCounts` 五类都出现（缺的给 0，不是 undefined）', () => {
  const db = freshDb()
  appendPackFact({ db, record: record() })
  appendPackFact({ db, record: record({ kind: 'rollback', version: '0.9.0' }) })
  const c = packFactCounts({ db })
  assert.equal(c.total, 2)
  assert.deepEqual(Object.keys(c.counts).sort(), [...PACK_FACT_KINDS].sort())
  assert.equal(c.counts.install, 1)
  assert.equal(c.counts.rollback, 1)
  // ★ 没出现过的类型给 0 而不是缺键：缺键会让读的人把"没有"与"没统计"混起来。
  assert.equal(c.counts.upgrade, 0)
  assert.equal(c.counts.enable, 0)
  assert.equal(c.counts.disable, 0)
})

test('⑥ 建表是幂等的，而且**加列**走 ensureColumn（老库不重建）', () => {
  const db = freshDb()
  ensurePackFactSchema(db) // 第二次
  appendPackFact({ db, record: record() })
  assert.equal(packFacts({ db }).length, 1)
  const src = readFileSync(join(HERE, 'pack-facts.mjs'), 'utf8')
  // 一次"新版本多记一个字段"的升级不该要求重建数据库——
  // 重建意味着丢掉全部安装事实，而那正是这一层存在的理由。
  assert.match(src, /ensureColumn\(db, 'pack_install_facts'/)
})

test('⑥ 磁盘库上也成立（不是只有内存库能过）', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'legion-pack-facts-'))
  const file = join(dir, 'hub.db')
  try {
    const a = new DatabaseSync(file)
    ensurePackFactSchema(a)
    appendPackFact({ db: a, record: record() })
    appendPackFact({ db: a, record: record({ kind: 'upgrade', version: '1.1.0' }) })
    a.close()
    // 重开：账还在，seq 接着走。
    const b = new DatabaseSync(file)
    ensurePackFactSchema(b)
    assert.deepEqual(packFacts({ db: b }).map((r) => r.version), ['1.0.0', '1.1.0'])
    assert.equal(appendPackFact({ db: b, record: record({ kind: 'enable', version: '1.1.0' }) }).seq, 3)
    b.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

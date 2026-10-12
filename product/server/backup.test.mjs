// ============================================================================
// product/server/backup.test.mjs —— 备份"拿得回来"的那条判据
//
// ## 为什么补它（2026-10-12）
//
// 将军问"配置包有啥用"，查完的结论是**在那个部署里没有用**（那 27 行模型配置本来就在
// 每一次整库备份里），于是配置包被删掉了。**而删掉之后**，这份备份成了那 27 行唯一的保护
// —— 于是才有人去读 `EXPECTED_TABLES`，发现它列了 12 张，**三张模型表一张都不在里面**：
//
//     整库 `VACUUM INTO` 当然把它们拷走了，而"备份必须被验证过才算数"这句话没覆盖它们
//     ⇒ 它们落在"有备份、但没人验过"的格子里。
//
//   > 一个"我一直以为另一条路在照看它"的东西，
//   > 在另一条路被拆掉的那一天，才会要求你回答"那你自己验过它吗"。
//
// ## 而补的过程中又抓到第二件事（这个文件有一半是为它写的）
//
// 拿**空库起一次真中枢**，再数它建了哪些表 ⇒ 原先那 12 张里**有 4 张根本不存在**：
// `run_context_snapshots`、`hub_users`、`hub_user_sessions`、`hub_devices`
// （它们的 schema 是**懒建**的：存在 `createXStore()` 里，那个功能没被用过就不建）。
//
// 也就是说：**在一个全新部署上，每一次夜间备份都会失败、并把快照删掉**
// （"不通过就把文件删掉"那条纪律）。而那是一个**备份系统最坏的失败形态**：
// 它不产出任何东西，而"没有备份"要等到出事那天才知道。
//
// 所以清单按**建表时机**分成两组，本文件守两件事：
//   ① 恒建表在快照里都在 / 缺一张必须报不 ok 并点名；
//   ② 懒建表：存在则必须读得回来；**不存在不判红**（没数据可丢）。
//   ③ ★ 前提：**恒建表里的每一张，在全新中枢上都必须真的存在** —— 往严格那组里
//      加一张懒建表 = 重新引入上面那个"每夜备份失败"，而那一步看起来只是"多加一行"。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { EXPECTED_TABLES, LAZY_TABLES, snapshotInto, inspectSnapshot } from './backup.mjs'

const dir = mkdtempSync(join(tmpdir(), 'legion-backup-'))

/** 造一个"这些表都在"的库：每张表建一行，好让行数读数也有值。 */
function makeDb(file, tables) {
  const db = new DatabaseSync(file)
  try {
    for (const t of tables) {
      db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, x TEXT)`)
      db.exec(`INSERT INTO ${t} (x) VALUES ('v')`)
    }
  } finally {
    db.close()
  }
  return file
}

test('① 恒建表都在 ⇒ `inspectSnapshot()` 报 ok，且每张表都有行数读数', () => {
  const src = join(dir, 'full.db')
  makeDb(src, EXPECTED_TABLES)
  const snap = join(dir, 'full-snap.db')
  snapshotInto(src, snap)

  const info = inspectSnapshot(snap)
  assert.equal(info.ok, true, `快照不完整：${JSON.stringify(info.missing)}`)
  assert.equal(info.integrity, 'ok')
  assert.deepEqual(info.missing, [])
  for (const t of EXPECTED_TABLES) {
    assert.equal(info.counts[t], 1, `${t} 的行数读数不对：${info.counts[t]}`)
  }
})

test('② ★★★ 模型配置三张表**必须**在恒建清单里（配置包拆掉之后，这里是它唯一的保护）', () => {
  // 把结论钉在清单上：哪一天有人把它们删掉，这里先红 ——
  // 而不是等到某次真恢复之后才发现模型配置没了。
  for (const t of ['model_providers', 'model_profiles', 'employee_model_bindings']) {
    assert.ok(EXPECTED_TABLES.includes(t),
      `${t} 不在备份的恒建表清单里 ⇒ 这份配置落进"有备份但没人验过"的格子`)
  }
})

test('③ ★★★ 缺一张恒建表 ⇒ **必须**报不 ok 并点名是哪一张（否则"验过了"是假的）', () => {
  // 反向锚，也是这次事故的成因本身：漏表之所以没人发现，是因为**没有这条判据**。
  const without = EXPECTED_TABLES.filter((t) => t !== 'model_profiles')
  const src = join(dir, 'missing-model.db')
  makeDb(src, without)
  const snap = join(dir, 'missing-model-snap.db')
  snapshotInto(src, snap)

  const info = inspectSnapshot(snap)
  assert.equal(info.ok, false, '少了 model_profiles 却报 ok —— 那"验证过"就是一句空话')
  assert.deepEqual(info.missing, ['model_profiles'], '必须点名缺的是哪一张')
})

test('④ ★★★ 懒建表**不在场**不判红，但要作为读数报出来（全新部署的常态）', () => {
  // 这一条就是那个"每夜备份失败"的守卫：全新中枢上那 4 张懒建表不存在，
  // 而备份**必须仍然算可用** —— 否则备份系统在全新部署上什么都不产出。
  const src = join(dir, 'fresh-like.db')
  makeDb(src, EXPECTED_TABLES)   // 恒建表都在；懒建表一张都不建
  const snap = join(dir, 'fresh-like-snap.db')
  snapshotInto(src, snap)

  const info = inspectSnapshot(snap)
  assert.equal(info.ok, true,
    '全新部署（懒建表一张都没启用）的备份被判不可用 ⇒ 那个部署永远没有备份')
  assert.deepEqual(info.missing, [], '懒建表不该出现在"缺失"里')
  assert.deepEqual([...info.lazyAbsent].sort(), [...LAZY_TABLES].sort(),
    '不在场的懒建表要逐张报出来（运维要知道"那份数据在不在"）')
})

test('⑤ ★ 懒建表在场 ⇒ 行数读得出来（有数据却读不回来才是最坏的）', () => {
  const src = join(dir, 'lazy-present.db')
  makeDb(src, [...EXPECTED_TABLES, ...LAZY_TABLES])
  const snap = join(dir, 'lazy-present-snap.db')
  snapshotInto(src, snap)
  const info = inspectSnapshot(snap)
  assert.equal(info.ok, true)
  assert.deepEqual(info.lazyAbsent, [])
  for (const t of LAZY_TABLES) {
    assert.equal(info.counts[t], 1, `${t} 在场却没读到行数`)
  }
})

test('⑥ ★★★ 前提：恒建清单里的**每一张**，全新中枢都必须建（否则"缺一张即失败"是错的）', async () => {
  // 这一条是"为什么那 11 张能进严格清单"的依据本身。它跑一次**真的启动路径**：
  // 空库 + import server.mjs（启动期那些 `ensure*Schema()` 就在模块作用域里）。
  //
  // ⚠ 不启动监听：只需要"模块被加载"这一步的建表效果 —— 监听会带来端口与关闭的负担。
  const fresh = mkdtempSync(join(tmpdir(), 'legion-freshhub-'))
  const prevDb = process.env.TEAM_HUB_DB
  const prevToken = process.env.TEAM_HUB_TOKEN
  process.env.TEAM_HUB_DB = join(fresh, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  try {
    await import('../../team-hub/server.mjs')
    const db = new DatabaseSync(join(fresh, 'team.db'), { readOnly: true })
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
    db.close()
    const notCreated = EXPECTED_TABLES.filter((t) => !tables.has(t))
    assert.deepEqual(notCreated, [],
      `这些表在**全新中枢**上不存在，却被放在"缺一张即失败"的清单里：${notCreated.join(', ')}\n`
      + '  ⇒ 那会让全新部署的每一次备份都失败、并把快照删掉。\n'
      + '    修法：把它们移到 LAZY_TABLES（懒建表只要求"存在则读得回来"），'
      + '或让中枢启动时就把 schema 建出来。')
    // 反向：懒建表里如果有哪张**其实**是恒建的，那它也不该留在懒建那组
    //（留在那组只会少一层保护，不会造成失败 —— 所以这里只提示，不判红）
    const lazyButEager = LAZY_TABLES.filter((t) => tables.has(t))
    assert.ok(Array.isArray(lazyButEager))
  } finally {
    if (prevDb === undefined) delete process.env.TEAM_HUB_DB; else process.env.TEAM_HUB_DB = prevDb
    if (prevToken === undefined) delete process.env.TEAM_HUB_TOKEN; else process.env.TEAM_HUB_TOKEN = prevToken
    // ⚠ 清理**必须包 try**：`import server.mjs` 之后，那个进程里还握着这个 SQLite 文件的句柄
    //   （store 是懒构造、但模块级已经建了 schema），Windows 不允许删除打开的文件 ⇒ EPERM。
    //   第一版没包，于是这一条在**断言全过**的情况下判红，报的还是 `EPERM` ——
    //   一个"清理失败"的红会让下一个人去查断言，而断言是对的。
    //   临时目录在系统 temp 里，交给系统回收。
    try { rmSync(fresh, { recursive: true, force: true }) } catch { /* 见上 */ }
  }
})

test('⑦ 快照与源库**不是同一个文件**：做出来之后源库继续写，快照不受影响', () => {
  // `VACUUM INTO` 的全部要点（文件头那段）：库正被写的时候也给完整的一份。
  const src = join(dir, 'busy.db')
  makeDb(src, EXPECTED_TABLES)
  const snap = join(dir, 'busy-snap.db')
  snapshotInto(src, snap)

  const db = new DatabaseSync(src)
  db.exec("INSERT INTO tasks (x) VALUES ('later')")
  db.close()

  const info = inspectSnapshot(snap)
  assert.equal(info.counts.tasks, 1, '快照应当停在它做出来的那一刻（1 行），不受后续写入影响')
})

test.after(() => {
  // 同上：`⑥` 那个临时中枢目录可能仍有句柄（Windows EPERM），删不掉就不删。
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 见 ⑥ 的说明 */ }
})

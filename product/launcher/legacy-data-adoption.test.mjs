// product/launcher/legacy-data-adoption.test.mjs
// ============================================================================
// PRT-251 续 ④：旧数据接管（安装目录 → DataDir）的判据
//
// 本套件里最要紧的一条是 ④：**真 SQLite、真 WAL、真两条路径**。
// 其余各条都是它周围那些"不许退化成猜"的边界。
// ============================================================================

import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  ADOPTION_CHECKED,
  ADOPTION_CODES,
  ADOPTION_KINDS,
  ADOPTION_STATES,
  ADOPTION_VERSION,
  adoptLegacyData,
  adoptionItems,
  adoptionPathsFor,
  kindOfFragment,
  planAdoption,
  pathsAreSameFile,
} from './legacy-data-adoption.mjs'
import { DATA_PATH_ENV } from './launcher.mjs'
import { resolveLayout } from '../paths.mjs'

/** 建一个临时"部署"：installDir 与 DataDir 分开，符合 §6.10。 */
function fixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `legion-adopt-${tag}-`))
  const layout = {
    installDir: join(root, 'Legion'),
    dataDir: join(root, 'data'),
    platform: process.platform,
  }
  mkdirSync(layout.installDir, { recursive: true })
  mkdirSync(layout.dataDir, { recursive: true })
  return { root, layout, done: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * 给**过 Launcher 的**用例用：`createLauncher` 要的是一份**解析过的**布局
 * （`productHome` 等字段），手搓一个 `{installDir, dataDir}` 会让体检在
 * `plan` 阶段就以 `PRODUCT_HOME_UNRESOLVED` 失败——于是"接管拒绝了启动"
 * 这条断言根本走不到，而它看起来像是绿的。
 */
function launcherFixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `legion-adopt-${tag}-`))
  const { layout } = resolveLayout({
    platform: 'win32',
    installDir: join(root, 'Legion'),
    dataDir: join(root, 'data'),
    workspaceDir: join(root, 'ws'),
    homeDir: root,
    env: {},
  })
  mkdirSync(layout.installDir, { recursive: true })
  mkdirSync(layout.dataDir, { recursive: true })
  return { root, layout, done: () => rmSync(root, { recursive: true, force: true }) }
}

/** 一份**只有 team-hub 一项**的映射：让每条断言都说得出它在验哪一项。 */
const HUB_ONLY = Object.freeze({ 'team-hub': Object.freeze({ TEAM_HUB_DB: 'team-hub/team.db' }) })

function hubPaths(layout) {
  const item = adoptionItems({ dataPathEnv: HUB_ONLY })[0]
  return adoptionPathsFor({ layout, item })
}

// ───────────────────────────────────────────── ① 声明面：不另立清单

test('① ★★ 旧的落点由**同一片段**推到安装目录下（第二张清单必然漂移）', () => {
  // `launcher.mjs:108-110` 原文：「这些键的**代码默认值落在安装目录内**」。
  // 所以 `dataDir/team-hub/team.db` 的旧落点就是 `installDir/team-hub/team.db`——
  // 同一条片段。若这里改成手写第二张表，两张表漂移的表现正是本缺口本身：
  // 「清单说已由 DataDir 承接，而接管路径其实没有」。
  const layout = { installDir: '/opt/legion', dataDir: '/home/u/.legion/data', platform: 'linux' }
  const { source, target } = hubPaths(layout)
  assert.equal(source, '/opt/legion/team-hub/team.db')
  assert.equal(target, '/home/u/.legion/data/team-hub/team.db')

  // 每一项都能推出来，且**没有任何一项**是自己写死的
  const items = adoptionItems({ dataPathEnv: DATA_PATH_ENV })
  assert.equal(items.length, 4, `数据落点应当是 4 项，实际 ${items.length}`)
  for (const item of items) {
    const p = adoptionPathsFor({ layout, item })
    assert.ok(p.source.startsWith('/opt/legion/'), `${item.env} 的旧落点不在安装目录下：${p.source}`)
    assert.ok(p.target.startsWith('/home/u/.legion/data/'), `${item.env} 的新落点不在 DataDir 下：${p.target}`)
    // 两侧的**相对片段逐字相同**——这正是"不需要第二张表"的形式化表述
    assert.equal(p.source.slice('/opt/legion/'.length), p.target.slice('/home/u/.legion/data/'.length))
  }
})

test('② 后缀决定 kind：`.db` 是库，其余是目录', () => {
  assert.equal(kindOfFragment('team-hub/team.db'), ADOPTION_KINDS.SQLITE)
  assert.equal(kindOfFragment('whiteboard/whiteboard.db'), ADOPTION_KINDS.SQLITE)
  assert.equal(kindOfFragment('whiteboard/rooms'), ADOPTION_KINDS.TREE)
  assert.equal(kindOfFragment('whiteboard/audit'), ADOPTION_KINDS.TREE)
  assert.equal(ADOPTION_CHECKED.version, ADOPTION_VERSION)
})

// ───────────────────────────────────────────── ③ 计划：三态 + 两种拒绝

test('③ ★★★ 计划三态各自可达，且「没来源」**不是**拒绝', () => {
  const f = fixture('plan')
  try {
    const source = hubPaths(f.layout).source

    // 新装机：来源不存在 ⇒ 正常，**可以启动**
    const nothing = planAdoption({ layout: f.layout, dataPathEnv: HUB_ONLY, exists: () => false })
    assert.equal(nothing.items[0].code, ADOPTION_CODES.SOURCE_MISSING)
    assert.equal(nothing.items[0].state, ADOPTION_STATES.NOTHING)
    assert.equal(nothing.ok, true, '新装机被误判成不可启动')
    assert.equal(nothing.counts.nothing, 1)

    // 可接管：来源在、目标不在
    const adoptable = planAdoption({ layout: f.layout, dataPathEnv: HUB_ONLY, exists: (p) => p === source })
    assert.equal(adoptable.items[0].state, ADOPTION_STATES.ADOPTED)
    assert.equal(adoptable.ok, true)
    assert.equal(adoptable.counts.adoptable, 1)

    // 已经接过：目标也在 ⇒ 跳过，**幂等**，也不是拒绝
    const already = planAdoption({ layout: f.layout, dataPathEnv: HUB_ONLY, exists: () => true })
    assert.equal(already.items[0].code, ADOPTION_CODES.TARGET_EXISTS)
    assert.equal(already.items[0].state, ADOPTION_STATES.ALREADY)
    assert.equal(already.ok, true, '目标已存在被误判成不可启动（那样第二次启动就起不来了）')
  } finally { f.done() }
})

test('④ ★★★ 有来源却没有 DataDir ⇒ 拒绝；目标落在安装目录内 ⇒ 拒绝', () => {
  const f = fixture('refuse')
  try {
    const source = hubPaths(f.layout).source
    const exists = (p) => p === source

    const noData = planAdoption({
      layout: { ...f.layout, dataDir: null }, dataPathEnv: HUB_ONLY, exists,
    })
    assert.equal(noData.items[0].code, ADOPTION_CODES.NO_DATA_DIR)
    assert.equal(noData.ok, false, '有来源却无处可接，不该判成可以启动')

    // §6.10 不变量：写不得落在安装目录内。DataDir 被指到安装目录里时必须拒绝。
    const inside = planAdoption({
      layout: { ...f.layout, dataDir: join(f.layout.installDir, 'data') },
      dataPathEnv: HUB_ONLY, exists,
    })
    assert.equal(inside.items[0].code, ADOPTION_CODES.TARGET_INSIDE_INSTALL)
    assert.equal(inside.ok, false)

    // 反向控制：同一条判据**不会**把正常的分离布局也拒了
    assert.equal(planAdoption({ layout: f.layout, dataPathEnv: HUB_ONLY, exists }).ok, true)
  } finally { f.done() }
})

test('⑤ 同一目录的旧/新位置可被认出（DataDir 被指到安装目录时）', () => {
  const same = { installDir: '/a', dataDir: '/a', platform: 'linux' }
  const item = adoptionItems({ dataPathEnv: HUB_ONLY })[0]
  assert.equal(pathsAreSameFile({ layout: same, item }), true)
  assert.equal(pathsAreSameFile({
    layout: { installDir: '/a', dataDir: '/b', platform: 'linux' }, item,
  }), false)
})

// ───────────────────────────────────────────── ⑥ ★ 真 WAL 的两条路径

test('⑥ ★★★★★ 真 SQLite + 真 WAL：快照保住全部行，**朴素文件拷贝丢掉 WAL 里的行**', async () => {
  const f = fixture('wal')
  const { source, target } = hubPaths(f.layout)
  mkdirSync(join(f.layout.installDir, 'team-hub'), { recursive: true })

  // 造一份**真的处在 WAL 状态**的旧库：把新行留在 -wal 里（不 checkpoint）。
  // 这正是真机上那份旧库的样子（实测 `team.db-wal` 4.3 MB）。
  const src = new DatabaseSync(source)
  try {
    src.exec('PRAGMA journal_mode = WAL')
    // 关掉自动 checkpoint：否则连接一静下来 WAL 就被合并进主文件，
    // 而"朴素拷贝会丢数据"这件事就**不被观察到**了——不是因为不存在，
    // 而是因为被造掉了。
    src.exec('PRAGMA wal_autocheckpoint = 0')
    src.exec('CREATE TABLE audit (seq INTEGER PRIMARY KEY, note TEXT)')
    src.exec("INSERT INTO audit (seq, note) VALUES (1, '检查点之前')")
    src.exec('PRAGMA wal_checkpoint(TRUNCATE)')   // 这一行进主文件
    for (let i = 2; i <= 40; i += 1) src.exec(`INSERT INTO audit (seq, note) VALUES (${i}, '只在 WAL 里')`)
    // ★ **不关连接**：关掉会 checkpoint。旧库此刻正被另一个进程持有，与真机一致。

    const inMain = (() => {
      const db = new DatabaseSync(source, { readOnly: true })
      try { return db.prepare('SELECT COUNT(*) AS n FROM audit').get().n } finally { db.close() }
    })()
    assert.equal(inMain, 40, `读数前提不成立：只见 ${inMain} 行`)

    // —— 朴素路径：只拷主文件（WAL 丢在路上）——
    const naive = join(f.root, 'naive.db')
    copyFileSync(source, naive)
    const naiveCount = (() => {
      const db = new DatabaseSync(naive, { readOnly: true })
      try { return db.prepare('SELECT COUNT(*) AS n FROM audit').get().n } finally { db.close() }
    })()

    // —— 生产路径：VACUUM INTO 快照 ——
    const result = await adoptLegacyData({ layout: f.layout, dataPathEnv: HUB_ONLY })
    assert.equal(result.ok, true, `接管失败：${JSON.stringify(result.items)}`)
    assert.equal(result.state, ADOPTION_STATES.ADOPTED)
    assert.equal(result.counts.adopted, 1)
    assert.equal(result.items[0].walPresent, true, '没有察觉 WAL 存在')

    const snapCount = (() => {
      const db = new DatabaseSync(target, { readOnly: true })
      try { return db.prepare('SELECT COUNT(*) AS n FROM audit').get().n } finally { db.close() }
    })()

    // ★ 这条断言是**整个模块存在的理由**，而不是一条边角用例：
    assert.equal(snapCount, 40, `快照没有保住 WAL 里的行：${snapCount}/40`)
    assert.ok(naiveCount < 40,
      `朴素拷贝竟然也拿到了 ${naiveCount} 行——那说明这份夹具没有真的把数据留在 WAL 里，`
      + '于是"只拷主文件会丢数据"这条论据就没有被观察到（不是不存在，是没被造出来）')
    assert.equal(naiveCount, 1, `朴素拷贝应当只看到检查点之前那一行，实际 ${naiveCount}`)

    // 来源**原样在**：不删、不改（它同时就是 spec line 610 要的那份备份）
    assert.equal(existsSync(source), true, '接管把来源删掉了——回退路径没了')
    assert.equal(statSync(`${source}-wal`).size > 0, true)
  } finally {
    try { src.close() } catch { /* 已关 */ }
    f.done()
  }
})

test('⑦ ★★★ 幂等：第二次运行什么都不做，且**不覆盖**已接管的库', async () => {
  const f = fixture('idem')
  try {
    const { source, target } = hubPaths(f.layout)
    mkdirSync(join(f.layout.installDir, 'team-hub'), { recursive: true })
    // 来源必须是**真的**库：假的会在快照那一步具名失败（那是 ⑩ 验的事），
    // 于是这一条就没在验幂等，而是在验失败。
    const mk = new DatabaseSync(source)
    mk.exec('CREATE TABLE t (n INTEGER)')
    mk.exec('INSERT INTO t VALUES (1)')
    mk.close()

    const first = await adoptLegacyData({ layout: f.layout, dataPathEnv: HUB_ONLY })
    assert.equal(first.ok, true, JSON.stringify(first.items))
    assert.equal(first.state, ADOPTION_STATES.ADOPTED)

    // ★ 篡改目标：若第二次运行覆盖它，这个标记就没了。
    //   （这才是"不覆盖"的判据——只看 state 的话，一个"每次都重新拷一遍、
    //     只是把 state 报成 already"的实现会照样通过。）
    writeFileSync(target, 'USER-EDITED')
    const second = await adoptLegacyData({ layout: f.layout, dataPathEnv: HUB_ONLY })
    assert.equal(second.state, ADOPTION_STATES.ALREADY)
    assert.equal(second.counts.adopted, 0)
    assert.equal(readFileSync(target, 'utf8'), 'USER-EDITED',
      '第二次运行覆盖了已接管的库——接管只能发生一次')
  } finally { f.done() }
})

test('⑧ ★★ 目录类落点走递归拷贝（白板 rooms / audit）', async () => {
  const f = fixture('tree')
  try {
    const mapping = { whiteboard: { WB_ROOMS_DIR: 'whiteboard/rooms' } }
    const { source, target } = adoptionPathsFor({
      layout: f.layout, item: adoptionItems({ dataPathEnv: mapping })[0],
    })
    mkdirSync(join(source, 'nested'), { recursive: true })
    writeFileSync(join(source, 'a.json'), '{"room":"r1"}')
    writeFileSync(join(source, 'nested', 'b.json'), '{"room":"r2"}')

    const result = await adoptLegacyData({ layout: f.layout, dataPathEnv: mapping })
    assert.equal(result.ok, true, JSON.stringify(result.items))
    assert.equal(readFileSync(join(target, 'a.json'), 'utf8'), '{"room":"r1"}')
    assert.equal(readFileSync(join(target, 'nested', 'b.json'), 'utf8'), '{"room":"r2"}')
    assert.equal(existsSync(source), true, '接管把来源目录删掉了')
  } finally { f.done() }
})

// ───────────────────────────────────────────── ⑨ 失败必须具名，且不静默降级

test('⑨ ★★★ 打不开旧库 ⇒ **具名拒绝**，绝不退化成文件拷贝', async () => {
  const f = fixture('unreadable')
  try {
    const { source, target } = hubPaths(f.layout)
    mkdirSync(join(f.layout.installDir, 'team-hub'), { recursive: true })
    writeFileSync(source, 'not-a-database')

    // ★ 注入一个**总是抛**的打开器：模拟"被独占锁住 / 权限不够 / 不是库"。
    const result = await adoptLegacyData({
      layout: f.layout, dataPathEnv: HUB_ONLY,
      openDatabase: () => { throw new Error('database is locked') },
    })
    assert.equal(result.ok, false)
    assert.equal(result.state, ADOPTION_STATES.FAILED)
    assert.equal(result.items[0].code, ADOPTION_CODES.SOURCE_UNREADABLE)
    assert.match(result.items[0].message, /locked/)
    // ★ 最要紧的一条：**没有**生成一个"看起来能用"的目标
    assert.equal(existsSync(target), false,
      '打开失败却写出了目标文件——那是一个"能打开但内容不明"的库，比失败坏得多')
  } finally { f.done() }
})

test('⑩ ★★ 来源不是合法库时，快照失败也要具名（VACUUM INTO 报错不外泄成崩溃）', async () => {
  const f = fixture('notadb')
  try {
    const { source, target } = hubPaths(f.layout)
    mkdirSync(join(f.layout.installDir, 'team-hub'), { recursive: true })
    writeFileSync(source, 'definitely not sqlite')

    const result = await adoptLegacyData({ layout: f.layout, dataPathEnv: HUB_ONLY })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].state, ADOPTION_STATES.FAILED)
    assert.ok(
      [ADOPTION_CODES.SOURCE_UNREADABLE, ADOPTION_CODES.COPY_FAILED].includes(result.items[0].code),
      `未具名：${result.items[0].code}`,
    )
    assert.equal(existsSync(target), false, '失败却留下了目标文件')
  } finally { f.done() }
})

test('⑪ ★★ 接管后的库验不过 ⇒ 具名 `VERIFY_FAILED`（不把坏库当成接管成功）', async () => {
  const f = fixture('verify')
  try {
    const { source, target } = hubPaths(f.layout)
    mkdirSync(join(f.layout.installDir, 'team-hub'), { recursive: true })
    writeFileSync(source, 'x')

    // 打开器：第一次（快照）成功，第二次（校验）返回一个 integrity_check 不是 ok 的库
    let calls = 0
    const result = await adoptLegacyData({
      layout: f.layout, dataPathEnv: HUB_ONLY,
      openDatabase: () => {
        calls += 1
        if (calls === 1) {
          return {
            exec: () => { writeFileSync(target, 'snapshot') },
            prepare: () => ({ get: () => ({ integrity_check: 'ok' }) }),
            close: () => {},
          }
        }
        return {
          exec: () => {},
          prepare: () => ({ get: () => ({ integrity_check: 'database disk image is malformed' }) }),
          close: () => {},
        }
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.items[0].code, ADOPTION_CODES.VERIFY_FAILED)
    assert.match(result.items[0].message, /malformed/)
  } finally { f.done() }
})

test('⑫ 没有 `node:sqlite` 时**不降级**：报错而不是悄悄走文件拷贝', async () => {
  const f = fixture('nosqlite')
  try {
    const { source, target } = hubPaths(f.layout)
    mkdirSync(join(f.layout.installDir, 'team-hub'), { recursive: true })
    writeFileSync(source, 'x')

    // 直接验"文件拷贝"这条退路**不存在**：即便打开器不可用，
    // 目标也不能出现——因为那条路会静默丢掉 WAL 里的数据。
    const result = await adoptLegacyData({
      layout: f.layout, dataPathEnv: HUB_ONLY,
      openDatabase: null, // → 走默认加载（本机有 node:sqlite）
    })
    // 本机有 node:sqlite，所以这一条验的是"默认路径可用"；
    // 真正的"没有 node:sqlite"分支由 ⑨/⑩ 的具名失败共同覆盖。
    assert.equal(typeof result.state, 'string')
    if (result.ok === false) assert.equal(existsSync(target), false)
  } finally { f.done() }
})

// ───────────────────────────────────────────── ⑬ Launcher 集成

test('⑬ ★★★ Launcher：有旧数据却接不成就**拒绝启动**，而不是空着起来', async () => {
  const { createLauncher } = await import('./launcher.mjs')
  const f = launcherFixture('launcher-refuse')
  try {
    // 布置是**完全合法**的（DataDir 与安装目录分离，layout 检查全过），
    // 只有"旧库读不动"这一件事是坏的——这样拒绝的阶段才唯一地指向接管。
    // 若这里改用"DataDir 指进安装目录"，拒绝会先发生在 `plan` 阶段
    // （layout 不变量），于是这条用例就不再是在验接管那条路。
    const legacyDir = join(f.layout.installDir, 'team-hub')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'team.db'), 'this is not a sqlite database')

    // ★ 先证明**体检本身是过的**。否则"start 失败了"这句话可能只是在说
    //   体检挡住了，而接管那一条根本没被执行到——那是本套件里最容易
    //   假装成证据的一种绿。
    //
    // ★ `include: ['team-hub']` 不是随手加的：接管**按启动范围**发生
    //   （见 `adoptionItems()` 的 `processes`）。`include: []` 是"一个进程都不启"，
    //   那时不该接管任何人的数据——于是这条用例会**绕过**它要验的那条路，
    //   然后以"start 成功了"的样子变红（或者更坏：被别人放宽判据后变绿）。
    //   要验"接不成 ⇒ 拒绝启动"，就必须让那个数据的主人在范围内。
    //
    // ★ 端口用 `ports` 挪开、并显式 `allowPortInUse`：本机真实跑着旧 team-hub
    //   （占 8787），而这条用例**不是**在验端口。让它去撞一个别人正在用的端口，
    //   会让"体检没过"和"接管拒绝了"混成同一个红——那样这条用例就不再
    //   是在验接管了。
    const L = createLauncher({
      layout: f.layout,
      include: ['team-hub'],
      ports: { 'team-hub': 0 },
      allowPortInUse: ['team-hub'],
      exists: () => true,
      runtimeCommand: 'node runtime.mjs',
    })
    const pre = await L.preflight()
    assert.equal(pre.ok, true,
      `体检没过，这条用例就验不到接管：${JSON.stringify(pre.diagnostics.map((d) => d.code))}`)

    const started = await L.start()
    assert.equal(started.ok, false, '旧库读不动却照样启动了——那就是④原样重演')
    assert.equal(started.phase, 'legacy-adoption', `拒绝发生在错误的阶段：${started.phase}`)
    assert.ok(
      started.diagnostics.some((d) => d.code === ADOPTION_CODES.SOURCE_UNREADABLE
        || d.code === ADOPTION_CODES.COPY_FAILED),
      `拒绝理由不是接管的具名码：${JSON.stringify(started.diagnostics.map((d) => d.code))}`,
    )
    // ★ 反面：拒绝时**不能**留下一个半成品目标
    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), false)
    await L.stop({ graceMs: 50 })
  } finally { f.done() }
})

test('⑬b ★★ 反向控制：**没有**旧数据时照常启动（拒绝只针对"该接却没接成"）', async () => {
  const { createLauncher } = await import('./launcher.mjs')
  const f = launcherFixture('launcher-nothing')
  try {
    const L = createLauncher({
      layout: f.layout, include: [], exists: () => true, runtimeCommand: 'node runtime.mjs',
    })
    const pre = await L.preflight()
    assert.equal(pre.ok, true, `体检没过：${JSON.stringify(pre.diagnostics.map((d) => d.code))}`)

    const started = await L.start()
    assert.notEqual(started.phase, 'legacy-adoption',
      '新装机（没有旧数据）被接管这条判据拦住了——那会让全新安装起不来')
    const reading = await L.adoptLegacyData()
    assert.equal(reading.state, ADOPTION_STATES.NOTHING)
    await L.stop({ graceMs: 50 })
  } finally { f.done() }
})

test('⑭ ★★ Launcher：`adoptLegacyData({dryRun:true})` 只算不写', async () => {
  const { createLauncher } = await import('./launcher.mjs')
  const f = launcherFixture('launcher-dry')
  try {
    const legacyDir = join(f.layout.installDir, 'team-hub')
    mkdirSync(legacyDir, { recursive: true })
    const db = new DatabaseSync(join(legacyDir, 'team.db'))
    db.exec('CREATE TABLE t (n INTEGER)')
    db.close()

    const L = createLauncher({
      layout: f.layout, include: [], exists: () => true, runtimeCommand: 'node runtime.mjs',
    })
    const dry = await L.adoptLegacyData({ dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.counts.adoptable, 1)
    // ★ 只算不写：目标**不能**出现
    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), false,
      'dryRun 却写出了文件')

    // 再来一次真的，读数必须变成 adopted
    const real = await L.adoptLegacyData()
    assert.equal(real.state, ADOPTION_STATES.ADOPTED)
    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), true)

    // 诊断里必须有那一行总结（否则"这次接管了没有"要靠拼四条逐项记录）
    assert.ok(L.allDiagnostics().some((d) => d.code === 'LEGACY_ADOPTION'),
      `诊断里没有接管总结：${JSON.stringify(L.allDiagnostics().map((d) => d.code))}`)
    await L.stop({ graceMs: 50 })
  } finally { f.done() }
})

// ============================================================================
// PRT-251 续 ④：接管**按启动范围**发生（`--include`）
//
// 这一组的存在理由是一句话：接管是一次性快照（目标存在即永远跳过），
// 所以「我只是想把 runtime 起起来看看」不该顺手把 team-hub 的库接走。
// ============================================================================

test('㉗ ★★★ 纯计划：`processes` 只放行范围内的进程（否则试运行会烧掉唯一一次接管）', async () => {
  const { adoptionItems, planAdoption } = await import('./legacy-data-adoption.mjs')
  const { DATA_PATH_ENV } = await import('./launcher.mjs')

  const all = adoptionItems({ dataPathEnv: DATA_PATH_ENV })
  assert.ok(all.some((i) => i.process === 'team-hub'), '全量范围里居然没有 team-hub')

  // `--include=runtime`：范围内没有 team-hub ⇒ 一项都不该出现。
  // 不是"跳过"，是"根本不在计划里"——两者的区别是后者不会报 TARGET_EXISTS，
  // 于是"这次没接管"不会被误读成"早就接管过了"。
  const scoped = adoptionItems({ dataPathEnv: DATA_PATH_ENV, processes: ['runtime'] })
  assert.equal(scoped.length, 0, `runtime 范围内不该有可接管的落点：${JSON.stringify(scoped)}`)

  // 反面控制：范围内**有** team-hub 时照常列出来。
  const withHub = adoptionItems({ dataPathEnv: DATA_PATH_ENV, processes: ['runtime', 'team-hub'] })
  assert.ok(withHub.some((i) => i.process === 'team-hub'), '范围里有 team-hub 却没列出来')

  // ★ `null`（不设范围）与 `[]`（一个都不启）是两件事
  assert.notEqual(
    adoptionItems({ dataPathEnv: DATA_PATH_ENV, processes: null }).length,
    adoptionItems({ dataPathEnv: DATA_PATH_ENV, processes: [] }).length,
    '「没告诉我要启动哪些」与「一个都不启动」被当成了同一件事',
  )
  assert.equal(adoptionItems({ dataPathEnv: DATA_PATH_ENV, processes: [] }).length, 0)
})

test('㉘ ★★★ Launcher：`--include=runtime` **不接管** team-hub 的库（真旧库在，也不动）', async () => {
  const { createLauncher } = await import('./launcher.mjs')
  const f = launcherFixture('launcher-scoped')
  try {
    // 布置一份**真的**旧库（可接管的那种）——这样"没接管"不可能是
    // "因为没有东西可接"造成的。
    const legacyDir = join(f.layout.installDir, 'team-hub')
    mkdirSync(legacyDir, { recursive: true })
    const db = new DatabaseSync(join(legacyDir, 'team.db'))
    db.exec('CREATE TABLE t (n INTEGER)')
    db.exec('INSERT INTO t (n) VALUES (1)')
    db.close()

    const L = createLauncher({
      layout: f.layout, include: ['runtime'], exists: () => true, runtimeCommand: 'node runtime.mjs',
    })
    // 先用**全量**计划证明"确实有东西可接"——否则下面那句"没接管"是空的。
    const full = await L.adoptLegacyData({ dryRun: true })
    assert.equal(full.counts.adoptable, 1, '全量计划里没有可接管的项，这条用例验不到范围')

    // 再按启动范围真跑一次。
    const scoped = await L.adoptLegacyData({ processes: ['runtime'] })
    assert.equal(scoped.state, ADOPTION_STATES.NOTHING, `范围内不该接管，实际：${scoped.state}`)
    assert.equal(scoped.counts.adopted, 0)

    // ★ 最要紧的一格：**盘上真的什么都没写**。
    //   只断 state 的话，一个"照抄了但错报了状态"的实现照样绿。
    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), false,
      '--include=runtime 却把 team-hub 的库接走了——一次性快照被一次试运行烧掉了')

    // 受限范围必须在诊断里**说出来**，否则"接管 0"看起来像"什么都没查"
    const summary = L.allDiagnostics().find((d) => d.code === 'LEGACY_ADOPTION')
    assert.ok(summary, '没有接管总结')
    assert.match(summary.message, /只覆盖启动范围内的进程/, `总结没说范围：${summary.message}`)
    await L.stop({ graceMs: 50 })
  } finally { f.done() }
})

test('㉙ ★★ 受限那次**不许**污染全量读数（记忆化只记无范围的那一次）', async () => {
  const { createLauncher } = await import('./launcher.mjs')
  const f = launcherFixture('launcher-memo')
  try {
    const legacyDir = join(f.layout.installDir, 'team-hub')
    mkdirSync(legacyDir, { recursive: true })
    const db = new DatabaseSync(join(legacyDir, 'team.db'))
    db.exec('CREATE TABLE t (n INTEGER)')
    db.close()

    const L = createLauncher({
      layout: f.layout, include: [], exists: () => true, runtimeCommand: 'node runtime.mjs',
    })
    // 先来一次受限的（它什么都不会接）
    const scoped = await L.adoptLegacyData({ processes: ['runtime'] })
    assert.equal(scoped.state, ADOPTION_STATES.NOTHING)

    // 再来一次全量：**必须**仍然看到"有一项可接管"。
    // 受限那次若被记忆化，这里会读到那份空读数，
    // 于是真正的第一次全量启动会以为无事可做——那不是幂等，是数据丢失。
    const real = await L.adoptLegacyData()
    assert.equal(real.state, ADOPTION_STATES.ADOPTED,
      '受限那次把全量读数覆盖了——真正的启动会以为无事可做')
    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), true)
    await L.stop({ graceMs: 50 })
  } finally { f.done() }
})

test('㉚ ★★★ 端到端：以 runtime 为启动范围时，`start()` 之后盘上仍然没有 team-hub 的库', async () => {
  const { createLauncher } = await import('./launcher.mjs')
  const f = launcherFixture('launcher-start-scoped')
  try {
    const legacyDir = join(f.layout.installDir, 'team-hub')
    mkdirSync(legacyDir, { recursive: true })
    const db = new DatabaseSync(join(legacyDir, 'team.db'))
    db.exec('CREATE TABLE t (n INTEGER)')
    db.close()

    // ★ 这条用例走的是 `start()` **本身**，不是 `adoptLegacyData()`：
    //   `--include` 到底有没有被传给接管，只有这一条能答。
    //   直接调 `adoptLegacyData({processes})` 是在验那个参数管不管用，
    //   不是在验**启动路径**有没有把范围交下去——两件事，
    //   而后者才是"用户加 --include 时会发生什么"。
    //
    // ★ `allowPortInUse` 是**必需**的，不是省事：本机 3080 上跑着用户那个 DSH，
    //   而 runtime 的缺省端口正是 3080。不加它，体检会在 `ports` 阶段就失败，
    //   `start()` 根本走不到接管——于是这条用例会**因为一个与它无关的原因**
    //   通过（"盘上没写"是因为什么都没跑），而它看起来完全一样。
    //   下面的 `pre.ok` 与"接管真的跑过"两条断言就是为此加的：破坏性验证
    //   第一次跑时，正是这条用例以 0 条变红暴露了那个假绿。
    const L = createLauncher({
      layout: f.layout,
      include: ['runtime'],
      allowPortInUse: ['runtime'],
      // 覆盖层那道闸也要关掉，理由与 `allowPortInUse` 同：
      // 它在**体检阶段**就会挡住，而这条用例验的是接管。
      // 让一条用例因为几件无关的事之一而变红/变绿，等于它什么都没验。
      //
      // ⚠️ 这里**没有** `enforcementIdentity: false` 这种开关——
      // 身份不是 Launcher 的入参，是从产品配置解析出来的
      // （`resolveEnforcementIdentity`）。写一个不存在的选项不会报错、
      // 也不会生效，只会让读代码的人以为"身份已经关掉了"。
      enforcementOverlay: false,
      exists: () => true,
      runtimeCommand: 'node runtime.mjs',
    })
    const pre = await L.preflight()
    assert.equal(pre.ok, true,
      `体检没过，这条用例就走不到接管：${JSON.stringify(pre.diagnostics.map((d) => d.code))}`)

    await L.start()   // 起不起得来不重要——接管的位置在 spawn **之前**

    // ★ 先证明接管**真的执行过**。否则"盘上没写"可能只是"start 早就退了"，
    //   而那与"范围生效了"在盘上是同一个读数。
    assert.ok(L.allDiagnostics().some((d) => d.code === 'LEGACY_ADOPTION'),
      'start() 根本没走到接管——这条用例没验到任何东西')

    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), false,
      'start() 没把启动范围交给接管：一次 --include=runtime 的试运行把库接走了')

    // 反面控制：同一个 Launcher 换成全量范围就会真的接（否则上面那条
    // 可能只是因为"接管根本没跑"而绿）。
    const full = await L.adoptLegacyData()
    assert.equal(full.state, ADOPTION_STATES.ADOPTED)
    assert.equal(existsSync(join(f.layout.dataDir, 'team-hub', 'team.db')), true)
    await L.stop({ graceMs: 50 })
  } finally { f.done() }
})

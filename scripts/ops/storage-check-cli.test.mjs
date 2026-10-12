// scripts/ops/storage-check-cli.test.mjs
// ============================================================================
// 体检脚本的**命令行行为**（真的把进程跑起来）。
//
// ## 为什么单测不够
//
// `storage-check.test.mjs` 测的是导出的纯函数（`checkStorage` / `verdict` /
// `statePathCheck` / `parseArgv`）。它证明了那些函数**算得对**，
// 但证明不了 `main()` **真的用了它们**。
//
// ★ 这一族是一次**破坏性验证**逼出来的：把 `main()` 里那句落点检查
//   替换成 `const place = { ok: true, … } || statePathCheck(…)`（短路，
//   检查永远不执行），把状态写入换成一句内联的 `writeFileSync`
//   —— **两处都没有判据变红**。
//
//   > 一批"证明函数算得对"的判据，与一批"证明那个函数真的被调用了"的判据，
//   > 在接线完好时是同一个东西 —— 只不过前者在**线没接上**的时候仍然全绿。
//
// 所以这里**真的 spawn 这个脚本**，然后看磁盘上发生了什么。
// ============================================================================
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve(new URL('./storage-check.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/** 造一个工作区：一个假的库 + 一个备份目录。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'legion-cli-'))
  const db = join(root, 'data', 'team.db')
  const backups = join(root, 'data', 'backups')
  const run = join(root, 'run')
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(backups, { recursive: true })
  mkdirSync(run, { recursive: true })
  writeFileSync(db, Buffer.alloc(4096))
  writeFileSync(join(backups, 'team-x.db.gpg'), 'x')
  return { root, db, backups, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 跑脚本，回 `{ status, stdout, stderr }`。 */
function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('storage-check CLI（真进程）', () => {
  it('★★★ ① 正常跑：状态文件真的被写出来，且退出码与结论一致', () => {
    const s = sandbox()
    try {
      const state = join(s.run, 'storage-state.json')
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', state])
      // 库 4KB、盘充足、备份新鲜 → ok。
      assert.equal(r.status, 0, `退出码应当是 0，实际 ${r.status}\n${r.stdout}${r.stderr}`)
      assert.ok(existsSync(state), `状态文件必须真的被写出来：${state}`)
      const written = JSON.parse(readFileSync(state, 'utf8'))
      assert.equal(written.schema, 1)
      assert.equal(written.level, 'ok')
      assert.equal(written.exitCode, 0)
      // ★ 落点检查真的跑过了（`--state` 在 run/ 下，与库不同盘目录）。
      assert.doesNotMatch(r.stderr, /落点不可用/)
    } finally { s.cleanup() }
  })

  it('★★★ ② 落点是**库文件本身** → 拒绝写入，且库文件**一个字节都没变**', () => {
    // ★ 这是 CLI 级最重要的一条：一个打错的 `--state` 会盖掉库。
    //   纯函数判据证明 `statePathCheck` 认得这种情况，但证明不了
    //   `main()` 真的**照着它的结论办事**。
    const s = sandbox()
    try {
      const before = readFileSync(s.db)
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', s.db])
      assert.equal(r.status, 0, '体检结论本身仍是 ok（落点问题不该改变体检结论）')
      assert.match(r.stderr, /落点不可用/, `必须报出来，实际 stderr=${JSON.stringify(r.stderr)}`)
      assert.match(r.stderr, /覆盖数据库/)
      const after = readFileSync(s.db)
      assert.deepEqual(after, before, '库文件必须**逐字节**不变')
    } finally { s.cleanup() }
  })

  it('★★★ ③ 落点是 **WAL** → 同样拒绝（那是更脏的一种覆盖）', () => {
    const s = sandbox()
    try {
      writeFileSync(`${s.db}-wal`, Buffer.alloc(512, 7))
      const before = readFileSync(`${s.db}-wal`)
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', `${s.db}-wal`])
      assert.match(r.stderr, /覆盖数据库/)
      assert.deepEqual(readFileSync(`${s.db}-wal`), before, 'WAL 必须不变')
    } finally { s.cleanup() }
  })

  it('★★★ ④ 落点在**备份目录**里 → 拒绝，且目录里没有多出文件', () => {
    // 多一个 JSON 之后，`newestMtimeMs` 会把它当成"最新一份备份" ——
    // 于是"备份陈旧"这条告警**永远不再触发**。
    const s = sandbox()
    try {
      const before = readdirSync(s.backups).sort()
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', join(s.backups, 'storage-state.json')])
      assert.match(r.stderr, /落点不可用/)
      assert.deepEqual(readdirSync(s.backups).sort(), before, '备份目录里不许多出任何文件')
    } finally { s.cleanup() }
  })

  it('★★★ ⑤ 落点与库**同一块盘目录** → 默认拒绝；`--allow-state-on-data-disk` 才写入', () => {
    const s = sandbox()
    try {
      const same = join(s.root, 'data', 'storage-state.json')
      const r1 = cli(['--db', s.db, '--backups', s.backups, '--state', same])
      assert.match(r1.stderr, /落点不可用/, '默认必须拒绝')
      assert.equal(existsSync(same), false, '拒绝之后不许留下文件')
      // 显式放行 → 写。
      const r2 = cli(['--db', s.db, '--backups', s.backups, '--state', same, '--allow-state-on-data-disk'])
      assert.doesNotMatch(r2.stderr, /落点不可用/)
      assert.ok(existsSync(same), '放行之后必须真的写出来')
      // ★ 而显式放行**不**适用于致命那一级（盖库没有任何开关）。
      const r3 = cli(['--db', s.db, '--backups', s.backups, '--state', s.db, '--allow-state-on-data-disk'])
      assert.match(r3.stderr, /覆盖数据库/, '盖库不能被放行开关救回来')
    } finally { s.cleanup() }
  })

  it('★★★ ⑥ 状态写入是**原子**的（写完不留临时文件）', () => {
    const s = sandbox()
    try {
      const state = join(s.run, 'storage-state.json')
      cli(['--db', s.db, '--backups', s.backups, '--state', state])
      const leftovers = readdirSync(s.run).filter((f) => f.includes('.tmp-'))
      assert.deepEqual(leftovers, [], `不许留下临时文件：${leftovers.join(', ')}`)
      assert.deepEqual(readdirSync(s.run).sort(), ['storage-state.json'])
    } finally { s.cleanup() }
  })

  it('★★★ ⑦ `--no-state` 时**不**写状态（一次性体检用）', () => {
    const s = sandbox()
    try {
      const state = join(s.run, 'storage-state.json')
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', state, '--no-state'])
      assert.equal(r.status, 0)
      assert.equal(existsSync(state), false, '--no-state 时不许写')
      assert.deepEqual(readdirSync(s.run), [])
    } finally { s.cleanup() }
  })

  it('★★★ ⑧ 落点不可写时：**不抛**、退出码仍是体检结论、并把后果说清', () => {
    // ★ "写失败"只意味着 Hub 那边显示陈旧 —— 那是**诚实的**降级，
    //   而不是把整次体检判为失败（那会让一次成功的体检看起来像失败）。
    const s = sandbox()
    try {
      // 用一个**目录**当状态文件路径 → 写入必然失败。
      const asDir = join(s.run, 'nope')
      mkdirSync(asDir)
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', asDir])
      assert.equal(r.status, 0, `退出码必须仍是体检结论，实际 ${r.status}\n${r.stderr}`)
      assert.match(r.stderr, /状态/, '要说出来')
      assert.match(r.stderr, /陈旧|读不到/, '要说清**后果**，不只是原因')
      assert.doesNotMatch(r.stderr, /ENOENT: no such file/, '不许把原始 Node 错误直接倒出来')
    } finally { s.cleanup() }
  })

  it('★★★ ⑨ `--state` 打错一个字母 → 退出码 3，且**不写**任何文件', () => {
    // 静默忽略一个拼错的参数，会让脚本去写默认位置（或什么都不写），
    // 而输出看起来完全正常。
    const s = sandbox()
    try {
      const r = cli(['--db', s.db, '--backups', s.backups, '--stat', join(s.run, 'x.json')])
      assert.equal(r.status, 3, `未认识参数必须回 3，实际 ${r.status}`)
      assert.match(r.stderr, /未认识的参数/)
      assert.deepEqual(readdirSync(s.run), [], '不许写任何文件')
    } finally { s.cleanup() }
  })

  it('★★★ ⑩ 退出码分档：没有备份 → 1（warn），不是 0', () => {
    // "一份备份都没有"必须让监控看见 —— 只看退出码的监控靠这一档。
    const s = sandbox()
    try {
      rmSync(s.backups, { recursive: true, force: true })
      const r = cli(['--db', s.db, '--backups', s.backups, '--state', join(s.run, 's.json'), '--no-state'])
      assert.equal(r.status, 1, `没有备份应当是 warn(1)，实际 ${r.status}\n${r.stdout}`)
      // 而写进状态文件的等级也要是 warn（Hub 读的是这个）。
      const r2 = cli(['--db', s.db, '--backups', s.backups, '--state', join(s.run, 's.json')])
      assert.equal(r2.status, 1)
      const st = JSON.parse(readFileSync(join(s.run, 's.json'), 'utf8'))
      assert.equal(st.level, 'warn')
      assert.equal(st.exitCode, 1)
      assert.equal(st.report.backupStale, true)
    } finally { s.cleanup() }
  })

  it('★★★ ⑪ `--json` 输出可被解析，且含落点与结论', () => {
    const s = sandbox()
    try {
      const r = cli(['--db', s.db, '--backups', s.backups, '--no-state', '--json'])
      const j = JSON.parse(r.stdout)
      assert.equal(j.level, 'ok')
      assert.equal(j.dbBytes, 4096)
      assert.equal(typeof j.backupAgeMs, 'number')
      assert.equal(j.paths.db, s.db)
    } finally { s.cleanup() }
  })

  it('★★ ⑫ 只读保证：跑完之后库与备份目录**逐字节**不变', () => {
    // 这个脚本会被挂到监控上周期性运行 —— 它绝不该改任何数据。
    const s = sandbox()
    try {
      const dbBefore = readFileSync(s.db)
      const backupBefore = readdirSync(s.backups).map((f) => [f, readFileSync(join(s.backups, f)).toString('utf8')])
      cli(['--db', s.db, '--backups', s.backups, '--state', join(s.run, 's.json')])
      assert.deepEqual(readFileSync(s.db), dbBefore, '库不许变')
      const backupAfter = readdirSync(s.backups).map((f) => [f, readFileSync(join(s.backups, f)).toString('utf8')])
      assert.deepEqual(backupAfter, backupBefore, '备份目录不许变')
    } finally { s.cleanup() }
  })
})

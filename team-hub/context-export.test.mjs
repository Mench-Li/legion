// team-hub/context-export.test.mjs
// ============================================================================
// PRT-409（右半部分）：上下文快照的**导出**——自验证，且**离线**可验。
//
// spec line 897：「`PRT-409`：持久化快照并支持查看和导出。」
//
// ## 本套件盯的不是"导出的字段对不对"，而是**两个哈希的分工**
//
// 快照自带 `snapshotHash`，盖住冻结下来的正文。很自然会想"导出带着它就行了"。
// 不行——导出文件还有一层**封皮**（从哪个 attempt 导的、谁导的、什么时候导的）：
//
//   > 一个"正文哈希在导出里验得过、而封皮没有任何哈希"的导出，
//   > 与一个"谁都能把 attemptId 换成另一个 Attempt"的导出，是同一个东西——
//   > 只不过前者看起来是可验证的。
//
// 把封皮里的 `attemptId` 改掉、正文一字不动，单哈希验证**照样通过**。
// 于是一份指着错误 Attempt 的文件"验过了"——对审计来说这比没有导出更坏，
// 它是一份**盖过章的错证据**。所以本套件把这一条作为核心用例（③）。
//
// ## 为什么离线验证要**另起进程**
//
// 一份"要连回那台服务器才能验证"的导出，不是导出，是截图。
// 在同一个进程里"不碰库"是个自我承诺；另起一个**没有库、没有 hub、
// 连数据库文件路径都没传**的 node 进程去验，才是一个事实。
// ============================================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  buildSnapshotExport, verifySnapshotExport, ContextExportError,
  CONTEXT_EXPORT_VERSION, CONTEXT_EXPORT_CODES, exportCanonicalJson,
} from './context-export.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-export-'))
let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  mod = await import('./server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
async function get(path) {
  const res = await fetch(base + path)
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

/** 造一次真实的装配，返回 attemptId。 */
async function freeze(attemptId) {
  const r = await post('/api/context-snapshots/assemble', {
    attemptId, runId: attemptId, frozenAtMs: 1700000000000, scope: 'default', canReadAll: true,
    candidates: [{
      source: {
        id: 'doc:1', type: 'document', version: 'v1', acquiredAtMs: 1699999999000,
        content: '这是一段**不可信**的外部文档正文。\n第二行。', trust: 'untrusted',
      },
    }],
  })
  assert.equal(r.status, 200, `装配失败：${JSON.stringify(r.body).slice(0, 240)}`)
  return attemptId
}

/**
 * 经由**真实读路由**拿一条记录——形状与 `store.get()` 相同。
 *
 * 刻意走 HTTP 而不是直接开一个 store：用例要验的是"导出这条路"，
 * 而导出在真实系统里拿到的那份记录正是从这条路由来的。
 */
async function readRecord(attemptId) {
  const r = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}?verify=1`)
  assert.equal(r.status, 200, `读快照失败：${JSON.stringify(r.body).slice(0, 200)}`)
  return r.body
}

/** 直接数库里的行数——"导出是只读的"要用库这个事实来说，而不是用自我承诺。 */
function rowCount() {
  return mod.db.prepare('SELECT COUNT(*) AS n FROM run_context_snapshots').get().n
}
function payloadOf(attemptId) {
  return mod.db.prepare('SELECT payload_json, snapshot_hash FROM run_context_snapshots WHERE attempt_id = ?')
    .get(attemptId)
}

// ── ① 基本往返 ────────────────────────────────────────────────────────────

test('① 构建 → 离线验证：两个哈希都成立，且导出是只读的', async () => {
  const attemptId = await freeze('att:export-1:1')
  const before1 = rowCount()
  const rec = await readRecord(attemptId)
  assert.ok(rec !== null)

  const doc = buildSnapshotExport(rec, { exportedBy: 'auditor', exportedAtMs: 1700000001000 })
  assert.equal(doc.exportVersion, CONTEXT_EXPORT_VERSION)
  assert.equal(doc.envelope.attemptId, attemptId)
  assert.equal(doc.envelope.sourceStoreHash, doc.snapshotHash)

  const v = verifySnapshotExport(doc)
  assert.equal(v.wellFormed, true)
  assert.equal(v.snapshotOk, true, `正文必须验得过：${JSON.stringify(v.findings)}`)
  assert.equal(v.exportOk, true, `封皮必须验得过：${JSON.stringify(v.findings)}`)
  assert.equal(v.ok, true)
  assert.deepEqual([...v.findings], [])

  // 只读：导出不许改动源
  assert.equal(rowCount(), before1, '导出之后快照数不许变')
  const after2 = await readRecord(attemptId)
  assert.equal(after2.snapshot.snapshotHash, rec.snapshot.snapshotHash)
  assert.equal(JSON.stringify(after2.snapshot), JSON.stringify(rec.snapshot), '导出不许改内容')
})

test('①b 导出里带着**完整正文**，不只是哈希——否则它导不出"模型看到了什么"', async () => {
  const attemptId = await freeze('att:export-1b:1')
  const rec = await readRecord(attemptId)
  const doc = buildSnapshotExport(rec, { exportedBy: 'auditor', exportedAtMs: 1700000001000 })
  assert.equal(doc.snapshot.finalText, rec.snapshot.finalText)
  assert.match(doc.snapshot.finalText, /不可信/,
    '导出的正文里必须有真实内容——只导摘要/哈希的导出无法回答它存在的那个问题')
  assert.ok(doc.snapshot.sources.length > 0)
})

// ── ② ★ 核心：封皮被改，而正文一字未动 ────────────────────────────────────

test('★★★ 只改封皮里的 attemptId（正文不动）→ 正文仍验得过，但导出必须判为失败', async () => {
  const attemptId = await freeze('att:export-2:1')
  await freeze('att:export-2:2')
  const doc = buildSnapshotExport(
    await readRecord(attemptId), { exportedBy: 'auditor', exportedAtMs: 1700000001000 },
  )

  // 把这份文件冒充成**另一个 Attempt** 的导出。正文、快照哈希、顶层 snapshotHash 全不动。
  const forged = {
    ...doc,
    envelope: { ...doc.envelope, attemptId: 'att:export-2:2' },
  }

  const v = verifySnapshotExport(forged)
  assert.equal(v.snapshotOk, true,
    '★ 正文必须仍然验得过——这正是"只验正文哈希"会漏掉这一类的证明')
  assert.equal(v.exportOk, false, '★ 封皮被改了，导出哈希必须对不上')
  assert.equal(v.ok, false, '整份导出必须判为不通过')
  assert.ok(v.findings.some((f) => f.code === CONTEXT_EXPORT_CODES.ENVELOPE_TAMPERED),
    `必须报出"封皮被改"而不是"正文被改"：${JSON.stringify(v.findings)}`)
  assert.ok(!v.findings.some((f) => f.code === CONTEXT_EXPORT_CODES.SNAPSHOT_TAMPERED),
    '正文没被改，就不该报正文被改——报错的东西错了会让排查走向反方向')
  // 诊断里必须点明"正文仍然是好的"，否则读的人会去查错的地方
  const detail = v.findings.find((f) => f.code === CONTEXT_EXPORT_CODES.ENVELOPE_TAMPERED).detail
  assert.match(detail, /正文/, `封皮被改的说明必须点明正文没动：${detail}`)
})

test('★ 封皮的其它字段（导出行者/时间/来源哈希）同样被哈希盖住', async () => {
  const attemptId = await freeze('att:export-2b:1')
  const doc = buildSnapshotExport(
    await readRecord(attemptId), { exportedBy: 'auditor', exportedAtMs: 1700000001000 },
  )
  for (const patch of [
    { exportedBy: 'someone-else' },
    { exportedAtMs: 1800000000000 },
    { sourceStoreHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    { runId: 'run-别的' },
  ]) {
    const v = verifySnapshotExport({ ...doc, envelope: { ...doc.envelope, ...patch } })
    assert.equal(v.exportOk, false, `改封皮字段 ${Object.keys(patch)[0]} 之后必须验不过`)
    assert.equal(v.snapshotOk, true, `改封皮不该影响正文判定（${Object.keys(patch)[0]}）`)
  }
})

// ── ③ 正文被改 ────────────────────────────────────────────────────────────

test('★★ 改正文里的一个字符 → 正文验不过（且必须报"正文被改"）', async () => {
  const attemptId = await freeze('att:export-3:1')
  const doc = buildSnapshotExport(
    await readRecord(attemptId), { exportedBy: 'auditor', exportedAtMs: 1700000001000 },
  )
  const text = doc.snapshot.finalText
  const tampered = { ...doc, snapshot: { ...doc.snapshot, finalText: text.replace('不可信', '不可信啊') } }
  assert.notEqual(tampered.snapshot.finalText, text, '替换必须真的生效——没生效的替换会伪装成"产品缺陷"')
  const v = verifySnapshotExport(tampered)
  assert.equal(v.snapshotOk, false)
  assert.equal(v.ok, false)
  assert.ok(v.findings.some((f) => f.code === CONTEXT_EXPORT_CODES.SNAPSHOT_TAMPERED))
})

test('★★ 顶层 snapshotHash 与正文自带的那个不一致 → 报错（有人只改了其中一个）', async () => {
  const attemptId = await freeze('att:export-3b:1')
  const doc = buildSnapshotExport(
    await readRecord(attemptId), { exportedBy: 'auditor', exportedAtMs: 1700000001000 },
  )
  const v = verifySnapshotExport({ ...doc, snapshotHash: 'sha256:' + '9'.repeat(64) })
  assert.equal(v.ok, false)
  assert.ok(v.findings.some((f) => f.code === CONTEXT_EXPORT_CODES.SNAPSHOT_TAMPERED),
    '两个 snapshotHash 不一致必须被发现——它们是同一件事的两次书写')

  // ★ 还要单独钉住 **exportOk**，不能只钉 `ok`。
  //
  //   破坏性验证发现：把导出哈希的覆盖范围从"取余"退回"列举 {envelope, snapshot}"
  //   之后，**这条用例照样绿**——因为顶层 snapshotHash 不在覆盖范围内，
  //   但上面那条"两份 snapshotHash 不一致"的 finding 仍然会被产出来，
  //   而 `ok` 把 findings 也算进去了。于是两条防线里有一条**从来没被执行过**：
  //
  //     > 一个"两条防线互相覆盖、于是谁都可以不存在"的实现，
  //     > 与一个"只有一条防线、而它是好的"实现，在用例上看起来一模一样。
  //
  //   钉住 exportOk 才是直接钉住"**这个字段在不在哈希覆盖范围内**"。
  assert.equal(v.exportOk, false,
    '顶层字段必须在导出哈希的覆盖范围内：一个不受哈希保护的字段，'
    + '与一个不存在于文档里的字段，在"这份文件能不能被改"上是同一个答案')
  assert.equal(v.snapshotOk, true, '正文本身没被改——正文的判定不该被牵连')
})

// ── ④ ★ 离线：另起一个没有库的进程来验 ───────────────────────────────────

test('★★★ 另一台"机器"（无库、无 hub 的子进程）能独立验证这份导出', async () => {
  const attemptId = await freeze('att:export-4:1')
  const doc = buildSnapshotExport(
    await readRecord(attemptId), { exportedBy: 'auditor', exportedAtMs: 1700000001000 },
  )
  const docPath = join(tmpRoot, 'export.json')
  writeFileSync(docPath, JSON.stringify(doc), 'utf8')

  const scriptPath = join(tmpRoot, 'verify-offline.mjs')
  const exportUrl = pathToFileURL(join(ROOT, 'team-hub', 'context-export.mjs')).href
  const docUrl = pathToFileURL(docPath).href
  writeFileSync(scriptPath, [
    `import { verifySnapshotExport } from ${JSON.stringify(exportUrl)}`,
    `import { readFileSync } from 'node:fs'`,
    `import { fileURLToPath } from 'node:url'`,
    `const doc = JSON.parse(readFileSync(fileURLToPath(${JSON.stringify(docUrl)}), 'utf8'))`,
    `const v = verifySnapshotExport(doc)`,
    // 只输出结论，不输出正文：这个进程的唯一任务就是判定
    `process.stdout.write(JSON.stringify({ ok: v.ok, exportOk: v.exportOk, snapshotOk: v.snapshotOk, findings: v.findings.length }))`,
  ].join('\n'), 'utf8')

  // ★ 注意：**不传** TEAM_HUB_DB、不传任何库路径。
  //   在同一个进程里"不碰库"是自我承诺；另起一个进程才是事实。
  const env = { ...process.env }
  delete env.TEAM_HUB_DB
  const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env, timeout: 60000 })
  assert.equal(r.status, 0, `子进程验证失败：${r.stderr?.slice(0, 300)}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.snapshotOk, true)
  assert.equal(out.exportOk, true)
  assert.equal(out.ok, true)
  assert.equal(out.findings, 0)

  // 同一个子进程验**被改过的封皮**也必须判失败——否则它只是"永远说 ok"
  const forgedPath = join(tmpRoot, 'export-forged.json')
  writeFileSync(forgedPath, JSON.stringify({
    ...doc, envelope: { ...doc.envelope, attemptId: 'att:别的:1' },
  }), 'utf8')
  const script2 = join(tmpRoot, 'verify-forged.mjs')
  writeFileSync(script2, [
    `import { verifySnapshotExport } from ${JSON.stringify(exportUrl)}`,
    `import { readFileSync } from 'node:fs'`,
    `import { fileURLToPath } from 'node:url'`,
    `const doc = JSON.parse(readFileSync(fileURLToPath(${JSON.stringify(pathToFileURL(forgedPath).href)}), 'utf8'))`,
    `const v = verifySnapshotExport(doc)`,
    `process.stdout.write(JSON.stringify({ ok: v.ok, snapshotOk: v.snapshotOk }))`,
  ].join('\n'), 'utf8')
  const r2 = spawnSync(process.execPath, [script2], { encoding: 'utf8', env, timeout: 60000 })
  assert.equal(r2.status, 0, `子进程失败：${r2.stderr?.slice(0, 300)}`)
  const out2 = JSON.parse(r2.stdout)
  assert.equal(out2.snapshotOk, true, '正文仍然是好的')
  assert.equal(out2.ok, false, '★ 离线进程也必须能识破封皮篡改——否则"离线可验"是空话')
})

// ── ⑤ ★ 拒绝导出验不过的记录（不要把篡改洗白） ───────────────────────────

test('★★★ 记录本身验不过 → **拒绝导出**，而不是导出一份"看起来带哈希"的文件', async () => {
  const attemptId = await freeze('att:export-5:1')
  const rec = await readRecord(attemptId)

  // 情形一：正文被改（哈希与内容对不上）
  const brokenBody = { ...rec, snapshot: { ...rec.snapshot, finalText: rec.snapshot.finalText + '加了字' } }
  assert.throws(
    () => buildSnapshotExport(brokenBody, { exportedBy: 'a', exportedAtMs: 1 }),
    (e) => {
      assert.equal(e.code, CONTEXT_EXPORT_CODES.RECORD_NOT_VERIFIED)
      assert.match(e.message, /拒绝|被改/)
      return true
    },
    '把一份验不过的记录导出，等于把一次篡改**洗白**成一份带哈希的正规文件',
  )

  // 情形二：正文自洽，但**库里那一行**记的哈希是另一个（整行被换过）
  const brokenRow = { ...rec, snapshotHash: 'sha256:' + '7'.repeat(64) }
  assert.throws(
    () => buildSnapshotExport(brokenRow, { exportedBy: 'a', exportedAtMs: 1 }),
    (e) => {
      assert.equal(e.code, CONTEXT_EXPORT_CODES.STORE_HASH_MISMATCH)
      return true
    },
    '只验正文自洽会漏掉"整行连同 payload 一起换成另一份自洽快照"',
  )
})

test('★ 缺 exportedAtMs / exportedBy / 正文 → 拒绝（不猜默认值）', async () => {
  const attemptId = await freeze('att:export-5b:1')
  const rec = await readRecord(attemptId)
  const ok = { exportedBy: 'a', exportedAtMs: 1700000001000 }

  assert.throws(() => buildSnapshotExport(rec, { ...ok, exportedAtMs: undefined }),
    (e) => e.code === CONTEXT_EXPORT_CODES.BAD_RECORD,
    '不拿"现在"当默认值——一个没写时间的导出会被读成"就是刚导的"')
  assert.throws(() => buildSnapshotExport(rec, { ...ok, exportedBy: '   ' }),
    (e) => e.code === CONTEXT_EXPORT_CODES.BAD_RECORD)
  assert.throws(() => buildSnapshotExport({ ...rec, snapshot: null }, ok),
    (e) => e.code === CONTEXT_EXPORT_CODES.BAD_RECORD,
    '只有摘要的记录导不出"模型当时看到了什么"')
  assert.throws(() => buildSnapshotExport(null, ok), (e) => e.code === CONTEXT_EXPORT_CODES.BAD_RECORD)
})

// ── ⑥ 结构不合法的文档：分开报，不猜 ─────────────────────────────────────

test('★ 结构不合法 → wellFormed:false，且**不**把未知版本按已知语义读', () => {
  assert.equal(verifySnapshotExport(null).wellFormed, false)
  assert.equal(verifySnapshotExport(null).ok, false)
  assert.equal(verifySnapshotExport({}).wellFormed, false)
  assert.equal(verifySnapshotExport({ envelope: {} }).wellFormed, false, '缺 snapshot 正文')

  // 版本不同的封面：不猜字段语义
  const wrong = verifySnapshotExport({
    envelope: { exportVersion: 'legion/context-snapshot-export@99' },
    snapshot: { snapshotHash: 'sha256:x' },
    exportHash: 'sha256:y',
  })
  assert.equal(wrong.wellFormed, false)
  assert.ok(wrong.findings.some((f) => f.code === CONTEXT_EXPORT_CODES.MALFORMED_DOC))
})

// ── ⑦ ★ 两个哈希的分工：同一次导出时间不同 → 导出哈希不同，正文哈希相同 ──

test('★★ 同一份快照导两次：exportHash 必然不同，而 snapshotHash 必然相同', async () => {
  const attemptId = await freeze('att:export-7:1')
  const rec = await readRecord(attemptId)
  const a = buildSnapshotExport(rec, { exportedBy: 'auditor', exportedAtMs: 1700000001000 })
  const b = buildSnapshotExport(rec, { exportedBy: 'auditor', exportedAtMs: 1700000002000 })

  // ★ 这条断言的方向很容易写反。`exportedAtMs` 是封皮的一部分，
  //   而封皮进了 exportHash——所以两份导出**必然**不同。
  //   写成"两次导出应当同哈希"的用例会把一条正确的行为报成缺陷；
  //   更糟的是，它可能诱使实现把 exportedAtMs 从哈希里拿掉，
  //   于是"这份文件是什么时候导的"就变成了一句可以随便改的话。
  assert.notEqual(a.exportHash, b.exportHash, '导出时间进了封皮，所以导出哈希必然不同')
  assert.equal(a.snapshotHash, b.snapshotHash, '而正文是同一份，正文哈希必然相同')
  assert.equal(a.envelope.exportedAtMs === b.envelope.exportedAtMs, false)

  // 差异**只在封皮**：把封皮换掉之后，正文的 canonical 文本必须逐字节相同
  assert.equal(doc_body(a), doc_body(b),
    '两份导出的差异必须**只在封皮**——否则"正文没变"这句话就没有依据')
  // 而**整份**导出的 canonical 文本必须不同——证明封皮真的进了哈希覆盖范围。
  // 少了这一条，"只哈希正文"的实现也能让上面那条通过。
  assert.notEqual(exportCanonicalJson(a), exportCanonicalJson(b),
    '整份导出的 canonical 文本必须不同：封皮必须在哈希覆盖范围内')
})

/** 取一份导出里"只有正文"的那部分 canonical 文本。 */
function doc_body(doc) {
  return JSON.stringify({ snapshot: doc.snapshot })
}

test('★ 两份不同快照的导出哈希必须不同（否则封皮哈希没有区分力）', async () => {
  const a = buildSnapshotExport(await readRecord(await freeze('att:export-7b:1')),
    { exportedBy: 'auditor', exportedAtMs: 1700000001000 })
  const b = buildSnapshotExport(await readRecord(await freeze('att:export-7b:2')),
    { exportedBy: 'auditor', exportedAtMs: 1700000001000 })
  assert.notEqual(a.exportHash, b.exportHash)
  assert.notEqual(a.snapshotHash, b.snapshotHash)
})

// ── ⑧ 路由 ────────────────────────────────────────────────────────────────

test('★★ HTTP：GET /api/context-snapshots/<attemptId>/export 返回可离线验证的文档', async () => {
  const attemptId = await freeze('att:export-8:1')
  const r = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}/export?by=auditor&atMs=1700000001000`)
  assert.equal(r.status, 200, `导出路由失败：${JSON.stringify(r.body).slice(0, 240)}`)
  const doc = r.body.export
  assert.ok(doc, '响应里必须有 export 文档')
  const v = verifySnapshotExport(doc)
  assert.equal(v.ok, true, `路由产出的文档必须自验证通过：${JSON.stringify(v.findings)}`)
  assert.equal(doc.envelope.exportedBy, 'auditor')

  // ★ 路由产出的文档必须与**直接构建**的逐字节同哈希——否则"导出"有两条路
  const direct = buildSnapshotExport(
    await readRecord(attemptId),
    { exportedBy: 'auditor', exportedAtMs: 1700000001000 },
  )
  assert.equal(doc.exportHash, direct.exportHash,
    '同一次导出的两条路（路由 / 直接构建）必须给出同一个文档')
})

test('★★ 路由：缺 by / atMs → 400，且**理由必须来自路由这一层**', async () => {
  const attemptId = await freeze('att:export-8b:1')
  const noBy = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}/export?atMs=1700000001000`)
  assert.equal(noBy.status, 400, `缺 by 必须 400：${JSON.stringify(noBy.body).slice(0, 160)}`)
  const noAt = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}/export?by=auditor`)
  assert.equal(noAt.status, 400, '缺 atMs 必须 400——不拿"现在"当默认值')

  // ★ 必须钉住**具名码**，不能只钉状态码。
  //
  //   这里同样是**两层**校验：路由先查 `by`/`atMs`，构建器再查
  //   `exportedBy`/`exportedAtMs`。把路由那一层整层删掉，构建器照样会拒绝，
  //   状态码**一字不变**——只是理由换了一套：
  //
  //     > 同一个请求被两层校验都拒绝、而两层给的**理由**不同，
  //     > 只看状态码分辨不出是哪一层拦下的——
  //     > 于是"路由层的检查"可以整层不存在，而用例全绿。
  //
  //   （这是本项目里**第二次**踩到同一形状：PRT-412 的
  //   `AUTHORITY_BEARING_KEYS` 与白名单也是两层同码不同理由。）
  assert.equal(noBy.body?.code, 'EXPORT_BY_REQUIRED',
    '缺 by 的理由必须来自路由层，而不是笼统的构建失败')
  assert.equal(noAt.body?.code, 'EXPORT_AT_REQUIRED',
    '缺 atMs 的理由必须来自路由层')
  assert.notEqual(noBy.body?.code, noAt.body?.code,
    '两种缺参必须给**不同**的码——同一个码会让调用方不知道该补哪一个')
})

test('★ 路由：不存在的 attempt → 404，而不是一份空导出', async () => {
  const r = await get('/api/context-snapshots/att%3Anever-existed%3A1/export?by=a&atMs=1700000001000')
  assert.equal(r.status, 404, `不存在的快照必须 404：${JSON.stringify(r.body).slice(0, 160)}`)
  assert.equal(r.body.export, undefined, '404 时不许给出一份"空的但格式正确"的导出')
})

test('★ 路由不能被 <attemptId> 的通配路由抢走', async () => {
  // `/api/context-snapshots/<attemptId>` 的处理器会拒绝含 `/` 的 id（400 MISSING_PARAM）。
  // 如果 /export 写在它后面，就会拿到那个 400。
  const attemptId = await freeze('att:export-8c:1')
  const r = await get(`/api/context-snapshots/${encodeURIComponent(attemptId)}/export?by=a&atMs=1700000001000`)
  assert.notEqual(r.body?.code, 'MISSING_PARAM',
    '导出路由必须排在通配路由之前，否则永远拿不到它')
})

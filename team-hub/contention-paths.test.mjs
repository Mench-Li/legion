// team-hub/contention-paths.test.mjs —— BUG-006 回归：诊断端点与认领路径**同一套文件域取法**
//
// 缺陷（实测 2026-10-05）：`GET /api/tasks/:id/contention` 曾写成 `intent?.paths ?? []`
// —— **不看 `tasks.fileDomain`**；而认领路径（reserveWrite / claim / transition）用的是
// `intent?.paths ?? fileDomain`。于是**同一个任务**在诊断里被当成"未申报 ⇒ 整仓独占"，
// 却在认领路径上用自己的文件域正常认领。将军据此去查了一个不存在的文件冲突。
//
// 判据按验收要求**两半对照**，四个方向各一条（缺任何一条都可能是"改宽了"而不是"改对了"）：
//   ① 声明 fileDomain、无 intent ⇒ contention ok:true，且**同一任务**能被 /api/claim 认领成功；
//   ② 声明 fileDomain 且与持有者真重叠 ⇒ 仍报 FILE_CONTENTION（不许把真冲突也说成没事）；
//   ③ 有 active intent ⇒ **以 intent 为准**（intent 优先于 fileDomain 的既有语义不变）；
//   ④ 未声明 fileDomain、无 intent ⇒ 仍按**整仓独占**（这个方向不许被顺手改掉）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('BUG-006：contention 与认领路径共用同一套文件域取法（四方向对照）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-contention-paths-'))
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  const hub = await import('./server.mjs')
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + hub.server.address().port
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const get = async (path) => {
    const response = await fetch(base + path)
    return { status: response.status, body: await response.json() }
  }
  const contention = (id) => get('/api/tasks/' + id + '/contention')
  const claim = (id) => post('/api/claim', { id, by: 'worker', scope: 'default' })

  try {
    const ins = hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount,fileDomain) VALUES (?,?,?,?,?,?)')
    const plain = hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)')

    // 持有者：真正占住 feature/a（用 write-intent + claim —— 与生产认领同一条路）
    plain.run('T-hold', 'holder', 'todo', 'default', 0)
    assert.equal((await post('/api/tasks/T-hold/write-intent', { by: 'planner', scope: 'default', paths: ['feature/a'] })).status, 200)
    const holdClaim = await claim('T-hold')
    assert.equal(holdClaim.status, 200, JSON.stringify(holdClaim.body))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-hold' AND state='reserved'").get().n, 1)

    // ① 声明 fileDomain（feature/b，与持有者不重叠）、**无 intent** ⇒ 诊断必须说"没冲突"，并且真能认领
    ins.run('T-dom-free', 'domain free', 'todo', 'default', 0, JSON.stringify(['feature/b']))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM task_write_intents WHERE task_id='T-dom-free'").get().n, 0,
      '前提：这个任务没有 write-intent（缺陷只在"无 intent"的路由上暴露）')
    const free = await contention('T-dom-free')
    assert.equal(free.status, 200)
    assert.equal(free.body.ok, true,
      '声明了 fileDomain、无 intent 的任务不该被判成整仓独占（修前这里是 false + (whole repository)）')
    assert.deepEqual(free.body.conflicts, [])
    assert.equal(free.body.pathsFrom, 'file-domain-fallback', '诊断必须说清路径是哪来的')
    assert.equal((await claim('T-dom-free')).status, 200, '同一条路径取法下，它能被认领')
    assert.equal(hub.db.prepare("SELECT source FROM task_write_intents WHERE task_id='T-dom-free'").get().source, 'file-domain-fallback')

    // ② 声明 fileDomain、但与持有者**真重叠** ⇒ 仍须报冲突（不许把真冲突说成没事）
    ins.run('T-dom-hit', 'domain hit', 'todo', 'default', 0, JSON.stringify(['feature/a']))
    const hit = await contention('T-dom-hit')
    assert.equal(hit.body.ok, false, '与持有者重叠的声明域必须仍判冲突')
    assert.equal(hit.body.code, 'FILE_CONTENTION')
    assert.equal(hit.body.holderTaskId, 'T-hold')
    assert.ok(!hit.body.paths.includes('(whole repository)'),
      '声明了具体文件域时不该退化成整仓独占：paths 应当就是它的域')
    // 冲突读数里的 paths 是**路径字符串**（与既有用例同一形状，见 write-intent-routes.test.mjs
    // 的 `blocked.body.paths.includes('src/a.mjs')`），不是 {path,type} 对象。
    assert.deepEqual(hit.body.paths, ['feature/a'])

    // ③ 有 active intent ⇒ 以 **intent** 为准（intent 优先于 fileDomain 的既有语义不变）
    //
    // 这里必须用**收窄**来构造，否则这条判据区分不开两种取法：
    // `POST /api/tasks/:id/write-intent` 会强制 intent ⊆ fileDomain（越界 422 OUT_OF_FILE_DOMAIN），
    // 所以"intent 指向 fileDomain 之外的目录"这种形态在 API 上**根本不存在**。可区分的形态是
    // 「域里有一部分被持有者占着，而 intent 收窄到不冲突的那部分」：
    //   · 按 fileDomain 取（['feature/a','feature/c']）⇒ 撞上持有者的 feature/a，报冲突；
    //   · 按 intent 取（['feature/c']）⇒ 无冲突，ok:true。
    // 因此 ok:true + pathsFrom==='intent' 正是"intent 赢了"的证据 —— 若实现退回 fileDomain，
    // 这一条会立刻变成 ok:false。
    ins.run('T-intent-wins', 'intent wins', 'todo', 'default', 0, JSON.stringify(['feature/a', 'feature/c']))
    assert.equal((await post('/api/tasks/T-intent-wins/write-intent', { by: 'planner', scope: 'default', paths: ['feature/c'] })).status, 200)
    const wins = await contention('T-intent-wins')
    assert.equal(wins.body.ok, true,
      'intent 收窄到不冲突的目录后必须判无冲突：若这里回到按 fileDomain 取，就会误报与持有者冲突')
    assert.equal(wins.body.pathsFrom, 'intent')

    // ④ 未声明 fileDomain、无 intent ⇒ 仍按整仓独占（这个方向不许被改掉）
    plain.run('T-unplanned', 'unplanned', 'todo', 'default', 0)
    const unplanned = await contention('T-unplanned')
    assert.equal(unplanned.body.ok, false, '未申报的任务仍按整仓独占')
    assert.deepEqual(unplanned.body.paths, ['(whole repository)'])
    assert.equal(unplanned.body.pathsFrom, 'unplanned-exclusive')
  } finally {
    hub.server.closeAllConnections?.()
    hub.server.close()
    hub.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

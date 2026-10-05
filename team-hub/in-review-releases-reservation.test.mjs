import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BUG-009-c 回归：任务进 `in_review` 时必须**释放**写入预约。
//
// 现场：T-178 已交付进 main、任务停在 in_review，它的预约却继续握着
// `workbench/ security/ orchestrator/ team-hub/ runtime/`，把同域切片 T-184 挡在
// `waiting-file` 四十多分钟，直到人工去调 release 接口才解开。
// in_review 的语义是"这一轮写完并提交了"（worker 提交后才自己转到这个状态），
// **它不再写任何文件**，继续占着域纯属账本没结清。
//
// 判据分三半（缺一不可）：
//   ① 认领 → 确实有活跃预约（前置成立，否则这条用例什么都没证明）；
//   ② 转 in_review → 预约变成 released、scheduling_state 变 released；
//   ③ 对照：转 `blocked`（**不确定性**结束：不知道 worker 停没停）仍然是 reconciling 冻结 ——
//      "写完提交了"与"不知道停没停"不是一回事，不许被一起放开。

test('BUG-009-c：进 in_review 释放写入预约，且不放松"未确认停止"那条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-inreview-release-'))
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  const hub = await import('./server.mjs')
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + hub.server.address().port
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  const state = (id) => hub.db.prepare("SELECT state FROM write_reservations WHERE task_id=? ORDER BY id DESC LIMIT 1").get(id)?.state
  const sched = (id) => hub.db.prepare('SELECT scheduling_state AS s FROM tasks WHERE id=?').get(id)?.s

  try {
    const ins = hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)')
    ins.run('T-ir', 'in_review 释放', 'todo', 'default', 0)
    ins.run('T-blk', 'blocked 冻结（对照）', 'todo', 'default', 0)

    // ① 前置：两条都先认领，各自拿到活跃预约（用 write-intent 声明域，避免整仓独占互相挡）
    assert.equal((await post('/api/tasks/T-ir/write-intent', { by: 'planner', scope: 'default', paths: ['src/ir.mjs'] })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-ir', by: 'worker', scope: 'default' })).status, 200)
    assert.equal(state('T-ir'), 'reserved', '前置：认领后必须有活跃预约')

    assert.equal((await post('/api/tasks/T-blk/write-intent', { by: 'planner', scope: 'default', paths: ['src/blk.mjs'] })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-blk', by: 'worker', scope: 'default' })).status, 200)
    assert.equal(state('T-blk'), 'reserved')

    // ② 转 in_review ⇒ 预约释放（这就是本次修复）
    const ir = await post('/api/transition', { id: 'T-ir', to: 'in_review', by: 'worker', scope: 'default' })
    assert.equal(ir.status, 200, JSON.stringify(ir.body))
    assert.equal(state('T-ir'), 'released',
      '进 in_review 必须释放预约：它已经写完并提交，却继续占着声明的域 —— T-184 就是这样被一个**已交付**的任务挡住的')
    assert.equal(sched('T-ir'), 'released', 'scheduling_state 也要跟着到 released，否则看板仍显示"占着"')

    // ③ 对照：转 blocked 仍是 reconciling（未确认停止 ⇒ 不许放开）
    //    守卫读的是"**by 不是当前执行者**时不许替它确认已停" —— 认领时 soldier 已经变成 worker，
    //    所以这里换一个旁观者来试（这正是那条护栏存在的意义：别人不能替执行者断言"它停了"）。
    const blkDenied = await post('/api/transition', { id: 'T-blk', to: 'blocked', by: 'bystander', scope: 'default', confirmedStopped: true })
    assert.equal(blkDenied.status, 403, '只有当前执行者能确认 worker 已停止（顺带确认这条既有护栏没被放松）')
    const blk2 = await post('/api/transition', { id: 'T-blk', to: 'blocked', by: 'worker', scope: 'default' })
    assert.equal(blk2.status, 200, JSON.stringify(blk2.body))
    assert.equal(state('T-blk'), 'reconciling',
      'blocked 属于"不知道 worker 停没停"，必须保持冻结 —— 本次修复不许顺手把它也放开（那会出现两个写者）')
  } finally {
    hub.server.closeAllConnections?.()
    hub.server.close()
    hub.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

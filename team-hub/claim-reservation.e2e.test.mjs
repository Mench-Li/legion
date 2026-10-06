import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('真实任务认领与文件预约同事务：撞车等待，释放后才能开工', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-claim-reserve-'))
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  const hub = await import('./server.mjs')
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + hub.server.address().port
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  try {
    const ins = hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount) VALUES (?,?,?,?,?)')
    ins.run('T-holder', 'holder', 'todo', 'default', 0)
    ins.run('T-waiter', 'waiter', 'todo', 'default', 0)
    const intentA = await post('/api/tasks/T-holder/write-intent', { by: 'planner', scope: 'default', paths: ['src/a.mjs'] })
    const intentB = await post('/api/tasks/T-waiter/write-intent', { by: 'planner', scope: 'default', paths: ['src/a.mjs'] })
    assert.equal(intentA.status, 200)
    assert.equal(intentB.status, 200)
    const a = await post('/api/claim', { id: 'T-holder', by: 'worker', scope: 'default' })
    assert.equal(a.status, 200, JSON.stringify(a.body))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-holder' AND state='reserved'").get().n, 1)
    const grantView = await fetch(base + '/api/tasks/T-holder/reservation')
    assert.equal(grantView.status, 200)
    const grantBody = await grantView.json()
    assert.equal(grantBody.reservation.attemptId, grantBody.intent.attemptId)
    assert.equal(grantBody.reservation.state, 'reserved')
    const b = await post('/api/claim', { id: 'T-waiter', by: 'worker', scope: 'default' })
    assert.equal(b.status, 409)
    assert.equal(b.body.code, 'FILE_CONTENTION')
    assert.equal(b.body.holderTaskId, 'T-holder')
    assert.equal(hub.db.prepare("SELECT status FROM tasks WHERE id='T-waiter'").get().status, 'todo')
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-waiter'").get().n, 0)
    assert.equal(hub.db.prepare("SELECT fixCount FROM tasks WHERE id='T-waiter'").get().fixCount, 0)
    ins.run('T-transition', 'transition start', 'todo', 'default', 0)
    await post('/api/tasks/T-transition/write-intent', { by: 'planner', scope: 'default', paths: ['src/a.mjs'] })
    const transitionBlocked = await post('/api/transition', { id: 'T-transition', to: 'in_progress', by: 'worker', scope: 'default' })
    assert.equal(transitionBlocked.status, 409)
    assert.equal(transitionBlocked.body.code, 'FILE_CONTENTION')
    assert.equal(hub.db.prepare("SELECT status FROM tasks WHERE id='T-transition'").get().status, 'todo')
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-transition'").get().n, 0)
    const row = hub.db.prepare("SELECT repo_id, attempt_id, lease_epoch FROM write_reservations WHERE task_id='T-holder'").get()
    const release = await post('/api/tasks/T-holder/reservation/release', { by: 'worker', scope: 'default', repoId: row.repo_id, attemptId: row.attempt_id, epoch: row.lease_epoch })
    assert.equal(release.status, 200)
    const transitioned = await post('/api/transition', { id: 'T-transition', to: 'in_progress', by: 'worker', scope: 'default' })
    assert.equal(transitioned.status, 200, JSON.stringify(transitioned.body))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-transition' AND state='reserved'").get().n, 1)
    const releasedTransition = await post('/api/advance', { id: 'T-transition', by: 'worker', scope: 'default' })
    assert.equal(releasedTransition.status, 200)
    const retry = await post('/api/claim', { id: 'T-waiter', by: 'worker', scope: 'default' })
    assert.equal(retry.status, 200, JSON.stringify(retry.body))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-waiter' AND state='reserved'").get().n, 1)
    const done = await post('/api/advance', { id: 'T-waiter', by: 'worker', scope: 'default' })
    assert.equal(done.status, 200, JSON.stringify(done.body))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-waiter' AND state='reserved'").get().n, 0)

    ins.run('T-run-holder', 'run holder', 'in_progress', 'default', 0)
    ins.run('T-run-waiter', 'run waiter', 'todo', 'default', 0)
    await post('/api/tasks/T-run-waiter/write-intent', { by: 'planner', scope: 'default', paths: ['src/run.mjs'] })
    const holder = await post('/api/tasks/T-run-holder/reservation', { by: 'worker', scope: 'default', attemptId: 'holder-run', epoch: 1, paths: ['src/run.mjs'] })
    assert.equal(holder.body.ok, true)
    const runtimeBlocked = await post('/api/runtime/claim', { workerId: 'runner', scope: 'default' })
    assert.equal(runtimeBlocked.status, 200)
    assert.equal(runtimeBlocked.body.claimed, null)
    assert.equal(runtimeBlocked.body.reason, 'file-contention')
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM run_attempts WHERE task_id='T-run-waiter'").get().n, 0)
    ins.run('T-run-free', 'run free', 'todo', 'default', 0)
    await post('/api/tasks/T-run-free/write-intent', { by: 'planner', scope: 'default', paths: ['src/free.mjs'] })
    const skippedHead = await post('/api/runtime/claim', { workerId: 'runner', scope: 'default' })
    assert.equal(skippedHead.body.claimed.taskId, 'T-run-free', JSON.stringify(skippedHead.body))
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM run_attempts WHERE task_id='T-run-waiter'").get().n, 0)
    const releaseRun = await post('/api/tasks/T-run-holder/reservation/release', { by: 'worker', scope: 'default', attemptId: 'holder-run', epoch: 1 })
    assert.equal(releaseRun.status, 200)
    const runtimeGranted = await post('/api/runtime/claim', { workerId: 'runner', scope: 'default' })
    assert.equal(runtimeGranted.body.claimed.taskId, 'T-run-waiter')
    const runReservation = hub.db.prepare("SELECT attempt_id, lease_epoch FROM write_reservations WHERE task_id='T-run-waiter' AND state='reserved'").get()
    assert.equal(runReservation.attempt_id, runtimeGranted.body.claimed.attemptId)
    assert.equal(runReservation.lease_epoch, runtimeGranted.body.claimed.leaseEpoch)

    ins.run('T-retry', 'review retry', 'todo', 'default', 0)
    await post('/api/tasks/T-retry/write-intent', { by: 'planner', scope: 'default', paths: ['src/retry.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-retry', by: 'worker', scope: 'default' })).status, 200)
    const beforeRetry = hub.db.prepare("SELECT attempt_id, lease_epoch FROM write_reservations WHERE task_id='T-retry' AND state='reserved'").get()
    assert.equal((await post('/api/transition', { id: 'T-retry', to: 'in_review', by: 'worker', scope: 'default' })).status, 200)
    assert.equal((await post('/api/transition', { id: 'T-retry', to: 'todo', by: 'worker', scope: 'default' })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-retry', by: 'worker', scope: 'default' })).status, 200)
    const afterRetry = hub.db.prepare("SELECT attempt_id, lease_epoch FROM write_reservations WHERE task_id='T-retry' AND state='reserved'").get()
    assert.notEqual(afterRetry.attempt_id, beforeRetry.attempt_id)
    assert.ok(afterRetry.lease_epoch > beforeRetry.lease_epoch)
    assert.equal(hub.db.prepare("SELECT COUNT(*) AS n FROM write_reservations WHERE task_id='T-retry' AND state='reserved'").get().n, 1)

    ins.run('T-blocked-resume', 'blocked resume', 'todo', 'default', 0)
    await post('/api/tasks/T-blocked-resume/write-intent', { by: 'planner', scope: 'default', paths: ['src/blocked.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-blocked-resume', by: 'worker', scope: 'default' })).status, 200)
    const deniedStop = await post('/api/transition', { id: 'T-blocked-resume', to: 'blocked', by: 'general', scope: 'default', confirmedStopped: true })
    assert.equal(deniedStop.status, 403)
    assert.equal((await post('/api/transition', { id: 'T-blocked-resume', to: 'blocked', by: 'worker', scope: 'default', confirmedStopped: true })).status, 200)
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-blocked-resume' ORDER BY id DESC LIMIT 1").get().state, 'released')
    assert.equal((await post('/api/claim', { id: 'T-blocked-resume', by: 'worker', scope: 'default' })).status, 200)
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-blocked-resume' ORDER BY id DESC LIMIT 1").get().state, 'reserved')

    ins.run('T-manual-stop', 'manual stop', 'todo', 'default', 0)
    await post('/api/tasks/T-manual-stop/write-intent', { by: 'planner', scope: 'default', paths: ['src/manual.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-manual-stop', by: 'worker', scope: 'default' })).status, 200)
    assert.equal((await post('/api/transition', { id: 'T-manual-stop', to: 'blocked', by: 'general', scope: 'default' })).status, 200)
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-manual-stop' ORDER BY id DESC LIMIT 1").get().state, 'reconciling')
    assert.equal((await post('/api/claim', { id: 'T-manual-stop', by: 'worker', scope: 'default' })).status, 409)
    assert.equal((await post('/api/tasks/T-manual-stop/reservation/confirm-stopped', { by: 'worker', scope: 'default', confirm: 'stopped:T-manual-stop' })).status, 403)
    assert.equal((await post('/api/tasks/T-manual-stop/reservation/confirm-stopped', { by: 'general', scope: 'default', confirm: 'stopped:T-manual-stop' })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-manual-stop', by: 'worker', scope: 'default' })).status, 200)

    const insertDomain = hub.db.prepare('INSERT INTO tasks (id,title,status,scope,fixCount,fileDomain) VALUES (?,?,?,?,?,?)')
    insertDomain.run('T-domain-a', 'domain a', 'todo', 'default', 0, JSON.stringify(['feature/a']))
    insertDomain.run('T-domain-b', 'domain b', 'todo', 'default', 0, JSON.stringify(['feature/b']))
    assert.equal((await post('/api/claim', { id: 'T-domain-a', by: 'worker', scope: 'default' })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-domain-b', by: 'worker', scope: 'default' })).status, 200)
    assert.equal(hub.db.prepare("SELECT source FROM task_write_intents WHERE task_id='T-domain-a'").get().source, 'file-domain-fallback')

    // ── ⑯ 守护重启孤儿：**必须真的释放**写入资格，否则"自动重新认领"是空话 ──────────
    //
    // 这一条钉的是一个把任务卡死过三轮的真缺陷（T-173 线、T-174、T-177）：
    // `releaseStaleTasks` 的「显式 ids」分支（= 守护在自己的进程刚重启、确认上一轮 worker
    // 已随进程消失之后发来的孤儿名单）把任务置回 todo，却在同一事务里把写入预约
    // **冻结**成 `reconciling`（`cancelled: true`）。于是任务看起来可以重新认领，
    // 实际每一次 claim 都以 `RECONCILING`（"上一轮执行尚未确认停止"）被拒，
    // 只能靠人工调 confirm-stopped 解开——而它的评论写的是"自动释放回 todo 重新认领续做"。
    //
    // 判据分两半，缺一不可：
    //   ① 孤儿释放后，**立即** claim 必须成功（不需要任何人工确认）；
    //   ② 与它对照：同样置回 todo 的**超龄**路径必须仍是冻结（执行者可能还活着，
    //      放开就会出现两个写者）——「重启孤儿已确认消失」与「很久没进展」不是一回事。
    ins.run('T-boot-orphan', 'boot orphan', 'todo', 'default', 0)
    await post('/api/tasks/T-boot-orphan/write-intent', { by: 'planner', scope: 'default', paths: ['src/orphan.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-boot-orphan', by: 'worker', scope: 'default' })).status, 200)
    const orphanRelease = await post('/api/release-stale', { by: 'general', scope: 'default', olderThan: 1, ids: ['T-boot-orphan'] })
    assert.equal(orphanRelease.status, 200)
    assert.deepEqual(orphanRelease.body.task?.released ?? orphanRelease.body.released, ['T-boot-orphan'])
    assert.equal(hub.db.prepare("SELECT status FROM tasks WHERE id='T-boot-orphan'").get().status, 'todo')
    // ① 关键断言：写入资格是 released（不是 reconciling），且**不需要人工确认**就能再认领
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-boot-orphan' ORDER BY id DESC LIMIT 1").get().state, 'released',
      '守护重启孤儿的解锁必须是 released：它已经确认执行者随进程消失，冻结会让任务永久认领不了')
    const reclaimOrphan = await post('/api/claim', { id: 'T-boot-orphan', by: 'worker', scope: 'default' })
    assert.equal(reclaimOrphan.status, 200,
      '孤儿释放后必须能立即重新认领（从前这里 409 RECONCILING："上一轮执行尚未确认停止"）')

    // ② 对照：超龄释放仍然冻结（安全的那个方向不许被"顺手"改掉）
    ins.run('T-stale-frozen', 'stale frozen', 'todo', 'default', 0)
    await post('/api/tasks/T-stale-frozen/write-intent', { by: 'planner', scope: 'default', paths: ['src/stale.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-stale-frozen', by: 'worker', scope: 'default' })).status, 200)
    // 把认领时间推老到超过 olderThan，再不带 ids 调一次（= 超龄路径）
    hub.db.prepare("UPDATE tasks SET claimedAt=? WHERE id='T-stale-frozen'").run(new Date(Date.now() - 3600_000).toISOString())
    const staleRelease = await post('/api/release-stale', { by: 'general', scope: 'default', olderThan: 1 })
    assert.equal(staleRelease.status, 200)
    assert.ok((staleRelease.body.task?.released ?? staleRelease.body.released ?? []).includes('T-stale-frozen'))
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-stale-frozen' ORDER BY id DESC LIMIT 1").get().state, 'reconciling',
      '超龄释放仍须冻结：它证明不了执行者已停止，放开就会出现两个写者')
    assert.equal((await post('/api/claim', { id: 'T-stale-frozen', by: 'worker', scope: 'default' })).status, 409)
    // 而它回到 todo 的意义正在这里：人工确认那条恢复路径可用
    assert.equal((await post('/api/tasks/T-stale-frozen/reservation/confirm-stopped', { by: 'general', scope: 'default', confirm: 'stopped:T-stale-frozen' })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-stale-frozen', by: 'worker', scope: 'default' })).status, 200)

    // ── ⑯③ ★ BUG-012：「老」与「孤儿」是**同一个任务**时，按**生产的次序**跑两条回收 ─────────
    //
    // ⑯① 与 ⑯② 各自都对，但它们的现场被切得各只让一条路径看得见：
    //   ① 的孤儿是**刚认领**的 ⇒ 超龄判据不命中 ⇒ 只有「带 ids」那条能看到它；
    //   ② 的任务**不是孤儿**   ⇒ 「带 ids」那条看不到它 ⇒ 只有超龄那条能看到它。
    // 生产上这两个"看不见"都不成立：孤儿的 `claimedAt` 通常**早已**超过 `staleMinutes`
    // （worker 超时预算 45 分钟、staleMinutes 60，而长任务很常见），于是**两条都能看见它**，
    // 谁先跑就决定了它被真释放还是被冻结。
    //
    // 现场（2026-10-06，docs/bugs/BUG-012-boot-orphan-reclaim-order.md）：守护把超龄那条排在前面，
    // 于是 T-189 被冻结 7 小时、850 次认领失败，它的整仓独占预约把 T-190 一起堵死，
    // 整个 software 空间零进展，只能人工 confirm-stopped 解开。
    //
    // 这一条钉**组合**：老孤儿 + 守护的真实次序（先 ids，后超龄）⇒ 必须真释放。
    ins.run('T-old-orphan', 'old orphan', 'todo', 'default', 0)
    await post('/api/tasks/T-old-orphan/write-intent', { by: 'planner', scope: 'default', paths: ['src/old-orphan.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-old-orphan', by: 'worker', scope: 'default' })).status, 200)
    // 推老到超过 olderThan ⇒ 此刻它**同时**满足两条回收的判据（老 + 孤儿）
    hub.db.prepare("UPDATE tasks SET claimedAt=? WHERE id='T-old-orphan'").run(new Date(Date.now() - 3600_000).toISOString())
    const orphanFirst = await post('/api/release-stale', { by: 'general', scope: 'default', olderThan: 1, ids: ['T-old-orphan'] })
    assert.equal(orphanFirst.status, 200)
    assert.ok((orphanFirst.body.task?.released ?? orphanFirst.body.released ?? []).includes('T-old-orphan'))
    const staleSecond = await post('/api/release-stale', { by: 'general', scope: 'default', olderThan: 1 })
    assert.equal(staleSecond.status, 200)
    assert.equal((staleSecond.body.task?.released ?? staleSecond.body.released ?? []).includes('T-old-orphan'), false,
      '第二趟必须已经看不见它（任务已是 todo，不在 in_progress 扫描里）—— 这就是"先跑的那条决定结局"')
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-old-orphan' ORDER BY id DESC LIMIT 1").get().state, 'released',
      '老孤儿必须被**真释放**：守护手里是"宿主刚重启"这条证明，不是"很久没进展"这条猜测')
    assert.equal((await post('/api/claim', { id: 'T-old-orphan', by: 'worker', scope: 'default' })).status, 200,
      '老孤儿释放后必须能立即重认领 —— 否则它就和 T-189 一样，要人工解锁才能再动')

    // ⑯④ 反序（超龄先跑）⇒ 冻结，且**「带 ids」那条再也看不到它**。这一半解释"次序为什么不能反"。
    ins.run('T-old-orphan-rev', 'old orphan reversed', 'todo', 'default', 0)
    await post('/api/tasks/T-old-orphan-rev/write-intent', { by: 'planner', scope: 'default', paths: ['src/old-orphan-rev.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-old-orphan-rev', by: 'worker', scope: 'default' })).status, 200)
    hub.db.prepare("UPDATE tasks SET claimedAt=? WHERE id='T-old-orphan-rev'").run(new Date(Date.now() - 3600_000).toISOString())
    const staleFirst = await post('/api/release-stale', { by: 'general', scope: 'default', olderThan: 1 })
    assert.equal(staleFirst.status, 200)
    assert.ok((staleFirst.body.task?.released ?? staleFirst.body.released ?? []).includes('T-old-orphan-rev'))
    const orphanSecond = await post('/api/release-stale', { by: 'general', scope: 'default', olderThan: 1, ids: ['T-old-orphan-rev'] })
    assert.equal((orphanSecond.body.task?.released ?? orphanSecond.body.released ?? []).includes('T-old-orphan-rev'), false,
      '反序下「带 ids」那条必然扑空：任务已被超龄那条改回 todo，不再是 in_progress —— 这正是 T-189 的现场')
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-old-orphan-rev' ORDER BY id DESC LIMIT 1").get().state, 'reconciling',
      '反序的结局是冻结（必须人工 confirm-stopped）—— ③ 与 ④ 合起来，才是"守护必须把孤儿回收排在超龄回收之前"的判据')
    assert.equal((await post('/api/claim', { id: 'T-old-orphan-rev', by: 'worker', scope: 'default' })).status, 409)

    // ── ⑰ BUG-007：超时结算的诚实出口（in_progress → todo，by = 执行者本人）──────────────
    //
    // 现场记录 docs/bugs/BUG-007-timeout-reservation-not-released.md。守护 worker 超时（25 分钟）
    // 后从前既不释放预约、也不改任务状态，只写一句"下一轮自动重试"；15 分钟后超龄回收器
    // （⑯②）把预约冻结，于是那句话永远无法兑现，任务每 40 分钟卡死一次。
    // 修好后：守护在**证实 worker 已停止**时，以 by = t.soldier + confirmedStopped: true 走
    // in_progress → todo —— hub 侧就是这里的三半对照。
    ins.run('T-timeout-confirmed', 'timeout confirmed', 'todo', 'default', 0)
    await post('/api/tasks/T-timeout-confirmed/write-intent', { by: 'planner', scope: 'default', paths: ['src/timeout.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-timeout-confirmed', by: 'worker', scope: 'default' })).status, 200)
    // ① 能证实（执行者本人声明已停止）⇒ released + 回 todo + 下一轮立刻能认领
    const confirmedStop = await post('/api/transition', { id: 'T-timeout-confirmed', to: 'todo', by: 'worker', scope: 'default', confirmedStopped: true })
    assert.equal(confirmedStop.status, 200, JSON.stringify(confirmedStop.body))
    assert.equal(hub.db.prepare("SELECT status FROM tasks WHERE id='T-timeout-confirmed'").get().status, 'todo')
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-timeout-confirmed' ORDER BY id DESC LIMIT 1").get().state, 'released',
      '能证实时必须是 released（cancelled:false）："下一轮自动重试"只有这样才成立')
    assert.equal((await post('/api/claim', { id: 'T-timeout-confirmed', by: 'worker', scope: 'default' })).status, 200,
      '释放后下一轮必须能真正重派（从前这里 409 RECONCILING："上一轮执行尚未确认停止"）')

    // ② 对照：同样是 in_progress → todo，但**不能证实**（confirmedStopped=false）⇒ 仍冻结
    ins.run('T-timeout-unconfirmed', 'timeout unconfirmed', 'todo', 'default', 0)
    await post('/api/tasks/T-timeout-unconfirmed/write-intent', { by: 'planner', scope: 'default', paths: ['src/timeout2.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-timeout-unconfirmed', by: 'worker', scope: 'default' })).status, 200)
    const unconfirmedStop = await post('/api/transition', { id: 'T-timeout-unconfirmed', to: 'todo', by: 'worker', scope: 'default' })
    assert.equal(unconfirmedStop.status, 200)
    assert.equal(hub.db.prepare("SELECT status FROM tasks WHERE id='T-timeout-unconfirmed'").get().status, 'todo')
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-timeout-unconfirmed' ORDER BY id DESC LIMIT 1").get().state, 'reconciling',
      '不能证实仍须冻结：这一半不许被"顺手释放"改掉')
    assert.equal((await post('/api/claim', { id: 'T-timeout-unconfirmed', by: 'worker', scope: 'default' })).status, 409)
    // 人工确认那条恢复路径仍可用（与 ⑯② 同一条）
    assert.equal((await post('/api/tasks/T-timeout-unconfirmed/reservation/confirm-stopped', { by: 'general', scope: 'default', confirm: 'stopped:T-timeout-unconfirmed' })).status, 200)
    assert.equal((await post('/api/claim', { id: 'T-timeout-unconfirmed', by: 'worker', scope: 'default' })).status, 200)

    // ③ 诚实出口只对**执行者本人**开放：非执行者拿 confirmedStopped=true 声明必须 403，且整事务回滚
    ins.run('T-timeout-imposter', 'timeout imposter', 'todo', 'default', 0)
    await post('/api/tasks/T-timeout-imposter/write-intent', { by: 'planner', scope: 'default', paths: ['src/timeout3.mjs'] })
    assert.equal((await post('/api/claim', { id: 'T-timeout-imposter', by: 'worker', scope: 'default' })).status, 200)
    const imposter = await post('/api/transition', { id: 'T-timeout-imposter', to: 'todo', by: 'general', scope: 'default', confirmedStopped: true })
    assert.equal(imposter.status, 403)
    assert.equal(imposter.body.code, 'STOP_CONFIRMATION_DENIED')
    assert.equal(hub.db.prepare("SELECT status FROM tasks WHERE id='T-timeout-imposter'").get().status, 'in_progress')
    assert.equal(hub.db.prepare("SELECT state FROM write_reservations WHERE task_id='T-timeout-imposter' ORDER BY id DESC LIMIT 1").get().state, 'reserved',
      '403 必须整事务回滚：非执行者声明既不能释放、也不能冻结他人的预约')
  } finally {
    hub.server.closeAllConnections?.()
    hub.server.close()
    hub.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

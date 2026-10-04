// product/node/executor.test.mjs
// 远程 Agent 通道 S-E：本地执行器接缝。
//
// 用一个真实的 node 子进程当执行器（写一段内联脚本），而不是替身——这个接缝的
// 全部价值就在"跨进程"这件事上：stdin 关没关、stdout 分行、退出码、取消时
// 子进程有没有真的死掉，替身一个都测不到。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXECUTOR_CODES, createCommandExecutor } from './executor.mjs'

/** 把一段 JS 源码当成执行器：`node -e <script>`。 */
const nodeExecutor = (script, opts = {}) => createCommandExecutor({ command: process.execPath, args: ['-e', script], ...opts })

const TASK = { task: { id: 'T-1', title: '示例任务' }, attempt: { attemptId: 'att-1', leaseEpoch: 1 }, workspace: { scope: 'software', path: process.cwd() } }

test('进展以 JSON 行上报，结果帧给出终态', async () => {
  const progress = []
  const run = nodeExecutor(`
    console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: '第一步' }));
    console.log('这行不是 JSON，应当留在本地');
    console.log(JSON.stringify({ type: 'progress', kind: 'tool', summary: '调了测试' }));
    console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '都过了', artifacts: [{ path: 'reports/out.md' }] }));
  `)
  const result = await run({ ...TASK, onProgress: (p) => progress.push(p) })
  assert.equal(result.outcome, 'completed')
  assert.equal(result.summary, '都过了')
  assert.deepEqual(result.artifacts, [{ path: 'reports/out.md' }])
  assert.deepEqual(progress, [
    { kind: 'step', summary: '第一步', detail: undefined },
    { kind: 'tool', summary: '调了测试', detail: undefined },
  ])
  // ★ 非 JSON 行留在本地，**不出境**。它们也照样被记下来，供人在电脑上排障。
  assert.ok(result.localLog.some((l) => l.includes('这行不是 JSON')))
})

test('任务经 stdin 送达（执行器能读到完整任务）', async () => {
  const run = nodeExecutor(`
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { raw += d; });
    process.stdin.on('end', () => {
      const input = JSON.parse(raw);
      console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '收到 ' + input.task.id }));
    });
  `)
  const result = await run(TASK)
  // 不关 stdin 的话，一个读到 EOF 才继续的执行器会一直等（超时是 30 分钟）。
  assert.equal(result.summary, '收到 T-1')
})

test('结果帧优先于退出码：非零退出但有结果时以结果为准', async () => {
  const run = nodeExecutor(`
    console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '做完了，收尾时非零退出' }));
    process.exit(3);
  `)
  const r = await run(TASK)
  // ★ 反过来（有非零退出码就改判失败）会把一次成功的交付记成失败，
  //   而那是"任务被莫名重跑"的来源。
  assert.equal(r.outcome, 'completed')
})

test('非零退出且没有结果帧 → failed，并带上退出码', async () => {
  const run = nodeExecutor(`console.error('炸了'); process.exit(7);`)
  const r = await run(TASK)
  assert.equal(r.outcome, 'failed')
  assert.equal(r.code, EXECUTOR_CODES.EXIT_NONZERO)
  assert.match(r.summary, /退出码 7/)
  assert.ok(r.localLog.some((l) => l.includes('炸了')), 'stderr 应留在本地日志')
})

test('退出码 0 但没有结果帧 → outcome_unknown（而不是"完成"）', async () => {
  const run = nodeExecutor(`console.log('我什么也没说');`)
  const r = await run(TASK)
  // ★ 退出码只说明进程正常结束，不说明它做完了任务。报 unknown 而不是 failed：
  //   这两者在 Hub 侧的处置不同（unknown 要人对账，failed 走重试策略）。
  assert.equal(r.outcome, 'outcome_unknown')
  assert.equal(r.code, EXECUTOR_CODES.NO_RESULT)
})

test('未登记的 outcome 被拒，且降级为 failed（不猜）', async () => {
  const run = nodeExecutor(`console.log(JSON.stringify({ type: 'result', outcome: 'succeeded', summary: 'ok' }));`)
  const r = await run(TASK)
  assert.equal(r.outcome, 'failed')
  assert.equal(r.code, EXECUTOR_CODES.BAD_RESULT)
  assert.match(r.summary, /succeeded/)
})

test('重复上报结果时只采用第一条（第二条进本地日志）', async () => {
  const run = nodeExecutor(`
    console.log(JSON.stringify({ type: 'result', outcome: 'failed', summary: '第一条' }));
    console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '第二条' }));
  `)
  const r = await run(TASK)
  // 采用两次中的哪一条都是猜，而"猜错了"的代价是把失败记成完成。
  assert.equal(r.outcome, 'failed')
  assert.equal(r.summary, '第一条')
  assert.ok(r.localLog.some((l) => l.includes('重复上报结果')))
})

test('取消会真的杀掉子进程，并把结果报成 cancelled', async () => {
  const controller = new AbortController()
  const run = nodeExecutor(`
    console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: '开始长任务' }));
    setTimeout(() => { console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '不该到这里' })); }, 30000);
  `)
  const started = Date.now()
  const promise = run({ ...TASK, signal: controller.signal })
  setTimeout(() => controller.abort(), 200)
  const r = await promise
  assert.equal(r.outcome, 'cancelled')
  assert.equal(r.code, EXECUTOR_CODES.CANCELLED)
  assert.equal(r.cancelled, true)
  assert.ok(Date.now() - started < 5000, '取消应立即生效，而不是等子进程自己结束')
})

test('超时被杀时报 outcome_unknown（副作用是否发生未知）', async () => {
  const run = nodeExecutor(`setTimeout(() => {}, 30000);`, { timeoutMs: 250 })
  const r = await run(TASK)
  // ★ 超时不能用 failed：我们不知道那个进程在被杀之前做没做外部写，
  //   而 failed 会走自动重试——重复付费/重复删除的来源。
  assert.equal(r.outcome, 'outcome_unknown')
  assert.equal(r.code, EXECUTOR_CODES.TIMEOUT)
  assert.equal(r.timedOut, true)
})

test('无法启动执行器时报 spawn 失败，而不是静默挂住', async () => {
  const run = createCommandExecutor({ command: process.execPath, args: ['-e', 'ok'], spawnFn: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } })
  await assert.rejects(() => run(TASK), /ENOENT/)
})

test('超长单行不解析也不撑爆内存', async () => {
  const run = nodeExecutor(`
    process.stdout.write(JSON.stringify({ type: 'progress', kind: 'step', summary: 'x'.repeat(2000000) }));
    process.stdout.write('\\n');
    console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: '仍然有结果' }));
  `)
  const r = await run(TASK)
  assert.equal(r.outcome, 'completed')
  assert.equal(r.overflow, true, '应记录发生过超长行')
})

test('cwd 取工作区路径（执行器在授权的工作区里跑）', async () => {
  const run = createCommandExecutor({
    command: process.execPath,
    args: ['-e', `console.log(JSON.stringify({ type: 'result', outcome: 'completed', summary: process.cwd() }))`],
  })
  const r = await run({ ...TASK, workspace: { scope: 'software', path: process.cwd() } })
  assert.equal(r.summary, process.cwd())
})

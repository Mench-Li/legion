// product/node/ledger.test.mjs
// 远程 Agent 通道 S-E：本地运行账本。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LEDGER_MAX_ENTRIES, LEDGER_PHASES, createRunLedger } from './ledger.mjs'

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'legion-ledger-')), 'ledger.json')

test('记录的字段与阶段是受控的，非法 phase 直接拒', () => {
  const ledger = createRunLedger({ file: null })
  const e = ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'accepted' })
  assert.equal(e.created, true)
  assert.deepEqual(LEDGER_PHASES, ['accepted', 'running', 'finished'])
  assert.throws(() => ledger.record({ taskId: 'T', attemptId: 'A', leaseEpoch: 1, phase: 'failed' }), /未登记的 phase/)
  assert.throws(() => ledger.record({ taskId: 'T', attemptId: 'A', leaseEpoch: 0, phase: 'accepted' }), /正整数 leaseEpoch/)
  assert.throws(() => ledger.record({ taskId: 'T', phase: 'accepted' }), /taskId 与 attemptId/)
})

test('账本里没有任何"任务状态"字段（它只记本进程视角）', () => {
  const ledger = createRunLedger({ file: null })
  const entry = ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'running' })
  // ★ 设计文档 §6.3：不得在本地另建一套可与 Hub 冲突的任务状态。
  //   `phase` 回答"我这里在干什么"，**不**回答"这个任务完成了没有"。
  for (const forbidden of ['status', 'taskStatus', 'task_state', 'completed', 'succeeded']) {
    assert.ok(!(forbidden in entry), `账本条目不得含 ${forbidden}`)
  }
})

test('同一 attempt+epoch 重复记录是更新而不是新增', () => {
  const ledger = createRunLedger({ file: null })
  ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 3, phase: 'accepted' })
  const second = ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 3, phase: 'running' })
  assert.equal(second.created, false)
  assert.equal(ledger.list().length, 1)
  assert.equal(ledger.get('att-1').phase, 'running')
})

test('epoch 变化**不**覆盖旧行：旧 epoch 那次运行确实发生过', () => {
  const ledger = createRunLedger({ file: null })
  ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'running' })
  ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 2, phase: 'running' })
  assert.equal(ledger.list().length, 2)
  // 抹掉旧 epoch 等于抹掉对账需要的证据（那次运行可能产生了副作用）。
  assert.equal(ledger.get('att-1', 1).leaseEpoch, 1)
  assert.equal(ledger.get('att-1', 2).leaseEpoch, 2)
})

test('unsettled 只列未收尾的（断线重启后要靠它对账）', () => {
  const ledger = createRunLedger({ file: null })
  ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'accepted' })
  ledger.record({ taskId: 'T-2', attemptId: 'att-2', leaseEpoch: 1, phase: 'running' })
  ledger.record({ taskId: 'T-3', attemptId: 'att-3', leaseEpoch: 1, phase: 'finished', outcome: 'completed' })
  assert.deepEqual(ledger.unsettled().map((e) => e.attemptId).sort(), ['att-1', 'att-2'])
  assert.equal(ledger.stats().unsettled, 2)
})

test('序号跨记录单调递增，且按 attempt+epoch 各自独立', () => {
  const ledger = createRunLedger({ file: null })
  ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'accepted' })
  ledger.record({ taskId: 'T-2', attemptId: 'att-2', leaseEpoch: 1, phase: 'accepted' })
  assert.equal(ledger.nextSeq({ attemptId: 'att-1', leaseEpoch: 1 }), 1)
  assert.equal(ledger.nextSeq({ attemptId: 'att-1', leaseEpoch: 1 }), 2)
  assert.equal(ledger.nextSeq({ attemptId: 'att-2', leaseEpoch: 1 }), 1, '另一条尝试应从 1 开始')
  assert.equal(ledger.nextSeq({ attemptId: 'att-1', leaseEpoch: 1 }), 3)
  assert.throws(() => ledger.nextSeq({ attemptId: 'nope', leaseEpoch: 1 }), /先 record 再取序号/)
})

test('序号跨进程重启继续递增（否则重连后新进展会被当成重放丢掉）', () => {
  const file = tmpFile()
  try {
    const first = createRunLedger({ file })
    first.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'running' })
    first.nextSeq({ attemptId: 'att-1', leaseEpoch: 1 })
    first.nextSeq({ attemptId: 'att-1', leaseEpoch: 1 })

    // 模拟进程重启：新开一个账本读同一个文件。
    const second = createRunLedger({ file })
    // ★ 如果这里回到 1，Hub 会把断线之后的**新**进展按 (attempt_id, event_seq)
    //   当成重复跳过——手机上再也看不到任何进展，而两端都不报错。
    assert.equal(second.nextSeq({ attemptId: 'att-1', leaseEpoch: 1 }), 3)
  } finally { rmSync(file, { recursive: true, force: true }) }
})

test('落盘后可读回，且是原子替换（不留下半个 JSON）', () => {
  const file = tmpFile()
  try {
    const ledger = createRunLedger({ file })
    ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'running' })
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.entries.length, 1)
    const reopened = createRunLedger({ file })
    assert.equal(reopened.get('att-1').phase, 'running')
  } finally { rmSync(file, { recursive: true, force: true }) }
})

test('坏账本按空处理而不是让节点起不来', () => {
  const file = tmpFile()
  try {
    writeFileSync(file, '{ this is not json', 'utf8')
    const ledger = createRunLedger({ file })
    // 把"对账信息缺失"升级成"机器不能用"是更坏的失败方式。
    assert.equal(ledger.list().length, 0)
    assert.ok(ledger.record({ taskId: 'T', attemptId: 'A', leaseEpoch: 1, phase: 'accepted' }))
  } finally { rmSync(file, { recursive: true, force: true }) }
})

test('条数上限生效，且更早的条目先被淘汰', () => {
  let t = 1_000_000
  const ledger = createRunLedger({ file: null, clock: () => (t += 1000) })
  for (let i = 0; i < LEDGER_MAX_ENTRIES + 20; i += 1) {
    ledger.record({ taskId: `T-${i}`, attemptId: `att-${i}`, leaseEpoch: 1, phase: 'finished' })
  }
  assert.equal(ledger.list().length, LEDGER_MAX_ENTRIES)
  // 最新那条一定在，最老的那条一定不在。
  assert.ok(ledger.get(`att-${LEDGER_MAX_ENTRIES + 19}`) !== null)
  assert.equal(ledger.get('att-0'), null)
})

test('forget 只清点名的条目', () => {
  const ledger = createRunLedger({ file: null })
  ledger.record({ taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, phase: 'finished' })
  ledger.record({ taskId: 'T-2', attemptId: 'att-2', leaseEpoch: 1, phase: 'finished' })
  assert.equal(ledger.forget(['att-1']).removed, 1)
  assert.deepEqual(ledger.list().map((e) => e.attemptId), ['att-2'])
})

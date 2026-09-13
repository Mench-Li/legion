// team-hub/context-store.test.mjs
// ============================================================================
// PRT-409：RunContextSnapshot 的持久化与查看（spec §6.5）
//
// 这一组守的是"**没有持久化就等于无法查看**"这件事：
// 在写入这张表之前，快照只存在于一次函数调用的栈上，
// 于是阶段 4 的完成标准（"还原其实际输入、来源版本、过滤和裁剪原因"）
// 无论装配器做得多对都无法达成。
//
// 两条主轴：
//   ① **不可变**——同一次 Attempt 的上下文不可能有两个版本；
//   ② **落库前与读回时都验哈希**——一份被改过的记录会让往后每一次"还原"
//      都建立在假前提上，而没有任何东西会说话。
// ============================================================================
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { CONTEXT_STORE_ERRORS, createContextStore } from './context-store.mjs'
import { assembleContext } from '../runtime/context/assembler.mjs'
import {
  SOURCE_TRUST,
  TOKEN_ESTIMATOR_KINDS,
  createContextSource,
} from '../runtime/contracts/context.mjs'

let db
let store
let audits

const tok = { kind: TOKEN_ESTIMATOR_KINDS.EXACT, count: (t) => t.length }

const src = (over = {}) => createContextSource({
  id: 'd1', type: 'document', version: 'v1', acquiredAtMs: 1, content: 'hello world',
  trust: SOURCE_TRUST.UNTRUSTED, ...over,
})

const snap = (over = {}) => assembleContext({
  attemptId: 'att-1', runId: 'run-1', frozenAtMs: 5_000,
  associations: { goalId: 'g1', taskId: 't1', employeeId: 'e1', teamPlanId: 'tp1' },
  candidates: [{ source: src() }],
  policy: { scope: 'default', maxTokens: null, canRead: () => true },
  tokenizer: tok,
  ...over,
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  audits = []
  store = createContextStore({ db, clock: () => 9_000, writeAudit: (p) => audits.push(p) })
})

describe('① 没有持久化 = 无法查看（本任务存在的理由）', () => {
  test('记下一份快照后可以完整读回来', () => {
    const s = snap()
    const r = store.record(s, { scope: 'default', actor: 'general' })
    assert.equal(r.ok, true)
    assert.equal(r.idempotent, false)

    const got = store.get('att-1')
    assert.ok(got !== null)
    assert.equal(got.snapshotHash, s.snapshotHash)
    assert.equal(got.includedCount, 1)
    assert.equal(got.candidateCount, 1)
  })

  test('**存的是全文**，不只是哈希（否则"还原"没有字面意义）', () => {
    const s = snap()
    store.record(s, { scope: 'default' })
    const got = store.get('att-1')
    assert.equal(got.snapshot.finalText, s.finalText)
    assert.ok(got.snapshot.finalText.includes('hello world'), '正文必须能读回来')
  })

  test('两个账本与分段都读得回来（裁剪原因可还原）', () => {
    const s = snap({
      candidates: [
        { source: src({ id: 'doc', content: 'A'.repeat(100) }), allowTruncate: true },
        { source: src({ id: 'secret', type: 'task', content: 'S' }), scope: 'other' },
      ],
      policy: { scope: 'default', maxTokens: 30, canRead: () => true },
    })
    store.record(s, { scope: 'default' })
    const got = store.get('att-1')
    assert.equal(got.truncationCount, 1)
    assert.equal(got.excludedCount, 1)
    assert.equal(got.snapshot.excluded[0].reason, 'out-of-scope')
    assert.equal(got.snapshot.truncations[0].id, 'doc')
    assert.ok(got.snapshot.segments.length >= 1, '分段表必须能读回来')
    assert.equal(got.summary.includes('截断'), true, '摘要要说得出来')
  })

  test('列表给摘要且可按 run 过滤', () => {
    store.record(snap({ attemptId: 'a1', runId: 'r1' }), { scope: 'default' })
    store.record(snap({ attemptId: 'a2', runId: 'r1' }), { scope: 'default' })
    store.record(snap({ attemptId: 'a3', runId: 'r2' }), { scope: 'default' })
    assert.equal(store.count(), 3)
    assert.equal(store.list().length, 3)
    assert.equal(store.list({ runId: 'r1' }).length, 2)
    assert.equal(store.list({ scope: 'nope' }).length, 0)
    // 摘要**不含**正文（列表不该把每份快照的全文都拖出来）
    assert.equal('finalText' in store.list()[0], false)
  })

  test('不存在的 Attempt → get 返回 null，verify 抛 404', () => {
    assert.equal(store.get('nope'), null)
    assert.throws(() => store.verify('nope'), (e) => {
      assert.equal(e.code, CONTEXT_STORE_ERRORS.NOT_FOUND)
      assert.equal(e.statusCode, 404)
      return true
    })
  })
})

describe('② 不可变：同一次运行的上下文不可能有两个版本', () => {
  test('重复记同一份 → 幂等成功（重试是合法的）', () => {
    const s = snap()
    const a = store.record(s, { scope: 'default' })
    const b = store.record(s, { scope: 'default' })
    assert.equal(a.idempotent, false)
    assert.equal(b.idempotent, true)
    assert.equal(store.count(), 1)
  })

  test('**同一个 attemptId 记不同内容 → 409 冲突**（不是"后写的赢"）', () => {
    store.record(snap(), { scope: 'default' })
    const different = snap({
      candidates: [{ source: src({ content: '内容变了' }) }],
    })
    assert.throws(() => store.record(different, { scope: 'default' }), (e) => {
      assert.equal(e.code, CONTEXT_STORE_ERRORS.CONFLICT)
      assert.equal(e.statusCode, 409, '冲突用 409，不是 400——请求没错，是状态不允许')
      assert.notEqual(e.existingHash, e.incomingHash)
      return true
    })
    // 原来的那份**没有被覆盖**：冲突不能有任何副作用。
    assert.equal(store.get('att-1').snapshotHash, snap().snapshotHash)
    assert.equal(store.count(), 1)
  })

  test('没有 update 这类入口；唯一的删除必须**留下墓碑**', () => {
    // ★ 这条用例的分类在 PRT-409 收尾时被**收紧**了，而不是被放宽。
    //
    //   原文是 `deepEqual(Object.keys(store), ['count','get','list','record','verify'])`，
    //   钉的是"整个 store 里没有任何删除入口"。加保留策略时它**变红了**——
    //   它在做自己该做的事。但"把它加进白名单"是最坏的一种应对：
    //
    //      > 一条"凡是新加的入口都补进白名单"的检查，
    //      > 与一条"从来没有检查过"的检查，在源码上长得一模一样——
    //      > 只不过前者的白名单看起来是有人维护的。
    //
    //   所以这里不是放宽，是把原来的**一个笼统断言**拆成三条更锋利的：
    //     ① 读面与写面照旧逐一列出——新加一个入口必须有人来这里决定它属于哪一类；
    //     ② **没有 update**：任何入口都不能就地改写一份已存在的快照的内容；
    //     ③ 唯一的删除是 `purge`，而它**必须留墓碑**——
    //        否则"删掉"就退化成"从来没存在过"，那正是全模块在防的事。
    const readOnly = ['count', 'counts', 'get', 'list', 'listTombstones', 'locate',
      'retentionRows', 'tombstone', 'verify']
    const writers = ['record']
    const removers = ['purge']
    assert.deepEqual(Object.keys(store).sort(), [...readOnly, ...writers, ...removers].sort(),
      '新增入口必须在这里被归类——不做分类就等于没有检查')

    // ② 没有任何名字暗示"就地改写"。这一条是**形状**上的：
    //    `update`/`set`/`patch`/`replace`/`overwrite` 一个都不许有。
    //    `record` 是唯一写面，而它对同一 attemptId 的**不同**内容给 409（上面那条用例钉着）。
    for (const name of Object.keys(store)) {
      assert.doesNotMatch(name, /^(update|set|patch|replace|overwrite|put|edit|modify)$/i,
        `store 不该有就地改写的入口：${name}`)
    }

    // ③ 唯一的删除入口必须留痕。这里用一个**行为**断言而不是再读一遍名单：
    //    删掉之后，`locate` 必须还能说出"它存在过"。
    const s = snap()
    store.record(s, { scope: 'default' })
    assert.equal(store.locate('att-1').kind, 'live')
    store.purge('att-1', { reason: '不可变性用例', actor: 'tester', nowMs: Date.now() })
    assert.equal(store.locate('att-1').kind, 'purged',
      '★ 唯一的删除入口必须留下墓碑——'
      + '一个"删了就查不到"的实现与一个"从来没存在过"的实现在读面上一模一样')
    assert.notEqual(store.tombstone('att-1'), null)
  })

  test('**幂等重写也要写审计**（否则那次运行的痕迹永远缺失）', () => {
    // 这是一次实测出来的连环缺陷：审计适配器写错 → 异常发生在**快照已经落库之后**
    // → 客户端拿到 400 但库里已有那一行 → 调用方重试 → 命中幂等分支。
    // 若幂等分支不写审计，最终结果是：**快照在库里、审计永远缺失、而客户端以为成功**。
    // 每一次"我们记下了这次运行"都该留下痕迹，包括重试带来的那一次。
    const s = snap()
    store.record(s, { scope: 'default', actor: 'e2e' })
    store.record(s, { scope: 'default', actor: 'e2e' })
    assert.equal(audits.length, 2, '两次 record（一次实写 + 一次幂等）应产生两条审计')
    assert.equal(audits[0].detail.idempotent, false)
    assert.equal(audits[1].detail.idempotent, true)
    assert.equal(store.count(), 1, '但库里仍然只有一份')
  })

  test('冲突路径**不写审计**（它没有改变任何状态）', () => {
    store.record(snap(), { scope: 'default' })
    const before = audits.length
    assert.throws(() => store.record(snap({ candidates: [{ source: src({ content: 'changed' }) }] }), {}))
    assert.equal(audits.length, before, '被拒绝的写入不该留下"记录成功"的痕迹')
  })
})

describe('③ 两处都验哈希：落库前、读回时', () => {
  test('哈希与内容不符的快照**拒绝落库**', () => {
    const s = snap()
    const tampered = { ...s, finalText: '被改过的文本' }
    assert.throws(() => store.record(tampered, { scope: 'default' }), (e) => {
      assert.equal(e.code, CONTEXT_STORE_ERRORS.INVALID_SNAPSHOT)
      assert.match(e.message, /被改过|不符/)
      return true
    })
    assert.equal(store.count(), 0, '被改过的快照不该进库')
  })

  test('**绕过写入校验直接改库**后，verify 能发现', () => {
    store.record(snap(), { scope: 'default' })
    // 模拟外部直接改库（不是通过本模块）
    const payload = JSON.parse(db.prepare('SELECT payload_json FROM run_context_snapshots WHERE attempt_id = ?').get('att-1').payload_json)
    payload.finalText = '外部改过的内容'
    db.prepare('UPDATE run_context_snapshots SET payload_json = ? WHERE attempt_id = ?')
      .run(JSON.stringify(payload), 'att-1')

    const v = store.verify('att-1')
    assert.equal(v.ok, false, '读回时验哈希必须发现这次改动')
    assert.notEqual(v.storedHash, '')
  })

  test('未被改动的记录 verify 为真', () => {
    store.record(snap(), { scope: 'default' })
    assert.equal(store.verify('att-1').ok, true)
  })

  test('payload 损坏时**不假装它是空快照**（那会让损坏的记录看起来正常）', () => {
    store.record(snap(), { scope: 'default' })
    db.prepare('UPDATE run_context_snapshots SET payload_json = ? WHERE attempt_id = ?').run('{不是 JSON', 'att-1')
    assert.throws(() => store.get('att-1'), (e) => {
      assert.equal(e.code, CONTEXT_STORE_ERRORS.BAD_PAYLOAD)
      return true
    })
  })

  test('缺 attemptId → 拒绝（它是主键，也是"这是哪次运行"的唯一答案）', () => {
    assert.throws(() => store.record({ ...snap(), attemptId: '' }), (e) => {
      assert.equal(e.code, CONTEXT_STORE_ERRORS.ATTEMPT_REQUIRED)
      return true
    })
  })
})

describe('④ 审计只记规模，不记正文', () => {
  test('写审计里没有正文内容', () => {
    store.record(snap(), { scope: 'default', actor: 'general' })
    assert.equal(audits.length, 1)
    const text = JSON.stringify(audits[0])
    assert.ok(!text.includes('hello world'), '审计不该把上下文正文抄一份')
    assert.equal(audits[0].detail.includedCount, 1)
    assert.equal(audits[0].detail.tokensKind, 'exact')
  })
})

describe('⑤ 装配器与存储的接缝（不是各测各的）', () => {
  test('装配 → 落库 → 读回 → 再验哈希，全链路一致', () => {
    const s = snap({
      candidates: [
        { source: src({ id: 'a', type: 'task', content: 'TASK', trust: SOURCE_TRUST.TRUSTED }) },
        { source: src({ id: 'b', type: 'document', content: 'B'.repeat(50) }), allowTruncate: true },
      ],
      policy: { scope: 'default', maxTokens: 40, canRead: () => true, priority: ['task', 'document'] },
    })
    store.record(s, { scope: 'default' })
    const got = store.get('att-1')
    // 读回来的那份，哈希仍要与库里的一致——这条把"装配时的自洽"与
    // "存下来之后的完整"接在一起。任何一端变了，这里就红。
    assert.equal(got.snapshot.snapshotHash, s.snapshotHash)
    assert.equal(store.verify('att-1').ok, true)
    assert.equal(got.snapshot.finalText, s.finalText)
    assert.deepEqual(got.snapshot.segments, s.segments)
  })

  test('**截断过的快照存下来之后，读回来仍然说自己被截断了**', () => {
    // 如果持久化把 truncations/segments 丢了，那么一份截断过的运行在查看时
    // 就变成"完整体验"——这恰恰是 PRT-407 花力气防的那种谎，只不过发生在第二层。
    const s = snap({
      candidates: [{ source: src({ id: 'long', content: 'X'.repeat(200) }), allowTruncate: true }],
      policy: { scope: 'default', maxTokens: 50, canRead: () => true },
    })
    store.record(s, { scope: 'default' })
    const got = store.get('att-1')
    assert.equal(got.truncationCount, 1)
    assert.equal(got.snapshot.sources[0].truncated, true)
    assert.equal(got.snapshot.sources[0].fullChars, 200)
    assert.equal(got.snapshot.sources[0].content.length, got.snapshot.truncations[0].keptChars)
  })
})

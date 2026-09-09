// workbench/scripts/dedupe.test.mjs — P2-3 S6 前端去重/合并纯函数单测。
// 运行：node --test --experimental-strip-types workbench/scripts/dedupe.test.mjs
// 覆盖 NotifyView（seq 去重降序）、ChatView（消息 id 合并保序）、App（v1 活动内容指纹）三套去重口径，
// 以及断线重连/轮询/乱序帧合并的语义（docs/review/T-100-REVIEW.md O5 缺口收口）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeSeqDesc, mergeById, activityFingerprint, dedupeByFingerprint } from '../src/dedupe.ts'

describe('dedupeSeqDesc（NotifyView：v2 审计按 seq 去重 + 降序）', () => {
  it('重复 seq 只保留一条，输出按 seq 降序', () => {
    const rows = [
      { seq: 2, action: 'b' },
      { seq: 1, action: 'a' },
      { seq: 2, action: 'b-dup' }, // 同 seq 重复（SSE 回放与轮询合并窗口）
      { seq: 3, action: 'c' },
    ]
    const out = dedupeSeqDesc(rows)
    assert.deepEqual(out.map(r => r.seq), [3, 2, 1])
    assert.equal(out[1].action, 'b') // 保留先出现的 b（去重不覆盖）
  })

  it('乱序输入（SSE 回放补帧后到）也能收敛为唯一降序序列', () => {
    const out = dedupeSeqDesc([{ seq: 5 }, { seq: 7 }, { seq: 6 }, { seq: 7 }])
    assert.deepEqual(out.map(r => r.seq), [7, 6, 5])
  })

  it('空数组/全重复输入不抛错', () => {
    assert.deepEqual(dedupeSeqDesc([]), [])
    assert.deepEqual(dedupeSeqDesc([{ seq: 1 }, { seq: 1 }]).map(r => r.seq), [1])
  })
})

describe('mergeById（ChatView：消息按 id 合并、保序升序、同 id 后者覆盖）', () => {
  it('合并两批有交集的升序消息：去重、排序、不丢失', () => {
    const a = [{ id: 1, body: '旧1' }, { id: 2, body: 'a2' }, { id: 3, body: 'a3' }]
    const b = [{ id: 2, body: 'b2-覆盖' }, { id: 4, body: 'b4' }]
    const out = mergeById(a, b)
    assert.deepEqual(out.map(m => m.id), [1, 2, 3, 4])
    assert.equal(out[1].body, 'b2-覆盖')
  })

  it('发送追加（a=旧列表, b=新消息）与加载更早（a=更早页, b=现有）方向一致', () => {
    const newer = mergeById([{ id: 3 }, { id: 5 }], [{ id: 4 }])
    assert.deepEqual(newer.map(m => m.id), [3, 4, 5])
    const older = mergeById([{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 5 }])
    assert.deepEqual(older.map(m => m.id), [1, 2, 3, 5])
  })

  it('空批合并幂等', () => {
    assert.deepEqual(mergeById([], [{ id: 1 }]).map(m => m.id), [1])
    assert.deepEqual(mergeById([{ id: 1 }], []).map(m => m.id), [1])
  })
})

describe('activityFingerprint / dedupeByFingerprint（App.tsx：v1 activity 内容指纹去重）', () => {
  it('指纹 = ts|kind|taskId|text 四段（空值归一为空串）', () => {
    assert.equal(activityFingerprint({ ts: 'T', kind: 'k', taskId: 'x', text: 't' }), 'T|k|x|t')
    assert.equal(activityFingerprint({ ts: 'T', kind: 'k', taskId: null, text: 't' }), 'T|k||t')
    assert.equal(activityFingerprint({}), '|||')
  })

  it('同内容重复帧（SSE 重连回放 + 轮询覆盖窗口）被去重，seen 集可播种/回传', () => {
    const base = [
      { ts: '1', kind: 'claim', taskId: 'T-1', text: '认领' },
      { ts: '1', kind: 'claim', taskId: 'T-1', text: '认领' }, // 重复
      { ts: '2', kind: 'done', taskId: 'T-1', text: '完成' },
    ]
    const { rows, seen } = dedupeByFingerprint(base)
    assert.equal(rows.length, 2)
    assert.equal(seen.size, 2)
    // 后续新批次携带 seen：仅新增帧通过
    const more = [{ ts: '1', kind: 'claim', taskId: 'T-1', text: '认领' }, { ts: '3', kind: 'gate', taskId: 'T-1', text: '闸门' }]
    const r2 = dedupeByFingerprint(more, seen)
    assert.deepEqual(r2.rows.map(r => r.ts), ['3'])
  })

  it('事件顺序不同但内容相同仍算重复（指纹不依赖到达顺序）', () => {
    const { rows } = dedupeByFingerprint([
      { ts: 'a', kind: 'x', taskId: '1', text: 'm' },
      { kind: 'x', text: 'm', ts: 'a', taskId: '1' }, // 键序不同
    ])
    assert.equal(rows.length, 1)
  })
})

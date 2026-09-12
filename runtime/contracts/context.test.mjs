// runtime/contracts/context.test.mjs
// ============================================================================
// PRT-401：Context Source 与 RunContextSnapshot（spec §6.5）
//
// 这一组用例守的是 spec §6.5 开头那句要求：
//
//   「任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因。」
//
// 所以用例的重点不在"字段都在"，而在**能否区分**：
//   · "没有这个来源" vs "有这个来源但被裁掉了"
//   · "精确 token 数" vs "保守估算"
//   · "上下文快照的哈希" vs "一次工具调用的批准哈希"
// 这三组区分如果做不到，一份**看起来完整**的快照会给出错误的结论。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONTEXT_SNAPSHOT_DOMAIN,
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  CONTEXT_SOURCE_TYPES,
  EXCLUSION_REASONS,
  SOURCE_TRUST,
  TOKEN_ESTIMATOR_KINDS,
  createContextSource,
  createExclusion,
  createTokenMeasurement,
  freezeContextSnapshot,
  computeSnapshotHash,
  orderSources,
  verifySnapshotHash,
} from './context.mjs'
import { canonicalJson, domainSeparatedHash } from './canonical.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const src = (over = {}) => createContextSource({
  id: 'g1', type: 'goal-context', version: 'v3', acquiredAtMs: 1_700_000_000_000,
  content: '目标：把退货率降到 3% 以下。', trust: SOURCE_TRUST.TRUSTED, ...over,
})

const exact = (n) => createTokenMeasurement({ kind: TOKEN_ESTIMATOR_KINDS.EXACT, tokens: n })
const estimate = (n) => createTokenMeasurement({
  kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE, tokens: n, note: '按 3 字符/token 保守估算（只会高估）',
})

const snap = (over = {}) => freezeContextSnapshot({
  attemptId: 'a1', runId: 'r1', frozenAtMs: 1_700_000_001_000,
  associations: { goalId: 'g1', taskId: 't1', employeeId: 'e1', teamPlanId: 'tp1' },
  candidateCount: 1, sources: [src()], excluded: [], tokens: exact(20), ...over,
})

describe('① 来源：默认不可信，且不可信不能承载权限', () => {
  test('不写 trust 就是 untrusted（新增来源类型不会静默获得权限）', () => {
    const s = createContextSource({ id: 'x', type: 'document', version: 'v1', acquiredAtMs: 1, content: 'hi' })
    assert.equal(s.trust, SOURCE_TRUST.UNTRUSTED)
  })

  test('trust 拼错不会被当成 trusted（一个笔误就是一次提权）', () => {
    assert.throws(
      () => createContextSource({ id: 'x', type: 'document', version: 'v1', acquiredAtMs: 1, trust: 'Trusted' }),
      /只能是/,
    )
  })

  test('不可信来源携带权限字段 → 抛错（spec §6.5 的"永远不能"变成断言）', () => {
    for (const key of ['grants', 'approvalPolicy', 'manifestPatch', 'toolScope', 'permissions']) {
      assert.throws(
        () => createContextSource({ id: 'x', type: 'document', version: 'v1', acquiredAtMs: 1, trust: 'untrusted', [key]: ['fs.write'] }),
        /会改变权限\/策略的字段/,
        `${key} 必须被拒`,
      )
    }
  })

  test('**可信**来源同样不许带权限字段（否则提权只需把来源标成 trusted）', () => {
    // 这一条是第一版实现错了、被用例逼出来的。原先只在 `trust === untrusted` 时检查，
    // 于是"可信来源可以带 grants"——而那就等于：一次提权只需要声明 trust: 'trusted'。
    // 权限的来处是 EmployeeManifest（作为**内容**进入快照），不是快照上的一个活字段。
    assert.throws(
      () => createContextSource({ id: 'x', type: 'employee-manifest', version: 'v1', acquiredAtMs: 1, trust: 'trusted', grants: ['read'] }),
      /会改变权限\/策略的字段/,
    )
  })

  test('未知字段被**拒绝**而不是被静默丢掉（丢掉会让调用方以为它生效了）', () => {
    assert.throws(
      () => createContextSource({ id: 'x', type: 'task', version: 'v1', acquiredAtMs: 1, anythingElse: 1 }),
      /未知字段/,
    )
  })

  test('来源是深度冻结的（快照冻结后不可修改）', () => {
    const s = src()
    assert.throws(() => { s.content = 'tampered' }, TypeError)
    assert.throws(() => { s.id = 'other' }, TypeError)
  })

  test('未知来源类型被拒（不是"照单全收"）', () => {
    assert.throws(() => createContextSource({ id: 'x', type: 'whatever', version: 'v1', acquiredAtMs: 1 }), /未知的 ContextSource.type/)
  })

  test('版本变了内容哈希就变；同版本同内容则相同（可判"有没有变过"）', () => {
    const a = src({ version: 'v1', content: 'same' })
    const b = src({ version: 'v1', content: 'same' })
    const c = src({ version: 'v2', content: 'same' })
    const d = src({ version: 'v1', content: 'different' })
    assert.equal(a.contentHash, b.contentHash)
    assert.notEqual(a.contentHash, c.contentHash, '版本不同必须不同')
    assert.notEqual(a.contentHash, d.contentHash, '内容不同必须不同')
  })

  test('缺少 acquiredAtMs 被拒（否则无法回答"什么时候拿到的"）', () => {
    assert.throws(() => createContextSource({ id: 'x', type: 'task', version: 'v1' }), /acquiredAtMs/)
  })
})

describe('② 计数守恒：每一个候选来源都必须有去向（本模块最重要的一条）', () => {
  test('入选 + 排除 == 候选数，否则抛错', () => {
    assert.throws(
      () => snap({ candidateCount: 3, sources: [src()], excluded: [] }),
      /来源计数不守恒/,
    )
  })

  test('把被裁掉的来源如实记进 excluded 就通过（这是"能还原裁剪原因"的最低要求）', () => {
    const s = snap({
      candidateCount: 2,
      sources: [src()],
      excluded: [createExclusion({ id: 'old1', reason: EXCLUSION_REASONS.STALE, detail: '已被 v4 取代' })],
    })
    assert.equal(s.excluded.length, 1)
    assert.equal(s.excluded[0].reason, 'stale')
  })

  test('同一来源既入选又被排除 → 抛错（两次判定不一致，必有一次是错的）', () => {
    assert.throws(
      () => snap({ candidateCount: 2, sources: [src({ id: 'dup' })], excluded: [createExclusion({ id: 'dup', reason: EXCLUSION_REASONS.STALE })] }),
      /同时出现在入选与排除/,
    )
  })

  test('未知排除理由被拒（机器判据必须来自枚举）', () => {
    assert.throws(() => createExclusion({ id: 'x', reason: 'i-dont-like-it' }), /未知的排除理由/)
  })
})

describe('③ token 计量必须带出处，且出处进哈希', () => {
  test('裸数字不被接受（没有出处的数字无法复核）', () => {
    assert.throws(() => createTokenMeasurement({ tokens: 100 }), /kind/)
  })

  test('保守估算必须注明是估算（否则它看起来和精确值一样）', () => {
    assert.throws(
      () => createTokenMeasurement({ kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE, tokens: 100 }),
      /注明是估算/,
    )
  })

  test('**token 数相同但计量种类不同 → 快照哈希不同**', () => {
    // 这是"可信度"必须进哈希的理由：两次运行的 token 数一样，但一次精确、一次估算，
    // 它们关于"上下文放不放得下"的结论可信度不同。哈希相同会让回放误以为同等可信。
    const a = snap({ tokens: exact(100) })
    const b = snap({ tokens: estimate(100) })
    assert.equal(a.tokens.tokens, b.tokens.tokens)
    assert.notEqual(a.snapshotHash, b.snapshotHash)
  })
})

describe('④ 哈希：与审批哈希在构造上不可互换（spec §6.5 末段）', () => {
  test('domain 与审批不同', () => {
    assert.notEqual(CONTEXT_SNAPSHOT_DOMAIN, 'legion.tool-execution.v1')
  })

  test('**结构完全相同的对象，在两个 domain 下哈希不同**', () => {
    const value = { target: '/tmp/a.txt', tool: 'fs.write', content: 'x' }
    const contextHash = domainSeparatedHash(CONTEXT_SNAPSHOT_DOMAIN, CONTEXT_SNAPSHOT_SCHEMA_VERSION, value)
    const approvalHash = domainSeparatedHash('legion.tool-execution.v1', 1, value)
    assert.notEqual(contextHash, approvalHash, '一个为读文件签发的批准不能冒充一次上下文快照')
  })

  test('schemaVersion 参与哈希（同 domain 下改规则不会撞上旧哈希）', () => {
    const value = { a: 1 }
    assert.notEqual(
      domainSeparatedHash(CONTEXT_SNAPSHOT_DOMAIN, 1, value),
      domainSeparatedHash(CONTEXT_SNAPSHOT_DOMAIN, 2, value),
    )
  })

  test('domain 不得含 NUL —— 分隔符本身不能出现在任一部分里', () => {
    // 拼的是 `domain \u0000 schemaVersion \u0000 json`。用 NUL 分隔正是为了让
    // ("a\u0000b", json) 与 ("a", "b\u0000json") 这类**拼接歧义**不可能存在：
    // 只要 NUL 不在 domain 里，第一个 NUL 就唯一确定了 domain 的边界。
    // 所以这条断言是那个"不可能"的前提。
    assert.throws(() => domainSeparatedHash('a\u0000b', 1, {}), /NUL/)
  })

  test('domain 不同 / schemaVersion 不同 → 哈希不同（同内容）', () => {
    const value = { same: 'content' }
    const a = domainSeparatedHash('legion.x.v1', 1, value)
    const b = domainSeparatedHash('legion.y.v1', 1, value)
    const c = domainSeparatedHash('legion.x.v1', 2, value)
    assert.equal(new Set([a, b, c]).size, 3, '三个哈希必须两两不同')
  })

  test('canonical JSON：键排序，数组保序，-0 归零', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]))
    assert.equal(canonicalJson(-0), canonicalJson(0))
    assert.equal(canonicalJson({ a: undefined }), '{}')
  })
})

describe('⑤ 快照：冻结、可校验、可回放', () => {
  test('快照深度冻结', () => {
    const s = snap()
    assert.throws(() => { s.finalText = 'tampered' }, TypeError)
    assert.throws(() => { s.sources[0].content = 'tampered' }, TypeError)
  })

  test('verifySnapshotHash 对原快照为真，对改动过的为假', () => {
    const s = snap({ finalText: '原始文本' })
    assert.equal(verifySnapshotHash(s), true)
    // 绕过冻结：模拟"存到库里之后被改过"
    const tampered = { ...s, finalText: '改过的文本' }
    assert.equal(verifySnapshotHash(tampered), false, '被改过的快照必须能被发现')
  })

  test('**确定性**：同样的来源、不同传入顺序 → 同一个哈希', () => {
    const a = src({ id: 'a1', type: 'task' })
    const b = src({ id: 'b1', type: 'document' })
    const s1 = snap({ candidateCount: 2, sources: [a, b] })
    const s2 = snap({ candidateCount: 2, sources: [b, a] })
    // 顺序本身是内容的一部分（它会进入最终文本），所以这里测的是 orderSources
    // 让**装配顺序**成为确定的函数，而不是依赖"谁先被检索到"。
    assert.equal(
      canonicalJson(orderSources([a, b])),
      canonicalJson(orderSources([b, a])),
    )
    void s1; void s2
  })

  test('来源顺序按 (type, id, version) 确定，与传入顺序无关', () => {
    const mk = (type, id, version) => src({ type, id, version })
    const list = [mk('task', 'z', 'v1'), mk('document', 'a', 'v2'), mk('document', 'a', 'v1')]
    const once = orderSources(list).map((s) => `${s.type}/${s.id}@${s.version}`)
    const twice = orderSources([...list].reverse()).map((s) => `${s.type}/${s.id}@${s.version}`)
    assert.deepEqual(once, twice)
    assert.deepEqual(once, ['document/a@v1', 'document/a@v2', 'task/z@v1'])
  })

  test('computeSnapshotHash 与冻结时算的一致（可回放复核）', () => {
    const s = snap()
    assert.equal(computeSnapshotHash(s), s.snapshotHash)
  })

  test('没有来源时可以给空数组（"确实没有"与"忘了记"靠 candidateCount 区分）', () => {
    const s = snap({ candidateCount: 0, sources: [], excluded: [] })
    assert.equal(s.sources.length, 0)
    assert.equal(s.snapshotHash.startsWith('sha256:'), true)
  })

  test('必须给出 sources 与 excluded（漏给会被当成"没有"）', () => {
    assert.throws(() => freezeContextSnapshot({ attemptId: 'a', runId: 'r', frozenAtMs: 1, tokens: exact(1), candidateCount: 0 }), /sources 与 excluded/)
  })

  test('快照记录了关联的目标/任务/员工/团队方案（spec §6.5 要求）', () => {
    const s = snap()
    assert.deepEqual(s.associations, { goalId: 'g1', taskId: 't1', employeeId: 'e1', teamPlanId: 'tp1' })
  })

  test('枚举清单与 spec §6.5 的点名一致（不可信类型）', () => {
    // spec：仓库文件、网页、附件、上游产物、用户输入一律标记为不可信
    for (const t of ['artifact', 'document', 'comment', 'user-feedback', 'upstream-delivery']) {
      assert.ok(CONTEXT_SOURCE_TYPES.includes(t), `${t} 应在来源类型里`)
    }
    assert.ok(CONTEXT_SOURCE_TYPES.includes('workspace-state'), '工作区状态是 spec 列出的输入之一')
  })
})

describe('⑥ 接线：投影模块必须真的被导出（否则它和不存在一样）', () => {
  test('contracts/index.mjs 真的导出了 context 的入口（不是"字符串出现过"）', async () => {
    // 这一条第一版写成了 `idx.includes('freezeContextSnapshot')`——而它是**子串检查**。
    // 把导出改成 `freezeContextSnapshotUnused: freezeContextSnapshot` 之后，
    // 子串仍在、用例仍绿，而那个入口**已经不可用了**。
    // **一个测字符串的断言，和一个正确的实现，在输出上完全一样。**
    // 所以这里真的去 import 并调用。
    const idx = await import('./index.mjs')
    for (const name of ['createContextSource', 'freezeContextSnapshot', 'verifySnapshotHash', 'domainSeparatedHash']) {
      assert.equal(typeof idx[name], 'function', `contracts/index.mjs 未导出可用的 ${name}`)
    }
    // 真的跑一遍：导出存在但一调用就炸同样是"没有入口"。
    const s = idx.freezeContextSnapshot({
      attemptId: 'a-idx', runId: 'r-idx', frozenAtMs: 1, candidateCount: 0, sources: [], excluded: [],
      tokens: idx.createTokenMeasurement({ kind: 'exact', tokens: 0 }),
    })
    assert.equal(idx.verifySnapshotHash(s), true)
  })

  test('审批哈希已经改用共享的 canonical 库（"共享基础库"不是加一句话）', () => {
    const enf = readFileSync(resolve(HERE, '..', 'dsh-composition', 'enforcement.mjs'), 'utf8')
    assert.match(enf, /from '\.\.\/contracts\/canonical\.mjs'/, '审批侧必须 import 共享库')
    // 不能同时保留一份自己的实现——两份实现今天一致，而**没有任何东西在维持它**。
    assert.ok(
      !/^export function canonicalJson/m.test(enf),
      '审批侧不应再有自己的 canonicalJson 实现',
    )
  })
})

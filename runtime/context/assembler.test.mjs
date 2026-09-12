// runtime/context/assembler.test.mjs
// ============================================================================
// PRT-407：Context Assembler（spec §6.5）
//
// 这一组的中心是**第三种状态**：一个来源的正文只进去了一半。
//
// `sources[]` 与 `excluded[]` 只能表达"整个进了"与"整个没进"。而截断产出的
// 第三种如果没被记录，一份**截断过的**快照会声称模型看过了全文——
// 用户看到"文档 A 已包含"，于是以为模型读完了整份规范，而它只看到前 2000 字。
// spec 要的是「还原其**实际**输入」，所以 `truncations[]` 与 `segments[]`
// 和那两个账本同等重要，并且有用例专门钉住"不许声称看过全文"。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASSEMBLY_CODES,
  AssemblyError,
  assembleContext,
  describeAssembly,
} from './assembler.mjs'
import {
  EXCLUSION_REASONS,
  SOURCE_TRUST,
  TOKEN_ESTIMATOR_KINDS,
  createContextSource,
  verifySnapshotHash,
} from '../contracts/context.mjs'
import { domainSeparatedHash } from '../contracts/canonical.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一个确定的测试 tokenizer：每个字符 1 token（便于手算预算）。 */
const charsAsTokens = { kind: TOKEN_ESTIMATOR_KINDS.EXACT, count: (t) => t.length }
/** 保守估算器：每 2 字符 1 token（只用来说明 kind 的传播）。 */
const halfTokens = { kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE, count: (t) => Math.ceil(t.length / 2) }

const src = (over = {}) => createContextSource({
  id: 'd1', type: 'document', version: 'v1', acquiredAtMs: 1,
  content: 'abc', trust: SOURCE_TRUST.UNTRUSTED, ...over,
})

const base = (over = {}) => ({
  attemptId: 'a1', runId: 'r1', frozenAtMs: 1_000,
  associations: { goalId: 'g1', taskId: 't1', employeeId: 'e1', teamPlanId: 'tp1' },
  candidates: [], policy: { scope: 'default', canRead: () => true, maxTokens: null }, tokenizer: charsAsTokens,
  ...over,
})

describe('① 权限判定先于一切：越权来源的正文根本不被读进装配', () => {
  test('不可读 → 进 excluded（reason=unauthorized），不进 sources', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'secret', content: '机密' }) }],
      policy: { scope: 'default', maxTokens: null, canRead: (m) => m.id !== 'secret' },
    }))
    assert.equal(s.sources.length, 0)
    assert.equal(s.excluded.length, 1)
    assert.equal(s.excluded[0].reason, EXCLUSION_REASONS.UNAUTHORIZED)
    assert.ok(!s.finalText.includes('机密'), '越权正文绝不能进最终文本')
  })

  test('**canRead 只拿得到元数据，拿不到正文**（读进来再过滤＝正文已经进过内存）', () => {
    let saw = null
    assembleContext(base({
      candidates: [{ source: src({ id: 'd1', content: 'should-not-be-visible' }) }],
      policy: {
        scope: 'default', maxTokens: null,
        canRead: (meta) => { saw = meta; return true },
      },
    }))
    assert.ok(saw !== null, 'canRead 应该被调用')
    assert.equal(saw.id, 'd1')
    assert.equal(saw.type, 'document')
    assert.equal(saw.version, 'v1')
    assert.equal(saw.trust, 'untrusted')
    // 元数据里**没有** content 这个键
    assert.ok(!('content' in saw), `canRead 拿到的不该带正文，实际键：${Object.keys(saw).join(',')}`)
  })

  test('判定函数抛错时**不放行**（无法判断 ≠ 可以）', () => {
    const s = assembleContext(base({
      candidates: [{ source: src() }],
      policy: { scope: 'default', maxTokens: null, canRead: () => { throw new Error('策略服务挂了') } },
    }))
    assert.equal(s.sources.length, 0, '判定失败必须按不可读处理')
    assert.match(s.excluded[0].detail, /按不可读处理/)
  })

  test('不给 canRead 直接拒绝（默认放行是最不该有的默认值）', () => {
    assert.throws(
      () => assembleContext(base({ policy: { scope: 'default', maxTokens: null } })),
      /canRead/,
    )
  })
})

describe('② 第三种状态：部分包含必须被记下来（本模块的核心）', () => {
  test('**截断必须进 truncations，且不得声称看过全文**', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'long', content: 'x'.repeat(100) }), allowTruncate: true }],
      policy: { scope: 'default', maxTokens: 40, canRead: () => true },
    }))
    assert.equal(s.sources.length, 1, '它确实进去了')
    assert.equal(s.truncations.length, 1, '但它只进去了一部分，必须记下来')
    const t = s.truncations[0]
    assert.equal(t.id, 'long')
    assert.equal(t.originalChars, 100)
    assert.ok(t.keptChars < 100, '确实被截了')
    assert.match(t.detail, /截断/, '必须写明模型没看到后面的部分')
    assert.equal(s.budget.trimmed, true)
  })

  test('**未声明 allowTruncate 时整个丢掉，而不是悄悄截断**', () => {
    // 悄悄截断一份规范，会让模型基于半份规范下结论——而没人知道。
    // 所以默认行为是"要么整份，要么不进"，并写明为什么没进。
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'long', content: 'x'.repeat(100) }) }],
      policy: { scope: 'default', maxTokens: 40, canRead: () => true },
    }))
    assert.equal(s.sources.length, 0)
    assert.equal(s.truncations.length, 0, '没声明就不该出现截断')
    assert.equal(s.excluded[0].reason, EXCLUSION_REASONS.OVER_BUDGET)
  })

  test('截断后的正文**确实**短于原文（不是只记了个数字）', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'long', content: 'A'.repeat(200) }), allowTruncate: true }],
      policy: { scope: 'default', maxTokens: 30, canRead: () => true },
    }))
    const kept = s.sources[0].content
    assert.ok(kept.length <= 30, `截断后应 <= 30 字符，实际 ${kept.length}`)
    assert.equal(s.tokens.tokens <= 30, true, `总 token 不该超预算，实际 ${s.tokens.tokens}`)
    assert.equal(s.truncations[0].keptChars, kept.length)
  })

  test('**两个账本必须互相对得上**（主账本说谎时这一条会红）', () => {
    // 第一版 `sources[]` 填的是**原始**来源对象，于是：
    //     truncations[0].keptChars = 30      ← 副账本说了实话
    //     sources[0].content.length = 200    ← 主账本说模型看了 200 字
    // 而任何人去看 `sources`（最自然的那一步）都会得出"模型读完了整份文档"。
    // **一个说了实话的副账本救不了一个说假话的主账本。**
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'long', content: 'A'.repeat(200) }), allowTruncate: true }],
      policy: { scope: 'default', maxTokens: 30, canRead: () => true },
    }))
    const t = s.truncations[0]
    const src0 = s.sources[0]
    assert.equal(src0.content.length, t.keptChars, '主账本的正文长度必须等于副账本记的保留长度')
    assert.equal(src0.truncated, true, '主账本必须自己标出"这是被截过的"')
    assert.equal(src0.fullChars, 200, '原文长度仍要可查——"它原本多长"不能消失')
    assert.notEqual(src0.contentHash, src0.fullContentHash, '截断后的哈希必须不同于原文哈希')
    // 同名字段必须自洽：`contentHash` 就是 `content` 的哈希。
    // 这里**真的重算一遍**，而不是断言"它非空"——一个占位式断言和一个正确的实现
    // 在输出上完全一样（本项目反复记过这一条）。
    assert.equal(
      src0.contentHash,
      `sha256:${domainSeparatedHash('legion.context-source-content.v1', 1, {
        type: src0.type, version: src0.version, content: src0.content,
      }).slice(7)}`,
      'contentHash 必须是自身 content 的哈希',
    )
    assert.equal(s.sources[0].content.length, s.segments[0].charEnd - s.segments[0].charStart - (
      `[${s.sources[0].type}:${s.sources[0].id}@${s.sources[0].version} trust=${s.sources[0].trust}]\n\n`.length
    ), '段长度必须等于"表头 + 有效正文"')
  })

  test('**段偏移切出来的正好是那一段**（偏移错一位则"第 N 个字符来自哪里"全错）', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'x', type: 'task', version: 'v1', content: 'X'.repeat(10), trust: SOURCE_TRUST.TRUSTED }) },
        { source: src({ id: 'y', type: 'skill', version: 'v2', content: 'Y'.repeat(20), trust: SOURCE_TRUST.TRUSTED }) },
      ],
      policy: { scope: 'default', maxTokens: null, canRead: () => true },
    }))
    for (const seg of s.segments) {
      const slice = s.finalText.slice(seg.charStart, seg.charEnd)
      assert.ok(slice.startsWith(`[${seg.type}:${seg.id}@${seg.version}`), `段 ${seg.id} 起始处应是它的表头`)
      // 表头之后、段末之前，应该正好是那个来源的有效正文
      const bodyStart = slice.indexOf(']\n') + 2
      const body = slice.slice(bodyStart, slice.endsWith('\n') ? -1 : undefined)
      assert.equal(body, s.sources.find((x) => x.id === seg.id).content, `段 ${seg.id} 的正文应与账本一致`)
    }
  })

  test('**segments 能回答"模型看到的第 N 个字符来自哪个来源"**', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'a', type: 'task', version: 'v1', content: '任务正文', trust: SOURCE_TRUST.TRUSTED }) },
        { source: src({ id: 'b', type: 'document', version: 'v2', content: '文档正文' }) },
      ],
      policy: { scope: 'default', maxTokens: null, canRead: () => true, priority: ['task', 'document'] },
    }))
    assert.equal(s.segments.length, 2)
    for (const seg of s.segments) {
      const slice = s.finalText.slice(seg.charStart, seg.charEnd)
      // 段边界必须真的切在最终文本上：偏移错一位，"第 N 个字符来自哪里"就全错。
      assert.ok(slice.includes(seg.id), `段 ${seg.id} 的偏移切出来的内容里应含它的 id`)
    }
    assert.equal(s.segments[0].charStart, 0)
    assert.equal(s.segments[1].charStart, s.segments[0].charEnd, '段必须首尾相接')
    assert.equal(s.segments[1].charEnd, s.finalText.length)
  })

  test('段里标出了可信性（便于阅读，且不假装是安全边界）', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'u1', content: 'x' }) }],
    }))
    assert.match(s.finalText, /trust=untrusted/)
  })
})

describe('③ 必需的来源放不下 → 失败（不交出一份缺了前提的快照）', () => {
  test('required 且超预算 → CONTEXT_TOO_LARGE，且**没有快照**', () => {
    assert.throws(
      () => assembleContext(base({
        candidates: [{ source: src({ id: 'taskdef', type: 'task', content: 'x'.repeat(100) }), required: true }],
        policy: { scope: 'default', maxTokens: 10, canRead: () => true },
      })),
      (e) => {
        assert.equal(e.name, 'AssemblyError')
        assert.equal(e.code, ASSEMBLY_CODES.CONTEXT_TOO_LARGE)
        assert.equal(e.requiredDropped.length, 1)
        return true
      },
    )
  })

  test('required 放得下时正常装配（失败只在真的放不下时发生）', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'taskdef', type: 'task', content: 'abc' }), required: true }],
      policy: { scope: 'default', maxTokens: 10, canRead: () => true },
    }))
    assert.equal(s.sources.length, 1)
  })

  test('非必需来源超预算只是被排除，不影响装配成功', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'small', type: 'task', content: 'abc' }), required: true },
        { source: src({ id: 'huge', type: 'document', content: 'x'.repeat(500) }) },
      ],
      policy: { scope: 'default', maxTokens: 10, canRead: () => true },
    }))
    assert.equal(s.sources.length, 1)
    assert.equal(s.excluded.length, 1)
    assert.equal(s.excluded[0].id, 'huge')
  })
})

describe('④ 没有 tokenizer 就不猜（猜出来的预算会让运行在真正发送时才失败）', () => {
  test('缺 tokenizer → TOKENIZER_REQUIRED', () => {
    assert.throws(
      () => assembleContext(base({ tokenizer: undefined })),
      (e) => { assert.equal(e.code, ASSEMBLY_CODES.TOKENIZER_REQUIRED); return true },
    )
  })

  test('tokenizer.kind 不合法 → 拒绝', () => {
    assert.throws(
      () => assembleContext(base({ tokenizer: { kind: 'guessed', count: (t) => t.length } })),
      (e) => { assert.equal(e.code, ASSEMBLY_CODES.TOKENIZER_REQUIRED); return true },
    )
  })

  test('保守估算器：kind 进快照，且**两次不同 kind 的哈希不同**', () => {
    const a = assembleContext(base({
      candidates: [{ source: src({ content: 'abcd' }) }], tokenizer: charsAsTokens,
    }))
    const b = assembleContext(base({
      candidates: [{ source: src({ content: 'abcd' }) }], tokenizer: halfTokens,
    }))
    assert.equal(a.tokens.kind, TOKEN_ESTIMATOR_KINDS.EXACT)
    assert.equal(b.tokens.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    assert.equal(a.tokens.tokens, 4)
    assert.equal(b.tokens.tokens, 2)
    assert.notEqual(a.snapshotHash, b.snapshotHash, '计量可信度不同 → 哈希必须不同')
  })

  test('预算不是正整数 → BAD_BUDGET（0 不是"不限"，是搞错了）', () => {
    assert.throws(
      () => assembleContext(base({ policy: { scope: 'default', maxTokens: 0, canRead: () => true } })),
      (e) => { assert.equal(e.code, ASSEMBLY_CODES.BAD_BUDGET); return true },
    )
  })
})

describe('⑤ 顺序与确定性（同样输入 → 同样哈希）', () => {
  test('传入顺序反转 → 快照哈希相同', () => {
    const mk = () => [
      { source: src({ id: 'a', type: 'task', version: 'v1', content: 'AA' }) },
      { source: src({ id: 'b', type: 'document', version: 'v1', content: 'BB' }) },
      { source: src({ id: 'c', type: 'skill', version: 'v1', content: 'CC' }) },
    ]
    const s1 = assembleContext(base({ candidates: mk() }))
    const s2 = assembleContext(base({ candidates: mk().reverse() }))
    assert.equal(s1.snapshotHash, s2.snapshotHash, '装配顺序必须是输入的确定函数，而不是"谁先被检索到"')
    assert.equal(s1.finalText, s2.finalText)
  })

  test('显式优先级决定顺序', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'doc', type: 'document', content: 'D' }) },
        { source: src({ id: 'tsk', type: 'task', content: 'T' }) },
      ],
      policy: { scope: 'default', maxTokens: null, canRead: () => true, priority: ['task', 'document'] },
    }))
    assert.deepEqual(s.sources.map((x) => x.id), ['tsk', 'doc'])
  })

  test('同优先级下**可信来源排在前面**（默认顺序不该让外部文本先被读到）', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'ext', type: 'document', content: 'E', trust: SOURCE_TRUST.UNTRUSTED }) },
        { source: src({ id: 'int', type: 'document', content: 'I', trust: SOURCE_TRUST.TRUSTED }) },
      ],
    }))
    assert.deepEqual(s.sources.map((x) => x.id), ['int', 'ext'])
  })

  test('优先级的**顺序影响预算结果**（这正是"按固定优先级裁剪"的含义）', () => {
    const cands = () => [
      { source: src({ id: 'big', type: 'document', content: 'x'.repeat(60) }) },
      { source: src({ id: 'small', type: 'task', content: 'y'.repeat(20) }) },
    ]
    // 任务优先 → 小的先进，大的放不下
    const a = assembleContext(base({
      candidates: cands(), policy: { scope: 'default', maxTokens: 40, canRead: () => true, priority: ['task', 'document'] },
    }))
    assert.deepEqual(a.sources.map((x) => x.id), ['small'])
    assert.equal(a.excluded[0].id, 'big')
  })
})

describe('⑥ 账本守恒（不做假账）', () => {
  test('入选 + 排除 == 候选数', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'ok', type: 'task', content: 'a' }) },
        { source: src({ id: 'no', type: 'document', content: 'b' }) },
        { source: src({ id: 'stale', type: 'skill', content: 'c' }) },
      ],
      policy: { scope: 'default', maxTokens: null, canRead: (m) => m.id !== 'no' },
    }))
    assert.equal(s.candidateCount, 3)
    assert.equal(s.sources.length + s.excluded.length, 3)
  })

  test('过期来源被记为 stale 并写明被谁取代', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'old', version: 'v1' }), supersededBy: 'v2' }],
    }))
    assert.equal(s.excluded[0].reason, EXCLUSION_REASONS.STALE)
    assert.match(s.excluded[0].detail, /v2/)
  })

  test('跨空间来源被记为 out-of-scope', () => {
    const s = assembleContext(base({
      candidates: [{ source: src({ id: 'other', type: 'task' }), scope: 'other-space' }],
    }))
    assert.equal(s.excluded[0].reason, EXCLUSION_REASONS.OUT_OF_SCOPE)
  })

  test('**来源不存在必须能记下来**（否则"我取不到"唯一能做的就是不提它）', () => {
    // 没有这一条时，一个"试着去取但产物不在"的调用方**唯一能做的事就是什么都不说**：
    // 不把这个候选放进来。守恒仍然成立、快照仍然"完整"，而少掉的来源**不留痕迹**——
    // 这正是 spec §6.5 点名的第一种情况（「这个来源不存在」）。
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'gone', type: 'artifact', version: 'v3' }), missing: true },
        { source: src({ id: 'gone2', type: 'document' }), missing: true, missingReason: '文件已从磁盘删除' },
      ],
    }))
    assert.equal(s.sources.length, 0)
    assert.equal(s.excluded.length, 2)
    assert.deepEqual(s.excluded.map((e) => e.reason), [EXCLUSION_REASONS.MISSING, EXCLUSION_REASONS.MISSING])
    assert.match(s.excluded[0].detail, /不存在或无法取得/)
    assert.match(s.excluded[1].detail, /文件已从磁盘删除/, '调用方给的理由要带出来')
    assert.equal(s.candidateCount, 2, '它仍然是一个候选——只是没能进来')
  })

  test('missing 的判定顺序：无权 / 过期 / 跨空间优先于"不存在"', () => {
    // 顺序是有意的：
    //   · 无权的先按**无权**记——系统不该向读不到它的人确认它是否存在；
    //   · 已被取代的先按**过期**记——"v1 已被 v2 取代"比"v1 没了"更有用；
    //   · 跨空间的根本不提。
    // 于是 missing 是这几条之后的兜底，含义明确：**该在的，不在了。**
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'no-perm' }), missing: true },
        { source: src({ id: 'old' }), missing: true, supersededBy: 'v9' },
        { source: src({ id: 'elsewhere' }), missing: true, scope: 'other' },
      ],
      policy: { scope: 'default', maxTokens: null, canRead: (m) => m.id !== 'no-perm' },
    }))
    const byId = Object.fromEntries(s.excluded.map((e) => [e.id, e.reason]))
    assert.equal(byId['no-perm'], EXCLUSION_REASONS.UNAUTHORIZED, '无权优先，且不确认它是否存在')
    assert.equal(byId.old, EXCLUSION_REASONS.STALE)
    assert.equal(byId.elsewhere, EXCLUSION_REASONS.OUT_OF_SCOPE)
  })

  test('缺省不是 missing（普通来源不会被当成"不存在"）', () => {
    const s = assembleContext(base({ candidates: [{ source: src({ content: null }) }] }))
    // content 为 null 是合法的"只有出处、没有正文"的来源，**不等于**不存在。
    // 若把 content===null 当成 missing，一个只做引用的来源就会被报成缺失。
    assert.equal(s.sources.length, 1, '没有 missing 标记就是正常来源')
  })

  test('**每个排除理由要么能产出、要么被明确标为预留**（防止加了枚举没人产出）', () => {
    // 一个"定义了但没有任何代码路径能产出"的枚举值是个陷阱：
    // 调用方以为可以传它，而它永远不会出现。所以这里把**当前可达集合**钉住，
    // 新增理由却忘了写产出路径时，这条用例会红。
    const reachable = new Set()
    // ① 无权
    reachable.add(assembleContext(base({
      candidates: [{ source: src() }], policy: { scope: 'default', maxTokens: null, canRead: () => false },
    })).excluded[0].reason)
    // ② 过期
    reachable.add(assembleContext(base({
      candidates: [{ source: src(), supersededBy: 'v2' }],
    })).excluded[0].reason)
    // ③ 跨空间
    reachable.add(assembleContext(base({
      candidates: [{ source: src(), scope: 'x' }],
    })).excluded[0].reason)
    // ④ 不存在
    reachable.add(assembleContext(base({
      candidates: [{ source: src(), missing: true }],
    })).excluded[0].reason)
    // ⑤ 超预算
    reachable.add(assembleContext(base({
      candidates: [{ source: src({ content: 'x'.repeat(100) }) }],
      policy: { scope: 'default', maxTokens: 5, canRead: () => true },
    })).excluded[0].reason)

    const all = Object.values(EXCLUSION_REASONS)
    const reserved = [EXCLUSION_REASONS.REDACTED]
    assert.deepEqual(
      all.filter((r) => !reachable.has(r) && !reserved.includes(r)), [],
      '这些理由既不可达也没有被标为预留',
    )
    assert.deepEqual(
      [...reachable].filter((r) => !all.includes(r)), [],
      '可达集合里出现了未定义的枚举值',
    )
    // 预留的那一个必须**记在文档里**，否则下一个人不知道它是等谁
    assert.equal(reserved.length, 1)
    assert.match(
      readFileSync(resolve(HERE, 'assembler.mjs'), 'utf8'),
      /REDACTED[\s\S]{0,400}PRT-408|PRT-408[\s\S]{0,400}REDACTED/,
      'REDACTED 是留给脱敏（PRT-408）的，必须在源码里写明，否则它看起来只是没人用的枚举',
    )
  })

  test('每个候选都有去向，且快照哈希可校验', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'a', type: 'task', content: 'a' }) },
        { source: src({ id: 'b', type: 'document', content: 'b' }), supersededBy: 'v9' },
      ],
    }))
    assert.equal(verifySnapshotHash(s), true)
  })

  test('candidates 不是数组 → BAD_CANDIDATE（不给默认空数组）', () => {
    assert.throws(
      () => assembleContext(base({ candidates: undefined })),
      (e) => { assert.equal(e.code, ASSEMBLY_CODES.BAD_CANDIDATE); return true },
    )
  })

  test('元素形状不对 → BAD_CANDIDATE 并指出下标', () => {
    assert.throws(
      () => assembleContext(base({ candidates: [{ source: src() }, { nope: 1 }] })),
      /candidates\[1\]/,
    )
  })
})

describe('⑦ 摘要说得出"排除了什么、为什么"', () => {
  test('摘要把截断与排除都讲出来', () => {
    const s = assembleContext(base({
      candidates: [
        { source: src({ id: 'long', type: 'document', content: 'x'.repeat(100) }), allowTruncate: true },
        { source: src({ id: 'secret', type: 'task', content: 'y' }), scope: 'nope' },
      ],
      policy: { scope: 'default', maxTokens: 40, canRead: () => true },
    }))
    const text = describeAssembly(s)
    assert.match(text, /截断/)
    assert.match(text, /排除/)
    assert.match(text, /不在本空间/)
  })
})

describe('⑧ 接线：runtime 层的模块导出（不是"字符串出现过"）', () => {
  test('assembler 可被 import 并真的能跑', async () => {
    const mod = await import('./assembler.mjs')
    assert.equal(typeof mod.assembleContext, 'function')
    const s = mod.assembleContext(base())
    assert.equal(s.candidateCount, 0)
    assert.equal(verifySnapshotHash(s), true)
  })

  test('runtime 层存在一个聚合出口，且真的导出 assembleContext', async () => {
    // 一个只有文件、没有出口的模块与"不存在"在用户侧完全一样。
    const idx = await import('./index.mjs')
    assert.equal(typeof idx.assembleContext, 'function', 'runtime/context/index.mjs 必须导出 assembleContext')
    assert.equal(typeof idx.describeAssembly, 'function')
  })

  test('源文件里没有把 tokenizer 缺省成字符数的兜底（猜预算是一条真实故障路径）', () => {
    const srcText = readFileSync(resolve(HERE, 'assembler.mjs'), 'utf8')
    // 断言"缺 tokenizer 时抛错"，而不是"出现过 TOKENIZER_REQUIRED 这个字符串"。
    assert.match(srcText, /throw new AssemblyError\(ASSEMBLY_CODES\.TOKENIZER_REQUIRED/)
    assert.ok(!/count\s*[:=]\s*\(?\s*text\s*\)?\s*=>\s*text\.length\s*\}\s*$/.test(srcText.slice(0, 4000)), '文件头不该有默认 tokenizer')
  })
})

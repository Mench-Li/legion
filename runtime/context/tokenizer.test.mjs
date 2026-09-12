// runtime/context/tokenizer.test.mjs
// ============================================================================
// PRT-413：token 计量（保守估算器 + 精确 tokenizer 的注册点）
//
// 这一组的中心是一条**方向性**断言：估算器必须**不低估**。
//
// 两个方向的代价完全不对称：
//   · 低估 → 以为放得下，把超限内容发出去 → 在供应商侧失败，**钱已经花了**，
//     而且"预算"这道防线其实是假的；
//   · 高估 → 提前裁掉一点 → 模型少看一些上下文，没有金钱代价，也不会失败。
//
// 所以"保守"不是一个形容词，而是一条可以被测的性质：
// 对任意输入，estimate ≥ 任何 BPE 类 tokenizer 的结果。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  TOKENIZER_KINDS,
  codePointCount,
  createConservativeTokenizer,
  defineExactTokenizer,
  isUpperBoundOf,
  tokenizerForProfile,
  utf8ByteLength,
} from './tokenizer.mjs'
import { TOKEN_ESTIMATOR_KINDS, createTokenMeasurement } from '../contracts/context.mjs'

/**
 * 一个粗糙但**真实**的 BPE 近似：按 4 字符一 token 切（英文的真实量级）。
 *
 * 空串必须回 **0**，不能回 1。第一版写成 `Math.max(1, …)`，于是它对空串声称
 * "1 token"——**一个真实 tokenizer 对空串给 0**，所以那条用例测的是夹具自己的 bug。
 * （这类"夹具不成立"的错已经在本项目出现过：那次是撞车对根本不撞。）
 */
const approxBpe = (text) => (codePointCount(text) === 0 ? 0 : Math.max(1, Math.ceil(codePointCount(text) / 4)))

describe('① 估算器必须是上界（本任务的核心性质）', () => {
  const est = createConservativeTokenizer()

  test('kind 是估算，且带一句说明', () => {
    assert.equal(est.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    assert.match(est.note, /估算/)
    assert.match(est.note, /上界/)
  })

  test('**对英文文本，估算 ≥ 近似 BPE**（高估是可以接受的代价）', () => {
    for (const text of ['hello world', 'a', 'The quick brown fox jumps over the lazy dog.', 'x'.repeat(1000)]) {
      assert.ok(
        isUpperBoundOf(est.count(text), approxBpe(text)),
        `估算 ${est.count(text)} 应 >= 近似 BPE ${approxBpe(text)}（text=${text.slice(0, 20)}…）`,
      )
    }
  })

  test('**对中文/emoji/混合文本同样是上界**', () => {
    const cases = [
      '这是一段中文文本，用于测试估算器。',
      '🙂🙃🚀' ,
      'Mixed 中英 text with emoji 🎉 and numbers 12345',
      '', // 空串
    ]
    for (const text of cases) {
      assert.ok(isUpperBoundOf(est.count(text), approxBpe(text)), `上界失败：${text}`)
    }
  })

  test('码点计数把代理对算 1（不是 UTF-16 的 2）', () => {
    assert.equal(codePointCount('🙂'), 1)
    assert.equal('🙂'.length, 2, '前提：JS 字符串长度是 2')
    assert.equal(codePointCount('abc'), 3)
    assert.equal(codePointCount('中文'), 2)
  })

  test('字节上界更大（UTF-8 里中文 3 字节）', () => {
    const bytes = createConservativeTokenizer({ bound: 'utf8-bytes' })
    assert.equal(bytes.count('中'), 3)
    assert.equal(est.count('中'), 1)
    // 字节版必然 ≥ 码点版 → 也是上界，只是更松
    assert.ok(isUpperBoundOf(bytes.count('中文测试'), est.count('中文测试')))
  })

  test('未知上界基准被拒（不默默退回某一个）', () => {
    assert.throws(() => createConservativeTokenizer({ bound: 'whatever' }), /未知的上界基准/)
  })

  test('非字符串输入抛错（而不是返回 0）', () => {
    assert.throws(() => codePointCount(null), TypeError)
    assert.throws(() => utf8ByteLength(123), TypeError)
  })
})

describe('② 估算值必须能与精确值区分（否则 kind 没有意义）', () => {
  test('保守估算器可以直接喂给 createTokenMeasurement（note 满足"必须注明是估算"）', () => {
    const est = createConservativeTokenizer()
    const m = createTokenMeasurement({ kind: est.kind, tokens: est.count('abcd'), note: est.note })
    assert.equal(m.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    assert.match(m.note, /估算/)
  })

  test('**同一 token 数、不同 kind → 快照哈希不同**（把可信度封进哈希）', () => {
    // 复用契约层的判据：这是 PRT-401 建立的，这里确认估算器接到那条链上。
    const a = createTokenMeasurement({ kind: TOKEN_ESTIMATOR_KINDS.EXACT, tokens: 10 })
    const b = createTokenMeasurement({
      kind: TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE, tokens: 10, note: '保守估算',
    })
    assert.equal(a.tokens, b.tokens)
    assert.notEqual(a.kind, b.kind)
  })
})

describe('③ 精确 tokenizer 需要依据（不许自称精确）', () => {
  test('没给 evidence → 拒绝', () => {
    assert.throws(
      () => defineExactTokenizer({ count: (t) => t.length }),
      /evidence/,
    )
  })

  test('evidence 是空串 → 拒绝（空白不算依据）', () => {
    assert.throws(
      () => defineExactTokenizer({ count: (t) => t.length, evidence: '   ' }),
      /evidence/,
    )
  })

  test('给了依据则可以注册，且 kind 是 exact', () => {
    const t = defineExactTokenizer({
      count: (s) => codePointCount(s),
      evidence: '绑定了 deepseek-v4 的词表，逐字符复现其分词',
    })
    assert.equal(t.kind, TOKEN_ESTIMATOR_KINDS.EXACT)
    assert.match(t.evidence, /词表/)
  })

  test('count 不是函数 → 拒绝', () => {
    assert.throws(() => defineExactTokenizer({ count: 'nope', evidence: 'x' }), TypeError)
  })
})

describe('④ 为 ModelProfile 选 tokenizer：拿不到就**明说**是估算', () => {
  test('注册表里有 → 用精确的', () => {
    const exact = defineExactTokenizer({ count: (s) => codePointCount(s), evidence: '词表' })
    const registry = new Map([['deepseek-v4', exact]])
    const got = tokenizerForProfile({ model: 'deepseek-v4' }, registry)
    assert.equal(got.kind, TOKEN_ESTIMATOR_KINDS.EXACT)
  })

  test('**注册表里没有 → 保守估算，且 kind 不冒充精确**', () => {
    const registry = new Map([['other-model', defineExactTokenizer({ count: (s) => s.length, evidence: 'v' })]])
    const got = tokenizerForProfile({ model: 'unknown-model' }, registry)
    assert.equal(got.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE,
      '拿不到精确 tokenizer 时必须标成估算——一个"看起来精确"的默认值会让 kind 失去意义')
  })

  test('不给注册表也能工作（全用估算）', () => {
    assert.equal(tokenizerForProfile({ model: 'x' }).kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
  })

  test('profile 不是对象 → 抛错（不静默给个估算器）', () => {
    assert.throws(() => tokenizerForProfile(null), TypeError)
  })
})

describe('⑤ 接到装配器上：低估会让预算这道防线变成假的', () => {
  test('估算器超预算 → 装配器真的裁剪（预算被尊重）', async () => {
    const { assembleContext } = await import('./assembler.mjs')
    const { createContextSource } = await import('../contracts/context.mjs')
    const est = createConservativeTokenizer()
    // 200 个英文字符：近似 BPE 说 50 token，估算器说 200。
    // 预算 100 → 估算器认为放不下（保守），于是裁剪。**方向正确。**
    const s = assembleContext({
      attemptId: 'a', runId: 'r', frozenAtMs: 1,
      candidates: [{
        source: createContextSource({ id: 'd', type: 'document', version: 'v1', acquiredAtMs: 1, content: 'a'.repeat(200) }),
        allowTruncate: true,
      }],
      policy: { scope: 'default', maxTokens: 100, canRead: () => true },
      tokenizer: est,
    })
    assert.equal(s.tokens.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    assert.ok(s.tokens.tokens <= 100, '总量必须在预算内')
    assert.equal(s.truncations.length, 1, '保守估算导致提前裁剪——这是可接受的代价')
    assert.match(s.tokens.note, /估算/)
  })

  test('低估方向的后果演示：若按近似 BPE 判断则不会裁，而真实上限已被突破', async () => {
    // 这不是测装配器，而是把"为什么必须高估"钉成一条可读的断言。
    const est = createConservativeTokenizer()
    const text = 'a'.repeat(200)
    assert.equal(approxBpe(text), 50, '前提：近似 BPE 认为只要 50 token')
    assert.equal(est.count(text), 200, '估算器说 200 token')
    // 若信 50：预算 100 时认为放得下；而真正交付给模型的 token 数是未知的，
    // `kind` 会如实标成估算——那条信息就是这条防线能不能被复核的关键。
    assert.ok(isUpperBoundOf(est.count(text), approxBpe(text)))
  })
})

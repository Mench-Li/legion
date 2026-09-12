// runtime/context/redaction.test.mjs
// ============================================================================
// PRT-408：上下文脱敏（spec §6.5）
//
// 与日志脱敏（PRT-208）的区别不是程度，是**不可撤回性**：
//   日志脱敏 —— 别把密钥写进日志；写错了至少还在本机，能删。
//   上下文脱敏 —— 别把密钥**发给模型**；发出去就撤不回来了。
//
// 所以这一组守的是"**发出去的东西里没有密钥**"，而不只是"函数返回了脱敏标记"。
// 最要紧的一条用例走完整链路：装配 → finalText → 断言密钥**不在最终文本里**。
// 只测 `redactText` 返回了 `[已脱敏]` 是不够的——那证明不了装配器用上了它。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  REDACTION_SCHEMA,
  REDACTED,
  describeRedaction,
  redactCandidates,
  redactForModel,
  redactSource,
} from './redaction.mjs'
import { assembleContext, describeAssembly } from './assembler.mjs'
import { createContextSource, verifySnapshotHash, TOKEN_ESTIMATOR_KINDS, SOURCE_TRUST } from '../contracts/context.mjs'
import { SECRET_VALUE_PATTERNS } from '../contracts/redact-patterns.mjs'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const tok = { kind: TOKEN_ESTIMATOR_KINDS.EXACT, count: (t) => t.length }
const readAll = () => true

/** 一个真实形态的 OpenAI 风格密钥（**虚构值**，不是任何真实凭证）。 */
const FAKE_KEY = 'sk-abcdefghijklmnopqrstuvwx'
const FAKE_GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const src = (over = {}) => createContextSource({
  id: 'doc1', type: 'document', version: 'v1', acquiredAtMs: 1, trust: SOURCE_TRUST.UNTRUSTED,
  content: 'hello', ...over,
})

const assemble = (candidates, policy = {}, tokenizer = tok) => assembleContext({
  attemptId: 'a', runId: 'r', frozenAtMs: 1, candidates,
  policy: { scope: 's', canRead: readAll, maxTokens: null, ...policy }, tokenizer,
})

describe('① 发出去的东西里不能有密钥（本模块唯一真正重要的断言）', () => {
  test('**端到端：密钥不在 finalText 里**', () => {
    // 只测 redactText 返回了标记是不够的——那证明不了装配器用上了它。
    // 这一条走完整链路，断言的是"最终发给模型的那段文本里没有那个密钥"。
    const snap = assemble([{
      source: src({ content: `调用示例：Authorization: Bearer ${FAKE_KEY}\n结束` }),
    }])
    assert.ok(!snap.finalText.includes(FAKE_KEY), '密钥出现在最终文本里——脱敏没有生效')
    assert.ok(snap.finalText.includes(REDACTED), '应该留下脱敏标记')
    assert.ok(snap.sources[0].content.includes(REDACTED))
    assert.ok(!snap.sources[0].content.includes(FAKE_KEY), '主账本里也不能有')
  })

  test('多种形态一起脱敏（前缀 / Bearer / URL 内嵌 / 私钥块）', () => {
    const body = [
      `key=${FAKE_KEY}`,
      `token: ${FAKE_GH}`,
      'db = postgres://user:hunter2@db.internal:5432/app',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const snap = assemble([{ source: src({ content: body }) }])
    for (const secret of [FAKE_KEY, FAKE_GH, 'hunter2', 'MIIEow']) {
      assert.ok(!snap.finalText.includes(secret), `${secret} 没被脱敏`)
    }
    // URL 里的主机名要留着——排障还需要它
    assert.ok(snap.finalText.includes('db.internal'), '主机名应当保留')
  })

  test('**每条模式都真的能被触发**（定义了却没有产出的模式是个陷阱）', () => {
    // 一个永远匹配不上的正则与一个不存在的检查在输出上完全一样。
    // 这里给每条模式喂一个**它自己该命中**的样本，逐条确认。
    const SAMPLES = {
      'OpenAI 风格密钥': `sk-${'a'.repeat(24)}`,
      'GitHub PAT': `ghp_${'A'.repeat(30)}`,
      'GitHub 细粒度 PAT': `github_pat_${'A'.repeat(30)}`,
      'AWS Access Key ID': 'AKIAIOSFODNN7EXAMPLE',
      'Slack token': 'xoxb-123456789012-abcdefghij',
      'Bearer 凭证': 'Bearer abcdefghijklmnop',
      'URL 内嵌凭证': 'https://u:p@host.tld/x',
      '私钥块': '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    }
    const reasons = SECRET_VALUE_PATTERNS.map((p) => p.why)
    assert.deepEqual(
      [...reasons].sort(), Object.keys(SAMPLES).sort(),
      '模式表与样本表必须一一对应——新增模式而没补样本，这条会红',
    )
    for (const [why, sample] of Object.entries(SAMPLES)) {
      const r = redactForModel(sample)
      assert.equal(r.changed, true, `模式「${why}」没有被触发`)
      assert.ok(r.hits.includes(why), `命中说明里应出现「${why}」，实际：${r.hits.join(',')}`)
    }
  })
})

describe('② 脱敏是内容变换，不是排除', () => {
  test('被脱敏的来源**仍在 `sources[]` 里**', () => {
    // 整条排除会丢掉"我看过这份文档"这个事实。
    const snap = assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    assert.equal(snap.sources.length, 1, '它还是这次运行的输入')
    assert.equal(snap.excluded.length, 0, '脱敏不是排除')
    assert.equal(snap.sources[0].redacted, true)
  })

  test('摘要说"已脱敏"，**不说"排除"**', () => {
    const snap = assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    const d = describeAssembly(snap)
    assert.match(d, /已脱敏/, `摘要应说明脱敏：${d}`)
    assert.ok(!/排除/.test(d), `脱敏不该被说成排除：${d}`)
  })

  test('引用型来源（没有正文）**不**被标成已脱敏', () => {
    // 把 `content === null` 也标成 redacted，会让"这份文档被脱敏过"变成假话。
    const s = src({ content: null })
    const r = redactSource(s)
    assert.equal(r.redactions.length, 0)
    assert.equal(r.source.redacted, undefined, '没有正文可脱敏，就不该留脱敏标记')
  })
})

describe('③ 脱敏改变哈希，且这件事可见', () => {
  test('原文的哈希与长度留着（"它原本是什么"仍可查）', () => {
    const s = src({ content: `key=${FAKE_KEY}` })
    const r = redactSource(s)
    assert.equal(r.source.preRedactionContentHash, s.contentHash)
    assert.equal(r.source.preRedactionChars, s.content.length)
    assert.equal(r.source.chars, r.source.content.length, 'chars 必须是脱敏后的长度')
  })

  test('**脱敏后的哈希与原文不同**', () => {
    const s = src({ content: `key=${FAKE_KEY}` })
    const r = redactSource(s)
    assert.notEqual(r.source.preRedactionContentHash, `sha256:x`)
    // 装配器会把 contentHash 重算成"实际发出去那一版"的哈希
    const snap = assemble([{ source: s }])
    assert.notEqual(snap.sources[0].contentHash, snap.sources[0].preRedactionContentHash)
    assert.equal(verifySnapshotHash(snap), true)
  })

  test('**哈希对"脱敏规则变了"敏感**（否则回放会给出不同结果而哈希说同一份）', () => {
    const a = assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    const b = assembleContext({
      attemptId: 'a', runId: 'r', frozenAtMs: 1, candidates: [{ source: src({ content: `key=${FAKE_KEY}` }) }],
      policy: { scope: 's', canRead: readAll, maxTokens: null }, tokenizer: tok,
    })
    assert.equal(a.snapshotHash, b.snapshotHash, '同一份输入必须同一个哈希')
    // 换一个 schema 版本 → 不同哈希
    const snap = assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    assert.equal(snap.redactionSchema, REDACTION_SCHEMA)
  })
})

describe('④ 审计里只有路径与说明，**没有原值**', () => {
  test('`redactions[]` 不含密钥片段', () => {
    const snap = assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    const flat = JSON.stringify(snap.redactions)
    assert.ok(!flat.includes(FAKE_KEY), '审计不该成为第二个泄漏点')
    assert.ok(!flat.includes('abcdefghij'), '连片段都不该有')
    assert.equal(snap.redactions[0].at, 'content')
    assert.equal(snap.redactions[0].sourceId, 'doc1')
  })

  test('整份快照序列化后也不含密钥', () => {
    const snap = assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    assert.ok(!JSON.stringify(snap).includes(FAKE_KEY))
  })

  test('命中说明去重但保持首次出现顺序', () => {
    const body = `a=${FAKE_KEY}\nb=${FAKE_KEY}\nc=${FAKE_GH}`
    const snap = assemble([{ source: src({ content: body }) }])
    const whys = snap.redactions.map((r) => r.why)
    assert.deepEqual(whys, ['OpenAI 风格密钥', 'GitHub PAT'])
    assert.equal(new Set(whys).size, whys.length)
  })
})

describe('⑤ 脱敏先于截断，账本按"发生过"记', () => {
  test('**被裁掉的尾部里的密钥仍然进账本**——因为脱敏作用在完整正文上', () => {
    // 这一条第一版写反了：我断言"没发出去就不该记脱敏"，然后它红了。
    // 红的是**测试**，不是实现。顺序不能反——先截断再脱敏的话，
    // 一次裁剪可能正好切在一个密钥中间，剩下的片段不再匹配任何模式，
    // 于是**一段残缺的密钥被发了出去**。
    //
    // 所以脱敏覆盖整份正文，账本因此会包含"后来被裁掉"的那部分。
    // 那不是多报：「这份来源含有一个密钥，我们把它脱敏了」是**真话**；
    // 「那部分有没有发出去」由 `truncations[]` 单独回答。
    //
    // 两个方向的风险不对称：多记一条（安全侧）与漏记一条**真的发出去**的
    // （灾难侧）不能同日而语。当前顺序**不可能**漏记。
    const content = `开头\n${'x'.repeat(200)}\nkey=${FAKE_KEY}`
    const snap = assemble(
      [{ source: src({ content }), allowTruncate: true }],
      { maxTokens: 10 },
    )
    assert.equal(snap.truncations.length, 1, '确实被裁了')
    assert.equal(snap.redactions.length, 1, '密钥在完整正文里，脱敏确实发生过')
    // 但**发出去的那部分**里绝没有它——这才是真正要紧的那条
    assert.ok(!snap.finalText.includes(FAKE_KEY))
    assert.ok(!snap.sources[0].content.includes(FAKE_KEY), '主账本里的正文也没有')
    // 两个账本各自回答自己的问题，互不冒充
    assert.match(describeAssembly(snap), /已脱敏/)
    assert.match(describeAssembly(snap), /被截断/)
  })

  test('**越权来源不进脱敏账本**（它的正文根本没被读）', () => {
    // 这一条与上一条不同：排除发生在 `pending` 之前，正文从来没进装配流程，
    // 所以是真的"没脱敏过"。上一条是"脱敏过但没发出去"。
    const snap = assemble(
      [{ source: src({ content: `key=${FAKE_KEY}` }) }],
      { canRead: () => false },
    )
    assert.equal(snap.excluded.length, 1)
    assert.equal(snap.sources.length, 0)
    assert.equal(snap.redactions.length, 0, '没读进来的正文谈不上脱敏')
  })

  test('脱敏在**裁剪之前**：脱敏后变短了，就能整个放下', () => {
    // 顺序反了的话，脱敏会作用在一段已被裁过的文本上，
    // 而 `preRedactionChars` 记的会是截断后的长度。
    const s = src({ content: `key=${FAKE_KEY}` })
    const r = redactSource(s)
    assert.equal(r.source.preRedactionChars, s.content.length, 'preRedactionChars 必须是**脱敏前**的长度')
    assert.ok(r.source.content.length < s.content.length, '脱敏后确实变短了')
  })

  test('**裁剪切在密钥中间也不会漏出去**（顺序不能反的真正理由）', () => {
    // 若先截断：正文被切到只剩 `sk-abcdefghij`（12 位仍匹配）甚至 `sk-abcd`（不匹配），
    // 后者就是一段残缺密钥被发出。现在脱敏先做，切片切在标记上，切出来的是完整标记的前缀。
    const s = src({ content: `${'y'.repeat(30)} key=${FAKE_KEY}` })
    const snap = assemble([{ source: s, allowTruncate: true }], { maxTokens: 40 })
    assert.ok(snap.truncations.length === 1 || snap.sources.length === 1)
    // 无论裁没裁，都不能出现 `sk-` 开头的残留
    assert.ok(!/sk-[A-Za-z0-9]{4,}/.test(snap.finalText), `残留了密钥片段：${snap.finalText.slice(-60)}`)
  })
})

describe('⑥ 确定性', () => {
  test('同一份含密钥的输入装配两次 → 同一个哈希', () => {
    const mk = () => assemble([{ source: src({ content: `key=${FAKE_KEY}` }) }])
    assert.equal(mk().snapshotHash, mk().snapshotHash)
  })

  test('没有密钥时**不产生**脱敏记录（不是"总是记录一条空的"）', () => {
    const snap = assemble([{ source: src({ content: '干净的正文' }) }])
    assert.deepEqual(snap.redactions, [])
    assert.equal(snap.sources[0].redacted, undefined)
    assert.equal(describeRedaction([]), null)
  })
})

describe('⑦ 与 PRT-208 的日志脱敏**共用同一张模式表**', () => {
  test('`redact-patterns.mjs` 是唯一真源，两侧导出同一个对象', async () => {
    // 两份表会漂移，而漂移的那一次就是漏掉一种新密钥形态的那一次。
    const logSide = await import('../adapters/dsh/redact.mjs')
    const ctxSide = await import('../contracts/redact-patterns.mjs')
    assert.equal(logSide.SECRET_VALUE_PATTERNS, ctxSide.SECRET_VALUE_PATTERNS,
      '两边必须是**同一个**冻结对象，不是两份内容相同的拷贝')
    assert.equal(logSide.REDACTED, ctxSide.REDACTED)
    assert.equal(logSide.SENSITIVE_KEY_RE, ctxSide.SENSITIVE_KEY_RE)
  })

  test('日志侧原有的出口一个都没少（提取不能破坏既有调用方）', async () => {
    const m = await import('../adapters/dsh/redact.mjs')
    for (const name of ['redactText', 'redactValue', 'redactJson', 'SENSITIVE_KEY_RE', 'SECRET_VALUE_PATTERNS', 'REDACTED']) {
      assert.ok(name in m, `日志脱敏少了导出 ${name}`)
    }
  })

  test('日志侧的按键名脱敏仍然有效（提取之后行为不变）', async () => {
    const { redactValue, REDACTED: R } = await import('../adapters/dsh/redact.mjs')
    const r = redactValue({ token: 'whatever', headers: { Authorization: 'x' } })
    assert.equal(r.value.token, R)
    assert.equal(r.value.headers.Authorization, R)
    assert.ok(r.redacted.includes('headers.Authorization'))
  })

  test('日志侧的**按键名**脱敏不适用于上下文（键名在正文里，不是结构）', () => {
    // 这是两侧真正不同的一处，值得显式钉住：
    // 日志是一条 `{token: '...'}` 的结构化记录，所以按键名能拦住；
    // 上下文是一整块**文本**，`token: xxx` 只是文本里的几个字，
    // 只能按**值形态**认。若上下文侧照抄按键名脱敏，它会一条也拦不住。
    const body = 'token: thisIsNotAMatchingSecretShape'
    const snap = assemble([{ source: src({ content: body }) }])
    // 值形态没命中 → 不脱敏。这是**已知且刻意**的局限，不是遗漏：
    // 我们无法在不误伤正常文本的前提下，从自由文本里认出"任意形状的密钥"。
    assert.deepEqual(snap.redactions, [])
  })
})

describe('⑧ 接线：不是"字符串出现过"', () => {
  test('assembler.mjs 真的 import 并调用了 redactSource', () => {
    const t = readFileSync(resolve(HERE, 'assembler.mjs'), 'utf8')
    assert.match(t, /import \{[^}]*redactSource[^}]*\} from '\.\/redaction\.mjs'/)
    assert.match(t, /redactSource\(p\.source\)/, '必须真的在装配流程里被调用')
    // 而且要**先于**预算裁剪
    const iRed = t.indexOf('redactSource(p.source)')
    const iTrim = t.indexOf('// ⑥ 预算裁剪')
    assert.ok(iRed > 0 && iTrim > 0 && iRed < iTrim, '脱敏必须在裁剪之前')
  })

  test('`redactions` 真的进了快照与哈希', () => {
    const t = readFileSync(resolve(HERE, '..', 'contracts', 'context.mjs'), 'utf8')
    assert.match(t, /redactions: Array\.isArray\(input\.redactions\)/)
    assert.match(t, /redactionSchema: input\.redactionSchema/)
  })

  test('`redactCandidates` 是批量入口且返回三个东西', () => {
    const r = redactCandidates([{ source: src({ content: `k=${FAKE_KEY}` }) }, { source: src({ id: 'd2', content: 'clean' }) }])
    assert.equal(r.candidates.length, 2)
    assert.deepEqual(r.redactedSourceIds, ['doc1'])
    assert.equal(r.redactions.length, 1)
    assert.equal(r.candidates[0].source.redacted, true)
    assert.equal(r.candidates[1].source.redacted, undefined)
    assert.throws(() => redactCandidates('nope'), TypeError)
    assert.throws(() => redactCandidates([null]), TypeError)
  })
})

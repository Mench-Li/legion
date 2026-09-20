// runtime/context/bpe.test.mjs
// ============================================================================
// PRT-413：字节级 BPE 与产物装载
//
// 这一组的中心是**"精确"必须真的是精确的**。
//
// 本仓库拿不到任何供应商词表（零依赖 + 数据许可），所以这里用一份**自己造的、
// 极小的词表**来验证算法本身：如果编码器对这份词表算出的切分与手算一致，
// 那么换成一份真的 CL100K 词表，它算的就是那个模型的 token 数——
// 因为**算法里没有一个硬编码的模型常量**，词表与 merge 全是数据。
//
// 反过来，如果这里只用"不抛错""返回正数"来断言，那这份实现与一个
// `count = () => 1` 的桩在用例上是分不开的。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BPE_ARTIFACT_FIELDS,
  assertBpeArtifactShape,
  bpeArtifactWiring,
  bytesToUnicode,
  createBpeTokenizer,
  exactTokenizerFromArtifact,
  fromByteLevel,
  parseTokenizerArtifact,
  toByteLevel,
} from './bpe.mjs'
import { TOKENIZER_LOAD_ERRORS, TokenizerLoadError, createLazyTokenizerRegistry, loadTokenizerRegistry, TOKENIZER_ARTIFACT_SUFFIX } from './tokenizer-registry.mjs'

/**
 * 一份**手写的极小词表**，够算出可手验的结果。
 *
 * 字节级形态：`h` `e` `l` `o` 这些可见字符在字节级就是它们自己
 * （见 `bytesToUnicode`：0x21..0x7e 原样保留）。所以 "hello" 的字节级是 `hello`，
 * 逐字符切开是 `h e l l o`，再按 merges 合并成 `he` `ll` `o` → 3 个 token。
 */
const SMALL = {
  name: 'small-test-bpe',
  model: 'test-model',
  evidence: '手写词表，仅用于验证算法（不是任何真实模型）',
  merges: ['h e', 'l l', 'he ll'],
  vocab: {
    h: 0, e: 1, l: 2, o: 3, he: 4, ll: 5, hell: 6, hello: 7,
  },
}

const tok = () => createBpeTokenizer(parseTokenizerArtifact(SMALL))

describe('① 字节级映射是算法，不是数据', () => {
  test('★ `decode(encode(x)) === x`——任意 Unicode 都能往返', () => {
    const { byteToChar, charToByte } = bytesToUnicode()
    assert.equal(byteToChar.size, 256, '256 个字节都要有映射')
    assert.equal(charToByte.size, 256, '映射必须是双射，否则 decode 会有歧义')
    assert.equal(byteToChar.size, charToByte.size)

    for (const s of [
      'hello', '中文也要能往返', 'emoji 🙂🚀', '', 'a\n\t b',
      'ÿ ® ¡ ¬', // 边界：这几个码点区间的两端
      '\u0000\u001f\u007f', // 控制字符（不可打印 → 会被挪到 256 以上）
    ]) {
      const round = fromByteLevel(toByteLevel(s))
      assert.equal(round, s, `往返失败：${JSON.stringify(s)} → ${JSON.stringify(round)}`)
    }
  })

  test('每个 UTF-8 字节恰好一个字符（字节级的意思就是逐字节）', () => {
    // "中" 是 3 个字节
    assert.equal([...toByteLevel('中')].length, 3)
    // 空串是 0
    assert.equal(toByteLevel(''), '')
  })
})

describe('② BPE 算出的切分与**手算**一致', () => {
  test('★★ "hello" → 3 个 token（he / ll / o），不是 5 个也不是 1 个', () => {
    // 手算：h e l l o → 按 rank 最低的 merge 反复合
    //   merges 顺序：0:"h e" 1:"l l" 2:"he ll"
    //   ① 先合 rank 0（h+e）→ [he, l, l, o]
    //   ② 再合 rank 1（l+l）→ [he, ll, o]
    //   ③ rank 2（he+ll）虽然给了，但合并后是 "hell"；这里**会不会**发生取决于实现。
    //      正确实现应当只在 rank 更低时合并——"he ll"(rank 2) 的 rank 比当前
    //      已无更优，所以会合并成 hell → [hell, o] → 2 个。
    //
    //   所以这里的期望是 **2**（hell + o），而不是 3。
    //   这条断言存在的意义：如果实现是"随便合到不能再合"，结果会一样；
    //   如果实现是"只看相邻两个是否在词表里"，结果也一样——
    //   但它会与"按 rank 优先级"在更复杂的词表上分叉。下面第三条用例钉住优先级。
    assert.equal(tok().count('hello'), 2)
    assert.deepEqual(tok().encode('hello').tokens, ['hell', 'o'])
  })

  test('★ merge 的**优先级**由次序决定（不是"能合就合"）', () => {
    // 换一份词表：让两个候选 merge 竞争同一段文本，次序决定结果。
    const a = createBpeTokenizer(parseTokenizerArtifact({
      name: 'a', model: 'm', evidence: 'e',
      merges: ['a b', 'ab c'], // 先 ab 再 abc
      vocab: { a: 0, b: 1, c: 2, ab: 3, abc: 4 },
    }))
    assert.deepEqual(a.encode('abc').tokens, ['abc'])

    // 反过来的次序：先合 bc，于是得到 a + bc（若 bc 在词表里）
    const b = createBpeTokenizer(parseTokenizerArtifact({
      name: 'b', model: 'm', evidence: 'e',
      merges: ['b c', 'a bc'],
      vocab: { a: 0, b: 1, c: 2, bc: 3, abc: 4 },
    }))
    assert.deepEqual(b.encode('abc').tokens, ['abc'], '两条路都该走到 abc——优先级不同但结果相同')
    // 让它们真的分叉：只给 "a b" 的 merge，不给 "ab c"
    const c = createBpeTokenizer(parseTokenizerArtifact({
      name: 'c', model: 'm', evidence: 'e',
      merges: ['a b'],
      vocab: { a: 0, b: 1, c: 2, ab: 3 },
    }))
    assert.deepEqual(c.encode('abc').tokens, ['ab', 'c'], '没有 ab+c 这条规则就不能合成 abc')
  })

  test('单字符与空串', () => {
    assert.equal(tok().count(''), 0)
    assert.deepEqual(tok().encode('').ids, [])
    assert.equal(tok().count('h'), 1)
    assert.equal(tok().count('o'), 1)
  })

  test('token 数随文本增长（不是恒返回 1 的桩）', () => {
    const t = tok()
    assert.ok(t.count('hello') >= 2)
    assert.ok(t.count('hellohello') > t.count('hello'), '两倍文本必然更多 token')
    assert.ok(t.count('some longer english text here') > t.count('hello'))
  })
})

describe('③ ★★ 词表没覆盖时给的是**上界**，不是 1', () => {
  test('未覆盖的片段按**字节数**计（真正的 tokenizer 只会拆得更碎）', () => {
    // 词表里没有 'z'，所以 'z' 落到未覆盖分支。
    const t = createBpeTokenizer(parseTokenizerArtifact({
      name: 'x', model: 'm', evidence: 'e',
      merges: [],
      vocab: { a: 0 },
    }))
    // 4 个 z → 4 个 token（每个字节一个），而不是 1
    assert.equal(t.count('zzzz'), 4)
    const cov = t.coverage('zzzz')
    assert.equal(cov.covered, false)
    assert.deepEqual(cov.misses, ['z'])
    // 3 字节的汉字 → 至少 3 个 token（上界方向）
    assert.ok(t.count('中') >= 3, `未覆盖的多字节字符必须至少按字节计，实际 ${t.count('中')}`)
  })

  test('★ 上界方向的可测性：未覆盖时 count ≥ 逐字节数', () => {
    const t = createBpeTokenizer(parseTokenizerArtifact({
      name: 'x', model: 'm', evidence: 'e', merges: [], vocab: { a: 0 },
    }))
    for (const s of ['zz', '中', 'a中b', '🙂']) {
      const bytes = [...new TextEncoder().encode(s)].length
      assert.ok(t.count(s) >= bytes, `${JSON.stringify(s)} 的估算 ${t.count(s)} 小于字节数 ${bytes}——低估了`)
    }
  })

  test('★★ "按字节数计"是由**切分粒度**保证的，不是靠某个循环乘一遍', () => {
    // 这条用例守的是那条上界推导的**前提**本身。
    //
    // 上界是"词元数 ≤ 码点数 ≤ 字节数"。实现里未覆盖的片段各算 1 个 token，
    // 而"1 个片段 = 1 个字节"这件事是由 `bpePiece` 用 `Array.from` 切**字节级串**
    // 保证的——不是由计数那一侧再乘一次字节数保证的。
    //
    // 断验证探针⑥⑤ 就是在这里失败的：它把 `for (...ids.push(-1))` 换成单个
    // `ids.push(-1)`，期望用例变红，结果**读数不变**——因为那个循环永远不会
    // 转第二圈。一个"改不动读数"的探针，说明原来那段代码的**表述**比它的
    // **作用**大。
    //
    //   > 一个"看起来在按字节数计"的循环，与一个"只 push 一次"的语句，
    //   > 在切分粒度恒为一时是同一个东西——只不过前者会让人以为
    //   > **那段代码**在保证上界，于是有人改动切分粒度时不会想到上界。
    //
    // 所以这一条直接把那个前提写成会红的断言：**未覆盖的片段必须恰好是一个字节**。
    const t = createBpeTokenizer(parseTokenizerArtifact({
      name: 'x', model: 'm', evidence: 'e', merges: [], vocab: { a: 0 },
    }))
    const { misses } = t.encode('中🙂zz')
    assert.ok(misses.length > 0, '这份文本必须有未覆盖的片段（否则下面等于没测）')
    for (const m of misses) {
      assert.equal([...m].length, 1,
        `未覆盖片段 ${JSON.stringify(m)} 不是单个字节——`
        + '"每个未覆盖片段算 1 个 token"就等于"每个字节算 1 个"的推导前提变了')
    }
  })
})

describe('④ 坏产物一律拒绝（不降级）', () => {
  const bad = (over, re) => assert.throws(() => parseTokenizerArtifact({ ...SMALL, ...over }), re)

  test('缺字段 / 类型错', () => {
    assert.throws(() => parseTokenizerArtifact(null), /必须是/)
    assert.throws(() => parseTokenizerArtifact([]), /必须是/)
    bad({ name: '' }, /name/)
    bad({ model: '  ' }, /model/)
    bad({ evidence: undefined }, /evidence/)
    bad({ vocab: [] }, /vocab/)
    bad({ merges: {} }, /merges/)
  })

  test('空词表被拒（一份空词表会让每个字符都"没覆盖"）', () => {
    bad({ vocab: {} }, /空的/)
  })

  test('vocab 的 id 必须是非负整数', () => {
    bad({ vocab: { h: 1.5 } }, /非负整数/)
    bad({ vocab: { h: -1 } }, /非负整数/)
    bad({ vocab: { h: '0' } }, /非负整数/)
  })

  test('merges 的每一项必须形如 "a b"', () => {
    bad({ merges: ['h'] }, /一个空格|形如/)
    bad({ merges: [42] }, /形如/)
  })

  test('★ 坏 pattern 在**加载期**就失败（否则每次 count 都抛）', () => {
    bad({ pattern: '([' }, /Invalid regular expression|Unterminated|正则/i)
  })

  test('★ 没有 evidence 的产物不能被当成"精确"', () => {
    assert.throws(() => exactTokenizerFromArtifact({ ...SMALL, evidence: '' }), /evidence/)
  })
})

describe('⑤ 从目录装载（接入点必须真的能走进去）', () => {
  const withDir = (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'legion-bpe-'))
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
      }
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('★★ 装载后 `tokenizerForProfile` 真的拿到**精确**的那个', async () => {
    const { tokenizerForProfile } = await import('./tokenizer.mjs')
    withDir({ [`a${TOKENIZER_ARTIFACT_SUFFIX}`]: SMALL }, (dir) => {
      const reg = loadTokenizerRegistry(dir)
      assert.equal(reg.size, 1)
      const t = tokenizerForProfile({ model: 'test-model' }, reg)
      assert.equal(t.kind, 'exact', '装载进去的必须是精确的那个，而不是估算')
      assert.equal(t.count('hello'), 2, '而且它算出来的数要真的是 BPE 的数')
      // 没注册的模型照旧拿估算器
      assert.equal(tokenizerForProfile({ model: 'unknown' }, reg).kind, 'conservative-estimate')
    })
  })

  test('★ evidence 里带上了 sha256 与路径（快照能回答"用哪份字节算的"）', () => {
    withDir({ [`a${TOKENIZER_ARTIFACT_SUFFIX}`]: SMALL }, (dir) => {
      const t = loadTokenizerRegistry(dir).get('test-model')
      assert.match(t.evidence, /sha256/)
      assert.match(t.evidence, /a\.tokenizer\.json/)
    })
  })

  test('非 tokenizer 后缀的文件被忽略（目录里可以放别的东西）', () => {
    withDir({ 'README.md': '# 不是词表', [`a${TOKENIZER_ARTIFACT_SUFFIX}`]: SMALL }, (dir) => {
      assert.equal(loadTokenizerRegistry(dir).size, 1)
    })
  })

  test('★ 没配置目录 = 空注册表（不是错误）', () => {
    assert.equal(loadTokenizerRegistry(null).size, 0)
    assert.equal(loadTokenizerRegistry(undefined).size, 0)
    assert.equal(loadTokenizerRegistry('').size, 0)
  })

  test('★★ 坏 JSON **让装载失败**，不静默跳过', () => {
    withDir({ [`bad${TOKENIZER_ARTIFACT_SUFFIX}`]: '{ 这不是 json' }, (dir) => {
      assert.throws(() => loadTokenizerRegistry(dir), (e) => {
        assert.ok(e instanceof TokenizerLoadError)
        assert.equal(e.code, TOKENIZER_LOAD_ERRORS.BAD_JSON)
        return true
      })
    })
  })

  test('★★ 形状不对的产物也让装载失败（跳过会让"精确"变成谎话）', () => {
    withDir({ [`bad${TOKENIZER_ARTIFACT_SUFFIX}`]: { name: 'x', model: 'm', evidence: 'e', vocab: {}, merges: [] } }, (dir) => {
      assert.throws(() => loadTokenizerRegistry(dir), (e) => {
        assert.equal(e.code, TOKENIZER_LOAD_ERRORS.BAD_ARTIFACT)
        return true
      })
    })
  })

  test('配置了但读不到的目录 → 报错（"配了"与"没配"是两件事）', () => {
    assert.throws(() => loadTokenizerRegistry(join(tmpdir(), 'legion-does-not-exist-xyz')),
      (e) => {
        assert.equal(e.code, TOKENIZER_LOAD_ERRORS.BAD_ARTIFACT)
        assert.match(e.message, /这与"没有配置目录"不同/)
        return true
      })
  })

  test('★ 同一个 model 被两份产物声明 → 报错，不猜用哪份', () => {
    withDir({
      [`a${TOKENIZER_ARTIFACT_SUFFIX}`]: SMALL,
      [`b${TOKENIZER_ARTIFACT_SUFFIX}`]: { ...SMALL, name: 'another' },
    }, (dir) => {
      assert.throws(() => loadTokenizerRegistry(dir), (e) => {
        assert.equal(e.code, TOKENIZER_LOAD_ERRORS.DUPLICATE_MODEL)
        return true
      })
    })
  })

  test('★ 惰性注册表：读盘失败会抛出并被 `status()` 记住，且**不重试**', () => {
    let calls = 0
    const reg = createLazyTokenizerRegistry(() => {
      calls += 1
      return join(tmpdir(), 'legion-nope-xyz')
    })
    // `getDir` 只在构造时调一次——`status()` 不该有副作用
    assert.equal(calls, 1, 'getDir 只该在构造时被调一次')
    assert.equal(reg.status().loaded, false, '没用到之前不该读盘')
    assert.equal(calls, 1, 'status() 不该再调 getDir（排障不该产生副作用）')
    assert.equal(reg.status().error, null)

    assert.throws(() => reg.get('m'))
    assert.equal(reg.status().loaded, false, '读失败不算"加载过"')
    assert.equal(reg.status().error.code, TOKENIZER_LOAD_ERRORS.BAD_ARTIFACT)
    // 再取一次**不重试**：一个坏目录不该让每次请求都去摸盘
    assert.throws(() => reg.get('m'))
    assert.equal(calls, 1, '失败后不该再次读盘')
  })

  test('惰性注册表读成功后 status 说清注册了什么', () => {
    withDir({ [`a${TOKENIZER_ARTIFACT_SUFFIX}`]: SMALL }, (dir) => {
      const reg = createLazyTokenizerRegistry(() => dir)
      assert.equal(reg.get('test-model').kind, 'exact')
      const st = reg.status()
      assert.equal(st.count, 1)
      assert.deepEqual(st.models, ['test-model'])
      assert.equal(st.error, null)
    })
  })

  test('惰性注册表：没配置时 get 返回 undefined（交给 tokenizerForProfile 走估算）', () => {
    const reg = createLazyTokenizerRegistry(() => null)
    assert.equal(reg.get('any'), undefined)
    assert.equal(reg.status().count, 0)
    assert.equal(reg.status().error, null)
  })
})

describe('⑥ 接线：入口真的导出（否则与不存在一样）', () => {
  test('runtime/context/index.mjs 导出了 BPE 与装载器，且**真的能用**', async () => {
    // ★ 不只断言"typeof === 'function'"：一个导出存在但一调用就炸的入口，
    //   与"没有入口"是同一个东西。所以这里真的跑一遍。
    const idx = await import('./index.mjs')
    for (const name of ['loadTokenizerRegistry', 'createLazyTokenizerRegistry',
      'createBpeTokenizer', 'parseTokenizerArtifact', 'exactTokenizerFromArtifact',
      'bytesToUnicode', 'toByteLevel', 'fromByteLevel']) {
      assert.equal(typeof idx[name], 'function', `index.mjs 未导出可用的 ${name}`)
    }
    for (const name of ['TOKENIZER_LOAD_ERRORS', 'TOKENIZER_ARTIFACT_SUFFIX', 'BPE_ARTIFACT_FIELDS']) {
      assert.ok(idx[name] !== undefined, `index.mjs 未导出 ${name}`)
    }
    // 真的走一遍：解产物 → 造编码器 → 算数
    const art = idx.parseTokenizerArtifact(SMALL)
    const t = idx.createBpeTokenizer(art)
    assert.equal(t.count('hello'), 2)
    assert.equal(idx.fromByteLevel(idx.toByteLevel('往返')), '往返')
  })
})

// ---------------------------------------------------------------------------
// 产物形状接线（第 43 轮）
//
// ★ 这一组补的是**原来那句断言的缺口**：`bpe.test.mjs` 只断言
//   `idx[name] !== undefined`（**名字在不在**），从不比对内容。
//   于是 `BPE_ARTIFACT_FIELDS` 少了 `ranks` 也没人红——
//   而那张表当时在整仓里**没有任何读者**。
//
//   > 一句"名字导出出来了"的断言，与一句"这个清单真的描述了产物"的断言，
//   > 在清单恰好写对的那一天是同一个东西——
//   > 只不过前者会在产物多一个字段的那一天继续保持绿色。
// ---------------------------------------------------------------------------

describe('BPE 产物形状：BPE_ARTIFACT_FIELDS 真的校验产物', () => {
  test('接线① ★★★ 真产物的键**恰好等于**声明的清单（多一个少一个都算错）', () => {
    const art = parseTokenizerArtifact(SMALL)
    const keys = Object.keys(art).sort()
    assert.deepEqual(keys, [...BPE_ARTIFACT_FIELDS].sort(),
      `产物实际字段 ${JSON.stringify(keys)}，而清单声明的是 ${JSON.stringify([...BPE_ARTIFACT_FIELDS])}`)
    // 反向控制：`ranks` 曾经是漏掉的那一个，这里点名钉住它
    assert.ok(BPE_ARTIFACT_FIELDS.includes('ranks'),
      'ranks 不在清单里——它曾经就是这样漏掉的（产物有、清单没有）')
    assert.equal(typeof art.ranks, 'object', '产物里的 ranks 不是对象')
  })

  test('接线② ★★★ 少了字段 ⇒ 判据报出，且构造处当场抛（不静默）', () => {
    const good = { name: 'a', model: 'b', pattern: null, vocab: {}, merges: [], ranks: {}, evidence: 'e' }
    assert.equal(bpeArtifactWiring({ artifact: good }).ok, true, '正确形状被判成错')

    const { ranks, ...missingRanks } = good
    assert.equal(ranks === undefined, false, '夹具没构造出"少了 ranks"的形状')
    const w = bpeArtifactWiring({ artifact: missingRanks })
    assert.equal(w.ok, false)
    assert.deepEqual(w.missing, ['ranks'], '少了 ranks 没被指出来')
    assert.throws(() => assertBpeArtifactShape(missingRanks), /少了 \["ranks"\]/)
  })

  test('接线③ ★★ 多了字段 ⇒ 同样报出（清单不是"至少要有"）', () => {
    const good = { name: 'a', model: 'b', pattern: null, vocab: {}, merges: [], ranks: {}, evidence: 'e' }
    const w = bpeArtifactWiring({ artifact: { ...good, diskUsageBytes: 1 } })
    assert.equal(w.ok, false)
    assert.deepEqual(w.extra, ['diskUsageBytes'], '多出来的字段没被指出来')
    assert.throws(() => assertBpeArtifactShape({ ...good, diskUsageBytes: 1 }), /多了 \["diskUsageBytes"\]/)
  })

  test('接线⑤ ★★★ 构造处**真的**拿清单校验了——注入一份坏清单，构造必须抛', () => {
    // ★★★ 这一条是证明"那句 `assertBpeArtifactShape(...)` 真的在跑"的**唯一**办法。
    //   若只是"产物恰好与清单一致"，那么把那个调用整个删掉，用例**依然全绿**
    //   ——破验 B2（删掉构造处的校验）最初就是**漏网**的，正是这个原因。
    //   ⇒ 把清单做成可注入的，构造路径的行为才变得**可观测**：
    //     注入一份与产物不符的清单，构造就该抛；不抛 ⇒ 那句校验没在跑。
    assert.throws(
      () => parseTokenizerArtifact(SMALL, { fields: [...BPE_ARTIFACT_FIELDS, 'ghost'] }),
      /少了 \["ghost"\]/,
      '注入了一份多出 ghost 的清单，构造却没抛 ⇒ 构造处那句校验没在跑（清单又退回成一句说明）',
    )
    assert.throws(
      () => parseTokenizerArtifact(SMALL, { fields: BPE_ARTIFACT_FIELDS.filter((f) => f !== 'ranks') }),
      /多了 \["ranks"\]/,
      '注入了一份少了 ranks 的清单，构造却没抛 ⇒ 构造处没有比对清单',
    )
    // 反向控制：真清单必须能构造出产物（别把"注入"变成"凡注入必抛"）
    assert.equal(Object.keys(parseTokenizerArtifact(SMALL, { fields: BPE_ARTIFACT_FIELDS })).length,
      BPE_ARTIFACT_FIELDS.length)
  })
  test('接线④ ★★ 列清单却没人校验 = 空话：构造处**必须**真的调了它', () => {
    // ★ 反证法：把清单改坏（注入），校验就该红。
    //   如果"清单"只是一句说明，那么改坏清单不会有任何反应——这里要证明有反应。
    const art = parseTokenizerArtifact(SMALL)
    const w = bpeArtifactWiring({ artifact: art, fields: [...BPE_ARTIFACT_FIELDS, 'ghost'] })
    assert.equal(w.ok, false, '清单里多一个不存在的字段，校验却没反应 ⇒ 清单没被用')
    assert.deepEqual(w.missing, ['ghost'])
  })
})

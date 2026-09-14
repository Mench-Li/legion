// security/secrets/dsh-credentials.test.mjs
// ============================================================================
// DSH 凭证子集读取器（PRT-509 路线 A′）
//
// ## 这一组守的是什么
//
//   · 认得出 DSH 自己写出的那个确切子集——**逐字段**比对，不是"没抛错"；
//   · 子集之外的每一样东西都以**具名码**被拒绝，且每个码被逐字钉住；
//   · "没有文件" / "读不懂" / "文件里没有这一条" / "这条读不出字符串"
//     **四个读数互不相等**——塌成一个值就会让"读不懂"看起来像"没有"；
//   · 诊断里有 key 名、没有值（用一把显然假的钥匙钉住）；
//   · **只读**：读完之后文件逐字节不变；
//   · 条件交叉核对：只要 `$DSH_CHECKOUT` 可达，同一批夹具会喂给 DSH 真的
//     `parseCredentialsDocument`，验"本读取器接受的，DSH 一定也接受，
//     而且解析结果逐字段相同"。这是防漂移的那一半——少了它，子集读取器
//     可以一直自洽地错下去。
//
// ## 测试形状纪律
//
//   · 断言**具名码字面量**，不用 `[...].includes(code)`，也不写"它抛了"；
//   · 接受类用例断言**解析结果**，不接受"没抛错"；
//   · 「四个读数不同」同时断言**相等的那两处也相等**（两个 null 都是 null），
//     否则一条"永远返回不同值"的实现也能绿；
//   · 交叉核对的期望值（DSH 会接受还是会拒绝）是**实测记录**，不是推的。
// ============================================================================

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DSH_CREDENTIALS_CODES,
  DSH_CREDENTIALS_FILENAME,
  DSH_CREDENTIALS_SOURCE,
  createDshCredentialsSource,
  parseDshCredentialsDocument,
  planDshLookup,
} from './dsh-credentials.mjs'
import { SecretStoreError } from './errors.mjs'

/** 一把显然假的钥匙。**它绝不允许出现在任何诊断里。** */
const SECRET = 'sk-DO-NOT-LEAK-0123456789'
const OTHER_SECRET = 'sk-ALSO-FAKE-9876543210'

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：接受面
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 每一栏是 `{name, text, expect}`；`expect` 是**期望的解析结果**本身
 * （不是"没抛错"）。这些夹具同时喂给下面的 DSH 交叉核对。
 */
const ACCEPTS = [
  {
    name: '空文档（DSH 的空库）',
    text: '',
    expect: { refs: {}, records: {} },
  },
  {
    name: '只有注释与空行（含缩进的整行注释）',
    text: '# 只有注释\n\n   # 缩进的注释也是注释\n',
    expect: { refs: {}, records: {} },
  },
  {
    name: 'refs：单个 POSIX 标识符 → 非空字符串',
    text: `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${SECRET}\n`,
    expect: { refs: { DEEPSEEK_API_KEY: SECRET }, records: {} },
  },
  {
    name: 'refs 段在但一条都没有（DSH 的空段）',
    text: 'version: 1\nrefs:\n',
    expect: { refs: {}, records: {} },
  },
  {
    name: '只有 version',
    text: 'version: 1\n',
    expect: { refs: {}, records: {} },
  },
  {
    name: 'null 根（`~`）也是空库',
    text: '~\n',
    expect: { refs: {}, records: {} },
  },
  {
    name: 'records：api-key 带 key 与 env',
    text: `version: 1\nrecords:\n  deepseek/main:\n    kind: api-key\n    key: ${SECRET}\n    env:\n      DEEPSEEK_API_KEY: ${OTHER_SECRET}\n`,
    expect: {
      refs: {},
      records: { 'deepseek/main': { kind: 'api-key', key: SECRET, env: { DEEPSEEK_API_KEY: OTHER_SECRET } } },
    },
  },
  {
    name: 'records：api-key 只有 env',
    text: `version: 1\nrecords:\n  deepseek/main:\n    kind: api-key\n    env:\n      DEEPSEEK_API_KEY: ${SECRET}\n`,
    expect: { refs: {}, records: { 'deepseek/main': { kind: 'api-key', env: { DEEPSEEK_API_KEY: SECRET } } } },
  },
  {
    name: 'records：api-key 裸记录（字段全可选）',
    text: 'version: 1\nrecords:\n  deepseek/main:\n    kind: api-key\n',
    expect: { refs: {}, records: { 'deepseek/main': { kind: 'api-key' } } },
  },
  {
    name: 'records：grant 的嵌套 payload（映射/序列/标量各种类型）',
    text: 'version: 1\nrecords:\n  legion/g:\n    kind: grant\n    payload:\n'
      + '      a: 1\n      b:\n        - x\n        - y\n      c: null\n      d: true\n      e: plain string\n      f: 42\n',
    expect: {
      refs: {},
      records: {
        'legion/g': {
          kind: 'grant',
          payload: { a: 1, b: ['x', 'y'], c: null, d: true, e: 'plain string', f: 42 },
        },
      },
    },
  },
  {
    name: 'records：grant 的 payload 为 null（键在、值为 null）',
    text: 'version: 1\nrecords:\n  legion/g:\n    kind: grant\n    payload:\n',
    expect: { refs: {}, records: { 'legion/g': { kind: 'grant', payload: null } } },
  },
  {
    name: 'records：grant 的 payload 是标量',
    text: 'version: 1\nrecords:\n  legion/g:\n    kind: grant\n    payload: 42\n',
    expect: { refs: {}, records: { 'legion/g': { kind: 'grant', payload: 42 } } },
  },
  {
    name: '值写在下一行（缩进标量）',
    text: 'version: 1\nrecords:\n  legion/g:\n    kind: grant\n    payload:\n      42\n',
    expect: { refs: {}, records: { 'legion/g': { kind: 'grant', payload: 42 } } },
  },
  {
    name: '行尾注释：注释不是值的一部分',
    text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-real # 2026-01 轮换过\n',
    expect: { refs: { DEEPSEEK_API_KEY: 'sk-real' }, records: {} },
  },
  {
    name: 'CRLF 行尾（Windows 上的常态）',
    text: 'version: 1\r\nrefs:\r\n  DEEPSEEK_API_KEY: sk-x\r\n',
    expect: { refs: { DEEPSEEK_API_KEY: 'sk-x' }, records: {} },
  },
  {
    name: 'version: 1.0（数字 1.0 就是 1，DSH 同样接受）',
    text: 'version: 1.0\nrefs:\n  DEEPSEEK_API_KEY: sk-x\n',
    expect: { refs: { DEEPSEEK_API_KEY: 'sk-x' }, records: {} },
  },
  {
    name: '值里有空格（DSH 自己就会写出这种形状）',
    text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: a  b\n',
    expect: { refs: { DEEPSEEK_API_KEY: 'a  b' }, records: {} },
  },
  {
    name: 'YAML 1.2 里仍是字符串的那些拼法（yes / 1_000 / 日期 / 点冒号…）',
    text: 'version: 1\nrefs:\n  A: .x\n  B: =x\n  C: +x\n  D: 1_000\n  E: 2026-01-01\n'
      + '  F: yes\n  G: abc:def\n  H: a#b\n  I: a,b\n',
    // `-x` 是**刻意不含**的：`-` 是 YAML 的首位指示符，本读取器拒绝它
    // （DSH 读成字符串）。那一条属于下面的"从严清单"。
    expect: {
      refs: { A: '.x', B: '=x', C: '+x', D: '1_000', E: '2026-01-01', F: 'yes', G: 'abc:def', H: 'a#b', I: 'a,b' },
      records: {},
    },
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：拒绝面
// ═══════════════════════════════════════════════════════════════════════════
//
// `dsh` 一栏是**实测记录**：`refuse` = DSH 也拒绝；`accept` = DSH 接受而
// 本读取器**刻意更严**（拒绝）。子集关系因此是单向的：
// **本读取器接受的，DSH 一定接受**；反过来不成立，而这不成立的地方
// 正是"读不懂就拒绝"这条纪律在起作用的地方。
const REFUSALS = [
  // ── 版本与顶层 ──
  { name: 'version 不是 1', text: 'version: 2\n', code: 'DSH_CREDENTIALS_BAD_VERSION', dsh: 'refuse' },
  { name: 'version 是字符串 "1"', text: 'version: "1"\nrefs:\n  A: sk-x\n', code: 'DSH_CREDENTIALS_QUOTED_SCALAR', dsh: 'refuse' },
  { name: '非空文档缺 version', text: 'A: sk-x\n', code: 'DSH_CREDENTIALS_NO_VERSION', dsh: 'refuse' },
  { name: '未知的顶层键', text: 'version: 1\nzz: 1\n', code: 'DSH_CREDENTIALS_UNKNOWN_TOP_KEY', dsh: 'refuse' },
  { name: '根是标量', text: 'hello\n', code: 'DSH_CREDENTIALS_ROOT_NOT_MAPPING', dsh: 'refuse' },
  { name: '根是序列', text: '- a\n', code: 'DSH_CREDENTIALS_ROOT_IS_SEQUENCE', dsh: 'refuse' },
  { name: 'refs 段的键被引号包住', text: 'version: 1\nrefs:\n  "A": sk-x\n', code: 'DSH_CREDENTIALS_QUOTED_SCALAR', dsh: 'accept' },

  // ── 词法：本读取器不承认的 YAML 特性 ──
  { name: '制表符缩进', text: 'version: 1\nrefs:\n\tDEEPSEEK_API_KEY: sk-x\n', code: 'DSH_CREDENTIALS_TAB_INDENT', dsh: 'refuse' },
  // 制表符**任何位置**都拒绝（不只缩进位）：DSH 自己只在缩进位报错，
  // 所以"注释行里的制表符"这一条属于从严清单。少判一次 tab 的位置语义，
  // 换来的是一条不需要证明的规则。
  { name: '制表符出现在注释行里', text: 'version: 1\nrefs:\n  A: sk-x\n\t# 缩进的注释\n', code: 'DSH_CREDENTIALS_TAB_INDENT', dsh: 'accept' },
  { name: '缩进不是 2 的倍数', text: 'version: 1\nrefs:\n   DEEPSEEK_API_KEY: sk-x\n', code: 'DSH_CREDENTIALS_BAD_INDENT', dsh: 'accept' },
  { name: '缩进 4（不是 DSH 写出来的那种）', text: 'version: 1\nrefs:\n    DEEPSEEK_API_KEY: sk-x\n', code: 'DSH_CREDENTIALS_BAD_INDENT', dsh: 'accept' },
  { name: '文档指令 %YAML', text: '%YAML 1.2\n---\nversion: 1\nrefs:\n  A: sk-x\n', code: 'DSH_CREDENTIALS_DIRECTIVE', dsh: 'accept' },
  { name: '文档开始标记 ---', text: '---\nversion: 1\n', code: 'DSH_CREDENTIALS_DOCUMENT_MARKER', dsh: 'accept' },
  { name: '文档结束标记 ...', text: 'version: 1\nrefs:\n  A: sk-x\n...\n', code: 'DSH_CREDENTIALS_DOCUMENT_MARKER', dsh: 'accept' },
  { name: '锚点 &', text: 'version: 1\nrefs:\n  A: &x sk-a\n', code: 'DSH_CREDENTIALS_ANCHOR', dsh: 'accept' },
  { name: '别名 *', text: 'version: 1\nrefs:\n  A: *x\n', code: 'DSH_CREDENTIALS_ALIAS', dsh: 'refuse' },
  { name: '标签 !!str', text: 'version: 1\nrefs:\n  A: !!str 42\n', code: 'DSH_CREDENTIALS_TAG', dsh: 'accept' },
  { name: '多行标量（字面块 |）', text: 'version: 1\nrefs:\n  A: |\n    sk-a\n', code: 'DSH_CREDENTIALS_BLOCK_SCALAR', dsh: 'accept' },
  { name: '多行标量（折叠块 >）', text: 'version: 1\nrefs:\n  A: >\n    sk-a\n', code: 'DSH_CREDENTIALS_BLOCK_SCALAR', dsh: 'accept' },
  { name: '单引号标量', text: "version: 1\nrefs:\n  A: 'sk-a'\n", code: 'DSH_CREDENTIALS_QUOTED_SCALAR', dsh: 'accept' },
  { name: '双引号标量', text: 'version: 1\nrefs:\n  A: "42"\n', code: 'DSH_CREDENTIALS_QUOTED_SCALAR', dsh: 'accept' },
  { name: '流式序列', text: 'version: 1\nrefs:\n  A: [1, 2]\n', code: 'DSH_CREDENTIALS_FLOW_STYLE', dsh: 'refuse' },
  { name: '流式映射', text: 'version: 1\nrefs:\n  A: {a: b}\n', code: 'DSH_CREDENTIALS_FLOW_STYLE', dsh: 'refuse' },
  { name: '值里出现行内嵌套映射', text: 'version: 1\nrefs:\n  A: a: b\n', code: 'DSH_CREDENTIALS_INLINE_MAPPING', dsh: 'refuse' },
  { name: '序列项从行内开始一个映射', text: 'version: 1\nrecords:\n  legion/g:\n    kind: grant\n    payload:\n      - k: v\n', code: 'DSH_CREDENTIALS_INLINE_MAPPING', dsh: 'accept' },
  { name: '同一层既有映射项又有序列项', text: 'version: 1\nrefs:\n  A: x\n  - y\n', code: 'DSH_CREDENTIALS_MIXED_BLOCK', dsh: 'refuse' },
  { name: '不成项的行（没有分隔冒号）', text: 'version: 1\nrefs:\n  A: x\n  nocolon\n', code: 'DSH_CREDENTIALS_BAD_ENTRY', dsh: 'refuse' },
  // 值以 YAML 的 c-indicator 开头（`-` 是其中之一）。这一条代表**一整类**
  // 从严：`- ? : , @` 开头的标量在 YAML 里仍是普通标量（DSH 读成字符串），
  // 而本读取器拒绝它们，因为判"这个符号是内容还是结构"正是本读取器
  // 刻意不做的那件事。夹具只取一个样本，完整的边界写在文档 §2.3/§7。
  { name: '值以 c-indicator 开头（-x）', text: 'version: 1\nrefs:\n  A: -x\n', code: 'DSH_CREDENTIALS_UNSAFE_CHARACTER', dsh: 'accept' },

  // ── refs 段 ──
  { name: 'refs 段不是映射（标量）', text: 'version: 1\nrefs: 3\n', code: 'DSH_CREDENTIALS_SECTION_NOT_MAPPING', dsh: 'refuse' },
  { name: 'refs 段不是映射（序列）', text: 'version: 1\nrefs:\n  - a\n', code: 'DSH_CREDENTIALS_SECTION_NOT_MAPPING', dsh: 'refuse' },
  { name: 'refs 的键不是 POSIX 标识符', text: 'version: 1\nrefs:\n  a/b: sk-x\n', code: 'DSH_CREDENTIALS_REF_KEY_INVALID', dsh: 'refuse' },
  { name: 'refs 的值为空（`A:`）', text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY:\n', code: 'DSH_CREDENTIALS_REF_VALUE_MISSING', dsh: 'refuse' },
  { name: 'refs 的值不是字符串（数字）', text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: 42\n', code: 'DSH_CREDENTIALS_REF_VALUE_NOT_STRING', dsh: 'refuse' },
  { name: 'refs 的值不是字符串（布尔）', text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: true\n', code: 'DSH_CREDENTIALS_REF_VALUE_NOT_STRING', dsh: 'refuse' },
  { name: 'refs 的值不是字符串（null）', text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: null\n', code: 'DSH_CREDENTIALS_REF_VALUE_NOT_STRING', dsh: 'refuse' },
  { name: 'refs 的值不是字符串（十六进制）', text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: 0x1f\n', code: 'DSH_CREDENTIALS_REF_VALUE_NOT_STRING', dsh: 'refuse' },
  { name: 'refs 里重复的键', text: 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-a\n  DEEPSEEK_API_KEY: sk-b\n', code: 'DSH_CREDENTIALS_DUPLICATE_KEY', dsh: 'refuse' },

  // ── records 段 ──
  { name: 'record 的键不是 <scope>/<id>（没有斜杠）', text: 'version: 1\nrecords:\n  nokey:\n    kind: api-key\n', code: 'DSH_CREDENTIALS_RECORD_KEY_INVALID', dsh: 'refuse' },
  { name: 'record 的键是三段', text: 'version: 1\nrecords:\n  a/b/c:\n    kind: api-key\n', code: 'DSH_CREDENTIALS_RECORD_KEY_INVALID', dsh: 'refuse' },
  { name: 'record 的键有大写段', text: 'version: 1\nrecords:\n  a/B:\n    kind: api-key\n', code: 'DSH_CREDENTIALS_RECORD_KEY_INVALID', dsh: 'refuse' },
  { name: 'record 不是映射', text: 'version: 1\nrecords:\n  a/b: 3\n', code: 'DSH_CREDENTIALS_RECORD_NOT_MAPPING', dsh: 'refuse' },
  { name: 'record 缺 kind', text: 'version: 1\nrecords:\n  a/b:\n    key: sk-x\n', code: 'DSH_CREDENTIALS_RECORD_NO_KIND', dsh: 'refuse' },
  { name: 'record 的 kind 未知', text: 'version: 1\nrecords:\n  a/b:\n    kind: other\n', code: 'DSH_CREDENTIALS_RECORD_UNKNOWN_KIND', dsh: 'refuse' },
  { name: 'record 的 kind 不是字符串', text: 'version: 1\nrecords:\n  a/b:\n    kind: 42\n', code: 'DSH_CREDENTIALS_RECORD_UNKNOWN_KIND', dsh: 'refuse' },
  { name: 'record 多了一个字段', text: 'version: 1\nrecords:\n  a/b:\n    kind: api-key\n    nope: 1\n', code: 'DSH_CREDENTIALS_RECORD_UNKNOWN_FIELD', dsh: 'refuse' },
  { name: 'grant 缺 payload', text: 'version: 1\nrecords:\n  a/b:\n    kind: grant\n', code: 'DSH_CREDENTIALS_GRANT_PAYLOAD_MISSING', dsh: 'refuse' },
  { name: 'grant 的 payload 不是 JSON（.inf）', text: 'version: 1\nrecords:\n  a/b:\n    kind: grant\n    payload:\n      at: .inf\n', code: 'DSH_CREDENTIALS_PAYLOAD_NOT_JSON', dsh: 'refuse' },
  { name: 'api-key 的 key 为空', text: 'version: 1\nrecords:\n  a/b:\n    kind: api-key\n    key:\n', code: 'DSH_CREDENTIALS_API_KEY_VALUE_INVALID', dsh: 'refuse' },
  { name: 'record 的字段重复', text: 'version: 1\nrecords:\n  a/b:\n    kind: grant\n    payload: 1\n    payload: 2\n', code: 'DSH_CREDENTIALS_DUPLICATE_KEY', dsh: 'refuse' },
  { name: 'env 不是映射', text: 'version: 1\nrecords:\n  a/b:\n    kind: api-key\n    env: 3\n', code: 'DSH_CREDENTIALS_ENV_NOT_MAPPING', dsh: 'refuse' },
  { name: 'env 的名字不是 POSIX 标识符', text: 'version: 1\nrecords:\n  a/b:\n    kind: api-key\n    env:\n      bad.name: x\n', code: 'DSH_CREDENTIALS_ENV_NAME_INVALID', dsh: 'refuse' },
  { name: 'env 的值为空', text: 'version: 1\nrecords:\n  a/b:\n    kind: api-key\n    env:\n      DEEPSEEK_API_KEY:\n', code: 'DSH_CREDENTIALS_ENV_VALUE_INVALID', dsh: 'refuse' },
]

/** 把一个节点的值折成可比的普通对象。 */
function shape(document) {
  return {
    refs: Object.fromEntries([...document.refs.entries()].sort()),
    records: Object.fromEntries([...document.records.entries()].sort()),
  }
}

/** 解析并返回具名码；**接受时返回 `null`**（而不是把异常咽掉）。 */
function codeOf(text) {
  try {
    parseDshCredentialsDocument(text)
    return null
  } catch (err) {
    return typeof err?.code === 'string' ? err.code : `UNNAMED:${err?.name ?? 'Error'}`
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 接受面：逐字段
// ═══════════════════════════════════════════════════════════════════════════

describe('① 接受 DSH 写出的确切子集（逐字段断言，不是"没抛错"）', () => {
  for (const fixture of ACCEPTS) {
    test(`接受：${fixture.name}`, () => {
      assert.deepEqual(shape(parseDshCredentialsDocument(fixture.text)), fixture.expect)
    })
  }

  test('① 空文档与"只有注释"是**同一个**空库，不是两种形状', () => {
    assert.deepEqual(shape(parseDshCredentialsDocument('')), { refs: {}, records: {} })
    assert.deepEqual(
      shape(parseDshCredentialsDocument('# 注释\n')),
      shape(parseDshCredentialsDocument('')),
    )
  })

  test('① 没有任何东西返回 null 或 undefined：接受就是有值', () => {
    const doc = parseDshCredentialsDocument(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${SECRET}\n`)
    assert.equal(doc.refs.get('DEEPSEEK_API_KEY'), SECRET)
    // 反面对照：不存在的键是 undefined，而不是空串——空串会被当成"有一把空钥匙"。
    assert.equal(doc.refs.get('NOT_THERE'), undefined)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ② 拒绝面：逐条钉住具名码
// ═══════════════════════════════════════════════════════════════════════════

describe('② 拒绝子集之外的一切，且每条一个具名码', () => {
  for (const fixture of REFUSALS) {
    test(`拒绝：${fixture.name} → ${fixture.code}`, () => {
      // 断言的是**字面量**：把 DSH_CREDENTIALS_CODES 的值改掉必须让这条红。
      assert.equal(codeOf(fixture.text), fixture.code)
    })
  }

  test('② 拒绝码是 SecretStoreError，且对外码仍是 SECRET_UNAVAILABLE', async () => {
    await assert.rejects(
      async () => parseDshCredentialsDocument('version: 1\nrefs:\n  A: "sk-x"\n'),
      (err) => {
        assert.equal(err.code, 'DSH_CREDENTIALS_QUOTED_SCALAR')
        assert.equal(err.name, 'SecretStoreError')
        assert.ok(err instanceof SecretStoreError)
        // 这一族码**刻意不逐个登记**进 RUNTIME_CODE_FOR；默认分支给出的就是它。
        assert.equal(err.runtimeErrorCode, 'SECRET_UNAVAILABLE')
        assert.ok(!err.message.includes('未知的密钥库错误'), 'DSH 族的拒绝码必须有可操作的文案')
        return true
      },
    )
  })

  test('② 每一个拒绝码的值都带家族前缀（没有漏配的散码）', () => {
    const values = Object.values(DSH_CREDENTIALS_CODES)
    assert.ok(values.length > 30)
    for (const value of values) {
      assert.match(value, /^DSH_CREDENTIALS_[A-Z0-9_]+$/)
    }
    // 重复的码会让两条不同的拒绝看起来像一回事。
    assert.equal(new Set(values).size, values.length)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ③ 不泄漏值
// ═══════════════════════════════════════════════════════════════════════════

describe('③ 诊断里有 key 名、没有值', () => {
  test('③ 拒绝消息里有 key 名、**没有**那个值', () => {
    // 夹具构造：值被引号包住 → QUOTED_SCALAR，报错点在这一**值**上，
    // 因此 ref 是 key 名（这正是"能定位到哪一条、但说不出它的值"）。
    const text = `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${SECRET}"\n`
    let caught = null
    try {
      parseDshCredentialsDocument(text)
    } catch (err) {
      caught = err
    }
    assert.notEqual(caught, null, '这一份必须被拒绝')
    assert.equal(caught.code, 'DSH_CREDENTIALS_QUOTED_SCALAR')
    assert.ok(caught.message.includes('DEEPSEEK_API_KEY'), '诊断必须能指出是哪个引用名')
    for (const surface of [caught.message, String(caught), caught.stack ?? '', JSON.stringify(caught)]) {
      assert.ok(!surface.includes(SECRET), `值泄漏到了诊断里：${surface.slice(0, 80)}`)
    }
  })

  test('③ 成功读取的路径上，值只出现在 get() 的返回值里', async () => {
    // 这条才是能失败的那一条：它把 get() 之外**所有**能拿到的表面都翻一遍。
    const dir = mkdtempSync(join(tmpdir(), 'legion-dsh-leak-'))
    try {
      const file = join(dir, DSH_CREDENTIALS_FILENAME)
      writeFileSync(file, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${SECRET}\n`, 'utf8')
      const src = createDshCredentialsSource({ file })
      assert.equal((await src.get('DEEPSEEK_API_KEY')).value, SECRET)
      const surfaces = [
        JSON.stringify(await src.inspect()),
        JSON.stringify(await src.explain('DEEPSEEK_API_KEY')),
        JSON.stringify(await src.describe('DEEPSEEK_API_KEY')),
        JSON.stringify({ ...src, get: undefined, readFile: undefined }),
      ]
      for (const surface of surfaces) {
        assert.ok(!surface.includes(SECRET), `值泄漏到了诊断表面：${surface}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ④ 来源：四个读数互不相等
// ═══════════════════════════════════════════════════════════════════════════

describe('④ 只读来源：四个读数必须可分', () => {
  let dir = null
  let missingFile = null
  let goodFile = null
  let badFile = null

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'legion-dsh-cred-'))
    missingFile = join(dir, 'never-created.yaml')
    goodFile = join(dir, DSH_CREDENTIALS_FILENAME)
    badFile = join(dir, 'not-our-subset.yaml')
    writeFileSync(goodFile, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${SECRET}\n`
      + `records:\n  deepseek/main:\n    kind: api-key\n    key: ${OTHER_SECRET}\n`
      + '  legion/g:\n    kind: grant\n    payload:\n      a: 1\n'
      + '  legion/two:\n    kind: api-key\n    env:\n      A: sk-1\n      B: sk-2\n', 'utf8')
    // 引号是 YAML 的一个特性，本读取器不认——于是这一份整份被拒绝。
    writeFileSync(badFile, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${SECRET}"\n`, 'utf8')
  })

  after(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
  })

  const srcOf = (file) => createDshCredentialsSource({ file })

  test('④ 「没有文件」：state=absent、get=null、reason=no-file', async () => {
    const src = srcOf(missingFile)
    assert.equal(src.source, DSH_CREDENTIALS_SOURCE)
    assert.deepEqual({ ...(await src.inspect()) }, {
      source: DSH_CREDENTIALS_SOURCE, file: missingFile, state: 'absent', code: null, refs: 0, records: 0,
    })
    assert.equal(await src.get('DEEPSEEK_API_KEY'), null)
    assert.equal((await src.explain('DEEPSEEK_API_KEY')).reason, 'no-file')
  })

  test('④ 「文件里没有这一条」：state=loaded、get=null、reason=absent', async () => {
    const src = srcOf(goodFile)
    const reading = await src.inspect()
    assert.equal(reading.state, 'loaded')
    assert.equal(reading.code, null)
    assert.equal(reading.refs, 1)
    assert.equal(reading.records, 3)
    assert.equal(await src.get('NOT_THERE'), null)
    assert.equal((await src.explain('NOT_THERE')).reason, 'absent')
  })

  test('④ 「读不懂」：get 拒绝并给出**那个**解析码，state=unrecognized', async () => {
    const src = srcOf(badFile)
    assert.equal((await src.inspect()).state, 'unrecognized')
    assert.equal((await src.inspect()).code, 'DSH_CREDENTIALS_QUOTED_SCALAR')
    await assert.rejects(() => src.get('DEEPSEEK_API_KEY'), (e) => e.code === 'DSH_CREDENTIALS_QUOTED_SCALAR')
    await assert.rejects(() => src.explain('DEEPSEEK_API_KEY'), (e) => e.code === 'DSH_CREDENTIALS_QUOTED_SCALAR')
  })

  test('④ ★ 三个读数**互相不同**：没有文件 ≠ 没有这条 ≠ 读不懂', async () => {
    const missing = srcOf(missingFile)
    const good = srcOf(goodFile)
    const bad = srcOf(badFile)

    const stateOf = async (src) => (await src.inspect()).state
    const reasonOf = async (src) => (await src.explain('NOT_THERE').catch((e) => `throws:${e.code}`))

    // 两个"没有值"的地方**确实相等**——否则"永远返回不同值"的假实现也能绿。
    assert.equal(await missing.get('NOT_THERE'), await good.get('NOT_THERE'))
    // 但它们的**读数**必须不同。
    assert.notEqual(await stateOf(missing), await stateOf(good))
    assert.notEqual(await reasonOf(missing), await reasonOf(good))
    // 第三个读数（读不懂）与两者都不同，而且它**不是**一个 null。
    assert.notEqual(await stateOf(bad), await stateOf(missing))
    assert.notEqual(await stateOf(bad), await stateOf(good))
    assert.match(await reasonOf(bad), /^throws:DSH_CREDENTIALS_QUOTED_SCALAR$/)
  })

  test('④ 读不出来（EACCES）与"没有文件"、与"读不懂"都不同', async () => {
    const src = createDshCredentialsSource({
      file: goodFile,
      readFile: async () => {
        throw Object.assign(new Error('拒绝访问：C:\\Users\\someone'), { code: 'EACCES' })
      },
    })
    const reading = await src.inspect()
    assert.equal(reading.state, 'unreadable')
    assert.equal(reading.code, 'DSH_CREDENTIALS_UNREADABLE')
    await assert.rejects(() => src.get('DEEPSEEK_API_KEY'), (e) => e.code === 'DSH_CREDENTIALS_UNREADABLE')
    // 底层 message 里的路径**不许**冒出来（它可能带账户名）。
    const err = await src.get('DEEPSEEK_API_KEY').catch((e) => e)
    assert.ok(!err.message.includes('someone'))
  })

  test('④ 「不能寻址」既不是"没有文件"也不是"文件里没有这条"', async () => {
    const src = srcOf(goodFile)
    // Legion 的引用名允许三段（`a/b/c`），DSH 的 records 键**恰好两段**：
    // 这条引用在 DSH 里根本不可能存在，因此必须与"查了没有"分开报。
    assert.equal((await src.explain('a/b/c')).reason, 'not-addressable')
    assert.equal(await src.get('a/b/c'), null)
    assert.notEqual((await src.explain('a/b/c')).reason, (await src.explain('NOT_THERE')).reason)
    // 连字符引用名没有斜杠，但 `-` 不在 DSH 的 refs 语法里。
    assert.equal((await src.explain('sk-no')).reason, 'not-addressable')
    assert.equal(await src.get('sk-no'), null)
  })

  test('④ 解析出值：形状与 store.get 同形，外加 source', async () => {
    const src = srcOf(goodFile)
    const record = await src.get('DEEPSEEK_API_KEY')
    assert.deepEqual(Object.keys(record).sort(), ['ref', 'resolvedAt', 'source', 'value'])
    assert.equal(record.ref, 'DEEPSEEK_API_KEY')
    assert.equal(record.value, SECRET)
    assert.equal(record.source, DSH_CREDENTIALS_SOURCE)
    assert.match(record.resolvedAt, /^\d{4}-\d{2}-\d{2}T/)
    // records 空间：api-key 的 `key` 优先于 env。
    assert.equal((await src.get('deepseek/main')).value, OTHER_SECRET)
  })

  test('④ 只有一条 env 时用它；两条就是**没有唯一答案**，具名拒绝', async () => {
    const src = srcOf(goodFile)
    const single = createDshCredentialsSource({
      file: join(dir, 'single-env.yaml'),
      readFile: async () => `version: 1\nrecords:\n  legion/one:\n    kind: api-key\n    env:\n      A: ${SECRET}\n`,
    })
    assert.equal((await single.get('legion/one')).value, SECRET)
    // 两条 env 且没有 `key`：挑一条就是编一个用户没选过的凭证。
    await assert.rejects(() => src.get('legion/two'), (e) => e.code === 'DSH_CREDENTIALS_RECORD_VALUE_AMBIGUOUS')
    assert.equal((await src.explain('legion/two')).reason, 'record-ambiguous')
  })

  test('④ grant 记录**读不出一把字符串钥匙**：具名拒绝，不是"没有"', async () => {
    const src = srcOf(goodFile)
    await assert.rejects(() => src.get('legion/g'), (e) => e.code === 'DSH_CREDENTIALS_RECORD_NOT_A_STRING')
    assert.equal((await src.explain('legion/g')).reason, 'record-not-a-string')
  })

  test('④ describe() 给出文件修改时间作为版本；没有这条就是 null', async () => {
    const src = createDshCredentialsSource({
      file: goodFile,
      stat: async () => ({ mtimeMs: 1_700_000_000_123 }),
    })
    assert.deepEqual({ ...(await src.describe('DEEPSEEK_API_KEY')) }, {
      ref: 'DEEPSEEK_API_KEY',
      source: DSH_CREDENTIALS_SOURCE,
      updatedAt: new Date(1_700_000_000_123).toISOString(),
    })
    assert.equal(await src.describe('NOT_THERE'), null)
    // grant 记录描述不出一个"可用的凭证版本"。
    assert.equal(await src.describe('legion/g'), null)
    // 版本取不到时**不编时间**：桩掉 stat。
    const noStat = createDshCredentialsSource({
      file: goodFile,
      stat: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) },
    })
    assert.equal(await noStat.describe('DEEPSEEK_API_KEY'), null)
  })

  test('④ 引用名非法：报 Legion 自己的 SECRET_REF_INVALID（不是 DSH 的码）', async () => {
    const src = srcOf(goodFile)
    await assert.rejects(() => src.get('..'), (e) => e.code === 'SECRET_REF_INVALID')
    await assert.rejects(() => src.get('a//b'), (e) => e.code === 'SECRET_REF_INVALID')
    await assert.rejects(() => src.get(42), (e) => e.code === 'SECRET_REF_INVALID')
  })

  test('④ ★ 只读：读完之后文件逐字节不变', async () => {
    const before = readFileSync(goodFile, 'utf8')
    const src = srcOf(goodFile)
    await src.get('DEEPSEEK_API_KEY')
    await src.get('deepseek/main')
    await src.explain('legion/g')
    await src.describe('DEEPSEEK_API_KEY')
    await src.inspect()
    await src.get('NOT_THERE').catch(() => null)
    assert.equal(readFileSync(goodFile, 'utf8'), before)
  })

  test('④ inspect/explain 的输出里没有值（对**真文件**验一遍）', async () => {
    const src = srcOf(goodFile)
    const surfaces = [
      JSON.stringify(await src.inspect()),
      JSON.stringify(await src.explain('DEEPSEEK_API_KEY')),
      JSON.stringify(await src.describe('DEEPSEEK_API_KEY')),
    ]
    for (const surface of surfaces) {
      assert.ok(!surface.includes(SECRET), `值泄漏进了诊断：${surface}`)
      assert.ok(!surface.includes(OTHER_SECRET), `值泄漏进了诊断：${surface}`)
    }
  })

  test('④ 每次调用都真的去读一次文件（不缓存明文）', async () => {
    let reads = 0
    const src = createDshCredentialsSource({
      file: join(dir, 'counter.yaml'),
      readFile: async () => {
        reads += 1
        return `version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-${reads}\n`
      },
    })
    assert.equal((await src.get('DEEPSEEK_API_KEY')).value, 'sk-1')
    assert.equal((await src.get('DEEPSEEK_API_KEY')).value, 'sk-2')
    assert.equal(reads, 2)
  })

  test('④ 构造参数是硬要求：没有 file 就不构造', () => {
    assert.throws(() => createDshCredentialsSource({}), TypeError)
    assert.throws(() => createDshCredentialsSource({ file: '' }), TypeError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 寻址语法
// ═══════════════════════════════════════════════════════════════════════════

describe('⑤ 引用名 → DSH 键空间', () => {
  test('⑤ 没有斜杠 → refs；有斜杠且恰好两段小写 → records；其余不可寻址', () => {
    assert.deepEqual({ ...planDshLookup('DEEPSEEK_API_KEY') }, { addressable: true, space: 'refs' })
    assert.deepEqual({ ...planDshLookup('deepseek/main') }, { addressable: true, space: 'records' })
    // 单段但含 `-`：Legion 允许，DSH 的 refs 语法不允许。
    assert.deepEqual({ ...planDshLookup('sk-no') }, { addressable: false, space: null })
    // 三段：Legion 允许，DSH 的 records 恰好两段。
    assert.deepEqual({ ...planDshLookup('a/b/c') }, { addressable: false, space: null })
    // 大写段 / 下划线段：DSH 的键段语法是小写连字符标识符。
    assert.deepEqual({ ...planDshLookup('a/B') }, { addressable: false, space: null })
    assert.deepEqual({ ...planDshLookup('a/b_c') }, { addressable: false, space: null })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 与 DSH 真的解析器交叉核对（条件：$DSH_CHECKOUT）
// ═══════════════════════════════════════════════════════════════════════════
//
// 这一段是这份读取器**唯一**能防"自己和自己一致地错"的东西：
//   · 本读取器接受的 → DSH 必须也接受，且解析结果逐字段相同；
//   · 那份"我们拒绝、DSH 接受"的清单是**实测**出来的：它证明从严是
//     刻意的一小片，而不是到处都是。

const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? null
const DSH_PARSER = DSH_CHECKOUT === null
  ? null
  : join(DSH_CHECKOUT, 'packages', 'credentials', 'credentials-local', 'lib', 'index.js')
const DSH_UNAVAILABLE = DSH_CHECKOUT === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(DSH_PARSER)
    ? `DSH 检出里找不到编译产物（${DSH_PARSER}）——DSH 未构建？`
    : false
const SKIP = DSH_UNAVAILABLE === false ? false : DSH_UNAVAILABLE

const guarded = (name, fn) => test(name, (t) => {
  if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
  return fn(t)
})

/** DSH 的解析器；拿不到就是 `null`，此时所有交叉核对用例逐条 skip。 */
const PARSE_DSH = SKIP === false
  ? (await import(pathToFileURL(DSH_PARSER).href)).parseCredentialsDocument
  : null

/** DSH 侧：接受时给形状，拒绝时给 `null`。 */
function dshShapeOf(text) {
  try {
    return shape(PARSE_DSH(text, '<fixture>'))
  } catch {
    return null
  }
}

// 交叉核对的用例**总是注册**（只是跑不了时逐条 skip）：这样"跑了没有"
// 在 `node --test` 的汇总里是一个数字，而不是一段需要人去读的输出。
describe('⑥ 与 DSH 的 parseCredentialsDocument 交叉核对', () => {
  test('⑥ 前提：真的拿到了 DSH 的解析器（不是拿到了 undefined）', (t) => {
    if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
    assert.equal(typeof PARSE_DSH, 'function')
  })

  for (const fixture of ACCEPTS) {
    guarded(`⑥ 本读取器接受 ⇒ DSH 接受，且结果相同：${fixture.name}`, () => {
      const ours = shape(parseDshCredentialsDocument(fixture.text))
      assert.deepEqual(ours, fixture.expect)
      const theirs = dshShapeOf(fixture.text)
      assert.notEqual(theirs, null, '本读取器接受了，DSH 却拒绝了——子集关系被破坏')
      assert.deepEqual(ours, theirs)
    })
  }

  for (const fixture of REFUSALS) {
    guarded(`⑥ 从严的边界与实测一致（${fixture.dsh}）：${fixture.name}`, () => {
      assert.equal(codeOf(fixture.text), fixture.code)
      const theirs = dshShapeOf(fixture.text)
      if (fixture.dsh === 'refuse') {
        assert.equal(theirs, null, 'DSH 应当也拒绝这一份')
      } else {
        assert.notEqual(theirs, null, '这一份是"我们从严"的样本，DSH 应当接受它')
      }
    })
  }

  test('⑥ ★ 从严清单是**有限且已知**的：我们拒绝而 DSH 接受的只有这些', (t) => {
    if (SKIP !== false) return t.skip(`SKIP：${SKIP}`)
    // 把"从严"变成一份可审阅的清单，而不是散落各处的宽容。清单变了
    // （DSH 收紧、或者我们放松）会让这条红——那是要人来看的信号。
    //
    // 注意方向：**只有**"我们拒绝、DSH 接受"进这份清单。"我们接受、
    // DSH 拒绝"是子集关系被破坏，上面两条循环已经把它判红，不在这里兜。
    const surplus = []
    for (const fixture of [...ACCEPTS, ...REFUSALS]) {
      const oursAccepts = codeOf(fixture.text) === null
      const theirsAccepts = dshShapeOf(fixture.text) !== null
      if (!oursAccepts && theirsAccepts) surplus.push(fixture.name)
    }
    const expected = [
      'refs 段的键被引号包住',
      '制表符出现在注释行里',
      '缩进不是 2 的倍数',
      '缩进 4（不是 DSH 写出来的那种）',
      '值以 c-indicator 开头（-x）',
      '文档指令 %YAML',
      '文档开始标记 ---',
      '文档结束标记 ...',
      '锚点 &',
      '标签 !!str',
      '多行标量（字面块 |）',
      '多行标量（折叠块 >）',
      '单引号标量',
      '双引号标量',
      '序列项从行内开始一个映射',
    ]
    assert.deepEqual([...surplus].sort(), [...expected].sort())
  })
})

if (SKIP !== false) {
  test('PRT-509 DSH 凭证读取器的交叉核对本次未运行', () => {
    assert.ok(true, `SKIP 原因：${SKIP}。外部解析器核对不伪造通过——跑不了就不算跑过。`)
  })
}

// security/secrets/credential-materializer.test.mjs
// ============================================================================
// PRT-509：把 Run 的冻结凭证句柄写成 DSH **读得回来**的 `.credentials.yaml`。
//
// ## 这一套件守的是什么（以及为什么第 ① 条必须长成那样）
//
//   ① ★ 往返：写出来的文件必须被 `dsh-credentials.mjs` 的**真实读取器**
//      （生产入口 `createDshCredentialsSource`，真的去读文件的那一个）读回来，
//      且值**逐字相等**。期望值来自本文件里的常量，**不来自写出器的输出**。
//   ② 不可寻址且未映射 → 具名拒绝（`REF_UNMAPPED`），不是静默跳过；
//   ③ 值不能安全表示 → 具名拒绝，且什么都没写；
//   ④ 临时文件 + `chmod(0600)` + `rename` 由**注入的 io 数出来**，不是从
//      "文件最终存在"推断的；被拒绝的调用连一次文件操作都不发生；
//   ⑤ 值不出现在任何错误消息/可枚举属性/结果序列化/描述对象里；
//   ⑥ 诚实边界：本模块里没有任何"provider → 名字"的表，也没有 DSH 进程读过
//      这些文件——两件都能被这条用例读出来，而不是只写在注释里。
//
// ## 为什么 ① 的绿**不能**由"检查自己写出的字节"换来
//
// 一个"写出去的格式符合我自己以为的格式"的用例，
// 与一个"那个文件被真正的读者读回来了"的用例，
// 在只检查自己写出的字节时是同一片绿——
// 只不过前者的绿，在读者一改键空间语法的那天照样是绿的。
//
// 所以本文件里**没有**一条用例断言"文件里应该有这几个字符"。它断言的是
// 读取器**读回来**的名字与值，以及它自己的 `inspect()` 计数。
//
// ## 测试形状纪律
//
//   · 断言**具名码字面量**，不写"它抛了"；
//   · 每个"拒绝了"的用例都同时断言**什么都没留下**（文件不存在 + 目录里没有临时残留）；
//   · 每个"没泄漏"的用例都同时断言元数据里**有**引用名/DSH 名字——否则
//     `includes(SECRET) === false` 对空字符串也是绿的；
//   · 所有临时目录都在 `after()` 里整棵删掉（`finally`/`after`，不是脚本末尾），
//     一次失败不会在 `%TEMP%` 里留下孤儿目录。
// ============================================================================

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  CREDENTIAL_MATERIALIZER_CODES,
  CREDENTIAL_MATERIALIZER_VERSION,
  CredentialMaterializerError,
  materializeRunCredentials,
} from './credential-materializer.mjs'
import {
  DSH_CREDENTIALS_FILENAME,
  DSH_CREDENTIALS_SOURCE,
  createDshCredentialsSource,
  parseDshCredentialsDocument,
  planDshLookup,
} from './dsh-credentials.mjs'
import { openRunCredentials } from './run-credentials.mjs'
import { createSecretStore, memoryBackend, nullProtector } from './store.mjs'
// 仓库自己的 env 读取点扫描器：判"这份代码读不读进程环境"的权威实现
// （`scan --check` 用的就是它），比本文件里手写的正则可信。
import { extractEnvReads } from '../../scripts/config/scan.mjs'

const CODES = CREDENTIAL_MATERIALIZER_CODES

/** 显然是假的、一次性的值。**它们绝不允许出现在任何诊断/元数据里。** */
const SECRETS = Object.freeze({
  MODEL: 'sk-test-not-a-real-model-credential',
  OPENAI: 'sk-test-not-a-real-openai-credential',
  ANTHROPIC: 'sk-test-not-a-real-anthropic-credential',
})

/** Legion 的模型引用：**三段** → `planDshLookup` 判不可寻址（本任务的核心）。 */
const MODEL_REF = 'legion/model/deepseek-chat'
/** 两段小写连字符 → DSH 的 `records` 空间（原生可寻址，不需要映射）。 */
const RECORDS_REF = 'legion/openai'
/** 无斜杠 POSIX 标识符 → DSH 的 `refs` 空间（原生可寻址）。 */
const REFS_REF = 'ANTHROPIC_API_KEY'
/**
 * 用于 `MODEL_REF` 的 DSH 那一侧的名字。**它由调用方给**，来源是 DSH 自己的声明：
 * `packages/bundle/base/cordis.patch.yml` 的 `apiKeyEnv: DEEPSEEK_API_KEY`
 * 与 `packages/llm/llm-deepseek/src/index.ts` 的 `DEFAULT_API_KEY_ENV`。
 */
const DSH_MODEL_NAME = 'DEEPSEEK_API_KEY'

const MODULE_PATH = fileURLToPath(new URL('./credential-materializer.mjs', import.meta.url))

/** 整棵夹具树。`after()` 一律删掉，**失败时也删**。 */
const ROOT = mkdtempSync(join(tmpdir(), 'legion-credmat-'))
after(() => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ } })

/**
 * 声明的 operator home：`~/.dsh`（**只做字符串比较，绝不 stat 它**）与一个
 * "自定义的 `$DSH_HOME`"（用来验"调用方注入的第二个 home 也被拒绝"）。
 */
const OPERATOR_HOMES = Object.freeze([
  join(homedir(), '.dsh'),
  join(ROOT, 'operator-dsh-home'),
])

/** 一个隔离的 Legion home：`<case>/legion-home/.credentials.yaml`。 */
function runHome(label) {
  const dir = mkdtempSync(join(ROOT, `${label}-`))
  const home = join(dir, 'legion-home')
  mkdirSync(home)
  return { dir, home, target: join(home, DSH_CREDENTIALS_FILENAME) }
}

/** 用**真实**的 store + `openRunCredentials` 造句柄（主用例都走这一条）。 */
async function handleFor(pairs) {
  const store = createSecretStore({
    backend: memoryBackend(),
    protector: nullProtector(),
    protectedRequired: false,
    now: () => '2026-09-11T00:00:00.000Z',
  })
  for (const [ref, value] of pairs) await store.put(ref, value, { purpose: 'model' })
  return openRunCredentials({ store, refs: pairs.map(([ref]) => ref), runId: 'run-1' })
}

/** 与句柄同形的假句柄：用于 store 造不出来的值（换行等）。 */
function fakeHandle(pairs) {
  const held = new Map(pairs)
  return {
    version: 1,
    runId: 'run-fake',
    resolvedAt: '2026-09-11T00:00:00.000Z',
    refs: Object.freeze([...held.keys()]),
    held: (ref) => held.has(ref),
    get: (ref) => {
      if (!held.has(ref)) throw new Error(`not held: ${ref}`)
      return held.get(ref)
    },
    describe: () => ({ version: 1, runId: 'run-fake', refs: [...held.keys()], count: held.size }),
    toJSON() { return this.describe() },
  }
}

/** **会数数**的 io 门面：把调用次序与实参记下来，再转发给真实的 `node:fs`。 */
function recordingIo() {
  const calls = []
  const wrap = (name, fn) => (...args) => { calls.push([name, ...args]); return fn(...args) }
  return {
    calls,
    realpathSync: wrap('realpathSync', realpathSync),
    openSync: wrap('openSync', openSync),
    writeSync: wrap('writeSync', writeSync),
    fsyncSync: wrap('fsyncSync', fsyncSync),
    closeSync: wrap('closeSync', closeSync),
    chmodSync: wrap('chmodSync', chmodSync),
    renameSync: wrap('renameSync', renameSync),
    unlinkSync: wrap('unlinkSync', unlinkSync),
    // ★ 退化的实现会用它直接写目标；把它摆进门面里，"没走这条路"才是个读数。
    writeFileSync: wrap('writeFileSync', writeFileSync),
  }
}

/** 碰一下就炸的 io：用来证明某条拒绝**一次文件操作都没有发生**。 */
function untouchableIo() {
  const boom = (name) => () => { throw new Error(`io.${name} 被调用了：这条拒绝必须发生在任何文件操作之前`) }
  return {
    realpathSync: boom('realpathSync'),
    openSync: boom('openSync'),
    writeSync: boom('writeSync'),
    fsyncSync: boom('fsyncSync'),
    closeSync: boom('closeSync'),
    chmodSync: boom('chmodSync'),
    renameSync: boom('renameSync'),
    unlinkSync: boom('unlinkSync'),
    writeFileSync: boom('writeFileSync'),
  }
}

/** 跑一次并断言"被具名拒绝了"，返回那个错误。 */
function expectRefusal(fn, why) {
  let caught = null
  try { fn() } catch (e) { caught = e }
  assert.notEqual(caught, null, `${why}：这次调用**没有**被拒绝`)
  assert.equal(caught instanceof CredentialMaterializerError, true,
    `${why}：拒绝不是具名的 CredentialMaterializerError（实际 ${caught?.name}: ${caught?.message}）`)
  return caught
}

/** 目录里除了给定的那几个名字以外还有别的东西吗（临时残留的判据）。 */
function strayEntries(dir, allowed) {
  return readdirSync(dir).filter((name) => !allowed.includes(name))
}

// ═══════════════════════════════════════════════ ① 往返（本套件存在的理由）

test('① ★★★★★ 写出去的文件被 Legion 的**真实读取器**读回来：值逐字相等，键空间由读者判定', async () => {
  const { home, target } = runHome('roundtrip')
  const handle = await handleFor([
    [MODEL_REF, SECRETS.MODEL],
    [RECORDS_REF, SECRETS.OPENAI],
    [REFS_REF, SECRETS.ANTHROPIC],
  ])

  const result = materializeRunCredentials({
    handle,
    targetFile: target,
    // 映射由调用方给；名字来自 DSH 自己的声明（见文件头与本文件常量注释）。
    mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home,
    operatorHomes: OPERATOR_HOMES,
  })
  assert.equal(result.version, CREDENTIAL_MATERIALIZER_VERSION)
  assert.equal(result.verified, true, '返回值必须说明这份文件被真实读者回读比对过')
  assert.equal(result.count, 3)
  assert.deepEqual(result.entries.map((e) => [e.ref, e.name, e.space]), [
    [MODEL_REF, DSH_MODEL_NAME, 'refs'],
    [RECORDS_REF, RECORDS_REF, 'records'],
    [REFS_REF, REFS_REF, 'refs'],
  ])

  // ── 真实读取器：生产入口，真的去读那个文件 ──────────────────────────
  const reader = createDshCredentialsSource({ file: target })

  const model = await reader.get(DSH_MODEL_NAME)
  assert.equal(model.value, SECRETS.MODEL, '真实读者读回来的值必须与句柄里那一份**逐字相等**')
  assert.equal(model.ref, DSH_MODEL_NAME)
  assert.equal(model.source, DSH_CREDENTIALS_SOURCE)

  assert.equal((await reader.get(REFS_REF)).value, SECRETS.ANTHROPIC)
  // records 空间：值在记录的 `key` 字段里被读出来（DSH 的第二条通路）
  assert.equal((await reader.get(RECORDS_REF)).value, SECRETS.OPENAI)

  const state = await reader.inspect()
  assert.deepEqual(
    { state: state.state, refs: state.refs, records: state.records },
    { state: 'loaded', refs: 2, records: 1 },
    '读者的文件层读数：它确实把这份文档当**认得**的东西读了',
  )

  // ★ 核心：Legion 自己的引用名在 DSH 眼里**不可寻址**——这正是必须有映射的原因。
  //   注意这条读数是读者的答案，不是我们描述的。
  assert.equal(await reader.get(MODEL_REF), null)
  assert.deepEqual(await reader.explain(MODEL_REF), {
    ref: MODEL_REF, source: DSH_CREDENTIALS_SOURCE, found: false, reason: 'not-addressable',
  })

  // 另一个真实入口（纯解析）必须给出同一份答案：两个入口不存在"一个读得回、一个读岔"。
  const parsed = parseDshCredentialsDocument(readFileSync(target, 'utf8'))
  assert.equal(parsed.refs.get(DSH_MODEL_NAME), SECRETS.MODEL)
  assert.equal(parsed.refs.get(REFS_REF), SECRETS.ANTHROPIC)
  assert.equal(parsed.records.get(RECORDS_REF).key, SECRETS.OPENAI)
  assert.equal(parsed.records.get(RECORDS_REF).kind, 'api-key')

  // 往返的绿不是靠把值记进返回值换来的（另一半在 ⑤，那里连错误对象一起查）
  assert.equal(JSON.stringify(result).includes(SECRETS.MODEL), false)
})

test('① ★★★★ 反向交叉核对：写出器 → **DSH 自己的 parseCredentialsDocument**（$DSH_CHECKOUT 可达时才跑）', {
  skip: process.env.DSH_CHECKOUT === undefined || process.env.DSH_CHECKOUT === ''
    ? '未配置 DSH_CHECKOUT：本机看不到 DSH 的编译产物，"DSH 自己读得回来"这一步就跳过了——'
      + '注意跳过的是这**一半**，Legion 的真实读取器那一半（上一条）在任何机器上都跑'
    : false,
}, async (t) => {
  // 与 `dsh-credentials.test.mjs` 的交叉核对走同一个入口（DSH 的编译产物）。
  const parserPath = join(process.env.DSH_CHECKOUT, 'packages', 'credentials', 'credentials-local', 'lib', 'index.js')
  if (!existsSync(parserPath)) {
    return t.skip('DSH_CHECKOUT 可达，但编译产物不在预期路径（先 pnpm build）——跳过，而不是假装通过')
  }
  const { parseCredentialsDocument } = await import(pathToFileURL(parserPath).href)

  const { home, target } = runHome('dsh-parser')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL], [RECORDS_REF, SECRETS.OPENAI]])
  materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  })

  // ★ 读的人换成 **DSH 自己**：同一个文件、同一个值，两个实现必须给出同一个答案。
  const document = parseCredentialsDocument(readFileSync(target, 'utf8'), DSH_CREDENTIALS_FILENAME)
  assert.equal(document.refs.get(DSH_MODEL_NAME), SECRETS.MODEL)
  assert.equal(document.records.get(RECORDS_REF)?.key, SECRETS.OPENAI)
  assert.equal(document.records.get(RECORDS_REF)?.kind, 'api-key')
  return undefined
})

test('① ★★★ 键空间实测口径：三段的 legion/model/<id> 在两个空间都不可寻址', () => {
  // 这三条不是"我们以为"，是读者自己的寻址函数在跑。
  assert.deepEqual(planDshLookup(MODEL_REF), { addressable: false, space: null })
  assert.deepEqual(planDshLookup(DSH_MODEL_NAME), { addressable: true, space: 'refs' })
  assert.deepEqual(planDshLookup(RECORDS_REF), { addressable: true, space: 'records' })
})

test('① ★★★ 合法但"不好看"的值必须被接受并原样读回来（拒绝不能退化成"什么都拒"）', async () => {
  const { home, target } = runHome('ugly-values')
  // 内部空格、`+ / =`、`~ @ ,`、`. _ -` 都在子集里，读者原样保留。
  const ugly = 'sk-test+a/b=c~d@e,f_g.h-7'
  const spaced = 'sk test value'
  const handle = fakeHandle([[MODEL_REF, ugly], [RECORDS_REF, spaced]])
  materializeRunCredentials({
    handle,
    targetFile: target,
    mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home,
    operatorHomes: OPERATOR_HOMES,
  })
  const reader = createDshCredentialsSource({ file: target })
  assert.equal((await reader.get(DSH_MODEL_NAME)).value, ugly)
  assert.equal((await reader.get(RECORDS_REF)).value, spaced, '内部空格是内容，不是分隔符')
})

// ═══════════════════════════════════════════════ ② 不可寻址 → 具名拒绝

test('② ★★★★ 持有但既不可寻址又没映射 → REF_UNMAPPED（具名拒绝，不是静默丢掉）', async () => {
  const { home, target } = runHome('unmapped')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL], [REFS_REF, SECRETS.ANTHROPIC]])

  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: target, mapping: {}, allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '三段 Legion 引用 + 空映射')

  assert.equal(caught.code, CODES.REF_UNMAPPED)
  assert.equal(caught.ref, MODEL_REF)
  assert.deepEqual([...caught.unmappedRefs], [MODEL_REF], '要能看出**是哪一条**没写出去')
  assert.deepEqual([...caught.heldRefs], [MODEL_REF, REFS_REF], '要能看出句柄到底持有什么')
  assert.equal(caught.runId, 'run-1')
  assert.deepEqual(caught.notAddressable.map((x) => x.ref), [MODEL_REF])

  // ★ 一个字节都没写：文件不存在，目录里也没有临时残留。
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
})

test('② ★★★ 映射目标**自己**也不可寻址 → MAPPING_TARGET_INVALID（换了个位置还是没人读）', async () => {
  const { home, target } = runHome('bad-map-target')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])

  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: 'legion/model/other' },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '映射到一个三段名字')

  assert.equal(caught.code, CODES.MAPPING_TARGET_INVALID)
  assert.equal(caught.ref, MODEL_REF)
  assert.equal(caught.name, 'legion/model/other')
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
})

test('② ★★ 两个引用映射到同一个名字 → MAPPING_DUPLICATE（否则一个值会静默压掉另一个）', async () => {
  const { home, target } = runHome('dup-name')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL], [REFS_REF, SECRETS.ANTHROPIC]])

  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: target,
    mapping: { [MODEL_REF]: 'SHARED_KEY', [REFS_REF]: 'SHARED_KEY' },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '两个引用映射到同一个名字')

  assert.equal(caught.code, CODES.MAPPING_DUPLICATE)
  assert.equal(caught.name, 'SHARED_KEY')
  assert.deepEqual([...caught.refs], [MODEL_REF, REFS_REF])
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
})

test('② ★★ 映射形状不对 → MAPPING_INVALID，不猜', async () => {
  const { home, target } = runHome('bad-map-shape')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  const cases = [
    ['字符串', 'DEEPSEEK_API_KEY'],
    ['数组', ['DEEPSEEK_API_KEY']],
    ['名字为空', { [MODEL_REF]: '' }],
    ['名字不是字符串', { [MODEL_REF]: 42 }],
    ['键是空串', { '': 'DEEPSEEK_API_KEY' }],
  ]
  for (const [label, mapping] of cases) {
    const caught = expectRefusal(() => materializeRunCredentials({
      handle, targetFile: target, mapping, allowedRoot: home, operatorHomes: OPERATOR_HOMES,
    }), `mapping=${label}`)
    assert.equal(caught.code, CODES.MAPPING_INVALID, `mapping=${label}`)
  }
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
})

test('② ★★ 未被用到的映射条目只是元数据（多给一条不是"少写了一把钥匙"）', async () => {
  const { home, target } = runHome('unused-map')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL], [REFS_REF, SECRETS.ANTHROPIC]])
  const result = materializeRunCredentials({
    handle, targetFile: target,
    mapping: { [MODEL_REF]: DSH_MODEL_NAME, 'legion/model/never-opened': 'UNUSED_KEY' },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  })
  assert.deepEqual([...result.unusedMappingRefs], ['legion/model/never-opened'])
  // 写出去的仍然是两条（refs 空间两条），读者读得回来。
  const reader = createDshCredentialsSource({ file: target })
  assert.equal((await reader.get(DSH_MODEL_NAME)).value, SECRETS.MODEL)
  assert.equal((await reader.get(REFS_REF)).value, SECRETS.ANTHROPIC)
})

// ═══════════════════════════════════════════════ ③ 值：拒绝而不是转义

test('③ ★★★ 不能安全表示的值 → VALUE_NOT_REPRESENTABLE（具名 + 具体原因），什么都没写', () => {
  const { home, target } = runHome('bad-values')
  const numericCause = 'DSH_CREDENTIALS_REF_VALUE_NOT_STRING'
  const cases = [
    ['换行', 'sk-test\nREST-OF-LINE', 'newline'],
    ['回车', 'sk-test\rrest', 'carriage-return'],
    ['制表', 'sk-test\trest', 'tab'],
    ['其它控制字符', 'sk-test\x07rest', 'control-character'],
    ['首尾空白', ' sk-test-not-real ', 'leading-or-trailing-whitespace'],
    ['#（注释起点）', 'sk-test#frag', 'comment-indicator'],
    [': （行内映射）', 'sk-test: frag', 'inline-mapping'],
    ['行尾冒号', 'sk-test:', 'inline-mapping'],
    ['非 ASCII（CJK）', 'sk-test-凭证', 'unsafe-character'],
    ['双引号', 'sk-test"frag', 'unsafe-character'],
    ['反斜杠', 'sk-test\\frag', 'unsafe-character'],
    // 纯数字/布尔字面量能过字符集，但 YAML 会把它们读成**非字符串**——
    // 这一条由真实读者的具名码判出来（写前自校验），所以 cause 是读者的码。
    ['纯数字（YAML 读成数字）', '1234567890', numericCause],
    ['true（YAML 读成布尔）', 'true', numericCause],
  ]
  for (const [label, value, cause] of cases) {
    const handle = fakeHandle([[MODEL_REF, value]])
    const caught = expectRefusal(() => materializeRunCredentials({
      handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
      allowedRoot: home, operatorHomes: OPERATOR_HOMES,
    }), `值=${label}`)
    assert.equal(caught.code, CODES.VALUE_NOT_REPRESENTABLE, `值=${label}`)
    assert.equal(caught.cause, cause, `值=${label} 的原因类别`)
    assert.equal(caught.ref, MODEL_REF)
    assert.equal(caught.name, DSH_MODEL_NAME)
    assert.equal(String(caught.message).includes(value), false, `值=${label}：值出现在了错误消息里`)
  }
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
})

test('③ ★★ 空值/非字符串值 → VALUE_NOT_A_STRING', () => {
  const { home, target } = runHome('non-string')
  for (const [label, value, cause] of [['空串', '', 'empty'], ['数字', 42, 'not-a-string'], ['null', null, 'not-a-string']]) {
    const handle = fakeHandle([[MODEL_REF, value]])
    const caught = expectRefusal(() => materializeRunCredentials({
      handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
      allowedRoot: home, operatorHomes: OPERATOR_HOMES,
    }), `值=${label}`)
    assert.equal(caught.code, CODES.VALUE_NOT_A_STRING, `值=${label}`)
    assert.equal(caught.cause, cause, `值=${label}`)
  }
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
})

// ═══════════════════════════════════════════════ ④ 目标、模式、原子性

test('④ ★★★ 临时文件 + chmod(0600) + rename：机制由注入的 io **数出来**，不是推出来的', async () => {
  const { home, target } = runHome('atomic')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  const io = recordingIo()

  materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES, io,
  })

  const names = io.calls.map((c) => c[0])
  const opened = io.calls.find((c) => c[0] === 'openSync')
  assert.notEqual(opened, undefined, 'openSync 一次都没被调用（说明没走"临时文件"这条路）')
  assert.notEqual(opened[1], target, '临时文件不能就写目标本身——那就不是原子的')
  assert.equal(dirname(opened[1]), dirname(target), '临时文件必须与目标**同目录**（跨设备 rename 会退化成复制）')
  assert.equal(opened[2], 'wx', '临时文件必须独占创建（wx），否则并发两次写会互相盖')
  assert.equal(opened[3] & 0o777, 0o600, 'open 时就要带上 0600（chmod 是补 umask 削掉的那部分）')

  const chmod = io.calls.find((c) => c[0] === 'chmodSync')
  assert.notEqual(chmod, undefined, 'chmodSync 一次都没被调用')
  assert.equal(chmod[1], opened[1], 'chmod 作用于**临时文件**（改名之前）')
  assert.equal(chmod[2] & 0o777, 0o600)

  const renamed = io.calls.find((c) => c[0] === 'renameSync')
  assert.deepEqual([renamed[1], renamed[2]], [opened[1], target], 'rename 必须从临时文件到目标')

  // ★ 次序：chmod 必须在 rename **之前**，否则有一个"已经可见但模式还不对"的窗口。
  assert.equal(names.indexOf('chmodSync') < names.indexOf('renameSync'), true)

  const fd = io.calls.find((c) => c[0] === 'writeSync')?.[1]
  assert.equal(typeof fd, 'number')
  assert.deepEqual(io.calls.filter((c) => c[0] === 'fsyncSync').map((c) => c[1]), [fd], '落盘前必须 fsync')
  assert.deepEqual(io.calls.filter((c) => c[0] === 'closeSync').map((c) => c[1]), [fd])

  // ★ 退化的实现会直接写目标；门面里有它，"没走这条路"才是读数。
  assert.equal(names.includes('writeFileSync'), false, '不能绕过临时文件直接 writeFileSync 到目标')
  assert.equal(names.includes('unlinkSync'), false, '成功路径不需要清理临时文件')
  assert.deepEqual(strayEntries(home, [DSH_CREDENTIALS_FILENAME]), [], '留下临时文件残留')

  // 而且它确实落到了盘上（真实读取器读得回来）。
  assert.equal((await createDshCredentialsSource({ file: target }).get(DSH_MODEL_NAME)).value, SECRETS.MODEL)
})

test('④ ★★ 落盘后的文件模式是 0600', {
  // 平台说不出这件事的**理由**必须写在跳过里，而不是安静地绿过去：
  // Windows 上 Node 的 chmod 只影响只读位，stat().mode 不反映 POSIX 权限位，
  // 因此"模式是 0600"这条断言在 win32 上**证不出来**。
  // 机制那一半（chmodSync(临时文件, 0o600) 在 rename 之前）由上面那条用例在**所有平台**上数出来。
  skip: process.platform === 'win32'
    ? 'win32 无法表达 POSIX 权限位：Node 的 chmod 在 Windows 上只影响只读位，stat().mode 恒为可读写形态，'
      + '这条断言在这个平台上证不出来——跳过，而不是假装通过'
    : false,
}, async () => {
  const { home, target } = runHome('mode')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  })
  assert.equal(statSync(target).mode & 0o777, 0o600)
})

test('④ ★★★ 被拒绝的调用：没有文件、没有临时残留，而且**一次文件操作都没有发生**', async () => {
  const { home, target } = runHome('pure-refusals')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])

  const cases = [
    ['目标不是绝对路径', { targetFile: 'relative/.credentials.yaml' }, CODES.TARGET_NOT_ABSOLUTE],
    ['文件名不是 .credentials.yaml', { targetFile: join(home, 'other.yaml') }, CODES.TARGET_BASENAME],
    // ★ operator 的真实 home：**只做字符串比较，绝不 stat 它**
    ['落在 ~/.dsh 里', { targetFile: join(homedir(), '.dsh', DSH_CREDENTIALS_FILENAME) }, CODES.TARGET_IN_OPERATOR_HOME],
    ['落在注入的 $DSH_HOME 里', { targetFile: join(ROOT, 'operator-dsh-home', DSH_CREDENTIALS_FILENAME) }, CODES.TARGET_IN_OPERATOR_HOME],
    ['在 allowedRoot 之外', { targetFile: join(ROOT, 'outside-home', DSH_CREDENTIALS_FILENAME) }, CODES.TARGET_OUTSIDE_ROOT],
    ['没给 allowedRoot', { allowedRoot: undefined }, CODES.ALLOWED_ROOT_REQUIRED],
    ['allowedRoot 不是绝对路径', { allowedRoot: 'legion-home' }, CODES.ALLOWED_ROOT_REQUIRED],
    ['没声明 operator home', { operatorHomes: undefined }, CODES.OPERATOR_HOME_REQUIRED],
    ['operator home 不是绝对路径', { operatorHomes: ['relative/dsh'] }, CODES.OPERATOR_HOME_INVALID],
    ['mode 允许组访问', { mode: 0o644 }, CODES.MODE_NOT_PRIVATE],
    ['mode 允许其他人访问', { mode: 0o606 }, CODES.MODE_NOT_PRIVATE],
    ['mode 所有者都读不了', { mode: 0o000 }, CODES.MODE_NOT_PRIVATE],
    ['mode 不是数字', { mode: '600' }, CODES.MODE_NOT_PRIVATE],
    ['映射不可寻址且未映射', { mapping: {} }, CODES.REF_UNMAPPED],
  ]

  for (const [label, override, code] of cases) {
    const caught = expectRefusal(() => materializeRunCredentials({
      handle,
      targetFile: target,
      mapping: { [MODEL_REF]: DSH_MODEL_NAME },
      allowedRoot: home,
      operatorHomes: OPERATOR_HOMES,
      io: untouchableIo(),
      ...override,
    }), label)
    assert.equal(caught.code, code, label)
  }

  // ★ 不 assert "~/.dsh 下没有那个文件"：那需要 stat operator 的 .dsh，本套件绝不碰它。
  //   "一次文件操作都没有发生"由 untouchableIo 证明（它一被调用就炸，而上面每一条都报出了具名码）。
  assert.equal(existsSync(target), false)
  assert.deepEqual(readdirSync(home), [])
  // 夹具树里也没有任何临时残留（临时文件名一律带 `.tmp-`）
  assert.deepEqual(readdirSync(ROOT).filter((n) => n.includes('.tmp-')), [])
})

test('④ ★★ 目标的父目录必须已经存在（本模块不替调用方 mkdir），根解析不出来就不写', async () => {
  const { home, target } = runHome('missing-dirs')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  const missingDir = join(home, 'no-such-dir')

  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: join(missingDir, DSH_CREDENTIALS_FILENAME),
    mapping: { [MODEL_REF]: DSH_MODEL_NAME }, allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '父目录不存在')
  assert.equal(caught.code, CODES.TARGET_DIR_UNRESOLVED)
  assert.equal(existsSync(missingDir), false, '不能顺手把计划外的目录建出来')

  // allowedRoot 本身不存在：先报根解析不出来（证不出在根内，就不写）
  const ghostRoot = join(ROOT, 'ghost-root')
  const caught2 = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: join(ghostRoot, DSH_CREDENTIALS_FILENAME),
    mapping: { [MODEL_REF]: DSH_MODEL_NAME }, allowedRoot: ghostRoot, operatorHomes: OPERATOR_HOMES,
  }), 'allowedRoot 不存在')
  assert.equal(caught2.code, CODES.ALLOWED_ROOT_UNRESOLVED)
  assert.equal(existsSync(ghostRoot), false)
  assert.equal(existsSync(target), false)
})

test('④ ★★ 落盘失败 → WRITE_FAILED（只带 errno），临时文件被清掉、目标不被改动', async () => {
  const { home, target } = runHome('write-failed')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  // 目标位置上放一个**目录**：rename 一定失败，而失败发生在"内容已经渲染好"之后
  // ——这正是"顺手把内容塞进错误消息"最容易发生的那条路。
  mkdirSync(target)
  writeFileSync(join(home, 'keep.txt'), 'keep', 'utf8')

  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '目标位置上是一个目录')

  assert.equal(caught.code, CODES.WRITE_FAILED)
  assert.equal(typeof caught.cause, 'string')
  assert.equal(caught.cause.includes(SECRETS.MODEL), false)
  assert.equal(statSync(target).isDirectory(), true, '目标（那个目录）没有被改动')
  assert.deepEqual(readdirSync(home).sort(), [DSH_CREDENTIALS_FILENAME, 'keep.txt'],
    '临时文件必须被清掉，既存内容不许被碰')
})

// ═══════════════════════════════════════════════ ⑤ 不泄漏

test('⑤ ★★★ 值不出现在**错误消息/可枚举属性/结果序列化/描述对象**里', async () => {
  const { home, target } = runHome('leak-ok')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL], [REFS_REF, SECRETS.ANTHROPIC]])

  // (1) 成功路径：返回值、`describe()`、`toJSON()`
  const result = materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  })
  const okTexts = [
    JSON.stringify(result),
    JSON.stringify(result.describe()),
    JSON.stringify(result.toJSON()),
    JSON.stringify(Object.entries(result)),
    JSON.stringify(result.entries),
  ]
  for (const text of okTexts) {
    assert.equal(text.includes(SECRETS.MODEL), false, '返回值里出现了凭证值')
    assert.equal(text.includes(SECRETS.ANTHROPIC), false, '返回值里出现了凭证值')
    assert.equal(text.includes('sk-test'), false)
  }
  // ★ 但元数据里必须**有**引用名与 DSH 名字——否则上面那几条对空字符串也是绿的。
  const okJson = JSON.stringify(result)
  assert.equal(okJson.includes(MODEL_REF), true)
  assert.equal(okJson.includes(DSH_MODEL_NAME), true)
  assert.equal(okJson.includes(REFS_REF), true)

  // (2) "渲染之后才失败"的那条路：错误对象也是会被打日志的地方
  const { target: badTarget } = runHome('leak-err')
  mkdirSync(badTarget)
  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: badTarget, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: dirname(badTarget), operatorHomes: OPERATOR_HOMES,
  }), '目标位置上是一个目录')
  assert.equal(caught.code, CODES.WRITE_FAILED)
  const errTexts = [
    String(caught.message),
    String(caught.stack),
    JSON.stringify(caught),
    Object.values(caught).map((v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '')).join('|'),
    String(caught.cause),
    String(caught.name),
  ]
  for (const text of errTexts) {
    assert.equal(text.includes(SECRETS.MODEL), false, '错误对象里出现了凭证值')
    assert.equal(text.includes('sk-test'), false)
  }

  // (3) 值级别的拒绝：消息里只有名字与类别
  const newlineValue = `sk-test-not-a-real${'\n'}REST`
  const caught2 = expectRefusal(() => materializeRunCredentials({
    handle: fakeHandle([[MODEL_REF, newlineValue]]),
    targetFile: join(home, DSH_CREDENTIALS_FILENAME),
    mapping: { [MODEL_REF]: DSH_MODEL_NAME }, allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '带换行的值')
  assert.equal(caught2.code, CODES.VALUE_NOT_REPRESENTABLE)
  assert.equal(String(caught2.message).includes('sk-test-not-a-real'), false)
  assert.equal(String(caught2.cause).includes('REST'), false)
  assert.equal(JSON.stringify(caught2).includes('REST'), false)
})

// ═══════════════════════════════════════════════ ⑥ 诚实边界

test('⑥ ★★★ 诚实边界：本模块里没有 provider → 名字的表，本套件也没证明 DSH 进程读过它', async () => {
  const src = readFileSync(MODULE_PATH, 'utf8')
  // 注释里可以（也应该）出现 `process.env`、DSH 的名字——那是在**解释**纪律。
  // 被判的是**代码**：先把注释剥掉，免得一条"注释里提过"的文本被当成一张表。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n')

  // ① 映射**不可能**是这里推导出来的：代码里除了具名错误码，没有任何
  //    "环境变量名形状"的字符串字面量。"从 DSH 的 apiKeyEnv 声明来"这句话
  //    在这里是个可数的读数，不是注释里的承诺。
  const literals = [...new Set([...code.matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]/g)].map((m) => m[1]))]
  const declared = new Set(Object.values(CREDENTIAL_MATERIALIZER_CODES))
  assert.deepEqual(literals.filter((l) => !declared.has(l)), [],
    '模块代码里出现了错误码之外的"环境变量名形状"字面量——那就是一张内置的 provider → 名字的表')
  assert.equal([...declared].every((c) => literals.includes(c)), true,
    '上面那条不能是空泛的：具名错误码本身必须能被这段提取读到')

  // ② 密钥层不读进程环境——这个问题只有一个权威答案：仓库自己的扫描器
  //    （`scripts/config/scan.mjs` 的 `extractEnvReads`，也就是 `scan --check` 用的那一个）。
  //    手写正则会把错误消息里**提到** `process.env` 当成一次读取，那是假阳性。
  const reads = extractEnvReads(src)
  assert.equal(reads.literal.size, 0, `本模块读了进程环境：${[...reads.literal].join(', ')}`)
  assert.deepEqual(reads.dynamic, [], `本模块有动态 env 下标：${reads.dynamic.join(', ')}`)

  // ③ 本模块不可能把文件交给一个**真正的 DSH 进程**去读：
  //    没有子进程、没有 DSH 的 YAML 实现。所以下面这件事实**没有被证明**——
  //    "一个真实的 DSH 进程读回过来自本模块的文件"。
  assert.equal(/child_process|spawn\(|execFile|execSync/.test(code), false)
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(imports.filter((s) => !s.startsWith('node:') && s !== './dsh-credentials.mjs'), [],
    '本模块只依赖 Node 内建与**真实的读取器**')
  assert.equal(imports.includes('./dsh-credentials.mjs'), true, '写前自校验用的就是那个真实读取器')

  // ④ 没有表 ⟹ 没有映射时就写不出去（这是行为上的同一条结论）
  const { home, target } = runHome('boundary')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  const caught = expectRefusal(() => materializeRunCredentials({
    handle, targetFile: target, mapping: {}, allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  }), '没有映射')
  assert.equal(caught.code, CODES.REF_UNMAPPED)
  assert.equal(existsSync(target), false)

  // 本文件**不**证明：真实 DSH 进程读得回来；映射内容是真的；DSH 自己的 YAML 实现
  // 写出的文件 Legion 的窄读者读得回来（那是反方向，归 `dsh-credentials.test.mjs`
  // 的 $DSH_CHECKOUT 交叉核对管）。
})

test('⑥ ★★ 映射目标名来自 DSH 自己的声明，而不是本模块编的（$DSH_CHECKOUT 可达时才核对）', {
  skip: process.env.DSH_CHECKOUT === undefined || process.env.DSH_CHECKOUT === ''
    ? '未配置 DSH_CHECKOUT：本机看不到 DSH 的检出，"这个名字是 DSH 声明的"就**证不出来**——跳过，而不是假装通过'
    : false,
}, (t) => {
  const checkout = process.env.DSH_CHECKOUT
  const patchFile = join(checkout, 'packages', 'bundle', 'base', 'cordis.patch.yml')
  // ★ 扫整个包的 `src/**/*.ts`，**不钉文件名**。
  //
  //   ⚠️ 这里原来钉的是 `src/index.ts`。2026-09-10 的 DSH 重构
  //   `6a137ea7`（"refactor(llm): unify DeepSeek protocol implementations"）
  //   把 `DEFAULT_API_KEY_ENV` **逐字节**搬到了同目录的 `config.ts`：
  //   值没变、语义没变、正则也不用改，**变的只是它住在哪个文件里**。
  //   钉文件的断言于是报了一次"漂移"——而 DSH 声明的东西一个字都没变。
  //
  //   > 一条钉死"声明住哪个文件"的断言，
  //   > 守的不是"这个名字是 DSH 声明的"，而是"DSH 的目录布局还是 2026-07 那副样子"。
  //
  //   改成扫目录之后，断言仍然要求**标识符与字符串字面量**同时出现在 DSH 自己的
  //   源码里（改名或删掉照样红），但不再对"文件被拆开/搬走"敏感。
  //   加 `^…$` 行锚：否则一句注释或字符串里提到它也能满足。
  const providerSrc = join(checkout, 'packages', 'llm', 'llm-deepseek', 'src')
  if (!existsSync(patchFile) || !existsSync(providerSrc)) {
    return t.skip('DSH_CHECKOUT 可达，但这两处声明文件不在预期路径上——那本身是个值得报的漂移')
  }
  // 行配置那一侧：`apiKeyEnv: DEEPSEEK_API_KEY`
  assert.match(readFileSync(patchFile, 'utf8'), /apiKeyEnv: DEEPSEEK_API_KEY/)
  // 适配器那一侧：`DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'`
  const providerCode = readdirSync(providerSrc, { recursive: true })
    .filter((rel) => rel.endsWith('.ts'))
    .map((rel) => readFileSync(join(providerSrc, rel), 'utf8'))
    .join('\n')
  assert.match(providerCode, /^const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'$/m)
  // 而本套件喂给 materializeRunCredentials 的映射目标就是这个名字。
  assert.equal(DSH_MODEL_NAME, 'DEEPSEEK_API_KEY')
  return undefined
})

test('⑥ ★★ 句柄是只读消费：写文件不改变句柄里的那一份值', async () => {
  const { home, target } = runHome('read-only-handle')
  const handle = await handleFor([[MODEL_REF, SECRETS.MODEL]])
  materializeRunCredentials({
    handle, targetFile: target, mapping: { [MODEL_REF]: DSH_MODEL_NAME },
    allowedRoot: home, operatorHomes: OPERATOR_HOMES,
  })
  assert.equal(handle.get(MODEL_REF), SECRETS.MODEL, '句柄里的值不该被写文件这件事影响')
  assert.deepEqual([...handle.refs], [MODEL_REF])
  assert.equal(Object.isFrozen(handle), true)
})

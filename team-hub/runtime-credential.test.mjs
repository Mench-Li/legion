// team-hub/runtime-credential.test.mjs
// ============================================================================
// **运行侧（DSH）有没有这把钥匙** —— 那三值判定的判据。
//
// 这一族守的核心是一句话：**"我没查到"不许说成"没有"。**
// （`credential-status.mjs` 的纪律 ① 是它的同族：那边是"读不出来 ≠ 没有"，
//   这边多一条"**没查那一层**也不能说那一层没有"。）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RUNTIME_KEY_STATES, RUNTIME_KEY_LAYERS, RUNTIME_KEY_UNCHECKED,
  RUNTIME_KEY_STATE_TEXT, classifyRuntimeKey, createRuntimeCredentialProbe,
} from './runtime-credential.mjs'

/** 造一个"读得出来"的两层读数。 */
const reading = ({ env = [], fileRefs = [] } = {}) => ({
  ok: true, env: new Set(env), fileRefs: new Set(fileRefs), reason: null,
})

test('① 宿主环境里有 ⇒ present，且点名是**环境**给的（DSH 的第一层）', () => {
  const r = classifyRuntimeKey('FJD_DS_API_KEY', reading({ env: ['FJD_DS_API_KEY'] }))
  assert.equal(r.state, 'present')
  assert.equal(r.layer, '宿主环境变量')
  assert.match(r.detail, /宿主环境/)
})

test('② 环境里没有、DSH 凭证文件里有 ⇒ present，且点名是**文件**给的', () => {
  const r = classifyRuntimeKey('FJD_DS_API_KEY', reading({ fileRefs: ['FJD_DS_API_KEY'] }))
  assert.equal(r.state, 'present')
  assert.equal(r.layer, 'DSH 凭证文件')
  assert.match(r.detail, /credentials\.yaml/)
})

test('③ ★★ 环境**赢**过文件：两层都有时 `layer` 必须是环境（复现 DSH 的优先级）', () => {
  // DSH 的四层是「宿主环境 > .credentials.yaml > …」。把优先级搞反不会让读数变化，
  // 只会让 `layer` 说错 —— 而 `layer` 存在的理由正是回答"这个值是谁给的"。
  const r = classifyRuntimeKey('K', reading({ env: ['K'], fileRefs: ['K'] }))
  assert.equal(r.layer, '宿主环境变量')
})

test('④ ★★★ 两层都没有 ⇒ absent，而且措辞必须**只声明查过的那两层**', () => {
  const r = classifyRuntimeKey('NOPE', reading({}))
  assert.equal(r.state, 'absent')
  // ① 逐字列出查过的两层
  for (const layer of RUNTIME_KEY_LAYERS) assert.ok(r.detail.includes(layer), `detail 里少了查过的那层：${layer}`)
  // ② 逐字声明**没查**的那一层 —— 没有这句，"absent" 就会被读成"DSH 没有"
  assert.ok(r.detail.includes(RUNTIME_KEY_UNCHECKED), `detail 里必须写明没查哪一层：${r.detail}`)
  // ③ 不许出现"DSH 没有这把钥匙"这类越权结论
  assert.equal(/DSH\s*(自己)?\s*没有/.test(r.detail), false, '不许替 DSH 说"没有"：第三层我们没查')
})

test('⑤ ★★★ 读失败 ⇒ unknown，**绝不是** absent（附"这不等于没有"）', () => {
  for (const bad of [null, undefined, { ok: false, reason: 'EACCES' }, { ok: false }]) {
    const r = classifyRuntimeKey('K', bad)
    assert.equal(r.state, 'unknown', `读失败被说成了 ${r.state}：${JSON.stringify(bad)}`)
    assert.match(r.detail, /无法判断/, r.detail)
    assert.match(r.detail, /这不等于"没有"/, r.detail)
  }
})

test('⑥ ★★ `DSH_HOME` 没设 ⇒ unknown（而不是"没有"）', async () => {
  // 这是最容易写成 absent 的一种：拿不到家目录时，"不知道文件在哪"与"文件里没有"
  // 在代码里只差一行，而在用户那里差一次白忙。
  const probe = createRuntimeCredentialProbe({ env: {}, dshCredentialsFileForStatus: () => ({ file: null, source: null }) })
  const s = await probe.snapshot()
  assert.equal(s.ok, false)
  assert.equal(s.of('ANY').state, 'unknown')
  assert.match(s.of('ANY').detail, /DSH_HOME/)
})

test('⑦ 文件不存在 ⇒ **确定**的 absent（不是 unknown）：一台没用过 DSH Models 的机器就是这个形状', async () => {
  const probe = createRuntimeCredentialProbe({
    env: { DSH_HOME: 'C:/nope' },
    dshCredentialsFileForStatus: () => ({ file: 'C:/nope/.credentials.yaml', source: 'env' }),
    readRefs: () => ({ ok: true, refs: new Set() }),
  })
  const s = await probe.snapshot()
  assert.equal(s.ok, true, '"文件不存在"是一个确定的读数，不是读失败')
  assert.equal(s.of('K').state, 'absent')
})

test('⑧ 空的 env 值不算"配了"（DSH 那边 `configured:false`）', async () => {
  const probe = createRuntimeCredentialProbe({
    env: { DSH_HOME: 'C:/x', EMPTY_KEY: '', SPACES: '   ', REAL: 'v' },
    dshCredentialsFileForStatus: () => ({ file: null, source: null }),
    readRefs: () => ({ ok: false, reason: 'x' }),
  })
  const s = await probe.snapshot()
  // `ok:false`（读文件失败）⇒ 全 unknown；所以这里改用一个读得成功的夹具来验"空值不算"。
  const probe2 = createRuntimeCredentialProbe({
    env: { DSH_HOME: 'C:/x', EMPTY_KEY: '', REAL: 'v' },
    dshCredentialsFileForStatus: () => ({ file: null, source: null }),
    readRefs: () => ({ ok: true, refs: new Set() }),
  })
  const s2 = await probe2.snapshot()
  assert.equal(s2.of('EMPTY_KEY').state, 'absent', '空串不算配了')
  assert.equal(s2.of('REAL').state, 'present', '非空值算配了')
  void s
})

test('⑨ `null`/空白引用 ⇒ not-needed（本地模型合法，不该报"缺钥匙"）', () => {
  for (const ref of [null, undefined, '', '   ']) {
    const r = classifyRuntimeKey(ref, reading({}))
    assert.equal(r.state, 'not-needed')
    assert.equal(r.layer, null)
  }
})

test('⑩ ★★ 一次列表只**读一遍**文件（20 个供应商不该读 20 次）', async () => {
  let reads = 0
  const probe = createRuntimeCredentialProbe({
    env: { DSH_HOME: 'C:/x' },
    dshCredentialsFileForStatus: () => ({ file: 'C:/x/.credentials.yaml', source: 'env' }),
    readRefs: () => { reads += 1; return { ok: true, refs: new Set(['A']) } },
  })
  const s = await probe.snapshot()
  for (let i = 0; i < 20; i += 1) s.of('A' + i)
  assert.equal(reads, 1, `读盘次数应是 1，实际 ${reads}`)
})

test('⑪ ★★ 三值词表与状态一一对应（加一态必须同时加文案，否则面板会显示 undefined）', () => {
  assert.deepEqual([...RUNTIME_KEY_STATES].sort(), Object.keys(RUNTIME_KEY_STATE_TEXT).sort())
  for (const k of RUNTIME_KEY_STATES) {
    assert.equal(typeof RUNTIME_KEY_STATE_TEXT[k], 'string')
    assert.ok(RUNTIME_KEY_STATE_TEXT[k].length > 0)
  }
})

test('⑫ ★★ 任何 detail 里都不出现那个引用名（引用名是可枚举的攻击面，BUG-028 的规矩）', () => {
  const REF = 'LEGION_LEAKY_REF_NAME'
  const cases = [
    classifyRuntimeKey(REF, reading({ env: [REF] })),
    classifyRuntimeKey(REF, reading({ fileRefs: [REF] })),
    classifyRuntimeKey(REF, reading({})),
    classifyRuntimeKey(REF, { ok: false, reason: 'EACCES' }),
  ]
  for (const c of cases) {
    assert.equal(c.detail.includes(REF), false, `detail 里出现了引用名：${c.detail}`)
  }
})

test('⑬ 造读取器时缺 `dshCredentialsFileForStatus` ⇒ 具名拒绝（路径只许定义一次）', () => {
  assert.throws(() => createRuntimeCredentialProbe({ env: {} }), /dshCredentialsFileForStatus/)
})

test('⑭ 真读一遍本机（有 DSH_HOME 才有意义）：结论必须是那三值之一，且 detail 非空', async () => {
  const { dshCredentialsFileForStatus } = await import('../product/dsh-location.mjs')
  const { osHomeFacts } = await import('../product/paths.mjs')
  const probe = createRuntimeCredentialProbe({ env: process.env, dshCredentialsFileForStatus, osHome: osHomeFacts(process.env).homeDir })
  const s = await probe.snapshot()
  for (const ref of [null, 'FJD_DS_API_KEY', 'DEFINITELY_NOT_A_KEY_XYZ']) {
    const r = s.of(ref)
    assert.ok(RUNTIME_KEY_STATES.includes(r.state), `状态不在词表里：${r.state}`)
    assert.ok(typeof r.detail === 'string' && r.detail.length > 10, '每种结论都要有一句能读的说明')
  }
})

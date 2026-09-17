// runtime/employee/role-pack.test.mjs
// ============================================================================
// F-19 Employee / Role Pack 的判据。
//
// 这一组的重心只有一句话：**"固化了"必须能被证伪**。
// 所以每个"看起来像固化"的写法，都要有一条用例证明它真的被拦住了。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROLE_PACK_CODES, ROLE_PACK_DOMAIN, ROLE_PACK_FIELDS, ROLE_PACK_HASHED_SECTIONS,
  ROLE_PACK_SECTIONS, ROLE_PACK_SECTION_FIELDS, ROLE_PACK_VERSION,
  FORBIDDEN_CONNECTOR_KEYS,
  assertRolePackFieldsClosed, buildRolePack, describeRolePack, diffRolePacks,
  normalizeRolePack, rolePackContentHash, verifyRolePack,
} from './role-pack.mjs'
import { FORBIDDEN_MANIFEST_FIELDS } from '../dsh-composition/employee-manifest.mjs'
import { EMPLOYEE_PRESET_CONTRACT } from '../dsh-composition/patch-layer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const H = (c) => `sha256:${c.repeat(64)}`

/** 一份七类齐全、合法的最小岗位包（每个用例按需在它上面做局部破坏）。 */
function sections(over = {}) {
  return {
    prompt: { id: 'dev-base', version: '3', hash: H('a') },
    skills: [{ id: 'skill.diff', version: '1.0.0' }, { id: 'skill.test', version: '2.0.0' }],
    tools: { id: 'tools.dev', version: '1.2.0', hash: H('b') },
    permissions: { presetId: 'perm.dev', version: '1.0.0', hash: H('c') },
    model: { profileId: 'gpt-4-0613', version: '2024-01-01' },
    connectors: [{ id: 'mcp.files', version: '1.0.0' }],
    budget: { policyId: 'budget.std', version: '1.0.0', hash: H('d') },
    ...over,
  }
}

const pack = (over = {}) => buildRolePack({
  rolePackId: 'rp.dev', role: 'dev', version: '1.0.0', sections: sections(), ...over,
})

/** 断言某次调用抛出指定 code 的错误。返回错误本身以便进一步检查文案。 */
function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

// ---------------------------------------------------------------------------
// ① 七类：一个都不能少，一个都不能多
// ---------------------------------------------------------------------------

test('① ★★ 七类**正好**是这七个，且列表本身被钉住', () => {
  assert.deepEqual(ROLE_PACK_SECTIONS, [
    'prompt', 'skills', 'tools', 'permissions', 'model', 'connectors', 'budget',
  ])
  // 每一类都必须有字段闭包定义，否则"这一节里能写什么"没有答案。
  for (const s of ROLE_PACK_SECTIONS) {
    assert.ok(Array.isArray(ROLE_PACK_SECTION_FIELDS[s]), `${s} 没有字段闭包`)
  }
  assert.deepEqual(Object.keys(ROLE_PACK_SECTION_FIELDS).sort(), [...ROLE_PACK_SECTIONS].sort())
})

test('① ★★★ 缺任何一类都拒绝——**不给默认空值**', () => {
  // 逐类摘掉一个，每一次都必须以 SECTION_MISSING 拒绝。
  // 这一条是本模块存在的理由：`?? []` 会让"作者忘了写"与"这一类就是空的"
  // 变成同一个东西。
  //
  // ★ 两条入口**都要**驱动：`buildRolePack` 与 `normalizeRolePack` 各有一道
  //   自己的七类检查。只测前者时，后者的那道永远不会跑到——
  //   而"两道检查、只有一道被验证"与"一道检查"在报告里都是"用例全绿"。
  for (const s of ROLE_PACK_SECTIONS) {
    const s2 = sections()
    delete s2[s]
    const err = throwsCode(
      () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: s2 }),
      ROLE_PACK_CODES.SECTION_MISSING,
    )
    assert.match(err.message, new RegExp(s), `缺 ${s} 的报错里没点名是它`)

    // 同一条规则、另一条入口：手写一份"看起来完整"的包（哈希是算出来的，
    // 于是它绕过了所有其他检查），只把那一节摘掉。
    const complete = sections()
    const forged = { ...s2 }
    const forgedHash = rolePackContentHash(forged)
    const err2 = throwsCode(
      () => normalizeRolePack({
        manifestVersion: ROLE_PACK_VERSION, rolePackId: 'rp.x', role: 'dev',
        version: '1.0.0', sections: forged, contentHash: forgedHash,
      }),
      ROLE_PACK_CODES.SECTION_MISSING,
    )
    assert.match(err2.message, new RegExp(s), `normalizeRolePack 缺 ${s} 时没点名是它`)
    void complete
  }
  // 一次缺两类时，报错要**列出全部**缺的，不是一个一个来。
  const s3 = sections()
  delete s3.prompt
  delete s3.budget
  const err = throwsCode(
    () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: s3 }),
    ROLE_PACK_CODES.SECTION_MISSING,
  )
  assert.match(err.message, /prompt/)
  assert.match(err.message, /budget/)
})

test('① ★ 「显式空」合法，与「缺失」必须分得开', () => {
  // 这是本模块的核心区分：`connectors: []` 是一个**决定**。
  const p = buildRolePack({
    rolePackId: 'rp.noconn', role: 'reader', version: '1.0.0',
    sections: sections({ connectors: [], skills: [] }),
  })
  assert.deepEqual(p.sections.connectors, [])
  assert.deepEqual(p.sections.skills, [])
  // 而"没写"是非法的——两者在默认值之后长得一样，所以必须在**解析时**分开。
  const missing = sections()
  delete missing.connectors
  throwsCode(
    () => buildRolePack({ rolePackId: 'rp.noconn', role: 'reader', version: '1.0.0', sections: missing }),
    ROLE_PACK_CODES.SECTION_MISSING,
  )
})

test('① 七类之外的节被拒（多出来的一节会让人以为它固化了某样东西）', () => {
  const err = throwsCode(
    () => normalizeRolePack({ ...pack(), sections: { ...sections(), secrets: { id: 'x', version: '1' } } }),
    ROLE_PACK_CODES.SECTION_UNKNOWN,
  )
  assert.match(err.message, /secrets/)
})

// ---------------------------------------------------------------------------
// ② 版本号：浮动 vs 形态
// ---------------------------------------------------------------------------

test('② ★★★ 浮动版本号被拒：`latest` / `*` / `head` / `dev`', () => {
  for (const bad of ['latest', '*', 'HEAD', 'current', 'dev', 'edge', 'next', 'stable']) {
    const s = sections({ skills: [{ id: 'skill.x', version: bad }] })
    const err = throwsCode(
      () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: s }),
      ROLE_PACK_CODES.REF_FLOATING,
    )
    // 文案必须点出**为什么**：它看起来像固化了。
    assert.match(err.message, /看起来像固化/)
  }
  // `version: ''` 走的是**另一条**分支（"没有版本号"），因为它与"没写这一行"
  // 是同一件事——两者都不该被报成"写了个会变的词"。
  const empty = sections({ skills: [{ id: 'skill.x', version: '' }] })
  throwsCode(
    () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: empty }),
    ROLE_PACK_CODES.REF_UNPINNED,
  )
})

test('② ★★ 缺 `version` 键被报成"没有版本号"，与写 `latest` 是两个码', () => {
  // 修法不同：一个是"补上行"，另一个是"把 latest 换成具体版本"。
  const s = sections({ skills: [{ id: 'skill.x' }] })
  throwsCode(
    () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: s }),
    ROLE_PACK_CODES.REF_UNPINNED,
  )
})

test('② ★★ `2024-01-01`、`gpt-4-0613` 这类**固定**写法必须被接受', () => {
  // 一条过严的规则会制造"为了过规则而说谎"的压力：拒掉日期会逼人改写成
  // `2024.1.1`，而那样写除了满足正则之外什么都没多出来。
  const accepted = [
    '3', '1.2.3', '1.2.3-rc.1', '1.2.3+build.5', '2024-01-01',
    'gpt-4-0613', 'claude-3-20240229', 'a1b2c3d', H('e'),
  ]
  for (const v of accepted) {
    const s = sections({ skills: [{ id: 'skill.x', version: v }] })
    const p = buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: s })
    assert.equal(p.sections.skills[0].version, v, `${v} 应该被接受`)
  }
})

test('② ★ 形态不认识单独一个码（与"浮动"修法不同）', () => {
  for (const bad of ['asdf', 'v latest', '1.2', 'release candidate', '...']) {
    const s = sections({ skills: [{ id: 'skill.x', version: bad }] })
    throwsCode(
      () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: s }),
      ROLE_PACK_CODES.REF_VERSION_SHAPE,
    )
  }
})

// ---------------------------------------------------------------------------
// ③ ★ 版本号是标签，哈希才是身份
// ---------------------------------------------------------------------------

test('③ ★★★ 承载内容的四类缺 `hash` 一律拒绝', () => {
  // 逐个摘掉 hash。这四类正是"同样版本号可以是两份内容"的地方。
  const idField = { prompt: 'id', tools: 'id', permissions: 'presetId', budget: 'policyId' }
  for (const s of ROLE_PACK_HASHED_SECTIONS) {
    const sec = sections()
    sec[s] = { [idField[s]]: 'x', version: '1.0.0' } // 无 hash
    const err = throwsCode(
      () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: sec }),
      ROLE_PACK_CODES.HASH_MISSING,
    )
    assert.match(err.message, /标签/, `${s} 的报错没有说明"版本号是标签"`)
    assert.match(err.message, /身份/)
  }
  // 而**引用表**（skills / model / connectors）**不该**要求 hash：
  // 它们的内容由自己的 id+version 定义，复制一份哈希等于两个地方各自漂移。
  const p = pack()
  assert.equal(p.sections.model.hash, undefined)
  assert.equal(p.sections.skills[0].hash, undefined)
  assert.equal(p.sections.connectors[0].hash, undefined)
})

test('③ ★ hash 的形态也要查（`sha256:` 前缀 + 64 位十六进制）', () => {
  for (const bad of ['abc', 'sha256:xyz', 'sha256:' + 'A'.repeat(64), 'md5:' + 'a'.repeat(32)]) {
    const sec = sections()
    sec.prompt = { id: 'dev-base', version: '3', hash: bad }
    throwsCode(
      () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: sec }),
      ROLE_PACK_CODES.HASH_MISSING,
    )
  }
})

test('③ ★★★ 声明的内容哈希与算出来的不一致 ⇒ 拒绝（不是静默改成算出来的）', () => {
  const p = pack()
  const err = throwsCode(
    () => normalizeRolePack({ ...p, contentHash: H('f') }),
    ROLE_PACK_CODES.CONTENT_HASH_MISMATCH,
  )
  assert.match(err.message, /算出来的/)
  // 正常路径：`buildRolePack` 算出来的就是 `normalizeRolePack` 认的。
  assert.equal(normalizeRolePack(p).contentHash, p.contentHash)
})

test('③ ★★ 内容哈希只覆盖七节：`notes` 与顶层版本号**不**影响它', () => {
  const a = pack()
  const b = pack({ notes: '一段说明文字' })
  assert.equal(a.contentHash, b.contentHash, 'notes 不该改变"这个岗位是哪一版"')
  // 但顶层 `version` 是**包的**版本，它独立于内容；内容不变时哈希也不变。
  const c = pack({ version: '1.0.1' })
  assert.equal(a.contentHash, c.contentHash)
  assert.notEqual(a.version, c.version)
})

test('③ ★★ 条目顺序不影响内容哈希（否则换顺序就是另一个身份）', () => {
  const ordered = buildRolePack({
    rolePackId: 'rp.o', role: 'dev', version: '1.0.0',
    sections: sections({ skills: [{ id: 'a', version: '1' }, { id: 'b', version: '2' }] }),
  })
  const reversed = buildRolePack({
    rolePackId: 'rp.o', role: 'dev', version: '1.0.0',
    sections: sections({ skills: [{ id: 'b', version: '2' }, { id: 'a', version: '1' }] }),
  })
  assert.equal(ordered.contentHash, reversed.contentHash)
  // 归一化之后读出来的顺序也是稳定的（排序过），不是恰好一致。
  assert.deepEqual(reversed.sections.skills.map((s) => s.id), ['a', 'b'])
})

test('③ 同一个 id 在条目表里出现两次被拒（"用哪一版"不能取决于数组顺序）', () => {
  const err = throwsCode(
    () => buildRolePack({
      rolePackId: 'rp.d', role: 'dev', version: '1.0.0',
      sections: sections({ skills: [{ id: 'a', version: '1' }, { id: 'a', version: '2' }] }),
    }),
    ROLE_PACK_CODES.REF_DUPLICATE,
  )
  assert.match(err.message, /顺序/)
})

// ---------------------------------------------------------------------------
// ④ agent 平面：不是强制面
// ---------------------------------------------------------------------------

test('④ ★★★ 顶层出现强制面字段 ⇒ ENFORCEMENT_ON_AGENT_PLANE', () => {
  for (const f of FORBIDDEN_MANIFEST_FIELDS) {
    const err = throwsCode(
      () => normalizeRolePack({ ...pack(), [f]: {} }),
      ROLE_PACK_CODES.ENFORCEMENT_ON_AGENT_PLANE,
    )
    assert.match(err.message, /强制面/)
  }
})

test('④ ★★★ 嵌套对象里的强制面字段也要拦（只查顶层就漏了 `sections.permissions.*`）', () => {
  // 这是最容易漏的一条：顶层干净，越权藏在 permissions 一节里。
  const sec = sections()
  sec.permissions = { presetId: 'p', version: '1', hash: H('c'), hardFloor: ['rm -rf'] }
  // 先被"字段不认识"拦（permissions 的闭包不含 hardFloor）——
  // 但**顺序**上必须也是硬拒绝，不能靠闭包碰巧挡住。
  throwsCode(
    () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: '1.0.0', sections: sec }),
    ROLE_PACK_CODES.ENFORCEMENT_ON_AGENT_PLANE,
  )
  // 换一个**在闭包内**的位置：直接构造一份"顶层干净但嵌套含 sandbox"的对象，
  // 绕过 buildRolePack 的逐节归一化，验证嵌套扫描本身是会咬的。
  const nested = { ...pack(), meta: { sandbox: { allow: true } } }
  throwsCode(() => normalizeRolePack(nested), ROLE_PACK_CODES.FIELD_UNKNOWN)
  // 直接驱动递归扫描：把它放在一个已知字段的**值**里。
  const deep = { ...pack(), notes: { deep: [{ denyTools: ['x'] }] } }
  const err = throwsCode(() => normalizeRolePack(deep), ROLE_PACK_CODES.ENFORCEMENT_ON_AGENT_PLANE)
  assert.match(err.message, /\$\.notes/, '报错要指出在哪一层')
})

test('④ ★ 与 `EMPLOYEE_PRESET_CONTRACT` 对账：岗位包是 agent 平面的冻结描述', () => {
  // 契约说 mayCarryEnforcement: false，岗位包就必须**结构上**做不到承载强制面。
  assert.equal(EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement, false)
  assert.equal(EMPLOYEE_PRESET_CONTRACT.plane, 'agent')
  const src = readFileSync(join(HERE, 'role-pack.mjs'), 'utf8')
  // 强制面字段表是**从** employee-manifest 借来的，不是本地抄一份——
  // 抄一份会在对方加字段的那天静默不同步。
  assert.match(src, /import \{ FORBIDDEN_MANIFEST_FIELDS \} from '\.\.\/dsh-composition\/employee-manifest\.mjs'/)
})

// ---------------------------------------------------------------------------
// ⑤ 连接器：只许引用，不许值
// ---------------------------------------------------------------------------

test('⑤ ★★★ 连接器里出现凭证字段 ⇒ 单独一个码，且文案说明"已经泄漏了"', () => {
  for (const k of ['token', 'apiKey', 'clientSecret', 'password', 'connectionString', 'privateKey']) {
    assert.ok(FORBIDDEN_CONNECTOR_KEYS.includes(k), `${k} 应该在禁区名单里`)
    const err = throwsCode(
      () => buildRolePack({
        rolePackId: 'rp.x', role: 'dev', version: '1.0.0',
        sections: sections({ connectors: [{ id: 'mcp.x', version: '1.0.0', [k]: 'ghp_secret' }] }),
      }),
      ROLE_PACK_CODES.SECRET_VALUE_IN_CONNECTORS,
    )
    assert.match(err.message, /Git/, '文案要说明为什么这比一般字段错误严重')
  }
})

test('⑤ 连接器的**合法**引用不带值也能用（禁区不是把这条路堵死）', () => {
  const p = pack()
  assert.deepEqual(p.sections.connectors, [{ id: 'mcp.files', version: '1.0.0' }])
  // 而且能被序列化进导出：整个包过一遍 JSON 往返不丢东西。
  const round = normalizeRolePack(JSON.parse(JSON.stringify(p)))
  assert.equal(round.contentHash, p.contentHash)
})

// ---------------------------------------------------------------------------
// ⑥ 顶层字段闭合与形态
// ---------------------------------------------------------------------------

test('⑥ ★ 顶层不认识的字段被拒（"多打一个字母让整条限制静默失效"）', () => {
  const err = throwsCode(
    () => normalizeRolePack({ ...pack(), sekcions: {} }),
    ROLE_PACK_CODES.FIELD_UNKNOWN,
  )
  assert.match(err.message, /不忽略/)
  assert.deepEqual(assertRolePackFieldsClosed(pack()).fields.length > 0, true)
  assert.deepEqual(ROLE_PACK_FIELDS.includes('sections'), true)
})

test('⑥ 必填字段缺一即拒，且报出**全部**缺的', () => {
  const p = pack()
  const broken = { ...p }
  delete broken.rolePackId
  delete broken.role
  const err = throwsCode(() => normalizeRolePack(broken), ROLE_PACK_CODES.BAD_PACK)
  assert.match(err.message, /rolePackId/)
  assert.match(err.message, /role/)
})

test('⑥ 形态版本对不上时不猜', () => {
  throwsCode(
    () => normalizeRolePack({ ...pack(), manifestVersion: 'legion/role-pack@2' }),
    ROLE_PACK_CODES.BAD_PACK,
  )
  assert.equal(ROLE_PACK_VERSION, 'legion/role-pack@1')
})

test('⑥ ★ 顶层 `version`（**包的**版本）同样必须固定', () => {
  // 它有自己的码：七节里每一个引用都固化了，而"这份包本身是哪一版"却写成
  // `latest` 时，包的身份仍然是浮动的——只不过浮动发生在上一层。
  for (const bad of ['latest', '*', 'v0.1', '']) {
    throwsCode(
      () => buildRolePack({ rolePackId: 'rp.x', role: 'dev', version: bad, sections: sections() }),
      ROLE_PACK_CODES.REF_BAD_VERSION,
    )
  }
  // 合法写法照常通过，且读回来就是写进去的那个。
  const p = pack({ version: '2.1.0' })
  assert.equal(p.version, '2.1.0')
})

test('⑥ 某一节里字段不认识（`version` 拼成 `ver` 会让引用**静默地没有版本**）', () => {
  const err = throwsCode(
    () => buildRolePack({
      rolePackId: 'rp.x', role: 'dev', version: '1.0.0',
      sections: sections({ prompt: { id: 'dev-base', ver: '3', hash: H('a') } }),
    }),
    ROLE_PACK_CODES.FIELD_UNKNOWN,
  )
  assert.match(err.message, /静默/)
})

test('⑥ 归一化后的对象是冻结的（改不动 = 不会被下游顺手改）', () => {
  const p = pack()
  assert.equal(Object.isFrozen(p), true)
  assert.equal(Object.isFrozen(p.sections), true)
  assert.equal(Object.isFrozen(p.sections.skills), true)
  assert.throws(() => { p.role = 'hacked' }, TypeError)
})

// ---------------------------------------------------------------------------
// ⑦ ★ 对账：两种漂移必须分开报
// ---------------------------------------------------------------------------

/** 构造一份与 `p` 完全一致的"世界"。 */
function worldFor(p) {
  return {
    prompt: { id: p.sections.prompt.id, version: p.sections.prompt.version, hash: p.sections.prompt.hash },
    tools: { id: p.sections.tools.id, version: p.sections.tools.version, hash: p.sections.tools.hash },
    permissions: { presetId: p.sections.permissions.presetId, version: p.sections.permissions.version, hash: p.sections.permissions.hash },
    budget: { policyId: p.sections.budget.policyId, version: p.sections.budget.version, hash: p.sections.budget.hash },
    model: { profileId: p.sections.model.profileId, version: p.sections.model.version },
    skills: p.sections.skills.map((s) => ({ ...s })),
    connectors: p.sections.connectors.map((s) => ({ ...s })),
  }
}

test('⑦ 世界与岗位包一致时 ok:true，且没有任何漂移', () => {
  const p = pack()
  const r = verifyRolePack({ pack: p, world: worldFor(p) })
  assert.equal(r.ok, true)
  assert.deepEqual(r.drifts, [])
  assert.equal(r.contentDrifted, false)
  assert.equal(r.rolePackId, 'rp.dev')
  assert.equal(r.contentHash, p.contentHash)
})

test('⑦ ★★★ 版本号**没变**而内容变了 ⇒ CONTENT_DRIFT（不是 VERSION_DRIFT）', () => {
  // 这是最阴险的一种：按版本号比对会报"一致"。
  const p = pack()
  const w = worldFor(p)
  w.prompt = { ...w.prompt, hash: H('9') } // 版本号仍是 '3'
  const r = verifyRolePack({ pack: p, world: w })
  assert.equal(r.ok, false)
  assert.equal(r.drifts.length, 1)
  assert.equal(r.drifts[0].code, ROLE_PACK_CODES.CONTENT_DRIFT)
  assert.equal(r.drifts[0].section, 'prompt')
  assert.equal(r.drifts[0].expectedVersion, '3')
  assert.equal(r.drifts[0].actualVersion, '3', '两边的版本号是一样的——这正是它阴险的地方')
  assert.match(r.drifts[0].detail, /版本号还是/)
  // ★ 这个布尔值是调用方决定"停下还是提醒"的依据。
  assert.equal(r.contentDrifted, true)
})

test('⑦ ★★ 版本号变了 ⇒ VERSION_DRIFT，且 `contentDrifted` 为 false', () => {
  const p = pack()
  const w = worldFor(p)
  w.tools = { ...w.tools, version: '2.0.0', hash: H('8') }
  const r = verifyRolePack({ pack: p, world: w })
  assert.equal(r.drifts.length, 1)
  assert.equal(r.drifts[0].code, ROLE_PACK_CODES.VERSION_DRIFT)
  assert.equal(r.contentDrifted, false, '版本号变了是**显眼**的，不该被报成阴险的那一种')
})

test('⑦ ★★★ 对账必须能分辨"世界说没有"与"调用方漏传"', () => {
  const p = pack()
  // 漏传一节 ⇒ 调用错误，抛。
  const missingKey = worldFor(p)
  delete missingKey.budget
  const err = throwsCode(
    () => verifyRolePack({ pack: p, world: missingKey }),
    ROLE_PACK_CODES.BAD_PACK,
  )
  assert.match(err.message, /忘了传|调用错误/)
  // 显式 `null` ⇒ 对账结论"世界那边不存在"。
  const nulled = worldFor(p)
  nulled.budget = null
  const r = verifyRolePack({ pack: p, world: nulled })
  assert.equal(r.ok, false)
  assert.equal(r.drifts[0].code, ROLE_PACK_CODES.REF_MISSING_IN_WORLD)
  assert.equal(r.drifts[0].actual, null)
})

test('⑦ 条目型（skills / connectors）逐条对账：少了 / 版本变了都要报', () => {
  const p = pack()
  const w = worldFor(p)
  w.skills = [{ id: 'skill.diff', version: '9.9.9' }] // 少了 skill.test，且 skill.diff 变了版本
  const r = verifyRolePack({ pack: p, world: w })
  assert.equal(r.drifts.length, 2)
  const byId = Object.fromEntries(r.drifts.map((d) => [d.id, d.code]))
  assert.equal(byId['skill.diff'], ROLE_PACK_CODES.VERSION_DRIFT)
  assert.equal(byId['skill.test'], ROLE_PACK_CODES.REF_MISSING_IN_WORLD)
})

test('⑦ 引用指向了**别的** id ⇒ 报"指向的是 X"（不是含糊的"漂移"）', () => {
  const p = pack()
  const w = worldFor(p)
  w.permissions = { ...w.permissions, presetId: 'perm.other' }
  const r = verifyRolePack({ pack: p, world: w })
  assert.equal(r.drifts[0].code, ROLE_PACK_CODES.REF_MISSING_IN_WORLD)
  assert.match(r.drifts[0].detail, /perm\.other/)
  assert.match(r.drifts[0].detail, /perm\.dev/)
})

test('⑦ ★ 世界拿不出内容哈希时**不当成一致**（无法确认 ≠ 确认过了）', () => {
  const p = pack()
  const w = worldFor(p)
  w.prompt = { id: w.prompt.id, version: w.prompt.version } // 没有 hash
  const r = verifyRolePack({ pack: p, world: w })
  assert.equal(r.ok, false)
  assert.equal(r.drifts[0].code, ROLE_PACK_CODES.CONTENT_DRIFT)
  assert.match(r.drifts[0].detail, /无法确认/)
})

test('⑦ 多处漂移一次全部报出（不是遇到第一个就停）', () => {
  const p = pack()
  const w = worldFor(p)
  w.prompt = { ...w.prompt, hash: H('7') }
  w.tools = { ...w.tools, version: '9.0.0', hash: H('6') }
  w.connectors = []
  const r = verifyRolePack({ pack: p, world: w })
  assert.equal(r.drifts.length, 3)
  assert.deepEqual([...new Set(r.drifts.map((d) => d.section))].sort(), ['connectors', 'prompt', 'tools'])
})

// ---------------------------------------------------------------------------
// ⑧ 读出口：describe / diff
// ---------------------------------------------------------------------------

test('⑧ ★ `describeRolePack` 给出七类清单，且**不含任何凭证值**', () => {
  const p = pack()
  const d = describeRolePack(p)
  assert.equal(d.sections.length, 7)
  assert.deepEqual(d.sections.map((s) => s.section), ROLE_PACK_SECTIONS)
  for (const s of d.sections) assert.equal(s.pinned, true, `${s.section} 没被标成已固化`)
  const text = JSON.stringify(d)
  assert.equal(/ghp_|sk-|password|token/i.test(text), false, `描述里出现了疑似凭证：${text}`)
})

test('⑧ ★ `diffRolePacks` 能回答"这次升级动了什么"', () => {
  const before = pack()
  const after = buildRolePack({
    rolePackId: 'rp.dev', role: 'dev', version: '1.1.0',
    sections: sections({
      prompt: { id: 'dev-base', version: '4', hash: H('5') },
      connectors: [],
    }),
  })
  const d = diffRolePacks({ before, after })
  assert.equal(d.sameContent, false)
  assert.equal(d.beforeVersion, '1.0.0')
  assert.equal(d.afterVersion, '1.1.0')
  assert.deepEqual(d.changed.map((c) => c.section).sort(), ['connectors', 'prompt'])
  // 没动的节**不能**出现在变化清单里——那会让"动了什么"失去意义。
  assert.equal(d.changed.some((c) => c.section === 'budget'), false)

  // 只改顶层版本号时，内容没变。
  const onlyVersion = pack({ version: '1.0.1' })
  const d2 = diffRolePacks({ before, after: onlyVersion })
  assert.equal(d2.sameContent, true)
  assert.deepEqual(d2.changed, [])
})

test('⑧ `rolePackContentHash` 是纯函数：同样的七节永远同一个值', () => {
  const a = sections()
  const b = sections()
  assert.equal(rolePackContentHash(a), rolePackContentHash(b))
  // 逐节改一格都会变——**每一节都真的进了哈希**。
  const base = rolePackContentHash(a)
  const mutations = {
    prompt: { ...a.prompt, version: '4' },
    tools: { ...a.tools, version: '2.0.0' },
    permissions: { ...a.permissions, hash: H('1') },
    budget: { ...a.budget, policyId: 'budget.pro' },
    model: { profileId: 'other-model', version: '2024-01-01' },
    skills: [{ id: 'skill.diff', version: '3.0.0' }],
    connectors: [{ id: 'mcp.other', version: '1.0.0' }],
  }
  for (const s of ROLE_PACK_SECTIONS) {
    const h = rolePackContentHash({ ...a, [s]: mutations[s] })
    assert.notEqual(h, base, `改 ${s} 之后哈希没变——那一节没有真的进哈希`)
  }
})

// ---------------------------------------------------------------------------
// ⑨ 结构级：这些纪律不能只活在注释里
// ---------------------------------------------------------------------------

test('⑨ ★ 模块里**没有**把七节写成"可选/默认空"的兜底', () => {
  const src = readFileSync(join(HERE, 'role-pack.mjs'), 'utf8')
  // `?? []` 出现在 sections 解析上就是本模块要防的那个兜底。
  // 允许列表型小节在**归一化之后**排序，但不允许"缺了就当空"。
  const sectionFallback = /sections\s*\[?[^\]]*\]?\s*\?\?\s*(\[\]|\{\})/
  assert.equal(sectionFallback.test(src), false, 'sections 上出现了 ?? [] 兜底')
  // 七类缺失必须是显式抛错。
  assert.match(src, /ROLE_PACK_CODES\.SECTION_MISSING/)
  assert.match(src, /const missing = ROLE_PACK_SECTIONS\.filter/)
})

test('⑨ ★ 强制面拦截是**递归**的，不是一个顶层 if', () => {
  const src = readFileSync(join(HERE, 'role-pack.mjs'), 'utf8')
  assert.match(src, /function assertNoEnforcementAnywhere/)
  // 递归函数必须真的被调用（定义一个零调用方的递归函数，与没有它是一样的）。
  assert.match(src, /assertNoEnforcementAnywhere\(input\)/)
  // 而且它必须查**每一层**的键，不只是顶层。
  assert.match(src, /Object\.entries\(value\)/)
})

test('⑨ ★ 哈希用的是 domain-separated 通道，不是裸 sha256', () => {
  const src = readFileSync(join(HERE, 'role-pack.mjs'), 'utf8')
  assert.match(src, /domainSeparatedHash\(ROLE_PACK_DOMAIN, ROLE_PACK_SCHEMA_VERSION/)
  // 与包内容 / 审批 / 快照用的是**不同**的 domain（spec §6.5）。
  assert.notEqual(
    readFileSync(join(HERE, '..', 'packs', 'manifest.mjs'), 'utf8').includes(ROLE_PACK_DOMAIN),
    true,
    '岗位包 domain 与包内容 domain 撞了',
  )
})

test('⑨ 每一个码都至少被一个用例触达（没有只用不报的码）', () => {
  // 反向检查：把码表列出来，确保没有"定义了但永远到不了"的分支——
  // 那种分支会让人以为某件事已经被拦住了。
  const src = readFileSync(join(HERE, 'role-pack.mjs'), 'utf8')
  const declared = [...src.matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1])
  const testSrc = readFileSync(join(HERE, 'role-pack.test.mjs'), 'utf8')
  const unreachable = declared.filter((name) => !testSrc.includes(`ROLE_PACK_CODES.${name}`))
  assert.deepEqual(unreachable, [], `这些码没有任何用例触达：${unreachable.join(', ')}`)
})

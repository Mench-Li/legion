// team-hub/role-pack-store.test.mjs
// ============================================================================
// F-19 缺口②的判据：冻结的岗位包**存得住、读得回、且同版本不能被换内容**。
//
// 这一组里有两条是本模块存在的理由：
//   · 多个版本**同时存在**（主键 `(scope, role_pack_id, version)`）
//   · 同 (id, version) 再写一次：**内容相同则幂等、内容不同则 409**
// 其余的用例都是这两条的边界。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ROLE_PACK_LITERALS, ROLE_PACK_RECORD_VERSION, ROLE_PACK_STORE_ERRORS,
  ensureRolePackSchema, exportRolePacks, freezeRolePack, getRolePack, listRolePacks,
  normalizeRolePackRecord, rolePackCounts,
} from './role-pack-store.mjs'
// ★ 测试里**可以**直接 import 执行面：产品库不许 import 它，而判据必须能
//   拿真的 `normalizeRolePack` 来对账"读回来的是不是一份合法的岗位包"。
import { ROLE_PACK_SECTIONS, ROLE_PACK_VERSION, buildRolePack, normalizeRolePack } from '../runtime/employee/role-pack.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const H = (c) => `sha256:${c.repeat(64)}`

function freshDb() {
  const db = new DatabaseSync(':memory:')
  ensureRolePackSchema(db)
  return db
}

/** 一份真实的岗位包（用真的 `buildRolePack`，不是我手写一份假的）。 */
function realPack(over = {}) {
  return buildRolePack({
    rolePackId: 'rp.dev',
    role: 'dev',
    version: '1.0.0',
    sections: {
      prompt: { id: 'dev-base', version: '3', hash: H('a') },
      skills: [{ id: 'skill.diff', version: '1.0.0' }],
      tools: { id: 'tools.dev', version: '1.2.0', hash: H('b') },
      permissions: { presetId: 'perm.dev', version: '1.0.0', hash: H('c') },
      model: { profileId: 'gpt-4-0613', version: '2024-01-01' },
      connectors: [],
      budget: { policyId: 'budget.std', version: '1.0.0', hash: H('d') },
    },
    ...over,
  })
}

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

// ---------------------------------------------------------------------------
// ① 单向产品边界：字面量副本必须与执行面逐字相同
// ---------------------------------------------------------------------------

test('① ★★★ hub 的字面量副本与执行面**逐字**相同（单向边界的代价由此钉住）', () => {
  const runtimeSrc = readFileSync(join(HERE, '..', 'runtime', 'employee', 'role-pack.mjs'), 'utf8')
  // 从执行面源码里**抽**出来比，而不是再抄一遍——再抄一遍的话，
  // 这个用例就变成了"两份手抄件互相核对"，两边一起写错时它全绿。
  const v = /export const ROLE_PACK_VERSION = '([^']+)'/.exec(runtimeSrc)
  assert.notEqual(v, null, '没能从执行面源码里抽出 ROLE_PACK_VERSION——锚点变了，用例失去了意义')
  assert.equal(ROLE_PACK_LITERALS.manifestVersion, v[1])

  const block = /export const ROLE_PACK_SECTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(runtimeSrc)
  assert.notEqual(block, null, '没能抽出 ROLE_PACK_SECTIONS')
  const runtimeSections = [...block[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  assert.deepEqual([...ROLE_PACK_LITERALS.sections], runtimeSections,
    'hub 侧的七类与执行面不一致（**顺序也算**——它是哈希输入）')
  assert.deepEqual(runtimeSections, [...ROLE_PACK_SECTIONS])
})

test('① ★ 产品库**没有** import 执行面（单向边界不能被一条 import 打破）', () => {
  const src = readFileSync(join(HERE, 'role-pack-store.mjs'), 'utf8')
  const imports = [...src.matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['./schema-util.mjs'],
    `产品库 import 了别的东西：${imports.join(', ')}——执行面依赖会变成产品库的编译期依赖`)
  assert.equal(/from '.*runtime\//.test(src), false)
})

// ---------------------------------------------------------------------------
// ② 冻结：新的一版 / 幂等 / 冲突
// ---------------------------------------------------------------------------

test('② ★★★ 冻结一份真实岗位包，读回来**原样**能喂给 `normalizeRolePack`', () => {
  const db = freshDb()
  const p = realPack()
  const r = freezeRolePack({ db, record: { pack: p, frozenBy: 'alice' } })
  assert.equal(r.frozen, true)
  assert.equal(r.created, true)
  assert.equal(r.record.packReadable, true)
  assert.equal(r.record.frozenBy, 'alice')

  const got = getRolePack({ db, rolePackId: 'rp.dev', version: '1.0.0' })
  // ★ 判据只有一条：**不做任何转写**就能喂回 `normalizeRolePack`。
  //   需要转写时，那个转写就是第二份推导——两份推导今天一致、没人维持。
  const back = normalizeRolePack(got.pack)
  assert.equal(back.contentHash, p.contentHash)
  assert.equal(back.rolePackId, p.rolePackId)
  assert.equal(back.role, p.role)
  assert.deepEqual(back.sections, p.sections)
  // 而且投影列与包本身一致（投影只写一次，见文件头 ③）。
  assert.equal(got.projected.contentHash, p.contentHash)
  assert.equal(got.projected.role, p.role)
  assert.equal(got.projected.version, p.version)
})

test('② ★★★ 同 (id, version) 同内容 ⇒ **幂等成功**，不是错误', () => {
  const db = freshDb()
  const p = realPack()
  const a = freezeRolePack({ db, record: { pack: p, frozenAtMs: 1000, frozenBy: 'alice' } })
  const b = freezeRolePack({ db, record: { pack: p, frozenAtMs: 9999, frozenBy: 'bob' } })
  assert.equal(a.created, true)
  assert.equal(b.created, false, '重放一次冻结应该幂等，而不是新建一版')
  assert.equal(b.frozen, true)
  // ★ 而"第一次是什么时候、谁冻的"**不能被重试改写**：
  //   它是事后定位"那次运行用的哪一版"的入口。
  assert.equal(b.record.frozenAtMs, 1000, '重试把冻结时刻改了')
  assert.equal(b.record.frozenBy, 'alice', '重试把冻结人改了')
  // ★★ 上面两条查的是**返回值**。返回值对不代表库里没被改过——
  //    变异验证抓到过这一点：一条 `UPDATE role_packs SET frozen_at_ms = ...`
  //    在 UPDATE 之后仍返回**改之前**读出来的那一行，于是只查返回值的用例
  //    全绿，而库里已经被踩过。所以必须**重新读一次**。
  const reread = getRolePack({ db, rolePackId: 'rp.dev', version: '1.0.0' })
  assert.equal(reread.frozenAtMs, 1000, '库里那一行的冻结时刻被重试改写了')
  assert.equal(reread.frozenBy, 'alice', '库里那一行的冻结人被重试改写了')
  assert.equal(rolePackCounts({ db }).total, 1)
})

test('② ★★★ 同 (id, version) **不同内容** ⇒ 409，且这一次写入没有发生', () => {
  const db = freshDb()
  const p = realPack()
  freezeRolePack({ db, record: { pack: p } })
  // 造一份"同样的版本号、不同的内容"——这正是"v3 换了内容"。
  const tampered = { ...p, contentHash: H('9') }
  const err = throwsCode(
    () => freezeRolePack({ db, record: { pack: tampered } }),
    ROLE_PACK_STORE_ERRORS.VERSION_CONFLICT,
  )
  assert.equal(err.statusCode, 409)
  assert.match(err.message, /没有发生/, '文案必须说清这次写入没有发生')
  assert.match(err.message, /递增版本号/, '文案必须给出修法')
  assert.equal(err.existingHash, p.contentHash)
  assert.equal(err.incomingHash, H('9'))
  // **真正的原子性**：原来那一版一字未动。
  const got = getRolePack({ db, rolePackId: 'rp.dev', version: '1.0.0' })
  assert.equal(got.pack.contentHash, p.contentHash)
  assert.equal(rolePackCounts({ db }).total, 1)
})

test('② ★★★ 多个版本**同时存在**（主键是 (scope, id, version)，不是 (scope, role)）', () => {
  const db = freshDb()
  const v1 = realPack()
  const v2 = buildRolePack({
    rolePackId: 'rp.dev', role: 'dev', version: '1.1.0',
    sections: {
      prompt: { id: 'dev-base', version: '4', hash: H('e') },
      skills: [{ id: 'skill.diff', version: '1.0.0' }],
      tools: { id: 'tools.dev', version: '1.2.0', hash: H('b') },
      permissions: { presetId: 'perm.dev', version: '1.0.0', hash: H('c') },
      model: { profileId: 'gpt-4-0613', version: '2024-01-01' },
      connectors: [],
      budget: { policyId: 'budget.std', version: '1.0.0', hash: H('d') },
    },
  })
  freezeRolePack({ db, record: { pack: v1, frozenAtMs: 1000 } })
  freezeRolePack({ db, record: { pack: v2, frozenAtMs: 2000 } })
  // ★ 两版都在，"当时是哪一版"才有答案。就地更新会让 v1 消失。
  assert.equal(rolePackCounts({ db }).total, 2)
  assert.equal(getRolePack({ db, rolePackId: 'rp.dev', version: '1.0.0' }).pack.contentHash, v1.contentHash)
  assert.equal(getRolePack({ db, rolePackId: 'rp.dev', version: '1.1.0' }).pack.contentHash, v2.contentHash)
  // 不传版本 ⇒ 最新。**确定性**：同一毫秒冻的两版也不能靠磁盘顺序。
  const latest = getRolePack({ db, rolePackId: 'rp.dev' })
  assert.equal(latest.pack.version, '1.1.0')
  const all = listRolePacks({ db, rolePackId: 'rp.dev' })
  assert.deepEqual(all.map((r) => r.pack.version), ['1.1.0', '1.0.0'])
})

test('② ★ 同一毫秒冻两版时"最新"仍然确定（按 version 再排一次）', () => {
  // 只按 frozen_at_ms 排时，同一毫秒的两版顺序取决于磁盘恰好怎么排——
  // 而"最新版本取决于返回顺序"与"随机返回一版"是同一个东西。
  const db = freshDb()
  const mk = (v) => buildRolePack({
    rolePackId: 'rp.same', role: 'dev', version: v,
    sections: {
      prompt: { id: 'x', version: v, hash: H('a') },
      skills: [], tools: { id: 't', version: v, hash: H('b') },
      permissions: { presetId: 'p', version: v, hash: H('c') },
      model: { profileId: 'g', version: '2024-01-01' }, connectors: [],
      budget: { policyId: 'b', version: v, hash: H('d') },
    },
  })
  freezeRolePack({ db, record: { pack: mk('1.0.0'), frozenAtMs: 5000 } })
  freezeRolePack({ db, record: { pack: mk('1.0.1'), frozenAtMs: 5000 } })
  assert.equal(getRolePack({ db, rolePackId: 'rp.same' }).pack.version, '1.0.1')
})

// ---------------------------------------------------------------------------
// ③ 形状：七类逐个对上，包括顺序
// ---------------------------------------------------------------------------

test('③ ★★★ sections 的顺序不同 ⇒ 拒绝（顺序是哈希输入，顺序变了哈希就变）', () => {
  const db = freshDb()
  const p = realPack()
  // 键完全相同、只是顺序不同——这在 JS 里是"同一个对象"，
  // 而在内容哈希里是**两份不同的东西**。
  const reordered = {}
  for (const k of [...ROLE_PACK_SECTIONS].reverse()) reordered[k] = p.sections[k]
  const err = throwsCode(
    () => freezeRolePack({ db, record: { pack: { ...p, sections: reordered } } }),
    ROLE_PACK_STORE_ERRORS.SECTIONS_MISMATCH,
  )
  assert.match(err.message, /顺序也是/)
})

test('③ ★ 少一类 / 多一类都拒绝', () => {
  const db = freshDb()
  const p = realPack()
  const fewer = { ...p.sections }
  delete fewer.budget
  throwsCode(
    () => freezeRolePack({ db, record: { pack: { ...p, sections: fewer } } }),
    ROLE_PACK_STORE_ERRORS.SECTIONS_MISMATCH,
  )
  const more = { ...p.sections, secrets: { id: 's', version: '1' } }
  throwsCode(
    () => freezeRolePack({ db, record: { pack: { ...p, sections: more } } }),
    ROLE_PACK_STORE_ERRORS.SECTIONS_MISMATCH,
  )
})

test('③ 形态版本对不上时不猜', () => {
  const db = freshDb()
  const p = realPack()
  throwsCode(
    () => freezeRolePack({ db, record: { pack: { ...p, manifestVersion: 'legion/role-pack@2' } } }),
    ROLE_PACK_STORE_ERRORS.BAD_RECORD,
  )
  assert.equal(ROLE_PACK_LITERALS.manifestVersion, ROLE_PACK_VERSION)
})

test('③ 缺字段 / 坏哈希都被拒（坏哈希会让"身份"这一层失效）', () => {
  const db = freshDb()
  const p = realPack()
  for (const bad of ['', 'abc', 'sha256:XYZ', H('A')]) {
    throwsCode(
      () => freezeRolePack({ db, record: { pack: { ...p, contentHash: bad } } }),
      ROLE_PACK_STORE_ERRORS.BAD_RECORD,
    )
  }
  const noRole = { ...p }
  delete noRole.role
  throwsCode(
    () => freezeRolePack({ db, record: { pack: noRole } }),
    ROLE_PACK_STORE_ERRORS.BAD_RECORD,
  )
})

test('③ ★ 记录里 `pack` 是被**原样**存的：不挑字段、不补默认值', () => {
  const db = freshDb()
  const p = realPack()
  // 多带一个字段（比如执行面以后加的）：存下来、读回来仍在，
  // 这样"控制面落后于执行面"不会静默丢信息。
  const withExtra = { ...p, futureField: { hello: 'world' } }
  freezeRolePack({ db, record: { pack: withExtra } })
  const got = getRolePack({ db, rolePackId: 'rp.dev' })
  assert.deepEqual(got.pack.futureField, { hello: 'world' })
  // 而"没写 notes"与"写了 notes: null"不会被补成同一个东西。
  assert.equal('notes' in p, false)
  assert.equal('notes' in got.pack, false)
})

// ---------------------------------------------------------------------------
// ④ 坏数据：宁可说读不出来
// ---------------------------------------------------------------------------

test('④ ★★★ 库里的 `pack_json` 坏了 ⇒ `packReadable:false`，**不是**空包', () => {
  const db = freshDb()
  const p = realPack()
  freezeRolePack({ db, record: { pack: p } })
  db.prepare('UPDATE role_packs SET pack_json = ? WHERE role_pack_id = ?').run('{ 不是 JSON', 'rp.dev')
  const got = getRolePack({ db, rolePackId: 'rp.dev' })
  assert.equal(got.pack, null)
  assert.equal(got.packReadable, false)
  // ★ 关键：一个"读不出来"的包**不能**被当成"这个岗位没有限制"。
  //   投影列还在，于是调用方至少知道"这里曾经有一版"。
  assert.equal(got.projected.contentHash, p.contentHash)
  assert.equal(got.projected.rolePackId, 'rp.dev')
})

test('④ 拿不到行数时报 `readable:false`，**不是 0**（0 是一个结论）', () => {
  // 与 F-15 同一条纪律：每个数字都要有一个"不知道"的邻居。
  const broken = { prepare: () => { throw new Error('表被删了') } }
  const c = rolePackCounts({ db: broken })
  assert.equal(c.readable, false)
  assert.equal(c.total, null)
  assert.match(c.reason, /表被删了/)
  // 正常路径给的是真数字。
  assert.deepEqual(rolePackCounts({ db: freshDb() }), {
    readable: true, total: 0, rolePackIds: 0, roles: 0,
  })
})

test('④ `getRolePack` 找不到时返回 `null`（不是抛，也不是空包）', () => {
  const db = freshDb()
  assert.equal(getRolePack({ db, rolePackId: 'rp.nope' }), null)
  assert.equal(getRolePack({ db, rolePackId: 'rp.nope', version: '9.9.9' }), null)
  // 但"没给 id"是调用错误，要抛。
  throwsCode(() => getRolePack({ db, rolePackId: '  ' }), ROLE_PACK_STORE_ERRORS.BAD_RECORD)
})

// ---------------------------------------------------------------------------
// ⑤ scope：不同空间互不可见
// ---------------------------------------------------------------------------

test('⑤ ★ scope 隔离：同一个 id 在两个空间里可以各有一版', () => {
  const db = freshDb()
  const a = realPack()
  const b = buildRolePack({
    rolePackId: 'rp.dev', role: 'dev', version: '1.0.0',
    sections: {
      prompt: { id: 'other', version: '9', hash: H('1') },
      skills: [], tools: { id: 't2', version: '9', hash: H('2') },
      permissions: { presetId: 'p2', version: '9', hash: H('3') },
      model: { profileId: 'g', version: '2024-01-01' }, connectors: [],
      budget: { policyId: 'b2', version: '9', hash: H('4') },
    },
  })
  freezeRolePack({ db, record: { pack: a }, scope: 'team-a' })
  freezeRolePack({ db, record: { pack: b }, scope: 'team-b' })
  assert.equal(getRolePack({ db, rolePackId: 'rp.dev', scope: 'team-a' }).pack.contentHash, a.contentHash)
  assert.equal(getRolePack({ db, rolePackId: 'rp.dev', scope: 'team-b' }).pack.contentHash, b.contentHash)
  assert.equal(rolePackCounts({ db, scope: 'team-a' }).total, 1)
  assert.equal(getRolePack({ db, rolePackId: 'rp.dev', scope: 'team-c' }), null)
})

// ---------------------------------------------------------------------------
// ⑥ 写失败：磁盘错误必须是 5xx
// ---------------------------------------------------------------------------

test('⑥ ★★ 非冲突的数据库错误报 500（把磁盘错误报成 4xx 会让调用方放弃重试）', () => {
  const db = freshDb()
  const p = realPack()
  // 假 db：SELECT 说"没有"，INSERT 直接抛（模拟坏盘），再查仍然没有。
  const fake = {
    prepare(sql) {
      if (/^\s*SELECT/i.test(sql)) return { get: () => undefined }
      return { run: () => { throw new Error('disk I/O error') } }
    },
  }
  const err = throwsCode(
    () => freezeRolePack({ db: fake, record: { pack: p } }),
    ROLE_PACK_STORE_ERRORS.WRITE_FAILED,
  )
  assert.equal(err.statusCode, 500)
  assert.match(err.message, /disk I\/O error/)
  assert.match(err.message, /重试/)
  void db
})

test('⑥ ★★ 唯一约束竞态：插入失败但**再查一次**拿到了同样的哈希 ⇒ 幂等成功', () => {
  // 这一条防的是"把一次已经成功的写入报成 500"——那会让调用方无限重试。
  const p = realPack()
  let calls = 0
  const fake = {
    prepare(sql) {
      if (/^\s*SELECT/i.test(sql)) {
        return {
          get: () => {
            calls += 1
            // 第一次查：没有。插入后第二次查：有，且哈希相同。
            return calls === 1 ? undefined : {
              scope: 'default', role_pack_id: 'rp.dev', version: '1.0.0', role: 'dev',
              content_hash: p.contentHash, pack_json: JSON.stringify(p),
              frozen_at_ms: 1, frozen_by: null,
            }
          },
        }
      }
      return { run: () => { throw new Error('UNIQUE constraint failed') } }
    },
  }
  const r = freezeRolePack({ db: fake, record: { pack: p } })
  assert.equal(r.frozen, true)
  assert.equal(r.created, false, '竞态下拿到同哈希应该报幂等，而不是失败')
})

test('⑥ ★ 竞态下拿到**不同**哈希 ⇒ 409（不是 500）', () => {
  const p = realPack()
  let calls = 0
  const fake = {
    prepare(sql) {
      if (/^\s*SELECT/i.test(sql)) {
        return {
          get: () => {
            calls += 1
            return calls === 1 ? undefined : {
              scope: 'default', role_pack_id: 'rp.dev', version: '1.0.0', role: 'dev',
              content_hash: H('9'), pack_json: JSON.stringify(p),
              frozen_at_ms: 1, frozen_by: null,
            }
          },
        }
      }
      return { run: () => { throw new Error('UNIQUE constraint failed') } }
    },
  }
  const err = throwsCode(
    () => freezeRolePack({ db: fake, record: { pack: p } }),
    ROLE_PACK_STORE_ERRORS.VERSION_CONFLICT,
  )
  assert.equal(err.statusCode, 409)
})

// ---------------------------------------------------------------------------
// ⑦ 导出：可提交进 Git，且字段是白名单
// ---------------------------------------------------------------------------

test('⑦ ★★ 导出是可解析的文本，含七类的**引用**，且不含包内容细节', () => {
  const db = freshDb()
  const p = realPack()
  freezeRolePack({ db, record: { pack: p, frozenAtMs: 1700000000000 } })
  const text = exportRolePacks({ db })
  const doc = JSON.parse(text)
  assert.equal(doc.format, 'legion/role-pack-frozen@1')
  assert.equal(doc.recordVersion, ROLE_PACK_RECORD_VERSION)
  assert.equal(doc.manifestVersion, ROLE_PACK_VERSION)
  assert.deepEqual(doc.packs.map((x) => `${x.rolePackId}@${x.version}`), ['rp.dev@1.0.0'])
  assert.equal(doc.packs[0].contentHash, p.contentHash)
  // 七类的引用都在，且形如 id@version。
  assert.deepEqual(Object.keys(doc.packs[0].sections), [...ROLE_PACK_SECTIONS])
  assert.equal(doc.packs[0].sections.prompt, 'dev-base@3')
  assert.equal(doc.packs[0].sections.tools, 'tools.dev@1.2.0')
  assert.deepEqual(doc.packs[0].sections.connectors, [])
  assert.deepEqual(doc.packs[0].sections.skills, ['skill.diff@1.0.0'])
  // 白名单：不许出现凭证类字段名，也不许把整包 dump 出去。
  for (const forbidden of ['token', 'secret', 'password', 'apiKey', 'credentials']) {
    assert.equal(new RegExp(`"${forbidden}"`, 'i').test(text), false, `导出里出现了 ${forbidden}`)
  }
  assert.equal(text.includes('"pack"'), false, '导出把整包 dump 出去了')
})

test('⑦ 导出在空库上也能用，且给出真实的 0（不是缺字段）', () => {
  const db = freshDb()
  const doc = JSON.parse(exportRolePacks({ db }))
  assert.deepEqual(doc.packs, [])
  assert.equal(doc.counts.total, 0)
  assert.equal(doc.counts.readable, true)
})

test('⑦ 读不出来时导出抛 500，而不是导出一份空文档', () => {
  // ★ 一条"读失败就当没有"的导出，与一条"报 200 + 空清单"的导出，
  //   在 review 的人眼里是同一个东西——他会以为这个空间真的没冻过岗位。
  const broken = { prepare: () => { throw new Error('库打不开') } }
  const err = throwsCode(() => exportRolePacks({ db: broken }), ROLE_PACK_STORE_ERRORS.READ_FAILED)
  assert.equal(err.statusCode, 500)
})

// ---------------------------------------------------------------------------
// ⑧ 结构级：这张表只追加
// ---------------------------------------------------------------------------

test('⑧ ★★★ 本模块里**没有**任何 `UPDATE role_packs` / `DELETE FROM role_packs`', () => {
  const src = readFileSync(join(HERE, 'role-pack-store.mjs'), 'utf8')
  // ★ 必须先剥掉注释再扫。否则**论证这段话本身的注释**会被自己的检查命中：
  //   第一次跑这个用例就是红的，而红的原因是文件头写着"本模块不出现 UPDATE ..."。
  //   一条把散文当成代码扫的结构级检查，与一条随机红的检查，在值班的人眼里
  //   是同一个东西——他学会的是"这条偶尔会红"，而不是"这条在保护什么"。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
  // 文件头 ③ 把"投影列不是第二份真相"的论证完全建立在"只追加、无 UPDATE 路径"上。
  // 那条论证一旦被一条 UPDATE 打破，投影列就真的会与包本身漂移——
  // 而**没有任何东西能判定谁对**。
  const upd = [...code.matchAll(/UPDATE\s+role_packs/gi)]
  const del = [...code.matchAll(/DELETE\s+FROM\s+role_packs/gi)]
  assert.deepEqual(upd.map((m) => m[0]), [], '出现了 UPDATE role_packs')
  assert.deepEqual(del.map((m) => m[0]), [], '出现了 DELETE FROM role_packs')
  // ★ 反向验证剥离本身有效：注释里**确实**有这些字，而剥离后没有。
  //   否则"扫不到"可能只是因为剥离把整段代码吃掉了。
  assert.match(src, /UPDATE role_packs/, '注释锚点不见了——剥离检查失去了意义')
  assert.equal(/UPDATE\s+role_packs/i.test(code), false)
  // 也确认建表用的是 IF NOT EXISTS（否则并发启动会崩在模块加载期）。
  assert.match(src, /CREATE TABLE IF NOT EXISTS role_packs/)
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_role_packs_role/)
  assert.match(src, /CREATE INDEX IF NOT EXISTS idx_role_packs_hash/)
})

test('⑧ ★ 建表是幂等的：连跑两次不抛（两个进程同时启动）', () => {
  const db = new DatabaseSync(':memory:')
  ensureRolePackSchema(db)
  ensureRolePackSchema(db)
  assert.equal(rolePackCounts({ db }).readable, true)
})

test('⑧ `normalizeRolePackRecord` 是纯函数：同样的输入给同样的输出', () => {
  const p = realPack()
  const a = normalizeRolePackRecord({ pack: p, frozenAtMs: 5, frozenBy: 'x' })
  const b = normalizeRolePackRecord({ pack: p, frozenAtMs: 5, frozenBy: 'x' })
  assert.deepEqual(a, b)
  assert.equal(Object.isFrozen(a), true)
  // 也接受"裸包"（不带 provenance 包装），因为最常见的调用方手上就是一份包。
  const c = normalizeRolePackRecord(p)
  assert.equal(c.pack.contentHash, p.contentHash)
  assert.equal(c.frozenBy, null)
})

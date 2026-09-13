// team-hub/context-plan-store.test.mjs
// ============================================================================
// PRT-402 的数据面：TeamPlan（冻结）与 EmployeeManifest（活的）
//
// ## 本套件守的三条
//
//   ① **TeamPlan 是冻结的**：同版重写要么幂等、要么 409。允许原地改写，
//      历史运行指向的就会是**今天的**计划，而它看起来完全正常。
//   ② **EmployeeManifest 的 `version` 由服务端递增**：`sources.mjs` 拿它当来源
//      版本，所以"边界变过没有"直接决定快照哈希。让调用方填 version，
//      一次边界变更就**不改变**快照哈希——两份内容不同的上下文被认成同一份。
//   ③ **写入前查明文密钥，命中就拒收（fail closed）**：这两张表的内容会**逐字**
//      进模型上下文并被发给供应商。所以它不是"存在本地库里"，比日志里出现密钥
//      严重一级——日志在本机、能删能轮换；发出去撤不回来。
//
// ## 为什么成套起**真的库**（而不是内存假库）
//
// 这里的全部工作就是 SQL：复合主键、`MAX(version)` 分组、UPSERT 的乐观递增。
// 一个手写的假 db 只会测出"我的假 db 按我写的规则工作"——而真正会错的那一半
// （主键写成了单列？`ORDER BY version DESC` 少了？）一行都没执行。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  CONTEXT_PLAN_ERRORS, ContextPlanError, createContextPlanStore, ensureContextPlanSchema,
  normalizeEmployeeManifest, normalizeTeamPlan,
} from './context-plan-store.mjs'

/** 每个用例一个**全新的内存库**：用例之间不共享状态，失败不会串味。 */
function fresh({ clock = () => 1000, db = null } = {}) {
  const database = db ?? new DatabaseSync(':memory:')
  ensureContextPlanSchema(database)
  const audits = []
  const store = createContextPlanStore({ db: database, clock, writeAudit: (p) => audits.push(p) })
  return { db: database, store, audits }
}

const PLAN = (over = {}) => ({
  id: 'tp1', version: 1, goalId: 'g1', title: '计划', objective: '做成', stages: ['dev', 'review'], ...over,
})

// ── ① TeamPlan 冻结 ───────────────────────────────────────────────────────

test('★ 冻结一版计划：按 (scope, id, version) 存下来', () => {
  const { store } = fresh()
  const r = store.putTeamPlan(PLAN(), { scope: 'default' })
  assert.equal(r.ok, true)
  assert.equal(r.idempotent, false)
  const p = store.readTeamPlan('tp1', { scope: 'default' })
  assert.equal(p.version, 1)
  assert.equal(p.goalId, 'g1')
  assert.deepEqual(p.stages, [{ role: 'dev' }, { role: 'review' }])
})

test('★★ 同版同内容重写 → 幂等（不是 409）', () => {
  // 重跑一次同样的写入是**正常路径**（脚本重试、两个进程同时启动）。
  // 把它判成冲突会让调用方无法安全重试——而它要做的事本来就没有副作用。
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default' })
  const again = store.putTeamPlan(PLAN(), { scope: 'default' })
  assert.equal(again.ok, true)
  assert.equal(again.idempotent, true)
  assert.equal(again.plan.version, 1)
})

test('★★ 同版**不同内容** → PLAN_FROZEN 409，且带上 id/version', () => {
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default' })
  assert.throws(
    () => store.putTeamPlan(PLAN({ stages: ['dev'] }), { scope: 'default' }),
    (e) => {
      assert.ok(e instanceof ContextPlanError)
      assert.equal(e.code, CONTEXT_PLAN_ERRORS.PLAN_FROZEN)
      // 409 而不是 400：请求本身是合法的，是**状态**不允许——
      // 调用方该做的是发新版本，不是改请求语法。
      assert.equal(e.statusCode, 409)
      // ★ 必须带上 id/version。不带的话调用方只有一句"已经冻结"，
      //   而它要做的是发一个**新**版本——那需要知道当前冻到第几版。
      assert.equal(e.id, 'tp1')
      assert.equal(e.version, 1)
      return true
    },
  )
  // 关键：拒绝之后旧的那一版**一个字没变**
  assert.deepEqual(store.readTeamPlan('tp1', { scope: 'default' }).stages, [{ role: 'dev' }, { role: 'review' }])
})

test('★ 改计划要先发新版本：旧版本仍在（历史运行指向的那一版没被改写）', () => {
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default' })
  store.putTeamPlan(PLAN({ version: 2, stages: ['dev'] }), { scope: 'default' })
  assert.deepEqual(store.teamPlanVersions('tp1', { scope: 'default' }), [1, 2])
  // 按 version 取回第一版：内容还是当时那一份
  assert.deepEqual(store.readTeamPlan('tp1', { scope: 'default', version: 1 }).stages, [{ role: 'dev' }, { role: 'review' }])
  // 不给 version 取**最新**一版
  assert.equal(store.readTeamPlan('tp1', { scope: 'default' }).version, 2)
})

test('★★ 按 goalId 取到的是**最新**一版（运行的当下该看的那一份）', () => {
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default' })
  store.putTeamPlan(PLAN({ version: 2 }), { scope: 'default' })
  assert.equal(store.readTeamPlan(null, { scope: 'default', goalId: 'g1' }).version, 2)
})

test('★ 计划是**按空间隔离**的：同名 id 在别的空间里互不可见', () => {
  // 隔离不是洁癖：`scope` 就是权限的参照，跨空间读到一份计划
  // 等于把另一个团队的岗位序列递给模型。
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'space-a' })
  assert.equal(store.readTeamPlan('tp1', { scope: 'space-b' }), null)
  assert.equal(store.readTeamPlan('tp1', { scope: 'space-a' }).version, 1)
})

test('★ 取不到 → `null`（由路由翻成 404，再由装配器翻成 missing 候选）', () => {
  const { store } = fresh()
  assert.equal(store.readTeamPlan('nope', { scope: 'default' }), null)
  assert.equal(store.readTeamPlan(null, { scope: 'default', goalId: 'nope' }), null)
  // 一个 id 也没给、一个 goalId 也没给：**不猜**，返回 null
  assert.equal(store.readTeamPlan(null, { scope: 'default' }), null)
})

test('★ `listTeamPlans` 每个 id 只给最新一版（界面看到的是当前状态，不是版本史）', () => {
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default' })
  store.putTeamPlan(PLAN({ version: 2 }), { scope: 'default' })
  store.putTeamPlan(PLAN({ id: 'tp2' }), { scope: 'default' })
  const list = store.listTeamPlans({ scope: 'default' })
  assert.equal(list.length, 2, '两个 id → 两条，不是三条')
  assert.deepEqual([...list.map((p) => p.version)].sort(), [1, 2])
})

// ── ② 输入归一化 ──────────────────────────────────────────────────────────

test('★ 计划必须有 id / version / stages —— 三条都给得出具体原因', () => {
  const cases = [
    [{ version: 1, stages: [] }, 'id'],
    [{ id: 'a', stages: [] }, 'version'],
    [{ id: 'a', version: 1 }, 'stages'],
    [{ id: 'a', version: 0, stages: [] }, 'version'],
    [{ id: 'a', version: 1.5, stages: [] }, 'version'],
    [{ id: 'a', version: 1, stages: 'x' }, 'stages'],
    [{ id: 'a', version: 1, stages: [''] }, 'stages'],
    [{ id: 'a', version: 1, stages: [{}] }, 'stages'],
    [{ id: '  ', version: 1, stages: [] }, 'id'],
  ]
  for (const [input, field] of cases) {
    assert.throws(
      () => normalizeTeamPlan(input),
      (e) => e.code === CONTEXT_PLAN_ERRORS.PLAN_INVALID && e.field === field,
      `${JSON.stringify(input)} 应在 ${field} 上被拒`,
    )
  }
})

test('★ 计划无 version 时**不默认成 1**：冻结是按版本冻的，没有版本就没有"冻的是哪一份"', () => {
  // 一个默认成 1 的 version，会让第二次提交**静默地**覆盖第一次——
  // 而它看起来只是一次普通的保存。
  assert.throws(() => normalizeTeamPlan({ id: 'a', stages: [] }),
    (e) => e.field === 'version')
})

test('★ 岗位清单必须有 employeeId，**不从 role 兜底**', () => {
  // employeeId 会进快照的 `associations.employeeId`，而那是"这次运行是谁在干"
  // 的答案。拿 role 兜底会把一个**猜测**写进那个人人都会看的字段里。
  assert.throws(
    () => normalizeEmployeeManifest({ role: 'dev' }),
    (e) => e.code === CONTEXT_PLAN_ERRORS.MANIFEST_INVALID && e.field === 'employeeId',
  )
})

test('★ 清单的数组字段：**不是数组就报错**，不把单值悄悄包起来', () => {
  for (const [field, value] of [['allowedTools', 'read'], ['deniedTools', 'deploy'], ['responsibilities', '写代码']]) {
    assert.throws(
      () => normalizeEmployeeManifest({ role: 'dev', employeeId: 'e1', [field]: value }),
      (e) => e.code === CONTEXT_PLAN_ERRORS.MANIFEST_INVALID && e.field === field,
      `${field} 应被拒`,
    )
  }
  // 不给 → 空数组（"没配"与"配成空"在这里是同一件事，且都是安全的默认）
  const m = normalizeEmployeeManifest({ role: 'dev', employeeId: 'e1' })
  assert.deepEqual(m.allowedTools, [])
  assert.deepEqual(m.limits, {})
})

test('★ 清单的 limits 必须是对象（不是数组、不是字符串）', () => {
  for (const limits of [[], 'x', 3]) {
    assert.throws(() => normalizeEmployeeManifest({ role: 'dev', employeeId: 'e1', limits }),
      (e) => e.code === CONTEXT_PLAN_ERRORS.MANIFEST_INVALID)
  }
})

// ── ③ EmployeeManifest 是活的，version 由服务端递增 ─────────────────────

test('★★ `version` 由服务端递增 —— 调用方**给什么都不算数**', () => {
  const { store } = fresh()
  const a = store.putEmployeeManifest({ role: 'dev', employeeId: 'e1', version: 99 }, { scope: 'default' })
  assert.equal(a.created, true)
  assert.equal(a.manifest.version, 1, '第一次是 1，与我传的 99 无关')

  const b = store.putEmployeeManifest({ role: 'dev', employeeId: 'e1', version: 1 }, { scope: 'default' })
  assert.equal(b.created, false)
  assert.equal(b.manifest.version, 2, '第二次是 2，与"我传了 1"无关')

  // 递减也无效
  const c = store.putEmployeeManifest({ role: 'dev', employeeId: 'e1', version: -5 }, { scope: 'default' })
  assert.equal(c.manifest.version, 3)
})

test('★★ 内容变了 → version 必须变（快照哈希靠它分辨"边界变过没有"）', () => {
  // `sources.mjs` 用 `manifest.version ?? manifest.updatedAtMs` 当来源版本。
  // 若一次边界变更**不改变** version，两份内容不同的上下文会被认成同一份。
  const { store } = fresh()
  const before = store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default' }).manifest
  const after = store.putEmployeeManifest(
    { role: 'dev', employeeId: 'e1', allowedTools: ['deploy'] }, { scope: 'default' },
  ).manifest
  assert.equal(after.allowedTools.includes('deploy'), true)
  assert.notEqual(after.version, before.version, '边界变过，version 必须变')
})

test('★ 清单按 (scope, role) 唯一：同一岗位只有一份（不是一份历史）', () => {
  const { store } = fresh()
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default' })
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default' })
  assert.equal(store.listEmployeeManifests({ scope: 'default' }).length, 1)
})

test('★ 按 role 与按 employeeId 都取得到，且**按空间隔离**', () => {
  const { store } = fresh()
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'space-a' })
  assert.equal(store.readEmployeeManifest({ scope: 'space-a', role: 'dev' }).employeeId, 'e1')
  assert.equal(store.readEmployeeManifest({ scope: 'space-a', employeeId: 'e1' }).role, 'dev')
  assert.equal(store.readEmployeeManifest({ scope: 'space-b', role: 'dev' }), null)
  assert.equal(store.readEmployeeManifest({ scope: 'space-b', employeeId: 'e1' }), null)
})

test('★ role 与 employeeId 都不给 → `null`（**不猜**：随便给一份会让模型照别人的边界干活）', () => {
  const { store } = fresh()
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default' })
  assert.equal(store.readEmployeeManifest({ scope: 'default' }), null)
  assert.equal(store.readEmployeeManifest({ scope: 'default', role: '', employeeId: '  ' }), null)
})

// ── ④ 明文密钥 fail closed ───────────────────────────────────────────────

test('★★★ 计划里出现疑似明文密钥 → 拒收，且**库里一行都不留**', () => {
  const { store, db } = fresh()
  assert.throws(
    // 值**整个**是一个密钥形态（`^sk-…$`）→ 命中
    () => store.putTeamPlan(PLAN({ note: 'sk-live-abcdefghijklmnopqrstuvwxyz' }), { scope: 'default' }),
    (e) => e.code === CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
  )
  assert.throws(
    // ★ `apiKey` **不是** TeamPlan 的字段——归一化会把它**丢掉**。
    //   所以这条断言检验的其实是"检查跑在归一化**之前**"：
    //   只查归一化后的对象时，这里什么都看不到（运行时实测过）。
    //
    //   丢掉当然比存下来安全，但**静默丢掉**是最坏的处置：调用方提交了一个
    //   密钥、收到 200、以为它存下了。而它该收到的是"你在往计划里塞密钥"。
    //   值与密钥形态无关（`anything-at-all`）——命中的是**键名**。
    () => store.putTeamPlan(PLAN({ objective: 'x', apiKey: 'anything-at-all' }), { scope: 'default' }),
    (e) => e.code === CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
  )
  // ★ 拒收而不是脱敏：脱敏是过滤器，只能拦下它认得的形态，而模式表是有限的。
  //   更要紧的是"拒收"必须是**真的没写**——写了一半再报错比不写更坏。
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_plans').get().n, 0)
})

test('★★★ 岗位清单里出现疑似明文密钥 → 拒收（这段内容会被**发给供应商**）', () => {
  const { store, db } = fresh()
  assert.throws(
    () => store.putEmployeeManifest(
      { role: 'dev', employeeId: 'e1', limits: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz' } },
      { scope: 'default' },
    ),
    (e) => e.code === CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_manifests').get().n, 0)
})

test('★ 明文检查在**更新**路径上也生效（旧行不被覆盖成含密的版本）', () => {
  const { store } = fresh()
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default' })
  assert.throws(
    () => store.putEmployeeManifest(
      // 整段 responsibilities 里有一个**整个**是密钥形态的元素 → 命中
      { role: 'dev', employeeId: 'e1', responsibilities: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'] },
      { scope: 'default' },
    ),
    (e) => e.code === CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
  )
  // 旧的那一份**原样还在**，version 没有前进
  const cur = store.readEmployeeManifest({ scope: 'default', role: 'dev' })
  assert.equal(cur.version, 1)
  assert.deepEqual(cur.responsibilities, [])
})

test('★★★ 岗位清单里**未知字段**的密钥也被拒（归一化会丢掉它，检查必须在归一化之前）', () => {
  // 这条与上面"计划里未知字段"那条是**同一性质在清单上的一遍**——
  // 而它是断验证探针⑨逼出来的：我先只给计划加了这条用例，
  // 于是"清单的 raw 那一遍"没有任何东西在守（把 raw 换成 null，fail=0）。
  //
  //   > 一个"只对两个同构路径中的一个加了用例"的覆盖，
  //   > 与一个"两条路径都没加"的覆盖，在两条路径都还没出过事的时候是同一个东西——
  //   > 只不过前者会让人以为这条性质**已经**被守住了。
  const { store, db } = fresh()
  assert.throws(
    // `apiKey` 不是 EmployeeManifest 的字段，归一化会丢掉它。
    () => store.putEmployeeManifest(
      { role: 'dev', employeeId: 'e1', apiKey: 'anything-at-all' },
      { scope: 'default' },
    ),
    (e) => e.code === CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM employee_manifests').get().n, 0)
})

test('⚠️ 边界：明文检查抓的是**键名**与**整个值**，不是子串扫描', () => {
  // 这条**不是**在庆祝一个性质，是在把一条既有的边界钉成可执行的断言。
  //
  // `findPlaintextSecrets` 的判据有两条：① 键名像密钥载体、且值是字符串；
  // ② **整个**字符串匹配一个密钥前缀形态（`^sk-…$` 这类，带锚点）。
  // 于是下面这段**会通过**：
  //
  //     note: '把 key: sk-live-abc… 记在这里'
  //
  // 而这两张表的内容会**逐字**进模型上下文并被发给供应商。
  // 也就是说：**把一个密钥粘进自由文本字段，这条检查拦不住。**
  //
  //   > 一个"只认键名与整个值"的明文检查，
  //   > 与一个"扫描子串"的明文检查，在密钥被规规矩矩放在 `apiKey` 字段里时
  //   > 是同一个东西——只不过前者拦不住那条最可能真实发生的路径：
  //   > 有人把密钥连同上下文一起粘进 `note`。
  //
  // 不做子串扫描是一个**有意的取舍**（误报会让正常文本写不进去），
  // 但那条取舍的代价必须写在这里，而不是等它发生。
  const { store } = fresh()
  const sneaky = '把 key: sk-live-abcdefghijklmnopqrstuvwxyz 记在这里'
  const r = store.putTeamPlan(PLAN({ note: sneaky }), { scope: 'default' })
  assert.equal(r.ok, true)
  assert.equal(store.readTeamPlan('tp1', { scope: 'default' }).note, sneaky)
  // 与"整个值是密钥"那条对照：同样的字符串，去掉前缀文字就命中
  assert.throws(
    () => store.putTeamPlan(PLAN({ id: 'tp2', note: 'sk-live-abcdefghijklmnopqrstuvwxyz' }), { scope: 'default' }),
    (e) => e.code === CONTEXT_PLAN_ERRORS.PLAINTEXT_SECRET,
  )
})

// ── ⑤ 审计 ────────────────────────────────────────────────────────────────

test('★ 写入留审计，且动作名区分 freeze / create / update', () => {
  const { store, audits } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default', actor: 'alice' })
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default', actor: 'alice' })
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default', actor: 'alice' })
  assert.deepEqual(audits.map((a) => a.action), ['team-plan.freeze', 'employee-manifest.create', 'employee-manifest.update'])
  for (const a of audits) assert.equal(a.actor, 'alice')
  // 幂等那次**不写审计**：没有发生写入，而一条"冻结了"的审计会让人以为改过什么
  audits.length = 0
  store.putTeamPlan(PLAN(), { scope: 'default', actor: 'alice' })
  assert.equal(audits.length, 0)
})

test('★ 审计载荷本身也过明文检查（与写入路径**同一个**判据）', () => {
  // 审计照写需要脱敏逻辑，而脱敏逻辑正是最容易漏的那一环。
  // 这里让 `writeAudit` 抛错，验证 store 真的把审计**当成写入的一部分**对待：
  // 审计写不出去，那次写入就不该被报成成功。
  const db = new DatabaseSync(':memory:')
  ensureContextPlanSchema(db)
  const store = createContextPlanStore({
    db, clock: () => 1000,
    writeAudit: () => { throw new Error('审计写不出去') },
  })
  assert.throws(() => store.putTeamPlan(PLAN(), { scope: 'default' }), /审计写不出去/)
})

// ── ⑥ 契约边界 ────────────────────────────────────────────────────────────

test('★ 构造期就拒绝坏依赖（接线错误不能推迟到某次运行）', () => {
  assert.throws(() => createContextPlanStore({}), TypeError)
  assert.throws(() => createContextPlanStore({ db: new DatabaseSync(':memory:'), clock: 5 }), TypeError)
})

test('★ 缺 scope → SCOPE_UNKNOWN（不是"默默用 default"）', () => {
  // 默认一个空间名，等于让一次**越权读**看起来像一次正常读。
  const { store } = fresh()
  for (const call of [
    () => store.putTeamPlan(PLAN(), {}),
    () => store.readTeamPlan('tp1', {}),
    () => store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, {}),
    () => store.readEmployeeManifest({}),
  ]) {
    assert.throws(call, (e) => e.code === CONTEXT_PLAN_ERRORS.SCOPE_UNKNOWN)
  }
})

test('★ `counts()` 两个数分开给（`teamPlanVersions` 与 `teamPlans` 是同一张表，但含义不同）', () => {
  const { store } = fresh()
  store.putTeamPlan(PLAN(), { scope: 'default' })
  store.putTeamPlan(PLAN({ version: 2 }), { scope: 'default' })
  store.putEmployeeManifest({ role: 'dev', employeeId: 'e1' }, { scope: 'default' })
  assert.deepEqual(store.counts(), { teamPlans: 2, teamPlanVersions: 2, employeeManifests: 1 })
})

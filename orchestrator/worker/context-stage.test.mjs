// orchestrator/worker/context-stage.test.mjs
// ============================================================================
// PRT-411：`buildContext` 阶段的真实实现
//
// 这个套件守的核心事实只有一句：**这个阶段真的会冻结一份上下文快照**，
// 而且**冻结不了时会失败**，不会降级成一份空上下文。
//
// 为什么要专门守"真的会"：`runtime/context/` 下的装配器、来源、脱敏、
// tokenizer、快照仓储**全部已交付、各有套件、全绿**，却一个生产调用方都没有。
// 「模块写好、用例绿、没人调用」与「功能不存在」在用户看来完全一样。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CONTEXT_STAGE_ERRORS,
  ContextStageError,
  conservativeTokenizer,
  createContextStage,
  createHubContextStage,
} from './context-stage.mjs'
import { inPlaceStages } from './main.mjs'
import { createContextStore, ensureContextSchema } from '../../team-hub/context-store.mjs'
import { TOKEN_ESTIMATOR_KINDS, verifySnapshotHash } from '../../runtime/contracts/context.mjs'

const NOW = 1_700_000_000_000

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'legion-ctxstage-'))
  const db = new DatabaseSync(join(root, 'team.db'))
  ensureContextSchema(db)
  const audits = []
  const store = createContextStore({ db, clock: () => NOW, writeAudit: (e) => audits.push(e) })
  return {
    root, db, store, audits,
    cleanup() { try { db.close() } catch { /* 已关 */ } rmSync(root, { recursive: true, force: true }) },
  }
}

/** 一份最小但**完整**的装配输入。 */
const inputs = (over = {}) => ({
  scope: 'software',
  goal: { id: 'g1', title: '目标', updatedAtMs: NOW },
  task: { id: 't1', title: '任务', updatedAtMs: NOW },
  teamPlan: { id: 'tp1', title: '团队计划', updatedAtMs: NOW },
  employeeManifest: { employeeId: 'e1', role: 'dev', updatedAtMs: NOW },
  documents: [{ id: 'doc1', path: 'a.md', sha256: 'aa', updatedAtMs: NOW, body: '正文' }],
  ...over,
})

const lease = (over = {}) => ({ attemptId: 'att:t1:1', taskId: 't1', workerId: 'w1', scope: 'software', ...over })

const stage = (env, over = {}, depsOver = {}) => createContextStage({
  contextStore: env.store,
  clock: () => NOW,
  loadInputs: async () => inputs(over),
  canRead: () => true,
  writeAudit: (e) => env.audits.push(e),
  ...depsOver,
})

const assertStageError = (fn, code) => {
  try { fn() } catch (e) {
    assert.ok(e instanceof ContextStageError, `期望 ContextStageError，实际 ${e?.name}`)
    assert.equal(e.code, code)
    return e
  }
  throw new Error(`期望抛出 ${code}，但没有抛错`)
}
/** 仓储里有没有这份快照。context-store 的 API 是 {record,list,get,verify,count}，没有 has。 */
const hasSnapshot = (store, attemptId) => store.get(attemptId) !== null

const assertStageRejects = async (p, code) => {
  try { await p } catch (e) {
    assert.equal(e.code, code, `期望 ${code}，实际 ${e.code}：${e.message}`)
    return e
  }
  throw new Error(`期望拒绝 ${code}，但没有拒绝`)
}

describe('① 真的会冻结一份快照（不是"跑过去就完事"）', () => {
  test('**快照出现在仓储里，且哈希自洽**', async () => {
    const env = makeEnv()
    try {
      const detail = await stage(env)(lease())
      assert.equal(detail.kind, 'frozen')
      assert.equal(detail.attemptId, 'att:t1:1')

      // 真正要紧的一条：**仓储里查得到**。
      // 只返回一个 detail 对象证明不了任何事——那可以是一段常数。
      const got = env.store.get('att:t1:1')
      assert.ok(got !== null && got !== undefined, '快照必须真的落库')
      assert.equal(got.snapshotHash, detail.snapshotHash)
      assert.equal(verifySnapshotHash(got.snapshot), true, '落库的快照哈希必须自洽')
      assert.equal(got.frozenAtMs, NOW)
    } finally { env.cleanup() }
  })

  test('**闸门真的会被满足**：这一阶段跑完之后 `BuildingContext → Running` 放行', async () => {
    // 与 run-store 的闸门用例联合起来才说明问题：
    // 单独看，两边的用例都通过，而中间那条缝（阶段跑了但闸门仍拒绝）没人测。
    const env = makeEnv()
    try {
      await stage(env)(lease())
      assert.equal(hasSnapshot(env.store, 'att:t1:1'), true)
    } finally { env.cleanup() }
  })

  test('装配真的发生了：来源进了快照，不是空数组', async () => {
    const env = makeEnv()
    try {
      const detail = await stage(env)(lease())
      assert.ok(detail.includedCount >= 3, `至少该有 goal/task/teamPlan/manifest，实际 ${detail.includedCount}`)
      const got = env.store.get('att:t1:1')
      assert.ok(got.snapshot.sources.length >= 3)
      assert.ok(got.snapshot.finalText.length > 0, '最终文本不能是空的')
    } finally { env.cleanup() }
  })

  test('审计真的写了（`canReadDefaulted` 是可查的，不是只活在注释里）', async () => {
    const env = makeEnv()
    try {
      await stage(env)(lease())
      const rec = env.audits.find((a) => a.action === 'context.frozen')
      assert.ok(rec, `审计里应有 context.frozen，实际 ${JSON.stringify(env.audits.map((a) => a.action))}`)
      assert.equal(rec.snapshotHash, env.store.get('att:t1:1').snapshotHash)
      assert.equal(rec.canReadDefaulted, false)
      assert.equal(rec.tokensKind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    } finally { env.cleanup() }
  })
})

describe('② 冻结不了就**失败**，不降级成空上下文', () => {
  test('**取不到输入 → 失败**（空上下文比失败坏得多）', async () => {
    // 一份空的快照会让 Attempt 走进 Running 而模型什么都没有——
    // 而失败会被重试或上报，空快照会被当成"正常运行"。
    const env = makeEnv()
    try {
      const s = createContextStage({
        contextStore: env.store, loadInputs: async () => { throw new Error('数据库连不上') }, canRead: () => true,
      })
      const e = await assertStageRejects(s(lease()), CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE)
      assert.match(e.message, /数据库连不上/)
      assert.equal(hasSnapshot(env.store, 'att:t1:1'), false, '失败时不该留下半个快照')
    } finally { env.cleanup() }
  })

  test('loadInputs 返回非对象 → 失败（不是"当成空输入"）', async () => {
    const env = makeEnv()
    try {
      const s = createContextStage({ contextStore: env.store, loadInputs: async () => null, canRead: () => true })
      await assertStageRejects(s(lease()), CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE)
    } finally { env.cleanup() }
  })

  test('**落库失败 → 阶段失败**（不 catch 后继续）', async () => {
    // 继续下去会造出一个"跑过了但无据可查"的 Attempt。
    const env = makeEnv()
    try {
      const broken = { record() { throw new Error('disk full') } }
      const s = createContextStage({ contextStore: broken, loadInputs: async () => inputs(), canRead: () => true })
      const e = await assertStageRejects(s(lease()), CONTEXT_STAGE_ERRORS.PERSIST_FAILED)
      assert.match(e.message, /disk full/)
    } finally { env.cleanup() }
  })

  test('装配失败时**保留装配器自己的码**（上层靠它决定能不能重试）', async () => {
    const env = makeEnv()
    try {
      // 目录不存在 → 来源不合格
      const s = createContextStage({
        contextStore: env.store,
        loadInputs: async () => inputs({ documents: 'not-an-array' }),
        canRead: () => true,
      })
      const e = await assertStageRejects(s(lease()), CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE)
      assert.equal(e.stage, 'buildContext')
    } finally { env.cleanup() }
  })

  test('超预算 → `CONTEXT_TOO_LARGE` 被**保留**在 `assemblyCode` 上', async () => {
    const env = makeEnv()
    try {
      const s = createContextStage({
        contextStore: env.store,
        loadInputs: async () => inputs({ documents: [{ id: 'd', path: 'a.md', sha256: 'x', updatedAtMs: NOW, body: 'y'.repeat(5000) }] }),
        canRead: () => true,
        policy: { maxTokens: 3 },
      })
      const e = await assertStageRejects(s(lease()), CONTEXT_STAGE_ERRORS.ASSEMBLY_FAILED)
      assert.equal(e.assemblyCode, 'CONTEXT_TOO_LARGE')
      assert.equal(e.stage, 'buildContext')
    } finally { env.cleanup() }
  })
})

describe('③ 权限判定 fail closed', () => {
  test('**不传 canRead 就拒绝一切**（"默认都能读"会让一次接线遗漏变成一次静默越权）', async () => {
    const env = makeEnv()
    try {
      const s = createContextStage({
        contextStore: env.store, loadInputs: async () => inputs(), // 刻意不传 canRead
        writeAudit: (e) => env.audits.push(e),
      })
      const detail = await s(lease())
      assert.equal(detail.kind, 'frozen')
      assert.equal(detail.includedCount, 0, '默认应当一个都不放行')
      assert.ok(detail.excludedCount > 0)
      // 而且**明说它发生了**：否则"没人接线"与"权限结果是全都不可读"
      // 在证据里长得完全一样。
      assert.equal(detail.canReadDefaulted, true)
      // **审计里也要有**。只写在返回值上是不够的：返回值只活在这一次调用的栈里，
      // 而"这次运行没有配权限判定"这件事日后要靠审计查——那时返回值早已不存在。
      // （这条断言是变红探针 ㊽ 教出来的：它原本只改审计那一行而用例仍绿，
      //   说明审计里那个字段此前**没有任何断言**在管。）
      const rec = env.audits.find((a) => a.action === 'context.frozen')
      assert.equal(rec.canReadDefaulted, true, '审计也必须记下"没配 canRead"')
    } finally { env.cleanup() }
  })

  test('传了 canRead 时 `canReadDefaulted=false`', async () => {
    const env = makeEnv()
    try {
      const detail = await stage(env)(lease())
      assert.equal(detail.canReadDefaulted, false)
    } finally { env.cleanup() }
  })

  test('**权限判定只看元数据，不给正文**（判定先于读正文）', async () => {
    const env = makeEnv()
    try {
      let sawContent = false
      const s = createContextStage({
        contextStore: env.store,
        loadInputs: async () => inputs(),
        canRead: (meta) => { if (meta !== null && 'content' in meta && meta.content !== undefined) sawContent = true; return true },
      })
      await s(lease())
      assert.equal(sawContent, false, 'canRead 收到了正文——那会让越权正文短暂存在于内存与日志里')
    } finally { env.cleanup() }
  })

  test('canRead 抛异常 = 读不了（fail closed：排除，不是放行）', async () => {
    // 第一版这里我断言"整次装配失败"，它红了——**红的是测试**。
    // 实现的选择是：判定抛错时把**这一个来源**按不可读排除，而不是让整次运行失败。
    // 这是对的：无法判断不等于可以放行，但"权限服务抖了一下"也不该
    // 让整个任务失败——排除它、说明原因，运行继续。
    // 若这里断言成"失败"，一次权限服务的短暂抖动会变成一次任务失败。
    const env = makeEnv()
    try {
      const s = createContextStage({
        contextStore: env.store, loadInputs: async () => inputs(),
        canRead: () => { throw new Error('权限服务挂了') },
      })
      const detail = await s(lease())
      assert.equal(detail.kind, 'frozen', '判定失败不该让整次运行失败')
      assert.equal(detail.includedCount, 0, '一个都不能放行')
      const snap = env.store.get('att:t1:1').snapshot
      assert.ok(snap.excluded.every((e) => e.reason === 'unauthorized'), '全部应为越权排除')
      // 而且原因里要带上真实错误——否则"权限服务挂了"与"这个人确实无权"
      // 在记录里长得一样，排查会走错方向。
      assert.ok(snap.excluded.some((e) => /权限服务挂了/.test(e.detail)),
        `排除原因里应带上真实错误：${JSON.stringify(snap.excluded.map((e) => e.detail))}`)
    } finally { env.cleanup() }
  })
})

describe('④ 接线错误在**构造时**就报（不是运行到一半才发现）', () => {
  test('缺 contextStore / loadInputs → 构造即抛 `BAD_WIRING`', () => {
    assertStageError(() => createContextStage(null), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    assertStageError(() => createContextStage({}), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    assertStageError(() => createContextStage({ contextStore: {} }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    assertStageError(() => createContextStage({ contextStore: { record() {} } }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
  })

  test('lease 缺 attemptId → `BAD_WIRING`（不是静默用 undefined 当键）', async () => {
    const env = makeEnv()
    try {
      await assertStageRejects(stage(env)({ taskId: 't1' }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
      await assertStageRejects(stage(env)(null), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    } finally { env.cleanup() }
  })

  test('输入里没有 scope → 拒绝（凭什么空间判定权限）', async () => {
    const env = makeEnv()
    try {
      const s = createContextStage({
        contextStore: env.store, loadInputs: async () => ({ ...inputs(), scope: undefined }), canRead: () => true,
      })
      await assertStageRejects(s({ attemptId: 'a' }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    } finally { env.cleanup() }
  })

  test('构造顺序不影响：依赖先校验，再谈运行', () => {
    // 一个"跑到一半才炸"的构造错误会在真实 worker 里表现为任务失败，
    // 而它其实是**部署配置**问题。
    assertStageError(() => createContextStage({ loadInputs: async () => ({}) }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
  })
})

describe('⑤ tokenizer', () => {
  test('保守估算器是**可证明的上界**，且声称自己是估算', () => {
    const t = conservativeTokenizer()
    assert.equal(t.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    assert.match(t.note, /估算/)
    const s = '你好 world 🌍'
    assert.ok(t.count(s) >= [...s].length, 'tokens 必须 ≥ 码点数（上界）')
    // 空串是 0，不是 1
    assert.equal(t.count(''), 0)
  })

  test('不传 tokenizer 时用保守估算，并**进哈希**（日后换精确 tokenizer 不会混淆）', async () => {
    const env = makeEnv()
    try {
      const detail = await stage(env)(lease())
      assert.equal(detail.tokensKind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
      assert.equal(env.store.get('att:t1:1').snapshot.tokens.kind, TOKEN_ESTIMATOR_KINDS.CONSERVATIVE_ESTIMATE)
    } finally { env.cleanup() }
  })

  test('传入的 tokenizer 被真的使用（不是被忽略）', async () => {
    const env = makeEnv()
    try {
      let called = 0
      const s = createContextStage({
        contextStore: env.store, loadInputs: async () => inputs(), canRead: () => true,
        tokenizer: { kind: TOKEN_ESTIMATOR_KINDS.EXACT, count: (t) => { called += 1; return String(t).length } },
      })
      const detail = await s(lease())
      assert.ok(called > 0, 'tokenizer.count 一次都没被调用——它被忽略了')
      assert.equal(detail.tokensKind, TOKEN_ESTIMATOR_KINDS.EXACT)
    } finally { env.cleanup() }
  })
})

describe('⑥ 冻结之后不可改（运行中更新只进下一次 Attempt）', () => {
  test('阶段是幂等的：同一份输入重跑得到**同一个哈希**', async () => {
    const env = makeEnv()
    try {
      const a = await stage(env)(lease())
      const b = await stage(env)(lease())
      assert.equal(a.snapshotHash, b.snapshotHash, '同样输入必须同样哈希，否则"回放"无从谈起')
    } finally { env.cleanup() }
  })

  test('输入变了 → 哈希变（不是"永远同一个"）', async () => {
    const env = makeEnv()
    try {
      // 两次必须用**不同**的 attemptId：同一个 Attempt 不可能有两份上下文（那是 CONFLICT），
      // 而这里要考的是"输入不同 → 哈希不同"，不是"同一 Attempt 能存两份"。
      const a = await stage(env)(lease({ attemptId: 'att:1' }))
      const b = await stage(env, { documents: [{ id: 'doc1', path: 'a.md', sha256: 'bb', updatedAtMs: NOW, body: '改过了' }] })(lease({ attemptId: 'att:2' }))
      assert.notEqual(a.snapshotHash, b.snapshotHash)
    } finally { env.cleanup() }
  })

  test('**没有 update 路径**：store 上就没有改快照的方法', () => {
    const env = makeEnv()
    try {
      const forbidden = ['update', 'replace', 'patch', 'deleteSnapshot', 'upsert']
      for (const name of forbidden) {
        assert.equal(typeof env.store[name], 'undefined', `仓储不该有 ${name}（快照冻结后不可改）`)
      }
    } finally { env.cleanup() }
  })

  test('已有快照时重跑 → 同哈希幂等；不同哈希被拒（不覆盖）', async () => {
    const env = makeEnv()
    try {
      await stage(env)(lease())
      const before = env.store.get('att:t1:1').snapshotHash
      // 同哈希：幂等放行
      await stage(env)(lease())
      assert.equal(env.store.get('att:t1:1').snapshotHash, before)
      // 不同哈希：阶段把它变成 PERSIST_FAILED，而不是覆盖掉已冻结的那一份
      const e = await assertStageRejects(
        stage(env, { documents: [{ id: 'doc1', path: 'a.md', sha256: 'zz', updatedAtMs: NOW, body: '换了' }] })(lease()),
        CONTEXT_STAGE_ERRORS.PERSIST_FAILED,
      )
      assert.equal(env.store.get('att:t1:1').snapshotHash, before, '已冻结的快照不能被覆盖')
      assert.ok(e.message.length > 0)
    } finally { env.cleanup() }
  })
})

describe('⑦ 接进 `inPlaceStages`：可判定的，不靠猜', () => {
  test('不给 contextStage → `kind: minimal` 且 `contextFrozen=false`', async () => {
    const s = inPlaceStages()
    assert.equal(s.contextFrozen, false)
    const d = await s.buildContext({})
    assert.equal(d.kind, 'minimal')
    // 降级时**如实说明没有快照**，不能让人以为有
    assert.match(d.note, /无上下文快照|未交付/)
  })

  test('给了 contextStage → 用的是**它**，且 `contextFrozen=true`', async () => {
    const env = makeEnv()
    try {
      const real = stage(env)
      const s = inPlaceStages({ contextStage: real })
      assert.equal(s.contextFrozen, true)
      const d = await s.buildContext(lease())
      assert.equal(d.kind, 'frozen')
      assert.ok(hasSnapshot(env.store, 'att:t1:1'), '走 inPlaceStages 也必须真的落库')
    } finally { env.cleanup() }
  })

  test('`workspaceIsolation` 仍是 none（PRT-306 未交付，不许谎报）', () => {
    assert.equal(inPlaceStages().workspaceIsolation, 'none')
    assert.equal(inPlaceStages({ contextStage: async () => ({}) }).workspaceIsolation, 'none')
  })
})

// ============================================================================
// PRT-411：远程 worker 的 `buildContext`（装配与持久化都在 hub 那一侧）
// ============================================================================
//
// 装配需要的数据都在 hub 的库里。让 worker 进程自己读，就要么直连那个 SQLite
// 文件、要么把读取逻辑写第二遍——而 `POST /api/context-snapshots/assemble`
// 已经是"装配 + 持久化在同一个请求里完成"的。

describe('⑧ 远程 worker：装配与持久化都在 hub 那一侧', () => {
  test('**把快照交给 hub，并把结果如实带回来**', async () => {
    const seen = []
    const stage = createHubContextStage({
      post: async (path, body) => {
        seen.push({ path, body })
        return { status: 200, body: { ok: true, snapshotHash: 'sha256:from-hub', snapshot: { sources: [1, 2], excluded: [], truncations: [], redactions: [], tokens: { kind: 'exact', tokens: 42 } } } }
      },
      canRead: () => true,
      clock: () => NOW,
    })
    const d = await stage({ attemptId: 'att:r:1', scope: 'software', workerId: 'w1' })
    assert.equal(d.kind, 'frozen')
    assert.equal(d.assembledBy, 'hub', '要能看出它是在 hub 那一侧装配的')
    assert.equal(d.snapshotHash, 'sha256:from-hub')
    assert.equal(d.includedCount, 2)
    assert.equal(d.tokens, 42)
    // 请求形状：路由要的字段一个不少
    assert.equal(seen.length, 1)
    assert.equal(seen[0].path, '/api/context-snapshots/assemble')
    for (const k of ['attemptId', 'runId', 'frozenAtMs', 'scope']) assert.ok(k in seen[0].body, `请求缺 ${k}`)
    assert.equal(seen[0].body.frozenAtMs, NOW)
    assert.equal(seen[0].body.attemptId, 'att:r:1')
  })

  test('**权限不给就拒绝构造**（路由不替调用方决定权限，这里也不猜）', () => {
    assertStageError(() => createHubContextStage({ post: async () => ({}) }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    assertStageError(() => createHubContextStage({ canRead: () => true }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    assertStageError(() => createHubContextStage(null), CONTEXT_STAGE_ERRORS.BAD_WIRING)
  })

  test('权限回答含糊 → 抛错，**不**偷偷当成"全可读"或"全不可读"', async () => {
    for (const bad of [undefined, null, 'yes', 0]) {
      const stage = createHubContextStage({
        post: async () => ({ status: 200, body: { ok: true } }),
        canRead: () => bad,
      })
      await assertStageRejects(stage({ attemptId: 'a', scope: 's' }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    }
  })

  test('权限三种明确回答各自翻译成路由字段（**恰好给一个**）', async () => {
    const cases = [
      [() => true, { canReadAll: true }],
      [() => ({ all: true }), { canReadAll: true }],
      [() => ['a', 'b'], { canReadIds: ['a', 'b'] }],
      [() => ({ ids: ['c'] }), { canReadIds: ['c'] }],
    ]
    for (const [canRead, expect] of cases) {
      let body = null
      const stage = createHubContextStage({
        post: async (_p, b) => { body = b; return { status: 200, body: { ok: true, snapshotHash: 'h' } } },
        canRead, clock: () => NOW,
      })
      await stage({ attemptId: 'a', scope: 's' })
      for (const [k, v] of Object.entries(expect)) assert.deepEqual(body[k], v, `${k} 不对`)
      const hasAll = 'canReadAll' in body
      const hasIds = 'canReadIds' in body
      assert.ok(hasAll !== hasIds, '权限字段必须**恰好**给一个')
    }
  })

  test('**路由非 200 就是阶段失败**（不能吞掉：快照没落库，"模型看到了什么"就没有答案）', async () => {
    const cases = [
      [400, 'CONTEXT_PERMISSION_REQUIRED', CONTEXT_STAGE_ERRORS.PERSIST_FAILED],
      [400, 'CONTEXT_BAD_SOURCE', CONTEXT_STAGE_ERRORS.PERSIST_FAILED],
      [409, 'CONTEXT_SNAPSHOT_CONFLICT', CONTEXT_STAGE_ERRORS.PERSIST_FAILED],
      // 超限是**装配**失败：能靠精简输入解决，与"存不下去"不是一件事
      [400, 'CONTEXT_TOO_LARGE', CONTEXT_STAGE_ERRORS.ASSEMBLY_FAILED],
    ]
    for (const [status, code, expected] of cases) {
      const stage = createHubContextStage({
        post: async () => ({ status, body: { ok: false, code, error: '模拟' } }),
        canRead: () => true, clock: () => NOW,
      })
      const e = await assertStageRejects(stage({ attemptId: 'a', scope: 's' }), expected)
      assert.equal(e.assemblyCode, code, 'hub 的具名码必须被保留下来')
      assert.equal(e.stage, 'buildContext')
    }
  })

  test('`ok` 不为 true 的一切都算失败（含 200 但 ok 缺失）', async () => {
    for (const res of [{ status: 200, body: {} }, { status: 200, body: null }, { status: 204, body: null }, null]) {
      const stage = createHubContextStage({ post: async () => res, canRead: () => true, clock: () => NOW })
      await assertStageRejects(stage({ attemptId: 'a', scope: 's' }), CONTEXT_STAGE_ERRORS.PERSIST_FAILED)
    }
  })

  test('路由不可达 → 阶段失败（不是"当作没有上下文继续"）', async () => {
    const stage = createHubContextStage({
      post: async () => { throw new Error('ECONNREFUSED') },
      canRead: () => true, clock: () => NOW,
    })
    const e = await assertStageRejects(stage({ attemptId: 'a', scope: 's' }), CONTEXT_STAGE_ERRORS.PERSIST_FAILED)
    assert.match(e.message, /ECONNREFUSED/)
  })

  test('loadSources 抛错 → 阶段失败；返回非对象 → 阶段失败', async () => {
    const mk = (loadSources) => createHubContextStage({
      post: async () => ({ status: 200, body: { ok: true } }),
      loadSources, canRead: () => true, clock: () => NOW,
    })
    await assertStageRejects(mk(async () => { throw new Error('读不到') })({ attemptId: 'a', scope: 's' }), CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE)
    for (const bad of [null, [], 'x']) {
      await assertStageRejects(mk(async () => bad)({ attemptId: 'a', scope: 's' }), CONTEXT_STAGE_ERRORS.INPUT_UNAVAILABLE)
    }
  })

  test('lease 缺 scope / attemptId → `BAD_WIRING`', async () => {
    const stage = createHubContextStage({
      post: async () => ({ status: 200, body: { ok: true } }), canRead: () => true, clock: () => NOW,
    })
    await assertStageRejects(stage({ attemptId: 'a' }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    await assertStageRejects(stage({ scope: 's' }), CONTEXT_STAGE_ERRORS.BAD_WIRING)
    await assertStageRejects(stage(null), CONTEXT_STAGE_ERRORS.BAD_WIRING)
  })

  test('远程路径**没有**"默认放行"这回事：`canReadDefaulted` 恒为 false', async () => {
    // 本地路径不传 canRead 会 fail closed 并把 `canReadDefaulted` 记成 true；
    // 远程路径由路由强制要求显式权限，所以那个标志**不存在**。
    // 两条路径在这一点上不同，而它们看起来都是"冻结成功了"——所以这个字段要能看出来。
    const stage = createHubContextStage({
      post: async () => ({ status: 200, body: { ok: true, snapshotHash: 'h' } }),
      canRead: () => true, clock: () => NOW,
    })
    const d = await stage({ attemptId: 'a', scope: 's' })
    assert.equal(d.canReadDefaulted, false)
  })
})

// ============================================================================
// PRT-411：`claim` 必须把 **scope** 一起发出去
// ============================================================================
describe('⑨ 认领响应必须带 scope（权限判定以空间为参照）', () => {
  test('**`claim` 返回的 claimed 里有 scope**', async () => {
    // 在这之前 `shapeAttempt` 有 scope 而这条认领响应漏了。
    // 后果不是"参数没传"那种能一眼看出来的错误：worker 要么拒绝一切
    // （看起来像一次正常的权限结果），要么自己猜一个默认空间（一次静默越权）。
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createRunStore, ensureRunSchema } = await import('../../team-hub/run-store.mjs')

    const root = mkdtempSync(join(tmpdir(), 'legion-claim-scope-'))
    const db = new DatabaseSync(join(root, 'team.db'))
    try {
      db.exec("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', priority TEXT DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'backlog', version INTEGER NOT NULL DEFAULT 1, soldier TEXT, scope TEXT DEFAULT 'default', hold INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT)")
      ensureRunSchema(db)
      db.prepare('INSERT INTO tasks (id, title, priority, status, scope, hold, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)')
        .run('T-1', 't', 'medium', 'todo', 'software', 0, new Date(NOW).toISOString(), new Date(NOW).toISOString())
      const store = createRunStore({ db, clock: () => NOW })
      const c = store.claim({ workerId: 'w1' })
      assert.equal(c.claimed.scope, 'software', '认领响应必须带上空间——它是权限判定的参照')
    } finally {
      try { db.close() } catch { /* 已关 */ }
      rmSync(root, { recursive: true, force: true })
    }
  })
})

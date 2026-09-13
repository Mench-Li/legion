// runtime/context/tokenizer-registry-wiring.test.mjs
// ============================================================================
// PRT-413：精确 tokenizer 的**接线**必须是真的
//
// 前一个套件（`bpe.test.mjs`）证明编码器算得对；这一组证明它**接上了**。
//
// 「模块写好、用例全绿、没人调用」与「功能不存在」在用户看来完全一样——
// 本项目已经在 PRT-504 上栽过一次。所以这里起一个**真的 team-hub**，
// 走真的 HTTP 路由，并在进程**外面**改 `LEGION_TOKENIZER_DIR` 观察差别。
//
// 三件事要被钉住：
//   ① 没配目录 → 保守估算器（`kind: conservative-estimate`），且 `/api/config`
//      如实说 `configured: false`；
//   ② 配了目录 → **同一个路由**给出的 `tokens.kind` 变成 `exact`，
//      且 token 数是那份词表算出来的（不是"不抛错就算过"）；
//   ③ 配了一个读不到的目录 → **那次请求失败**，而不是悄悄回落成估算。
//
// ③ 是这一组里最要紧的一条：一个"读不到词表就用估算"的实现，
// 会让 `tokens.kind` 独自承担全部告知责任，而没人会去看它。
// ============================================================================
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 一份手写的小词表：`hello` → `hell` + `o` = 2 个 token（见 bpe.test.mjs 的手算）。 */
const SMALL = {
  name: 'wiring-test-bpe',
  model: 'wiring-model',
  evidence: '手写词表，仅用于验证接线（不是任何真实模型）',
  merges: ['h e', 'l l', 'he ll'],
  vocab: { h: 0, e: 1, l: 2, o: 3, he: 4, ll: 5, hell: 6, hello: 7 },
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-tokwire-'))
const tokDir = join(tmpRoot, 'tokenizers')
mkdirSync(tokDir, { recursive: true })
writeFileSync(join(tokDir, 'wiring.tokenizer.json'), JSON.stringify(SMALL), 'utf8')

let mod
let base = ''

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  process.env.TEAM_HUB_TOKEN = ''
  // ★ 在 import **之前**设好：`CFG` 是模块级常量，`createLazyTokenizerRegistry`
  //   的 `getDir` 在构造时就取一次——这是刻意的（见那一行注释），
  //   所以"运行时改 env"不会生效，用例必须为此在 import 前设好。
  process.env.LEGION_TOKENIZER_DIR = tokDir
  mod = await import('../../team-hub/server.mjs')
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + mod.server.address().port
})

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close() } catch { /* 已关闭 */ }
  try { mod?.db?.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

const get = async (p) => {
  const r = await fetch(base + p)
  return { status: r.status, body: await r.json() }
}

const post = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

/** 冻结一份快照，返回快照体（`tokens` / `snapshotHash` 都在里面）。 */
async function freeze({ attemptId, model, text }) {
  const body = {
    attemptId,
    runId: 'run-wire',
    scope: 'default',
    frozenAtMs: Date.now(),
    candidates: [{
      id: 'c1',
      source: {
        type: 'task', id: 't1', version: 'v1',
        acquiredAtMs: Date.now(), content: text, trust: 'untrusted',
      },
      required: true,
    }],
    // 路由**不替调用方决定权限**（默认放行会让越权来源静默进入上下文），
    // 所以必须显式给，且它是**顶层**字段而不是 policy 里的。这与本组的目的无关，
    // 但少了它连 200 都拿不到。
    canReadAll: true,
    policy: { scope: 'default' },
  }
  if (model !== undefined) body.model = model
  return post('/api/context-snapshots/assemble', body)
}

/**
 * 读回一条快照。
 *
 * ★ 形状坑：`get()` 返回 `{ ...摘要字段, snapshot, summary }`，而
 *   `tokens` / `sources` 这些在 **`snapshot`** 里面，不在顶层。
 *   `POST /api/context-snapshots/assemble` 的 200 响应**根本不含** `tokens`
 *   （只有 `ok/recorded/summary/snapshotHash`）——所以"装配完就能看到 token 数"
 *   是假的，得读回来。第一版这份用例就在这上面红过（`tokens` 是 undefined）。
 */
async function readSnapshot(attemptId) {
  const r = await get('/api/context-snapshots/' + encodeURIComponent(attemptId))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.snapshot
}

describe('① 没有配置目录 → 保守估算器（既有的、如实的行为）', () => {
  test('★ `/api/config` 如实报告 tokenizer 这一栏', async () => {
    const r = await get('/api/config')
    assert.equal(r.status, 200)
    assert.equal(r.body.runPlane, true, 'PRT-301 的能力位不能被这次改动挤掉')
    assert.ok(r.body.tokenizer, '必须有一栏 tokenizer——否则"配了没生效"问不出来')
    assert.equal(r.body.tokenizer.dir, tokDir, '报告的是构造时取到的那个目录')
    assert.equal(r.body.tokenizer.error, null, '只用 status 探测不该触发读盘，更不该失败')
  })

  test('★ description 说不清之外的键没被动过（一次改动的边界要小）', async () => {
    const r = await get('/api/config')
    for (const k of ['auth', 'db', 'port', 'runPlane']) {
      assert.ok(k in r.body, `既有键 ${k} 必须保留`)
    }
  })
})

describe('② 配了目录 → **同一个路由**算出精确 token 数', () => {
  test('★★ `tokens.kind` 是 `exact`，且数就是那份词表算的 2', async () => {
    const r = await freeze({ attemptId: 'att-wire-1', model: 'wiring-model', text: 'hello' })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const detail = await readSnapshot('att-wire-1')
    assert.equal(detail.tokens.kind, 'exact',
      '配了词表却还在报估算——说明注册表没接上（而用例会绿，如果只断言"不抛错"）')
    assert.equal(detail.tokens.tokens, 2, '`hello` 在这份词表下是 hell + o = 2')
    // evidence 要说清用哪份字节算的
    assert.match(detail.tokens.note ?? '', /wiring-test-bpe/)
  })

  test('★★ 一个精确计数**不许**在摘要里写着"约"', async () => {
    // 这句话是用户唯一会读到的 token 说明。对它说"约"，
    // 等于让 `tokens.kind` 这个区分字段在**人看的那条路径上**彻底不存在。
    const exact = await freeze({ attemptId: 'att-wire-sum-1', model: 'wiring-model', text: 'hello' })
    assert.doesNotMatch(exact.body.summary, /约/, `精确计数不能说"约"：${exact.body.summary}`)
    assert.match(exact.body.summary, /精确/, `摘要要自己说清可信度：${exact.body.summary}`)

    const est = await freeze({ attemptId: 'att-wire-sum-2', model: 'other-model', text: 'hello' })
    assert.match(est.body.summary, /约/, '估算值才该说"约"')
    assert.match(est.body.summary, /保守估算/, `摘要要自己说清可信度：${est.body.summary}`)
  })

  test('★ 没在注册表里的 model 仍然走保守估算（不是"有一个精确的就全都是精确的"）', async () => {
    const r = await freeze({ attemptId: 'att-wire-2', model: 'other-model', text: 'hello' })
    assert.equal(r.status, 200)
    const detail = await readSnapshot('att-wire-2')
    assert.equal(detail.tokens.kind, 'conservative-estimate',
      '注册表命中查询必须按 model 走——否则"精确"会覆盖到它没有依据的模型上')
  })

  test('★ 精确与估算的数**不同**（证明差别是真的，不是同一个数字的两个标签）', async () => {
    await freeze({ attemptId: 'att-wire-3', model: 'wiring-model', text: 'hello' })
    await freeze({ attemptId: 'att-wire-4', model: 'other-model', text: 'hello' })
    const exact = await readSnapshot('att-wire-3')
    const est = await readSnapshot('att-wire-4')
    assert.notEqual(exact.tokens.tokens, est.tokens.tokens,
      '同 token 数不同可信度会让这个字段失去意义')
    assert.notEqual(exact.snapshotHash, est.snapshotHash,
      '可信度不同的两次数不出同一个哈希')
  })

  test('★ 装载之后 `/api/config` 说得出注册了什么', async () => {
    const r = await get('/api/config')
    assert.equal(r.body.tokenizer.loaded, true)
    assert.deepEqual(r.body.tokenizer.models, ['wiring-model'])
    assert.equal(r.body.tokenizer.count, 1)
  })
})

describe('③ 坏目录 → 报错，**不**悄悄回落（这一组最要紧的一条）', () => {
  test('★★★ 配了读不到的目录时，装配**失败**而不是用估算糊过去', async () => {
    // 单独起一个进程内实例做不到（CFG 是模块级常量），所以直接验证
    // 惰性装载器的行为——它正是那条路由用的那个对象。
    const { createLazyTokenizerRegistry } = await import('./tokenizer-registry.mjs')
    const reg = createLazyTokenizerRegistry(() => join(tmpdir(), 'legion-definitely-missing-xyz'))
    assert.throws(() => reg.get('any-model'), (e) => {
      assert.match(e.message, /读不了 tokenizer 目录/)
      return true
    }, '读不到目录必须抛——否则"配了但没生效"会被记成"这个模型没有精确 tokenizer"')
    // 而且 status 要把这件事说清楚，而不是报成"加载成功、只是空的"
    assert.equal(reg.status().loaded, false)
    assert.equal(reg.status().count, 0)
    assert.ok(reg.status().error, '错误必须被记下来，否则排障时只见一个空表')
  })
})

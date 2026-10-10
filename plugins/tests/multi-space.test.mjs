import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { childLogFile, fetchSpaceViews, isSupervisor, planSpaceRunners, statusFileNames } from '../lib/index.js'

/**
 * SP-P1 多空间编排：监督者的**决策**是纯函数，这里逐条钉住它的边界。
 * 覆盖：单空间兼容（scopes 缺省）、白名单/auto、未开通执行、无数据面流水线、执行配置下发、
 *      子实例不再递归监督、状态文件与日志文件的按空间分文件。
 */

function config(overrides = {}) {
  return {
    role: 'soldier-auto', intervalMs: 30_000, maxWorkers: 1, workerTimeoutMs: 60_000,
    staleMinutes: 40, taskTtlMinutes: 0, provider: 'spawn', scrumDir: 'D:/scrum',
    workspace: 'D:/w', isolate: true, repoRoot: 'D:/repo', worktreeRoot: '', denyTools: [],
    rolesFile: 'D:/repo/roles.json', logFile: 'C:/logs/worker.log',
    hubUrl: 'http://127.0.0.1:8787', hubToken: '', scope: 'software', agentPreset: 'code',
    ...overrides,
  }
}

const space = (id, { enabled = true, stages = 6, maxWorkers, isolate } = {}) => ({
  id, enabled, stages, ...(maxWorkers === undefined ? {} : { maxWorkers }), ...(isolate === undefined ? {} : { isolate }),
})

test('TC-SP-P1-01 scopes 缺省 = 单空间模式：不做任何编排（P1 之前的既有行为逐字不变）', () => {
  assert.deepEqual(planSpaceRunners(config(), [space('software'), space('ozon')]), [])
  assert.deepEqual(planSpaceRunners(config({ scopes: undefined }), [space('ozon')]), [])
})

test('TC-SP-P1-02 scopes=auto → 接管全部「已开通且已配流水线」的空间', () => {
  const runners = planSpaceRunners(config({ scopes: 'auto' }), [space('software'), space('ozon')])
  assert.deepEqual(runners.map(r => r.scope), ['software', 'ozon'])
})

test('TC-SP-P1-03 白名单只接管列出的空间（顺序按数据面返回顺序）', () => {
  const runners = planSpaceRunners(config({ scopes: ['ozon'] }), [space('software'), space('ozon')])
  assert.deepEqual(runners.map(r => r.scope), ['ozon'])
})

test('TC-SP-P1-04 space_runtime.enabled=false → 不接管（P1 执行开关的依据）', () => {
  const runners = planSpaceRunners(config({ scopes: 'auto' }), [space('software', { enabled: false }), space('ozon')])
  assert.deepEqual(runners.map(r => r.scope), ['ozon'])
})

test('TC-SP-P1-05 数据面无流水线（0 环）→ 不接管：避免退化成单角色认领任意 todo', () => {
  const runners = planSpaceRunners(config({ scopes: 'auto' }), [space('software', { stages: 0 }), space('ozon', { stages: 6 })])
  assert.deepEqual(runners.map(r => r.scope), ['ozon'])
})

test('TC-SP-P1-06 数据面执行配置下发到子实例：maxWorkers/isolate 覆盖部署面默认值', () => {
  const [only] = planSpaceRunners(config({ scopes: 'auto', maxWorkers: 2, isolate: true }), [space('ozon', { maxWorkers: 1, isolate: false })])
  assert.equal(only.scope, 'ozon')
  assert.equal(only.maxWorkers, 1)
  assert.equal(only.isolate, false)
  // 数据面没给的值 → 保留部署面
  const [kept] = planSpaceRunners(config({ scopes: 'auto', maxWorkers: 3, isolate: false }), [space('ozon')])
  assert.equal(kept.maxWorkers, 3)
  assert.equal(kept.isolate, false)
})

test('TC-SP-P1-07 子实例退回单空间模式，且不继承父 rolesFile（多空间共用一个文件会串味）', () => {
  const [child] = planSpaceRunners(config({ scopes: 'auto' }), [space('ozon')])
  assert.equal(child.scopes, 'off', '子实例必须退回单空间模式，否则无限递归')
  assert.equal(child.rolesFile, '', '数据面才是流水线来源；子实例不吃父的部署面文件')
})

test('TC-SP-P1-08 子实例日志分文件（多空间共用一份日志会互相淹没）', () => {
  const [child] = planSpaceRunners(config({ scopes: 'auto' }), [space('ozon')])
  assert.equal(child.logFile, 'C:/logs/worker-ozon.log')
  assert.equal(childLogFile('', 'ozon'), '', '未配日志（空串）保持空串 → 子实例沿用默认路径')
  assert.equal(childLogFile('C:/logs/w', 'ozon'), 'C:/logs/w-ozon', '无扩展名时直接追加后缀')
  assert.equal(childLogFile('C:/logs/w.log', 'a/b'), 'C:/logs/w-a_b.log', 'scope 里的非法字符转下划线')
})

test('TC-SP-P1-09 状态文件：主 scope 继续维护 daemon.json（看板/健康页兼容），其余空间只写 per-scope', () => {
  assert.deepEqual(statusFileNames('software', undefined), ['daemon.json', 'daemon-software.json'], '单空间部署：行为与 P1 之前兼容')
  assert.deepEqual(statusFileNames('software', ''), ['daemon.json', 'daemon-software.json'], '空串 = 本实例即主（单空间部署默认值）')
  assert.deepEqual(statusFileNames('software', 'software'), ['daemon.json', 'daemon-software.json'])
  assert.deepEqual(statusFileNames('ozon', 'software'), ['daemon-ozon.json'], '非主空间不得抢写 daemon.json')
})

test('TC-SP-P1-10 主 scope 归属：父 scope 在接管集合内归父；否则第一个空间顶上（daemon.json 不能没人写）', () => {
  const own = planSpaceRunners(config({ scopes: 'auto', scope: 'software' }), [space('software'), space('ozon')])
  assert.deepEqual(own.map(c => c.primaryScope), ['software', 'software'])

  const fallback = planSpaceRunners(config({ scopes: 'auto', scope: 'legacy' }), [space('software'), space('ozon')])
  assert.deepEqual(fallback.map(c => c.primaryScope), ['software', 'software'], '父 scope 未被接管 → 第一个空间顶上')
  const files = fallback.map(c => statusFileNames(c.scope, c.primaryScope))
  assert.deepEqual(files, [['daemon.json', 'daemon-software.json'], ['daemon-ozon.json']])
})

test('TC-SP-P1-11 监督者判定：缺省/off = 单空间（未校验的手工配置不炸），数组或 auto = 监督者', () => {
  assert.equal(isSupervisor(config()), false, '缺省 scopes（手工构造配置）必须按单空间处理')
  assert.equal(isSupervisor(config({ scopes: 'off' })), false)
  assert.equal(isSupervisor(config({ scopes: 'auto' })), true)
  assert.equal(isSupervisor(config({ scopes: ['ozon'] })), true)
})

// ============================================================================
// ★★ BUG-017：`fetchSpaceViews` 曾经读错响应形状（2026-10-10 实测）
// ----------------------------------------------------------------------------
// 真实中枢 `GET /api/spaces` 返回的是**对象** `{ spaces: [...] }`，而它从前写的是
// `Array.isArray(list) ? list : []` ⇒ 循环一次都不转 ⇒ views 恒为空 ⇒
// **一个空间都不接管**，而且 skipped 也是空的 ⇒ **一行日志都不打**。
//
// 上面 TC-SP-P1-01..11 全部只测纯函数 `planSpaceRunners`，逐条通过 ——
// 因为它们喂进去的 `views` 是**手工造的数组**，而做 I/O 的那一环从来没有判据。
//
//   > 一组夹具喂进去的是"我以为中枢会返回的形状"，
//   > 与一组夹具喂进去的是"中枢真的返回的形状"，在两者都绿的时候是同一个东西。
//
// 这一组用**替身 fetch** 喂进真实形状（照 `acceptance.test.mjs` 的 stubFetch 写法）。
// ============================================================================

/** 真实的 fetch：替身要还原到的那个（不是"上一个替身"）。 */
const REAL_FETCH = globalThis.fetch

/** 用替身 fetch 跑一次，结束后一定还原（`t.after`）。 */
function withFetch(t, handler) {
  globalThis.fetch = async (url, init) => handler(String(url), init)
  t.after(() => { globalThis.fetch = REAL_FETCH })
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
})

/** 真实中枢的形状：**对象**，不是数组。 */
const HUB_SPACES_PAYLOAD = {
  spaces: [
    { id: 'default', name: '我的空间', localDir: '', agentCount: 3 },
    { id: 'software', name: '软件流水线', localDir: 'D:\\project\\DSH\\legion', agentCount: 8 },
    { id: 'ozon', name: 'Ozon 跨境电商', localDir: 'D:\\project\\DSH\\shop', agentCount: 11 },
  ],
}

test('★ TC-SP-P1-12 `fetchSpaceViews` 必须认得真实形状 `{spaces:[...]}`（BUG-017 的回归判据）', async (t) => {
  const seen = []
  withFetch(t, (url) => {
    seen.push(url)
    if (url.endsWith('/api/spaces')) return jsonResponse(HUB_SPACES_PAYLOAD)
    if (url.includes('/api/pipeline?scope=software')) return jsonResponse({ runtime: { enabled: true, maxWorkers: 2, isolate: true }, activeRoles: ['a', 'b'] })
    if (url.includes('/api/pipeline?scope=ozon')) return jsonResponse({ runtime: { enabled: true }, activeRoles: ['a'] })
    return jsonResponse({ runtime: { enabled: false }, activeRoles: [] })
  })

  const views = await fetchSpaceViews(config())
  assert.equal(views.length, 3,
    '★ 从前这里是 0 —— 真实响应是对象，而它只认数组。0 个视图 ⇒ 不挂载任何子实例、且一行日志都不打')
  assert.deepEqual(views.map(v => v.id), ['default', 'software', 'ozon'], '顺序按数据面返回顺序')
  assert.equal(views.find(v => v.id === 'software').enabled, true)
  assert.equal(views.find(v => v.id === 'software').stages, 2, 'stages 取 activeRoles 长度')
  assert.equal(views.find(v => v.id === 'software').maxWorkers, 2, '执行配置随视图下发')
  assert.equal(views.find(v => v.id === 'default').enabled, false)
  assert.ok(seen.some(u => u.includes('/api/pipeline?scope=software&include=active')),
    '每个空间都要问一次流水线（带 include=active）')
})

test('★ TC-SP-P1-13 裸数组形状仍然收（兼容老夹具/老数据面）', async (t) => {
  withFetch(t, (url) => url.endsWith('/api/spaces')
    ? jsonResponse(HUB_SPACES_PAYLOAD.spaces)
    : jsonResponse({ runtime: { enabled: true }, activeRoles: ['a'] }))
  const views = await fetchSpaceViews(config())
  assert.deepEqual(views.map(v => v.id), ['default', 'software', 'ozon'])
})

test('★ TC-SP-P1-14 认不出的形状 → 空数组（fail closed，且不抛）', async (t) => {
  for (const body of [{}, { spaces: null }, { spaces: 'nope' }, null, 42]) {
    withFetch(t, () => jsonResponse(body))
    const views = await fetchSpaceViews(config())
    assert.deepEqual(views, [], `形状 ${JSON.stringify(body)} 应当得到空数组而不是崩掉`)
  }
})

test('★ TC-SP-P1-15 hubUrl 为空 → 不发请求（非 hub 模式）', async (t) => {
  let called = 0
  withFetch(t, () => { called += 1; return jsonResponse({}) })
  assert.deepEqual(await fetchSpaceViews(config({ hubUrl: '' })), [])
  assert.equal(called, 0, '非 hub 模式不许打网络')
})

test('★ TC-SP-P1-16 同一仓里三个 `/api/spaces` 读取者必须认同一个形状（静态判据）', async () => {
  // 这一条守的是"下次又有人只按数组解析"：三个读取者里任何一个读错，症状都是**静默**的。
  const { readFileSync } = await import('node:fs')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const files = ['index.ts', 'workspace.ts', 'mediation.ts']
  for (const f of files) {
    const src = readFileSync(join(root, 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.equal(src.includes('Array.isArray') && /Array\.isArray\(list\)\s*\?\s*list\s*:\s*\[\]/.test(src), false,
      `${f} 里出现了"只认数组"的解析写法 —— 真实数据面是 { spaces: [...] }`)
  }
  const indexSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.match(indexSrc, /\.spaces/, 'index.ts 的读取器要认得 `spaces` 字段')
  for (const f of ['workspace.ts', 'mediation.ts']) {
    assert.match(readFileSync(join(root, 'src', f), 'utf8'), /\.spaces/, `${f} 也要认得 \`spaces\` 字段`)
  }
})

test('★ TC-SP-P1-17 空视图必须**说出来**（"没读到空间"与"没有空间"不许长得一样）', async () => {
  // BUG-017 之所以活了不知多久，一半是因为读错形状，另一半是因为**它一声不响**：
  // 监督者每 30s 准时跑、准时算出 0 个执行器，而日志里一行都没有。
  const { readFileSync } = await import('node:fs')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.match(src, /views\.length === 0/, '要在 reconcile 里显式处理空视图')
  assert.match(src, /数据面没有读到任何空间/, '空视图要打一句能定位的话（含 hub 地址）')
  // 而且只喊一次：每 30s 重复喊会把日志淹掉，而"喊过一次"就够定位了
  assert.match(src, /loggedEmptyViews/, '要有"只喊一次"的闸门')
})

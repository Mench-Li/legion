// workbench/scripts/model-api.test.mjs
// ============================================================================
// PRT-507（前端收尾）：模型与密钥配置的客户端层
//
// ## 这一层此前**完全不存在**
//
// 后端把模型档案 CRUD、岗位绑定与 fallback、连通性探测、非敏感配置迁移、
// 配置导入导出**全都做完了**，而 `workbench/src/api.ts` 里**一个客户端函数都没有**——
// 也就是说这些功能从界面上**一次都调不到**。
//
// 与 PRT-507 查到的"PRT-504 没有任何非测试调用方"是同一种形态：
// **功能在、测试在、文档在，而没有任何入口。**
//
// ## 这一组守三件事
//
// ① **方法 + 路径必须与服务端逐字对上**（这里的错法不会报错，只会 404）；
// ② **结构化错误必须真的到达调用方**——`hubPost` 原本把响应体压成一句字符串，
//    于是 PRT-252 那些**有测试守着**的 `code`/`field`/`hint`/`candidates`
//    在到达界面之前就没了；
// ③ **每条路径都要在平台契约里真实存在**——这一条是防"前端写了个不存在的端点"，
//    而它是**交叉校验**，不依赖任何人记得同步。
// ============================================================================
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// api.ts 在模块顶层就会读 window / localStorage（hubBase 与 token）。
// 静态 import 会被提升到这些赋值之前，所以必须**先设全局再动态导入**。
globalThis.window = { location: { search: '' } }
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
}
store.set('legion.workbench.hub', 'http://hub.test')

const api = await import('../src/api.ts')

/** 记录每次请求；返回一个可配置的响应。 */
let calls = []
let nextResponse = { status: 200, body: {} }
const realFetch = globalThis.fetch

const fakeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    return fakeResponse(nextResponse.status, nextResponse.body)
  }
})
after(() => { globalThis.fetch = realFetch })
beforeEach(() => { calls = []; nextResponse = { status: 200, body: {} } })

const lastCall = () => calls[calls.length - 1]

describe('① 每条客户端调用都打到正确的 method + 路径（错法不会报错，只会 404）', () => {
  test('模型档案：列表 / 建 / 改 / 删 / 测连接', async () => {
    await api.fetchModelProfiles()
    assert.equal(lastCall().method, 'GET')
    assert.match(lastCall().url, /\/api\/model-profiles$/)

    await api.fetchModelProfiles({ includeDeleted: true })
    assert.match(lastCall().url, /\/api\/model-profiles\?includeDeleted=1$/)

    await api.createModelProfile({ id: 'p1' }, 'general')
    assert.equal(lastCall().method, 'POST')
    assert.match(lastCall().url, /\/api\/model-profiles$/)
    assert.equal(lastCall().body.actor, 'general')

    await api.updateModelProfile('p/1', { id: 'p1' }, 3, 'general')
    assert.equal(lastCall().method, 'PUT')
    // 路径里的 id 必须被编码：不编码时 `p/1` 会变成两段，服务端按"两段绑定路径"解析
    assert.match(lastCall().url, /\/api\/model-profiles\/p%2F1$/)
    assert.equal(lastCall().body.version, 3, 'CAS 版本必须带出去')

    await api.deleteModelProfile('p/1', 4, 'general')
    assert.equal(lastCall().method, 'DELETE')
    assert.match(lastCall().url, /\/api\/model-profiles\/p%2F1$/)

    // **三处拼 id 的地方都要断言编码**：只测其中一处时，另外两处去掉
    // `encodeURIComponent` 不会有任何用例变红——第一版的变红验证就是这样
    // 只测到了一个（探测那处的 break 全绿），而它当时"通过"了。
    await api.probeModelProfile('p/1')
    assert.equal(lastCall().method, 'POST')
    assert.match(lastCall().url, /\/api\/model-profiles\/p%2F1\/probe$/, '探测路径里的 id 也必须编码')
    // 按钮按下时默认强制真探：只回缓存会让人以为"刚才那次点击验证了现在"
    assert.equal(lastCall().body.force, true)
    assert.deepEqual(lastCall().body.requiredCapabilities, [])
  })

  test('岗位绑定：列表 / 保存 / 解析 / 删除', async () => {
    await api.fetchModelBindings('default')
    assert.equal(lastCall().method, 'GET')
    assert.match(lastCall().url, /\/api\/model-bindings\?scope=default$/)

    await api.saveModelBinding({
      scope: 'default', employeeRole: 'reviewer', primaryProfile: 'p1', actor: 'general',
    })
    assert.equal(lastCall().method, 'POST')
    assert.match(lastCall().url, /\/api\/model-bindings$/)
    assert.equal(lastCall().body.employeeRole, 'reviewer')
    assert.deepEqual(lastCall().body.fallbackProfiles, [], '没给 fallback 时必须是空数组，不是 undefined')
    assert.equal(lastCall().body.perRunBudget, null)

    await api.resolveModelBinding('default', 'reviewer')
    assert.equal(lastCall().method, 'GET')
    assert.match(lastCall().url, /\/api\/model-bindings\/resolve\?scope=default&role=reviewer$/)

    await api.deleteModelBinding('default', 'reviewer', 'general')
    assert.equal(lastCall().method, 'DELETE')
    assert.match(lastCall().url, /\/api\/model-bindings\/default\/reviewer$/)
  })

  // ★ 2026-10-12：这里原有「迁移：计划（带/不带协议）与执行」一条 —— 随「配置迁移」
  //   整个功能（PRT-506）删掉了：`fetchMigrationPlan` / `applyMigration` 与
  //   `/api/model-migration/*` 都不再存在。理由见 `docs/bugs/BUG-026` / `BUG-027`。
  //
  //   ★★ 同一批的「配置包：导出 / 计划导入 / 执行导入」也删了 —— 「配置包」（PRT-508）
  //   整体拆除：在单机部署里它没有用处（那些行本来就在每一次整库备份里），
  //   而"配置能不能搬"现在由**备份/恢复**负责。理由与它那条不可替代的判据去哪了，
  //   见 `workbench/src/api.ts` 里那一节留下的说明。

  // ★★ 2026-10-12：这里原有「凭证：状态 / 列表 / 新增 / 轮换 / 删除（方法 + 路径逐字对上）」、
  //   「**值只走请求体，绝不进 URL**（本族最硬的一条纪律）」、「密钥库的失败必须带**结构化码**」、
  //   「自检失败是 HTTP 200 + ok:false…」、「列表响应的形状被显式收窄」五条 —— 随
  //   「🔑 凭证库」页签（`SecretVaultPanel.tsx`）一起删掉了：那五个客户端函数
  //   （`fetchSecretStatus` / `fetchSecrets` / `putSecret` / `rotateSecret` / `deleteSecret`）
  //   只被那一页用，`api.ts` 里已经不存在。
  //
  //   为什么拆：钥匙由用户在「供应商与模型」页**填一次**，客户端把值随**供应商那次写**
  //   一起交给服务端（`credentialValue`），由服务端落库并写进 DSH（运行时）——
  //   客户端不再分两步管钥匙。后端五条路由与存储**原样保留**（写入要用），
  //   所以「方法 + 路径」「值不进 URL」「结构化码」这些判据没有变，只是照着**服务端**测：
  //   见 `team-hub/secret-routes.test.mjs`（含 `BUG-029`）与 `team-hub/secret-admin.test.mjs`。
})

describe('② 结构化错误必须真的到达调用方（这正是此前断掉的那一环）', () => {
  test('400 的 code/field/hint/candidates **全部保留**', async () => {
    nextResponse = {
      status: 400,
      body: {
        ok: false,
        error: '没有已登记的供应商「openai」。',
        code: 'MODEL_CONFIG_UNKNOWN_PROVIDER',
        field: 'provider',
        hint: '已登记的供应商：custom-ds、zai-coding-cn。',
        candidates: ['custom-ds', 'zai-coding-cn'],
      },
    }
    await assert.rejects(
      () => api.createModelProfile({ id: 'p1' }, 'general'),
      (e) => {
        assert.equal(e.name, 'HubError')
        assert.equal(e.status, 400)
        assert.equal(e.code, 'MODEL_CONFIG_UNKNOWN_PROVIDER')
        assert.equal(e.field, 'provider', 'field 必须活下来——它就是"错在哪个框"')
        assert.match(e.hint, /custom-ds/)
        assert.deepEqual([...e.candidates], ['custom-ds', 'zai-coding-cn'])
        return true
      },
    )
  })

  test('消息形态仍是 `状态码：说明`，且**不再把整段 JSON 原样上屏**', async () => {
    nextResponse = { status: 409, body: { ok: false, error: '版本冲突', code: 'VERSION_CONFLICT' } }
    await assert.rejects(() => api.updateModelProfile('p1', {}, 1, 'g'), (e) => {
      assert.equal(e.message, '409：版本冲突')
      assert.ok(!e.message.includes('"code"'), '不该把 JSON 结构倒进用户看的文案里')
      return true
    })
  })

  test('响应体不是 JSON 时**不编造结构**（HTML 错误页不该被猜成"某字段有问题"）', async () => {
    nextResponse = { status: 502, body: '<html>Bad Gateway</html>' }
    await assert.rejects(() => api.createModelProfile({ id: 'p1' }, 'g'), (e) => {
      assert.equal(e.status, 502)
      assert.equal(e.code, null)
      assert.equal(e.field, null)
      assert.deepEqual([...e.candidates], [])
      assert.match(e.message, /502/)
      return true
    })
  })

  test('candidates 里混进非字符串时被过滤（否则界面渲染出 undefined）', async () => {
    nextResponse = { status: 400, body: { error: 'x', candidates: ['a', null, 42, '', { z: 1 }, 'b'] } }
    await assert.rejects(() => api.createModelProfile({ id: 'p1' }, 'g'), (e) => {
      assert.deepEqual([...e.candidates], ['a', 'b'])
      return true
    })
  })

  test('网络异常仍是普通 Error（**不假装**它是一个中枢错误）', async () => {
    const saved = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    try {
      await assert.rejects(() => api.createModelProfile({ id: 'p1' }, 'g'), (e) => {
        assert.notEqual(e.name, 'HubError')
        assert.equal(e.code, undefined)
        assert.match(e.message, /无法连接中枢/)
        return true
      })
    } finally { globalThis.fetch = saved }
  })
})

describe('③ 每条路径都必须在平台契约里真实存在（交叉校验，不靠人记得同步）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const ROOT = resolve(HERE, '..', '..')

  test('api.ts 里用到的每个 /api/ 路径都能在源码抽出的路由表里找到', async () => {
    // ★★★★★ 2026-09-21：这一行此前是
    //     `extractRoutes(readFileSync('team-hub/server.mjs'))`
    //   ——而 PRT-316 把路由逐片搬进 `team-hub/routes/*.mjs` 之后，
    //   `server.mjs` 里**只剩 2 条**，真正的 186 条在族模块里。
    //   于是这条用例报了 70 条"前端写了个不存在的端点"，而那 70 条**全都存在**。
    //
    //   > 一个「搬家之后观测点塌了」的交叉校验，
    //   > 与一个「前端真的写了 70 个不存在的端点」的交叉校验，
    //   > 报的是**同一句话**——而这句话读起来完全正确，所以没人会去怀疑它。
    //
    //   修法不是"把 server.mjs 加回去"，而是**改用唯一权威**：
    //   `platformHttpRoutes()`（`buildSnapshot()` 用的是同一个函数）。
    //   判据一个字没改弱——它现在真的在查**全部** 188 条路由。
    const { platformHttpRoutes } = await import('../../scripts/prt/baseline-snapshot.mjs')
    const routes = platformHttpRoutes()
    // 路由形如 "POST /api/model-profiles/"（startsWith 形态）——用前缀匹配。
    const byMethod = new Map()
    for (const r of routes) {
      const [method, path] = r.split(' ')
      if (!byMethod.has(method)) byMethod.set(method, [])
      byMethod.get(method).push(path)
    }
    const exists = (method, path) => {
      const list = byMethod.get(method) ?? []
      return list.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}?`)))
    }

    // 从 api.ts 的**字面量**调用里抽出 (method, path)。
    //
    // 只认 `hubGet` / `hubPost` / `hubRequest` 这三个**必带路径字面量**的入口，
    // 不认裸 `fetch(...)`：后者在 api.ts 里既有模板拼接又有方法写在 init 里，
    // 正则抽出来的 (method, path) 会错位——第一版就因为多抽了一个 capture group
    // 而把路径当成了方法，报出一串 `/api/config undefined`。
    // **一条会给出错误结论的校验，比不校验更坏**，所以这里把范围收窄到能可靠判定的集合。
    const src = readFileSync(resolve(ROOT, 'workbench/src/api.ts'), 'utf8')
    const found = []
    // ★ 2026-10-05（T-178）：抽取器从前在模板段（美元花括号）处**截断**，
    //   于是中间带模板段的路径只剩前缀：tasks 那条抽成 /api/tasks/、
    //   repositories 那条抽成 /api/repositories/。那些**截断出来的前缀**
    //   再去与路由表做前缀匹配必然全落空 —— 报出来的是「前端写了个不存在的端点」，
    //   而真实情况是**抽取器自己截断了**。
    //
    //   > 一个「在模板段处截断」的抽取器，与一个「前端调了 6 个不存在的端点」的抽取器，
    //   > 报的是同一句话；而这句话读起来完全正确，所以没人会去怀疑抽取器。
    //
    //   现在改抽**整个字面量**，再把模板段归一成路由表里位置参数的写法（:param）、
    //   并去掉查询串（查询串不属于路径）。判据没有放宽：被检查的路径**变多**了
    //   （后缀不再被丢掉），而且位置参数段必须与路由表逐字对上。
    // 归一规则（两条，各自对应一种真实形态）：
    //   · 模板段后面还有路径字面量（/api/tasks/${id}/write-intent）⇒ 它是位置参数，换 :param；
    //   · 模板段直接接在路径末尾（plan${qs}、skills${qs.size …}）⇒ 它是查询串/拼接，丢掉。
    //     这一条也顺带兜住**嵌套模板**（`/api/skills${qs.size ? `?${qs}` : ''}` 会被
    //     内层反引号切断，残留 `${…`）——判据只对"清理干净的路径"做。
    const normalize = (raw) => raw
      .split('?')[0]
      .replace(/(\/)?\$\{[^}]*\}/g, (m, slash) => (slash === '/' ? '/:param' : ''))
      .replace(/\$\{.*$/, '')
    // 反引号在正则字符类里写成 \x60（免得与这里的模板串定界符打架）。
    const patterns = [
      [/hubGet\(\s*[\x60'"](\/api\/[^\x60'"]*)/g, 'GET'],
      [/hubPost\(\s*[\x60'"](\/api\/[^\x60'"]*)/g, 'POST'],
      [/hubRequest\(\s*'([A-Z]+)'\s*,\s*[\x60'"](\/api\/[^\x60'"]*)/g, null],
    ]
    for (const [re, method] of patterns) {
      let m
      while ((m = re.exec(src)) !== null) {
        found.push(method === null
          ? { method: m[1], path: normalize(m[2]) }
          : { method, path: normalize(m[1]) })
      }
    }

    // 前提自检：抽取器必须真的抽到东西，否则这条用例测的是"空集合里没有不存在的东西"
    assert.ok(found.length >= 12, `只抽到 ${found.length} 条客户端路径，抽取规则可能已与 api.ts 脱节`)

    // 本轮新增的那一族**必须**在集合里——否则上面的阈值可能被既有调用凑够，
    // 而新写的路径一条都没被检查到。
    // ★ 2026-10-12：名单里的 `/api/config-bundle/plan` 已随「配置包」删除（那条路径不再存在）。
    //
    // ★★ 2026-10-12：名单里原有的 `/api/secrets` 与 `/api/secrets/status` 也去掉了 ——
    //   「🔑 凭证库」页签拆除后，那五条路由在 `api.ts` 里**一个客户端函数都没有了**
    //   （顶层的那族函数整段删除），这个抽取器只读 `api.ts`，所以它**抓不到**那两条路径。
    //   ⚠ 这意味着那两条路径**不再被这条交叉校验覆盖**：留着它们在这里只会让用例必红，
    //     而删掉是**如实**的——覆盖范围真的变小了。客户端唯一剩下调用它们的地方是
    //     `DshProvidersPanel.tsx` 里那条裸的 `/api/secrets/status`（不在本抽取器的范围里）；
    //     路由本身存在与否由 `team-hub` 自己的套件守着（`secret-routes.test.mjs`）。
    for (const p of ['/api/model-profiles', '/api/model-bindings']) {
      assert.ok(found.some((f) => f.path === p || f.path.startsWith(p + '/')), `抽取结果里缺少 ${p}`)
    }

    // 抽取器的覆盖边界（写在这里，以免日后被当成"已经校验过"）：
    //   · 从前那两处盲区（轮换路径与 DELETE 路径在模板段处被截断）**已经不存在**：
    //     归一规则把 `${…}/probe` 落成 `/:param/probe`、把末尾的模板段丢弃，
    //     于是 `/api/model-profiles/:param` 与 `/api/model-profiles/:param/probe` 都被逐条校验了。
    //     （那两处盲区最初正是拿 `/api/secrets/${ref}/rotate` 与 `DELETE /api/secrets/${ref}`
    //     量出来的；那一族客户端函数已随凭证库页签删除，但归一规则照旧。）
    //   · 本抽取器**不**负责查询串里的语义：`?taskId=` 这类参数名不属于路径，
    //     这里只校验路径本身（查询串在切分时就丢掉了）。
    //   · 本抽取器**只读 `workbench/src/api.ts`**：别的文件里裸写的 `hubRequest(...)`
    //     （例如 `DshProvidersPanel.tsx` 的 `/api/secrets/status`）不在覆盖范围内。

    const bad = found.filter((f) => !exists(f.method, f.path))
    assert.deepEqual(
      bad.map((f) => `${f.method} ${f.path}`), [],
      '这些路径在 team-hub 的路由表里不存在（前端写了个不存在的端点，用户只会看到一个 404）',
    )
  })
})

// workbench/scripts/dsh-models-base.test.mjs
// ============================================================================
// BUG-014：「供应商与模型」页的请求**发到了错误的数据源**，而失败信息是浏览器的
//          `Failed to fetch`——不说地址、不说原因。
//
// 现场（2026-10-09，浏览器在 http://127.0.0.1:5173/ 打开指挥台）：
//
//   ① `workbench/src/api.ts` 的 `dshModelsRpc` 用的是 `${apiBase()}/api/dsh-models`；
//   ② `apiBase()` 在没有 `?api=` / localStorage 时默认 **`http://127.0.0.1:4820`**
//      ——那是**另一个**数据源（v1 看板，`scrum/serve.mjs`）的默认端口；
//   ③ 4820 上没人监听 ⇒ 浏览器回 `TypeError: Failed to fetch`
//      ⇒ 面板把它当错误原文渲染出来 ⇒ 用户看到的就是「failed」。
//
// 而这条路由**必须同源**，三个事实各自独立成立：
//   · 它住在 `workbench/scripts/serve.mjs`，也就是**发这个页面的那台进程**；
//   · 服务端强制同源（`Origin.host` 必须等于 `Host`，否则 403）；
//   · 它只限本机（非回环 403），所以远端页面本来也用不了。
// 同时那条数据源地址的默认值**也不能**改成同源：它服务的 v1 看板路由
// （`/api/config`、`/api/board`、`/api/activity`…）`serve.mjs` **一条都不提供**。
// ⇒ 两条数据源各有各的地址，这里要守的是"**别混用**"，不是"改个默认值"。
//
// ★★ v1 看板取消后，apiBase 没了，这条判据改为**只守同源**（见 BUG-015）：
//    `workbench/src/api.ts` 里再没有那条可配置的 v1 数据源地址，所以第 ③ 条不再能拿
//    "它的默认值仍是 4820"当反向锚 —— 那条锚连同被守的对象一起消失了。现在守的是
//    这份**语义**：这条路由的地址必须是写死的**相对路径常量**（既不走任何 base 配置，
//    也不拼 `location.origin`），且 `apiBase` 这个名字不许以任何形式回来。
//    第 ① ② 条（请求真的落在同源 `/api/dsh-models`、`dshModelsRpc` 不许引用它）原样保留。
//
// 与 BUG-001 同形（那一处修的是「桥接层 → 宿主」写死 3080，这一处是「页面 → 桥接层」
// 用错了 base），所以判据也照它的手法写：**地址必须随部署走，连不上时必须说得清**。
// ============================================================================
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(resolve(ROOT, 'workbench/src/api.ts'), 'utf8')

// `api.ts` 在模块顶层读 window / localStorage，所以必须先设全局再**动态**导入
// （静态 import 会被提升到赋值之前 —— 与 model-api.test.mjs 同一手法）。
globalThis.window = { location: { search: '', origin: 'http://127.0.0.1:5173' } }
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
}
const api = await import('../src/api.ts')

/** 记录请求并按剧本作答；每个用例自行设定。 */
let calls = []
let script = () => { throw new Error('未设定剧本') }
const realFetch = globalThis.fetch
beforeEach(() => { calls = []; script = () => { throw new Error('未设定剧本') } })
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return script(String(url), init)
}

const jsonResponse = (status, body) => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
})

describe('BUG-014：「供应商与模型」必须打到本页自己的源', () => {
  test('① 请求路径是同源相对路径，**不含**那条 v1 数据源（默认 4820）', async () => {
    script = () => jsonResponse(200, { ok: true, value: { groups: [] } })
    await api.dshModelsRpc('session/modelCatalog', {})
    assert.equal(calls.length, 1)
    const url = calls[0].url
    // 相对路径：既没有别的 host，也不含 4820。
    assert.equal(url, '/api/dsh-models',
      `「供应商与模型」必须打到本页自己的源（相对路径）；实测发到了 ${url}`)
    assert.equal(url.includes('4820'), false, '不许再出现 v1 看板的默认端口')
    assert.equal(/^https?:\/\//.test(url), false, '不许拼成绝对地址（会被 apiBase() 的默认值带偏）')
  })

  test('② 源码层：这条路由不许再引用 apiBase()（它属于 v1 看板那条数据源）', () => {
    const fn = /export async function dshModelsRpc[^]*?\n}/.exec(SRC)?.[0] ?? ''
    assert.ok(fn.length > 0, '找不到 dshModelsRpc')
    assert.equal(fn.includes('apiBase()'), false,
      'dshModelsRpc 不许用 apiBase()：那是 v1 看板的数据源，而这条路由在发页面的那台 serve.mjs 上')
    assert.match(fn, /DSH_MODELS_PATH/, '地址必须来自那个具名常量，便于一处改、一处读')
  })

  test('③ 地址写死成**同源相对路径常量** —— 它不属于任何可配置的数据源', () => {
    // ★ v1 看板取消后 `apiBase()` 没了（BUG-015），这条判据改为只守同源：
    //   从前这里钉的是"apiBase() 的默认值仍是 4820"，而那个对象现在整条都不存在了 ——
    //   继续钉它就等于钉一个已经删掉的符号。现在守的是同一份语义的另两个面：
    //   地址是相对路径常量（不走任何 base、不拼 location.origin），且 `apiBase` 不许回来。
    const constDecl = /const DSH_MODELS_PATH = '([^']+)'/.exec(SRC)
    assert.ok(constDecl, '地址必须来自那个具名常量 DSH_MODELS_PATH，便于一处改、一处读')
    assert.equal(constDecl[1], '/api/dsh-models',
      '常量值必须是同源相对路径')
    assert.equal(/^https?:\/\//.test(constDecl[1]), false,
      '不许写成绝对地址：相对路径由浏览器按页面源解析，不会被任何 base 配置带偏')
    assert.equal(SRC.includes('apiBase'), false,
      'v1 看板取消后 api.ts 里不该再有 apiBase —— 它那条数据源整条删掉了，名字回来就意味着链路也在回来')
  })

  test('④ 连不上时不许把浏览器的 `Failed to fetch` 当结论端出去：要说地址与链路', async () => {
    const boom = Object.assign(new TypeError('Failed to fetch'), { cause: { code: 'ECONNREFUSED' } })
    script = () => { throw boom }
    await assert.rejects(
      () => api.dshModelsRpc('settings/describe', {}),
      (e) => {
        assert.equal(e.message.includes('Failed to fetch'), false,
          '不许把浏览器的原话当结论：它不说地址，也不说这是本机配置问题')
        assert.match(e.message, /127\.0\.0\.1:5173/, '必须说出**实际用的**地址（本页源）')
        assert.match(e.message, /ECONNREFUSED/, '必须带出原因码')
        assert.match(e.message, /serve\.mjs|同源/, '必须说清这是哪条链路（发页面的那台 serve.mjs、同源）')
        assert.match(e.message, /v1 看板/,
          '必须点出它与那条 v1 看板数据源不是同一台服务 —— 那正是本 Bug 的错处（v1 取消后仍要说清"不是它"）')
        return true
      },
    )
  })

  test('⑤ 401 与其它 HTTP 错误的文案保持不变（这一修只动 base 与网络层文案）', async () => {
    script = () => jsonResponse(401, { error: 'unauthorized' })
    await assert.rejects(() => api.dshModelsRpc('settings/describe', {}),
      (e) => e.message === '模型服务连接未授权，请重新连接服务后刷新配置。')
    script = () => jsonResponse(502, { error: '连不上模型配置宿主（http://127.0.0.1:19387/api/x）：ECONNREFUSED' })
    await assert.rejects(() => api.dshModelsRpc('settings/describe', {}),
      (e) => e.message.includes('连不上模型配置宿主'),
      '桥接层给的具名错误必须原样到达界面（BUG-001 的产物不许被这一修吃掉）')
  })
})

// 收尾：还原被替换的 fetch，避免影响同进程内其它套件。
test.after(() => { globalThis.fetch = realFetch })

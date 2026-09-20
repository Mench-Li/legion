// ============================================================================
// PRT-316 切片 29：技能来源（`/api/skill-source` 两条）
//   GET  /api/skill-source   读某空间绑定的团队技能仓库
//   POST /api/skill-source   写入（走 `handleWrite`：by 必填 + 审计 + SSE）
//
// ★ 本族搬走之前，这两条**路由**一把判据都没有（`survey-judges2` 报"强判据 0 套"），
//   而且**连域模块都没有独立文件** —— `getSkillSource`/`setSkillSource` 就住在 `server.mjs` 里。
//
// ★★★ 本片钉住一处已验证的真缺陷（只钉现状、不修）：
//   `handleWrite` 的签名是 `run(body, by, scope)`，其中 `scope = readScope(body)`：
//       readScope = 是字符串且 trim 后非空 ? trim() : 'default'
//   **而本族的路由回调写的是 `(body, by) =>` —— 丢掉了第三个参数，直接用 `body.scope` 原值。**
//   于是四类后果全部成立（都量过）：
//     · `scope: null`  ⇒ 存进 **NULL**；`scope` 是 PRIMARY KEY 而 SQLite 里 **NULL 互不相等**
//                        ⇒ `ON CONFLICT(scope)` **永不触发** ⇒ 每写一次多一行，且**谁都读不回来**
//     · `scope: 123`   ⇒ 存成文本 `"123.0"` ⇒ `?scope=123` 读不到
//     · `scope: '  a  '` ⇒ 原样存 ⇒ `?scope=a` 读不到（只有原样才读得到）
//     · `scope: ''`    ⇒ 与"不给 scope"落成**两个不同**的空间（本该都被 `readScope` 归成 `default`）
//   最狠的一条：`scope: {}` —— node:sqlite 把对象当**具名参数**，位置参数于是**整体错位一格**，
//   结果是**把 url 写进了 scope、url 留空**，而 HTTP 回的是 **200**。
//
//   ⇒ 一个 token 的改动（`(body, by, scope) => setSkillSource({ scope, … })`）能让这四类后果全部消失。
//   这与切片 24（键名不存在 ⇒ `undefined` 被 JSON.stringify 丢掉）、切片 26（警告被丢）、
//   切片 28（`err.plan`/`err.migration` 被定形信封丢掉）是**同一类**的邻居：
//   **写入成功、回执成功、而那条数据谁都拿不到。**
// ============================================================================
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mod
let base
let dbDir

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method, agent: false,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  let payload = null
  try { payload = await res.json() } catch { /* 无正文 */ }
  return { status: res.status, body: payload }
}
const get = (qs = '') => call('GET', '/api/skill-source' + qs)
const post = (body) => call('POST', '/api/skill-source', body)

/** `node:sqlite` 返回的是**无原型对象**，`deepStrictEqual` 会比原型 ⇒ 先摊平。 */
const stored = () => mod.db.prepare('SELECT rowid, scope, url, branch, updatedAt FROM skill_sources ORDER BY rowid')
  .all().map((r) => ({ ...r }))
const reset = () => mod.db.exec('DELETE FROM skill_sources')

dbDir = mkdtempSync(join(tmpdir(), 'legion-ssroutes-'))
process.env.TEAM_HUB_DB = join(dbDir, 'team.db')
mod = await import('./server.mjs')
await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
base = 'http://127.0.0.1:' + mod.server.address().port

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
  try { mod?.server?.close?.() } catch { /* 已关闭 */ }
  try { mod?.db?.close?.() } catch { /* 已关闭 */ }
  rmSync(dbDir, { recursive: true, force: true })
})

// ── 读 ────────────────────────────────────────────────────────────────────
test('① 空库读：200 + **空占位**，不是 404', async () => {
  reset()
  const r = await get()
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'source'])
  assert.deepEqual(r.body.source, { scope: 'default', url: '', branch: '', updatedAt: null },
    '★ "没绑过仓库" 与 "绑了一个空仓库" 在这一层长得一样 —— 靠 url 空串区分')
})

test('② ★★ `?scope=` 空串落成 `scope:\'\'`，**不落** `default`（`?? ` 拦不住空串）', async () => {
  reset()
  assert.equal((await get()).body.source.scope, 'default', '缺参数 ⇒ default')
  assert.equal((await get('?scope=')).body.source.scope, '', '★ `\'\' ?? \'default\'` 是 `\'\'` —— 空串不是 null')
  assert.equal((await get('?scope=%20%20')).body.source.scope, '  ', '★ 读的时候**不 trim**')
})

// ── 写 ────────────────────────────────────────────────────────────────────
test('③ 写：信封是 `{ok, task}`，且**回执里包着写进去的那一行**', async () => {
  reset()
  const r = await post({ scope: 's1', url: 'https://github.com/a/b.git', branch: '  main  ', by: '业主' })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'task'])
  assert.equal(r.body.ok, true)
  assert.equal(r.body.task.scope, 's1')
  assert.equal(r.body.task.url, 'https://github.com/a/b.git')
  assert.equal(r.body.task.branch, 'main', '★ url/branch **会** trim')
  assert.deepEqual(Object.keys(r.body.task).sort(), ['branch', 'scope', 'updatedAt', 'url'])
  assert.match(String(r.body.task.updatedAt), /^\d{4}-\d{2}-\d{2}T/)
})

test('④ 写缺 `by` ⇒ 400（不是 401）；`by` 会被 trim', async () => {
  reset()
  for (const by of [undefined, '', '   ', 123, null]) {
    const r = await post({ scope: 'x', url: 'https://u/', by })
    assert.equal(r.status, 400, `by=${JSON.stringify(by)}`)
    assert.equal(r.body.error, '缺少操作者身份 by')
  }
  assert.equal(stored().length, 0, '★ 身份没通过 ⇒ 一个字节都没写')
  assert.equal((await post({ scope: 'x', url: 'https://u/', by: '  甲  ' })).status, 200)
})

test('⑤ 同 scope 再写是 **upsert**（不是插新行）', async () => {
  reset()
  await post({ scope: 's1', url: 'https://a/1', branch: 'main', by: 'x' })
  const first = stored()
  await post({ scope: 's1', url: 'https://a/2', branch: 'dev', by: 'x' })
  const rows = stored()
  assert.equal(rows.length, 1, '★ `ON CONFLICT(scope) DO UPDATE` 生效')
  assert.equal(rows[0].rowid, first[0].rowid, '★ 是同一行（不是删了重插）')
  assert.equal(rows[0].url, 'https://a/2')
  assert.equal(rows[0].branch, 'dev')
})

test('⑥ 读回来与写进去的一致', async () => {
  reset()
  const w = await post({ scope: 's1', url: 'https://a/1', branch: 'main', by: 'x' })
  assert.deepEqual((await get('?scope=s1')).body.source, w.body.task)
})

// ── ★★★ scope 没走 readScope 的四类后果 ───────────────────────────────────
test('⑦ ★★★ `scope: null` ⇒ 每写一次多一行，而且**谁都读不回来**', async () => {
  reset()
  for (let i = 1; i <= 3; i++) {
    const r = await post({ scope: null, url: 'https://n/' + i, by: 'x' })
    assert.equal(r.status, 200, '★ 每次都报成功')
    // ★ 回执里**有** `scope` 这个键，值是 `null`。
    //   我第一版写成"键不存在"——那是我把探针输出里 `task?.scope ?? task?.error` 那个 `??`
    //   当成了"键不存在"。（`??` 会把 `null` 也换成右边。）
    assert.equal('scope' in r.body.task, true)
    assert.equal(r.body.task.scope, null, '★ 回执如实回了 `scope: null` —— 客户端看到的是"我写了一个叫 null 的空间"')
    assert.equal(stored().length, i, '★ `scope` 是 PRIMARY KEY，而 SQLite 里 **NULL 互不相等** ⇒ 冲突永不触发')
  }
  const rows = stored()
  assert.deepEqual(rows.map((r) => r.url), ['https://n/1', 'https://n/2', 'https://n/3'], '三行都在库里')
  assert.ok(rows.every((r) => r.scope === null))
  // 用哪种 scope 都读不回来
  assert.equal((await get('?scope=default')).body.source.url, '', 'default 里没有')
  assert.equal((await get('?scope=')).body.source.url, '', '空串里也没有')
  assert.equal((await get('?scope=null')).body.source.url, '', '字面量 "null" 里也没有')
  assert.equal(mod.db.prepare("SELECT COUNT(*) AS n FROM skill_sources WHERE url LIKE 'https://n/%'").get().n, 3,
    '★ 三行确实躺在库里 —— 写进去了、读不出来')
})

test('⑧ ★★ `scope: \'\'` 与"不给 scope"落在**两个不同**的空间', async () => {
  reset()
  await post({ scope: '', url: 'https://empty/', by: 'x' })
  await post({ url: 'https://none/', by: 'x' })
  assert.deepEqual(stored().map((r) => r.scope), ['', 'default'])
  assert.equal((await get('?scope=')).body.source.url, 'https://empty/')
  assert.equal((await get('?scope=default')).body.source.url, 'https://none/')
  // ★ `handleWrite` 本来就把 `readScope` 的结果算好了、并作为**第三个参数**递进回调，
  //   而 `readScope({scope:''})` 是 `'default'` ⇒ 这两次本该落在**同一个**空间。
  //   这条与 ⑦/⑨/⑩/⑫ 是同一个根因的四种外显，分开写是为了让"红在哪一格"一眼看得出来。
})

test('⑨ ★★ `scope: \'  a  \'` 原样存 ⇒ `?scope=a` 读不到', async () => {
  reset()
  await post({ scope: '  a  ', url: 'https://p/', by: 'x' })
  assert.deepEqual(stored().map((r) => r.scope), ['  a  '], '★ 写的时候**不 trim**')
  assert.equal((await get('?scope=a')).body.source.url, '', '★ 按"看起来的那个名字"读不到')
  assert.equal((await get('?scope=%20%20a%20%20')).body.source.url, 'https://p/', '只有原样带空白才读得到')
})

test('⑩ ★★ `scope: 123` 存成文本 `"123.0"` ⇒ `?scope=123` 读不到', async () => {
  reset()
  const r = await post({ scope: 123, url: 'https://num/', by: 'x' })
  assert.equal(r.status, 200)
  assert.equal(r.body.task.scope, '123.0', '★ 数字被 node:sqlite 按 REAL 绑进去、TEXT 列再把它转成 "123.0"')
  assert.deepEqual(stored().map((x) => x.scope), ['123.0'])
  assert.equal((await get('?scope=123')).body.source.url, '', '★ 按 123 读不到')
  assert.equal((await get('?scope=123.0')).body.source.url, 'https://num/', '得念 "123.0"')
})

test('⑪ ★★ 布尔 / 数组 / 对象 scope ⇒ 400，而**驱动原文**直接漏给客户端', async () => {
  reset()
  const cases = [
    [true, /cannot be bound to SQLite parameter/],
    [false, /cannot be bound to SQLite parameter/],
    [['a'], /Unknown named parameter/],
    [{ a: 1 }, /Unknown named parameter/],
  ]
  for (const [v, re] of cases) {
    const r = await post({ scope: v, url: 'https://u/', by: 'x' })
    assert.equal(r.status, 400, `scope=${JSON.stringify(v)}`)
    assert.match(String(r.body.error), re,
      '★ 这是 node:sqlite 的**原始报错文本**：`Provided value cannot be bound to SQLite parameter 1.` / ' +
      '`Unknown named parameter \'a\'` —— 它既没被翻译、也没被包成具名码，直接把驱动内部措辞漏出去了')
  }
  assert.equal(stored().length, 0)
})

test('⑫ ★★★ `scope: {}` ⇒ 200，但**位置参数整体错位一格**：把 url 写进了 scope', async () => {
  reset()
  const r = await post({ scope: {}, url: 'https://shifted/', branch: 'b', by: 'x' })
  assert.equal(r.status, 200, '★ 报成功')
  const rows = stored()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].scope, 'https://shifted/',
    '★ 存进去的 `scope` **是那个 url** —— node:sqlite 把对象当**具名参数**，于是位置参数从 `url` 那个开始往后错一位')
  assert.equal(rows[0].url, 'b', '★ `url` 拿到的是 branch')
  assert.match(String(rows[0].branch), /^\d{4}-\d{2}-\d{2}T/, '★ `branch` 拿到的是 `now()` 那个时间戳')
  assert.equal(rows[0].updatedAt, null, '★ 第四个 `?` 没人喂 ⇒ NULL')
  // ★ 整行都错位了：`scope←url`、`url←branch`、`branch←now()`、`updatedAt←NULL`。
  //   我第一版只推到"`branch` 是空串"——错在**只往下推了一位**。
  //   一个"我把参数错位的后果推完了"的印象，与一个"它**每一位**都往前提了一格"的事实，
  //   在我没有把那四个值逐个对出来的时候是同一个东西。
  // ★ 这条如果红了：说明有人开始校验 `scope` 的类型了 —— 那是**修对了**。
  //   请把断言改成 400 + 具名码，并把 §7~⑫ 这几条一起改。
})

// ── url 的归一 ────────────────────────────────────────────────────────────
test('⑬ `url` 归一：缺/`null` ⇒ 空串；数字 ⇒ 字符串；前后空白 ⇒ trim', async () => {
  reset()
  for (const [label, url, want] of [
    ['缺', undefined, ''],
    ['null', null, ''],
    ['空串', '', ''],
    ['数字', 12345, '12345'],
    ['空白包围', '  https://a/  ', 'https://a/'],
  ]) {
    const body = { scope: 'u' + label.length + label, by: 'x' }
    if (url !== undefined) body.url = url
    const r = await post(body)
    assert.equal(r.status, 200, `url=${label}`)
    assert.equal(r.body.task.url, want, `url=${label}`)
  }
})

test('⑭ ★ **完全不校验 URL**（段首说明写着"只是 URL 配置，拉取时另行白名单校验"）', async () => {
  reset()
  for (const url of ['这不是 URL', 'javascript:alert(1)', 'file:///etc/passwd', 'https://github.com/a/b']) {
    const r = await post({ scope: 'v', url, by: 'x' })
    assert.equal(r.status, 200, `★ 写的时候一个都不拦：${url}`)
    assert.equal(r.body.task.url, url)
  }
  assert.equal((await get('?scope=v')).body.source.url, 'https://github.com/a/b', '最后一次覆盖')
})

test('⑮ 空 `url` 也是**合法写入**（"清空绑定"与"没绑过"在这一层分不开）', async () => {
  reset()
  await post({ scope: 'c', url: 'https://had/', by: 'x' })
  assert.equal((await get('?scope=c')).body.source.url, 'https://had/')
  const cleared = await post({ scope: 'c', url: '', by: 'x' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.task.url, '')
  assert.equal(stored().length, 1, '★ 是覆盖成空，不是删行')
  assert.deepEqual((await get('?scope=c')).body.source,
    { scope: 'c', url: '', branch: '', updatedAt: cleared.body.task.updatedAt },
    '★ 清空之后与"从来没绑过"**长得一模一样**（只差 updatedAt 不为 null）')
})

// ── 方法位 ────────────────────────────────────────────────────────────────
test('⑯ 方法位：只认 GET/POST 各自那一个', async () => {
  reset()
  for (const [m, p] of [['PUT', '/api/skill-source'], ['DELETE', '/api/skill-source'], ['PATCH', '/api/skill-source'], ['GET', '/api/skill-source/x']]) {
    assert.equal((await call(m, p)).status, 404, `${m} ${p} 应当 404`)
  }
  assert.equal((await call('GET', '/api/skill-source')).status, 200, '读路径不查授权')
  // ★ `/api/skills`（带 s）是**另一条**路径，本族的前缀不该把它捞进去
  assert.notEqual((await call('GET', '/api/skills')).status, 404, '`/api/skills` 是另一个族，仍然活着')
})

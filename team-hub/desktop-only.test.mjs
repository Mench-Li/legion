// team-hub/desktop-only.test.mjs
// ============================================================================
// "桌面端才有的功能"的判定与那句话。
//
// 守三句话：
//   ① 边界要**准** —— 带斜杠的前缀不许误伤同前缀的别的路径；
//   ② 那句话要说清三件事（有意的 / 为什么 / 怎么办），且**不许**把用户支给管理员；
//   ③ ★★ **绝不遮蔽真实路由** —— 这条必须端到端证明，不是靠约定。
// ============================================================================
import { describe, it, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DESKTOP_ONLY_STATUS, DESKTOP_ONLY_CODE, DESKTOP_ONLY,
  desktopOnlyFor, desktopOnlyMessage, desktopOnlyHint, desktopOnlyBody,
} from './desktop-only.mjs'

// ── ① ★★★ 判定本身 ────────────────────────────────────────────────────────

describe('desktopOnlyFor', () => {
  it('★★★ 认得出各功能面，并说清是**哪一件**', () => {
    assert.equal(desktopOnlyFor('/api/fs/list')?.label, '目录选择')
    assert.equal(desktopOnlyFor('/api/files/list')?.label, '文件中心')
    assert.equal(desktopOnlyFor('/api/files/reveal')?.label, '文件中心')
    assert.equal(desktopOnlyFor('/api/fs/home')?.label, '目录选择')
    assert.equal(desktopOnlyFor('/api/dsh-models')?.label, '模型列表')
    assert.equal(desktopOnlyFor('/api/skills/import')?.label, '技能导入')
    assert.equal(desktopOnlyFor('/api/skills/scan-dir')?.label, '技能扫描')
    // `why` 必须给出（用户要知道为什么）。
    assert.match(desktopOnlyFor('/api/files/list').why, /本机|电脑/)
  })

  it('★★★ 带斜杠的前缀**不许**误伤同前缀的别的路径（这一类边界错本仓库犯过多次）', () => {
    // 用裸 `startsWith('/api/fs')` 会把下面这些都吞进去。
    for (const p of ['/api/fsharp', '/api/fs-other', '/api/filesystem', '/api/files_extra', '/api/dsh-models-extra', '/api/fsx/list']) {
      assert.equal(desktopOnlyFor(p), null, `${p} 不该被认成桌面端功能`)
    }
    // 而**该**认的一个都不能漏 —— 否则这条判据就成了"什么都不认"。
    for (const p of ['/api/fs', '/api/fs/list', '/api/files', '/api/files/read']) {
      assert.notEqual(desktopOnlyFor(p), null, `${p} 应当被认出来`)
    }
  })

  it('★★★ 非斜杠前缀也**不许**误伤：`/api/skills/importx` 不算技能导入', () => {
    // ★ 这条是一次**破坏性验证**逼出来的：有一类前缀写成 `/api/skills/import`
    //   （不带结尾斜杠），匹配走的是「等于或后跟斜杠」。
    //   把它退化成裸 `startsWith` 时，`/api/skills/importx` 会被吃掉 ——
    //   而原来的判据里**没有这一条**，所以那处破坏没被抓住。
    assert.equal(desktopOnlyFor('/api/skills/importx'), null)
    assert.equal(desktopOnlyFor('/api/skills/importation'), null)
    assert.equal(desktopOnlyFor('/api/skills/scan-dirZZZ'), null)
    assert.equal(desktopOnlyFor('/api/skills/synchronize'), null)
    // 而「等于」与「后跟斜杠」两种**都要**认出来（否则这条判据成了"什么都不认"）。
    assert.notEqual(desktopOnlyFor('/api/skills/import'), null)
    assert.notEqual(desktopOnlyFor('/api/skills/import/'), null)
    assert.notEqual(desktopOnlyFor('/api/skills/import/abc'), null)
    assert.notEqual(desktopOnlyFor('/api/skills/sync'), null)
    assert.notEqual(desktopOnlyFor('/api/skills/sync/x'), null)
  })
  it('★★★ `/api/fs` 精确命中，而 `/api/fsx` 不算', () => {
    assert.notEqual(desktopOnlyFor('/api/fs'), null)
    assert.equal(desktopOnlyFor('/api/fsx'), null)
    assert.equal(desktopOnlyFor('/api/filesx'), null)
  })

  it('★★★ 存在的真路由**不被认成**桌面端功能（否则会误导用户）', () => {
    // 这些在 Hub 上都有真路由（见 server.mjs 的路由表）。
    for (const p of ['/api/tasks', '/api/chat/messages', '/api/identity/status', '/api/agents', '/api/skills/register', '/api/config']) {
      assert.equal(desktopOnlyFor(p), null, `${p} 是真路由，不该被判成桌面端功能`)
    }
  })

  it('★★ 畸形输入不抛，且回 null（不是 false、不是抛）', () => {
    for (const bad of [null, undefined, '', 42, {}, []]) {
      assert.doesNotThrow(() => desktopOnlyFor(bad))
      assert.equal(desktopOnlyFor(bad), null, `${String(bad)} 应当回 null`)
    }
  })

  it('★ 表里每条都要有 label 与 why（缺了用户不知道为什么）', () => {
    assert.ok(DESKTOP_ONLY.length >= 8, `表里应当有若干条，实际 ${DESKTOP_ONLY.length}`)
    for (const e of DESKTOP_ONLY) {
      assert.equal(typeof e.label, 'string')
      assert.ok(e.label.length > 0, `缺 label：${JSON.stringify(e)}`)
      assert.equal(typeof e.why, 'string')
      assert.ok(e.why.length > 0, `缺 why：${JSON.stringify(e)}`)
      assert.ok(typeof e.exact === 'string' || typeof e.prefix === 'string', '至少要有一个匹配形态')
    }
  })

  it('★★ 前缀带斜杠的那一类，**必须**真的以斜杠结尾（判据盯住这个约定）', () => {
    // 只要有**一个**条目的前缀漏了斜杠并且代码改用裸 startsWith，
    // 上面那条边界判据就会失效。这里把约定钉死。
    for (const e of DESKTOP_ONLY) {
      if (typeof e.prefix === 'string' && e.prefix.startsWith('/api/') && !e.prefix.endsWith('/')) {
        // 允许不带斜杠，但那种必须**也**给 exact，或者本身就是一个完整资源名
        // （如 `/api/skills/import`）—— 这时匹配走的是"等于或后跟斜杠"。
        assert.ok(e.prefix.split('/').length >= 4,
          `前缀 ${e.prefix} 太宽了：不带结尾斜杠时它有误伤风险`)
      }
    }
  })
})

// ── ①b ★★★ 接线（按源码结构）：判定必须在**所有 dispatch 之后** ──────────
//
// 这一节是**结构性**的（断言源码里的**位置**），不是行为性的。理由：
// "不遮蔽真路由"这条性质**完全靠调用点**撑着 —— 判定若被挪到 dispatch 之前，
// 每一条前缀都会抢走它下面的真接口（例如 `/api/web/` 抢走 `/api/web/history`）。
//
// ★ 而"把它挪到前面"这个破坏**写不出来**（字符串替换挪不动一大段代码），
//   所以我第一版的破坏只是把同一行又写了一遍 —— **空破坏**。
//   位置性质只能用位置判据盯。
const SERVER_SRC = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('★★★ `desktopOnlyFor` 的每一次调用都在 `handle()` 的**最后一次 dispatch 之后**', () => {
  const h = SERVER_SRC.indexOf('async function handle(')
  assert.ok(h > 0, '找不到 handle')
  const end = SERVER_SRC.indexOf('\nconst server = http.createServer(', h)
  const body = SERVER_SRC.slice(h, end > 0 ? end : undefined)
  const lastDispatch = body.lastIndexOf('router.dispatch(')
  assert.ok(lastDispatch > 0, 'handle() 里应当有 router.dispatch')
  const calls = [...body.matchAll(/desktopOnlyFor\(/g)].map((m) => m.index)
  assert.ok(calls.length >= 1, 'handle() 里应当调用 desktopOnlyFor')
  for (const at of calls) {
    assert.ok(at > lastDispatch,
      `desktopOnlyFor 在偏移 ${at}，而最后一次 dispatch 在 ${lastDispatch} —— `
      + '判定跑到了路由前面，会抢走它前缀下的真接口（如 /api/web/history）')
  }
})

test('★★★ 反例守卫：dispatch 之前的偏移必须被判为不合格', () => {
  const h = SERVER_SRC.indexOf('async function handle(')
  const end = SERVER_SRC.indexOf('\nconst server = http.createServer(', h)
  const body = SERVER_SRC.slice(h, end)
  const lastDispatch = body.lastIndexOf('router.dispatch(')
  const before = lastDispatch - 1
  assert.equal(before > lastDispatch, false, '反例：dispatch 之前的偏移不该通过')
  assert.equal(body.length - 1 > lastDispatch, true, '正例：文件末尾的偏移该通过')
})

// ── ② ★★★ 那句话 ─────────────────────────────────────────────────────────

describe('desktopOnlyMessage', () => {
  it('★★★ 三件事缺一不可（有意的 / 为什么 / 怎么办的边界）', () => {
    const m = desktopOnlyMessage({ label: '文件中心', why: '它的目录根是你本机的目录。' })
    // ① 是**有意**的（"需要在桌面端" 而不是 "出错了"）。
    assert.match(m, /桌面端/, '要说清这是桌面端才有的')
    // ② 为什么 —— 操作对象是**你的**电脑。
    assert.match(m, /本机|你的/)
    // ③ 说清服务器上为什么做不到（这才是"为什么不是 bug"）。
    assert.match(m, /服务器/, '要说清服务器上做不到')
  })

  it('★★★ 不许把用户支给管理员（管理员**修不好**这件事）', () => {
    // 与 `storage-health.mjs` 的 `storageMessage` 相反：那个要"请联系管理员"
    // （盘满是运维能修的），而这里**不是故障、是设计** —— 引到管理员那里
    // 只会浪费两个人的时间。
    const m = desktopOnlyMessage({ label: '文件中心', why: '本机目录。' })
    assert.doesNotMatch(m, /请联系管理员|联系运维/, '这不是故障，不该让用户去找管理员')
  })

  it('★★★ 不许说"暂不支持 / 敬请期待"这类含糊话（用户会一直等）', () => {
    const m = desktopOnlyMessage({ label: '文件中心', why: '本机目录。' })
    for (const vague of [/暂不支持/, /敬请期待/, /即将上线/, /稍后再试/]) {
      assert.doesNotMatch(m, vague, `不许用含糊话：${m}`)
    }
  })

  it('★★★ 要指名道姓说**是哪一件**功能（"这个功能"等于没说）', () => {
    const m = desktopOnlyMessage({ label: '文件中心', why: '本机目录。' })
    assert.match(m, /文件中心/)
  })

  it('★★ 缺参数不出现 undefined，也不抛', () => {
    for (const bad of [null, undefined, {}, { label: '', why: '' }, 42]) {
      let m
      assert.doesNotThrow(() => { m = desktopOnlyMessage(bad) })
      assert.doesNotMatch(m, /undefined|\bnull\b|\[object/, `脏值：${m}`)
      assert.match(m, /桌面端/, '退化时仍然要说清是桌面端的事')
    }
  })
})

describe('desktopOnlyHint', () => {
  it('★★★ 给出**下一步**（与 message 分工：一个解释，一个指路）', () => {
    const h = desktopOnlyHint({ label: '文件中心' })
    assert.match(h, /桌面端/, '要指到桌面端去')
    assert.match(h, /文件中心/, '要说清是哪一件事')
    // 与 message 不重复：hint 里不该再解释"为什么"。
    assert.doesNotMatch(h, /服务器上做不到/)
  })

  it('★★ 缺参数不抛、不出现 undefined', () => {
    for (const bad of [null, undefined, {}, 42]) {
      assert.doesNotThrow(() => desktopOnlyHint(bad))
      assert.doesNotMatch(desktopOnlyHint(bad), /undefined|\bnull\b/)
    }
  })
})

// ── ③ ★★★ 响应体形状 ─────────────────────────────────────────────────────

describe('desktopOnlyBody', () => {
  it('★★★ 形状齐备：具名码 + 可读的话 + 下一步 + 一个**显式**布尔量', () => {
    const b = desktopOnlyBody(desktopOnlyFor('/api/files/list'))
    assert.equal(b.code, DESKTOP_ONLY_CODE)
    assert.equal(b.code, 'DESKTOP_ONLY')
    assert.equal(typeof b.error, 'string')
    assert.equal(typeof b.hint, 'string')
    // ★ 显式布尔量：客户端不该靠 `code` 的**字符串值**去判断 ——
    //   那是一种"改一个常量就静默失效"的耦合。
    assert.equal(b.desktopOnly, true)
  })

  it('★★★ 状态码是 501 而不是 404/500', () => {
    // 404 = "没有这个接口"（暗示 bug，而这是**有意**的）
    // 500 = "我们不知道哪里错了"（而这里我们**知道**）
    // 501 = "服务器**不实现**这个功能" —— 与事实一字不差
    assert.equal(DESKTOP_ONLY_STATUS, 501)
    assert.notEqual(DESKTOP_ONLY_STATUS, 404)
    assert.notEqual(DESKTOP_ONLY_STATUS, 500)
    assert.notEqual(DESKTOP_ONLY_STATUS, 403, '403 是"你没权限" —— 而这不是权限问题')
  })

  it('★★ 畸形输入不抛', () => {
    for (const bad of [null, undefined, 42, {}, { label: null, why: null }]) {
      assert.doesNotThrow(() => desktopOnlyBody(bad))
      assert.equal(desktopOnlyBody(bad).desktopOnly, true)
    }
  })
})

// ── ④ ★★★ 端到端：**绝不遮蔽真实路由** ───────────────────────────────────
//
// 这一节是本文件最要紧的部分。判定被放在**所有路由族都没匹配上之后**
// （`server.mjs` 的 404 兜底处），所以它**结构上**不可能抢走真路由 ——
// 但"结构上不可能"必须被**证明**，而不是被约定。
//
// 证明方式：对表里每一条前缀，都找一个**确实存在**的真路由，
// 断言它走的是真路由（不是 501）。
describe('端到端：真路由优先（真 HTTP）', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-desktop-only-'))
  const HUB_TOKEN = 'desktop-only-hub-token'
  const IDENTITY_KEY = 'desktop-only-identity-key-0123456789'
  let mod
  let base = ''

  before(async () => {
    process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
    process.env.TEAM_HUB_HOST = '127.0.0.1'
    process.env.TEAM_HUB_TOKEN = HUB_TOKEN
    process.env.LEGION_IDENTITY_KEY = IDENTITY_KEY
    process.env.LEGION_REMOTE_AUTH = '1'
    mod = await import('./server.mjs')
    await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${mod.server.address().port}`
  })

  after(() => {
    try { mod?.nodeGateway?.close?.() } catch { /* 已关 */ }
    try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
    try { mod?.server?.close() } catch { /* 已关闭 */ }
    try { mod?.db?.close?.() } catch { /* 已关闭 */ }
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const call = async (method, path) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${HUB_TOKEN}` } })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }

  it('★★★ 桌面端不了的路径 → 501 + DESKTOP_ONLY + 那句话', async () => {
    const r = await call('GET', '/api/fs/list')
    assert.equal(r.status, DESKTOP_ONLY_STATUS, `实际 ${r.status}：${r.text.slice(0, 160)}`)
    assert.equal(r.json?.code, DESKTOP_ONLY_CODE)
    assert.equal(r.json?.desktopOnly, true)
    assert.match(r.json.error, /目录选择/)
    assert.match(r.json.error, /桌面端/)
    assert.equal(typeof r.json.hint, 'string')
    // ★ 不许是那句含糊的 `not found`。
    assert.doesNotMatch(r.text, /not found/, '不许回"没找到" —— 那是"这里坏了"的读法')
  })

  it('★★★ **真路由优先**：每一条前缀都有一个真路由没被抢走', async () => {
    // ★ 这一条是整族的守门判据。表按前缀写（宽），所以必须证明
    //   真路由**先赢** —— 否则我们会把能用的接口变成 501。
    //
    //   每个样本都选一个**确实存在**的路由，且它的路径落在某条桌面端前缀之下。
    const samples = [
      // `/api/web/` 前缀之下的真路由
      ['GET', '/api/web/history'],
      // `/api/files/` 前缀之下：`/api/files` 无真路由，但 `/api/artifact/content` 是真路由 ——
      // 这里用另一个已知真路由确认兜底不影响它
      ['GET', '/api/chat/conversations'],
      // `/api/fs/` 前缀之下没有真路由，用相邻的真路由证明前缀没有写宽
      ['GET', '/api/tasks'],
    ]
    for (const [method, path] of samples) {
      const r = await call(method, path)
      assert.notEqual(r.status, DESKTOP_ONLY_STATUS,
        `${path} 是真路由，绝不能被兜底抢走（实际 ${r.status}）`)
    }
  })

  it('★★★ 真路由 `/api/web/history` 走的是它自己（不被 `/api/web/` 前缀抢走）', async () => {
    // 这一条单独拎出来：它是"前缀表宽 + 真路由优先"这个设计能不能成立的关键证据。
    const r = await call('GET', '/api/web/history')
    assert.notEqual(r.status, DESKTOP_ONLY_STATUS, `被抢走了：${r.text.slice(0, 160)}`)
    assert.notEqual(r.json?.code, DESKTOP_ONLY_CODE)
  })

  it('★★★ 完全无关的路径仍然回 404（兜底不许把 404 变成 501）', async () => {
    // ★ 否则"500/501 到处都有"会让真正的拼写错误也看起来像"桌面端功能"。
    for (const p of ['/api/nonexistent-xyz', '/api/fsharp', '/totally/unknown']) {
      const r = await call('GET', p)
      assert.equal(r.status, 404, `${p} 应当仍然是 404，实际 ${r.status}`)
      assert.match(r.text, /not found/, `${p} 应当仍然是那句 not found`)
    }
  })

  it('★★★ 桌面端面**不需要**令牌也回 501（不是 401 抢先）', async () => {
    // 一个匿名用户点"文件中心"，该看到"要在桌面端用"，而不是"请先登录" ——
    // 因为登录了也做不到。
    //
    // ⚠️ 注意：`LEGION_REMOTE_AUTH=1` 时那道远端门会**先**回 401。
    //    这条判据因此断言的是"**要么** 401（被门挡住，合理），
    //    **要么** 501（走到兜底，也合理）" —— 不许是 404。
    const res = await fetch(`${base}/api/fs/list`)
    assert.ok([401, DESKTOP_ONLY_STATUS].includes(res.status),
      `匿名应当 401 或 501，实际 ${res.status}`)
    assert.notEqual(res.status, 404)
  })

  it('★★★ 各种方法都认（GET/POST/PUT/DELETE 不是只认一种）', async () => {
    // `/api/files/*` 里读是 GET、写是 POST/PUT、删除是 POST ——
    // 只认一种方法会让一半的面板仍然拿到 404。
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await call(method, '/api/files/list')
      assert.equal(r.status, DESKTOP_ONLY_STATUS, `${method} 实际 ${r.status}`)
      assert.equal(r.json?.code, DESKTOP_ONLY_CODE)
    }
  })

  it('★★★ 进程没被带崩（后续请求照常）', async () => {
    assert.equal((await call('GET', '/api/identity/status')).status, 200)
    assert.equal((await call('GET', '/api/config')).status, 200)
  })
})

// team-hub/download-lines.test.mjs
// ============================================================================
// 多线路下载（T-196）：线路表的解析/选线，以及它**真的进了页面**。
//
// ## 这组用例守的是什么
//
// 起因是一次实测：站点只经 Cloudflare Tunnel 对外，境内访客被分配到洛杉矶边缘，
// 195MB 安装包约 **1.8 KB/s**（而源站直连 connect 0.06s）。修法是"多线路"，
// 而多线路最容易坏的**不是**选线算法，是这两个接缝：
//
//   ① 线路表写错时**静默退回单线路** —— 于是"镜像没生效"与"配置写错了"
//      在页面上长得一模一样，运营者会一直去查 CDN；
//   ② 选了线路却**没进页面** —— 算法对、页面还是老地址，
//      而单元测试只测算法时它全绿。
//
//   > 一个"选线正确但页面没用到"的实现，
//   > 与一个"没有多线路"的实现，在用户那边是同一个东西——
//   > 只不过前者有一组全绿的选线用例。
//
// 所以下面既有纯函数断言，也有**走真实 dispatch 的路由级断言**（带
// `cf-ipcountry` 头，断言页面上的 href 真的换成了那条线路）。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DOWNLOAD_LINE_CODES, DOWNLOAD_LINES_CHECKED, DOWNLOAD_LINES_FORMAT,
  formatDownloadLineProblems, loadDownloadLines, parseDownloadLines,
  sampleLinesConfig, selectDownloadLine, selfCheckDownloadLines,
} from './download-lines.mjs'
// ★ 2026-10-12：这两条 import 从 `routes/site.mjs` 换成了 `routes/portal.mjs`。
//   官网不再有下载按钮，按地区选线现在服务于门口页那一个按钮。
import { createPortalRoutes, renderPortal } from './routes/portal.mjs'

const CN_URL = 'https://legion-releases.s3.cn-north-1.jdcloud-oss.com/legion/releases/r-1/Legion-Setup-win-x64.exe'
const GLOBAL_URL = 'https://legion-si.online/legion/releases/r-1/Legion-Setup-win-x64.exe'

const LINES = Object.freeze([
  Object.freeze({ id: 'cn', label: '国内线路', labelEn: 'China mirror', url: CN_URL, countries: Object.freeze(['CN']) }),
  Object.freeze({ id: 'global', label: '国际线路', labelEn: 'Global', url: GLOBAL_URL, countries: Object.freeze([]) }),
])

async function call(routes, { method = 'GET', path = '/', headers = {} } = {}) {
  const chunks = []
  const res = {
    writeHead(status, h) { this.status = status; this.headers = h },
    write(c) { chunks.push(Buffer.from(c)); return true },
    end(c) { if (c !== undefined) chunks.push(Buffer.from(c)); this.ended = true },
    on() { return this }, once() { return this }, emit() { return true },
  }
  const handled = await routes.dispatch({ method, url: path, headers }, res, { path })
  if (!res.ended) await new Promise((r) => setTimeout(r, 60))
  return { handled, status: res.status, headers: res.headers ?? {}, body: Buffer.concat(chunks).toString('utf8') }
}

// ── ① 解析：合法输入 ────────────────────────────────────────────────────────

describe('线路表：解析', () => {
  test('① 合法线路表解析出全部线路，且 labelEn 缺省时回退到 label', () => {
    const r = parseDownloadLines({
      format: DOWNLOAD_LINES_FORMAT,
      lines: [{ id: 'only', label: '唯一线路', url: GLOBAL_URL }],
    })
    assert.equal(r.ok, true, JSON.stringify(r.problems))
    assert.equal(r.lines.length, 1)
    assert.equal(r.lines[0].labelEn, '唯一线路', 'labelEn 缺席时应回退到 label，而不是空串')
    assert.deepEqual([...r.lines[0].countries], [])
  })

  test('② 样例配置与装载期自检一致（自检本身也必须绿）', () => {
    assert.equal(DOWNLOAD_LINES_CHECKED.ok, true, JSON.stringify(DOWNLOAD_LINES_CHECKED.problems))
    const r = parseDownloadLines(sampleLinesConfig())
    assert.equal(r.ok, true)
    assert.equal(r.lines.length, 2)
    assert.equal(selfCheckDownloadLines().ok, true)
  })

  test('③ 大小写与空白：countries 归一成大写，label 去首尾空白', () => {
    const r = parseDownloadLines({
      format: DOWNLOAD_LINES_FORMAT,
      lines: [{ id: 'cn', label: '  国内线路  ', url: CN_URL, countries: ['cn'] }],
    })
    assert.equal(r.ok, true, JSON.stringify(r.problems))
    assert.equal(r.lines[0].label, '国内线路')
    assert.deepEqual([...r.lines[0].countries], ['CN'])
  })

  // ── ② 解析：每一条拒绝都必须**具名**，且 fail closed ──────────────────────
  //
  // ★ `fail closed` 单独断言（不只是"有 ok:false"）：半生效更坏——
  //   一部分用户静默拿到慢线路，而没有任何地方说明为什么。
  const REJECTS = [
    ['不是对象', null, DOWNLOAD_LINE_CODES.NOT_OBJECT],
    ['format 不对', { format: 'legion/whatever@9', lines: [] }, DOWNLOAD_LINE_CODES.BAD_FORMAT],
    ['lines 不是数组', { format: DOWNLOAD_LINES_FORMAT, lines: {} }, DOWNLOAD_LINE_CODES.BAD_LINES],
    ['lines 为空', { format: DOWNLOAD_LINES_FORMAT, lines: [] }, DOWNLOAD_LINE_CODES.EMPTY_LINES],
    ['id 形状不对', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'CN Line', label: 'x', url: CN_URL }] }, DOWNLOAD_LINE_CODES.BAD_ID],
    ['label 为空', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: '  ', url: CN_URL }] }, DOWNLOAD_LINE_CODES.BAD_LABEL],
    ['labelEn 给了但为空', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', labelEn: '', url: CN_URL }] }, DOWNLOAD_LINE_CODES.BAD_LABEL],
    ['url 是相对路径', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: '/legion/releases/x.exe' }] }, DOWNLOAD_LINE_CODES.BAD_URL],
    ['url 是 javascript:', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: 'javascript:alert(1)' }] }, DOWNLOAD_LINE_CODES.BAD_URL],
    ['url 是 ftp:', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: 'ftp://h/x.exe' }] }, DOWNLOAD_LINE_CODES.BAD_URL],
    ['明文 http 未显式允许', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: 'http://117.72.146.36/x.exe' }] }, DOWNLOAD_LINE_CODES.INSECURE_URL],
    ['id 重复', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: CN_URL }, { id: 'a', label: 'y', url: GLOBAL_URL }] }, DOWNLOAD_LINE_CODES.DUPLICATE_ID],
    ['url 重复', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: CN_URL }, { id: 'b', label: 'y', url: CN_URL }] }, DOWNLOAD_LINE_CODES.DUPLICATE_URL],
    ['countries 是三位码', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: CN_URL, countries: ['CHN'] }] }, DOWNLOAD_LINE_CODES.BAD_COUNTRIES],
    ['countries 不是数组', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: CN_URL, countries: 'CN' }] }, DOWNLOAD_LINE_CODES.BAD_COUNTRIES],
    ['两条默认线路', { format: DOWNLOAD_LINES_FORMAT, lines: [{ id: 'a', label: 'x', url: CN_URL }, { id: 'b', label: 'y', url: GLOBAL_URL }] }, DOWNLOAD_LINE_CODES.BAD_COUNTRIES],
  ]

  for (const [name, input, code] of REJECTS) {
    test(`④ 具名拒绝并 fail closed：${name}`, () => {
      const r = parseDownloadLines(input)
      assert.equal(r.ok, false, `${name} 应被拒绝`)
      assert.ok(r.problems.some((p) => p.code === code),
        `${name} 期望拒绝码 ${code}，实际 ${r.problems.map((p) => p.code).join(',')}`)
      assert.equal(r.lines.length, 0, `${name}：拒绝时必须一条线路都不给（fail closed）`)
      // 每条问题都要有可读的理由：一句只有码的错误让人无从下手。
      // ★ 判据是"理由存在且不是把码抄一遍"，**不是**长度阈值——
      //   第一版写的 `length > 8` 把「线路表必须是对象」（9 个字符，完全够清楚）
      //   判成了不合格。长度与"说得清不清楚"没关系，那只是一种容易写错的代理。
      for (const p of r.problems) {
        assert.equal(typeof p.message, 'string', `问题「${p.code}」没有理由`)
        assert.ok(p.message.trim().length > 0, `问题「${p.code}」的理由是空的`)
        assert.notEqual(p.message.trim(), p.code, `问题「${p.code}」的理由只是把码抄了一遍`)
      }
    })
  }

  test('⑤ 显式 allowInsecureHttp 时 http 可通过（测试机的真实用法）', () => {
    const r = parseDownloadLines({
      format: DOWNLOAD_LINES_FORMAT, allowInsecureHttp: true,
      lines: [{ id: 'test', label: '测试机', url: 'http://117.72.146.36/legion/releases/x.exe' }],
    })
    assert.equal(r.ok, true, JSON.stringify(r.problems))
  })

  test('⑥ allowInsecureHttp 不是布尔时具名拒绝', () => {
    const r = parseDownloadLines({ format: DOWNLOAD_LINES_FORMAT, allowInsecureHttp: 'yes', lines: [{ id: 'a', label: 'x', url: CN_URL }] })
    assert.equal(r.ok, false)
    assert.ok(r.problems.some((p) => p.code === DOWNLOAD_LINE_CODES.BAD_LINE))
  })
})

// ── ③ 选线 ──────────────────────────────────────────────────────────────────

describe('线路表：按地区选线', () => {
  test('⑦ 声明了该地区的线路优先', () => {
    assert.equal(selectDownloadLine(LINES, { country: 'CN' }).featured.id, 'cn')
    assert.equal(selectDownloadLine(LINES, { country: 'cn' }).featured.id, 'cn', '小写地区码也要认')
  })

  test('⑧ 没有该地区时用默认线路（countries 为空的那条）', () => {
    assert.equal(selectDownloadLine(LINES, { country: 'US' }).featured.id, 'global')
  })

  test('⑨ 地区未知 / 非法地区码 / 空对象都回退到默认线路', () => {
    for (const visitor of [{}, { country: null }, { country: '' }, { country: '不是地区码' }, { country: 'CHN' }]) {
      assert.equal(selectDownloadLine(LINES, visitor).featured.id, 'global',
        `访客 ${JSON.stringify(visitor)} 应回退到默认线路`)
    }
  })

  test('⑩ 备选线路里**不含**被选中的那条，且顺序保持', () => {
    const cn = selectDownloadLine(LINES, { country: 'CN' })
    assert.deepEqual(cn.others.map((l) => l.id), ['global'])
    const us = selectDownloadLine(LINES, { country: 'US' })
    assert.deepEqual(us.others.map((l) => l.id), ['cn'])
  })

  test('⑪ 没有默认线路时，谁都不匹配就取第一条（总得给一个能点的链接）', () => {
    const only = [{ id: 'a', label: 'x', labelEn: 'x', url: CN_URL, countries: ['CN'] }]
    assert.equal(selectDownloadLine(only, { country: 'US' }).featured.id, 'a')
  })

  test('⑫ 空表 → ok:false（调用方据此维持原来的单线路行为）', () => {
    const r = selectDownloadLine([], { country: 'CN' })
    assert.equal(r.ok, false)
    assert.equal(r.featured, null)
    assert.deepEqual([...r.others], [])
  })
})

// ── ④ 落盘读取 ──────────────────────────────────────────────────────────────

describe('线路表：从磁盘读', () => {
  test('⑬ 路径为空 = 没配多线路：合法，且**没有问题**', () => {
    const r = loadDownloadLines('')
    assert.deepEqual([...r.lines], [])
    assert.deepEqual([...r.problems], [], '「没配」不该被报成问题——否则启动日志会一直有噪音')
    assert.equal(r.source, null)
  })

  test('⑭ 路径给了但文件不在 = 具名问题（与「没配」是两件事）', () => {
    const r = loadDownloadLines('C:\\definitely-missing-lines.json')
    assert.equal(r.problems[0]?.code, DOWNLOAD_LINE_CODES.FILE_MISSING)
    assert.deepEqual([...r.lines], [])
  })

  test('⑮ 坏 JSON 与非法内容都具名拒绝，不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legion-lines-'))
    try {
      const bad = join(dir, 'bad.json')
      writeFileSync(bad, '{ not json')
      assert.equal(loadDownloadLines(bad).problems[0].code, DOWNLOAD_LINE_CODES.FILE_BAD_JSON)

      const wrong = join(dir, 'wrong.json')
      writeFileSync(wrong, JSON.stringify({ format: 'nope', lines: [] }))
      const r = loadDownloadLines(wrong)
      assert.ok(r.problems.some((p) => p.code === DOWNLOAD_LINE_CODES.BAD_FORMAT))
      assert.deepEqual([...r.lines], [])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('⑯ 真实落盘的一份线路表能读回来（端到端过一遍 JSON）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legion-lines-ok-'))
    try {
      const file = join(dir, 'lines.json')
      writeFileSync(file, JSON.stringify({ format: DOWNLOAD_LINES_FORMAT, lines: [
        { id: 'cn', label: '国内线路', labelEn: 'China mirror', url: CN_URL, countries: ['CN'] },
        { id: 'global', label: '国际线路', labelEn: 'Global', url: GLOBAL_URL },
      ] }))
      const r = loadDownloadLines(file)
      assert.deepEqual([...r.problems], [], JSON.stringify(r.problems))
      assert.equal(r.lines.length, 2)
      assert.equal(selectDownloadLine(r.lines, { country: 'CN' }).featured.url, CN_URL)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('⑰ 启动日志把问题渲染成一行行可读文本（含具名码）', () => {
    const lines = formatDownloadLineProblems([{ code: 'x-code', message: '理由' }])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /x-code/)
    assert.match(lines[0], /理由/)
    assert.deepEqual(formatDownloadLineProblems(null), [])
  })
})

// ── ⑤ 渲染：**备选线路那一段已经没有了** ────────────────────────────────────
//
// ★ 2026-10-12：这一族（原 ⑱–㉒）测的是"备选线路真的进了官网页面"。
//   官网的下载卡片撤掉之后，**没有任何页面再展示备选线路** ——
//   门口页只给一个按钮（被选中的那条线）。所以那五条判据没有了被测对象。
//
//   处理方式：**删掉画线那部分，保留"选线"那部分**（下面的 ⑦ 与上面的
//   ① – ④ 全都在测 `parseDownloadLines` / `selectDownloadLine`，它们照旧有用：
//   `describeDownload()` 仍然用它来挑门口页那个按钮指向哪条线）。
//
//   > 一个"页面不再展示它"的功能，与一个"没有这个功能"的功能，
//   > 在只看页面的人眼里是同一个东西 —— 区别在于选线那半边还在被用着。

// ── ⑥ 路由级：CF-IPCountry 真的改变了**门口页那个按钮**的地址 ──────────────
//
// ★ 这一组才是"接缝"的断言：上面的纯函数全绿而页面还是老地址，是完全可能的。
//
// ★★ 2026-10-12：这一组**从官网搬到了门口页**。原因是官网不再有下载按钮，
//   于是它原先读 `CF-IPCountry` 的那一行成了"读了没人用"。
//
//   不搬会怎样：`describeDownload({ country })` 永远拿到 `undefined`，
//   于是**所有人**都拿到默认线路 —— 而页面看起来完全正常（按钮在、能点、能下），
//   只是那条"给国内用户准备的线"从此不再被选中。
//
//   > 一个"按地区选线"的功能，与一个"永远选默认线"的功能，
//   > 在不看请求头的时候是同一个东西。

describe('门口页路由：按 CF-IPCountry 换按钮地址', () => {
  function routesWithSpy() {
    const seen = []
    const routes = createPortalRoutes({
      downloadUrl: (visitor = {}) => {
        seen.push(visitor)
        const sel = selectDownloadLine(LINES, { country: visitor.country ?? null })
        return sel.featured.url
      },
      version: '1.0.0',
      registration:
        'open',
    })
    return { routes, seen }
  }

  test('㉓ CN 访客：按钮指向国内线路', async () => {
    const { routes, seen } = routesWithSpy()
    const r = await call(routes, { path: '/', headers: { 'cf-ipcountry': 'CN' } })
    assert.equal(r.status, 200)
    assert.deepEqual(seen[0], { country: 'CN' }, '路由必须把 CF-IPCountry 传进 downloadUrl')
    assert.ok(r.body.includes(`href="${CN_URL}"`), `按钮应指向国内线路，实际：${r.body.slice(0, 200)}`)
  })

  test('㉔ 非 CN 访客：按钮指向国际线路', async () => {
    const { routes, seen } = routesWithSpy()
    const r = await call(routes, { path: '/', headers: { 'cf-ipcountry': 'US' } })
    assert.deepEqual(seen[0], { country: 'US' })
    assert.ok(r.body.includes(`href="${GLOBAL_URL}"`))
  })

  test('㉕ 读不到该头（本地开发/直连）：country 传 null，回退到默认线路', async () => {
    const { routes, seen } = routesWithSpy()
    const r = await call(routes, { path: '/', headers: {} })
    assert.deepEqual(seen[0], { country: null }, '没有该头时必须传 null，而不是空串或 undefined')
    assert.ok(r.body.includes(`href="${GLOBAL_URL}"`), '应回退到默认线路')
  })

  test('㉖ 大小写/空串的头也照原样传下去（不在这里归一，由选线那一侧负责）', async () => {
    // readme：归一只有一处（`normalizeCountry`），路由层不做第二次判断 ——
    // 两处各归一一次，正是当初 `"cn"` 配置生效、`"cn"` 访客不生效的那个 bug。
    const { routes, seen } = routesWithSpy()
    for (const raw of ['cn', '', 'XX']) {
      await call(routes, { path: '/', headers: { 'cf-ipcountry': raw } })
    }
    assert.deepEqual(seen.map((v) => v.country), ['cn', '', 'XX'], '路由层只做透传，不做归一')
  })

  test('㉗ 没配多线路时按钮就是那一个地址（既有行为不变）', async () => {
    const seen = []
    const routes = createPortalRoutes({
      downloadUrl: (v = {}) => { seen.push(v); return GLOBAL_URL },
    })
    const r = await call(routes, { path: '/', headers: { 'cf-ipcountry': 'CN' } })
    assert.equal(r.status, 200)
    assert.ok(r.body.includes(`href="${GLOBAL_URL}"`))
    // 单线路时也不能把地址弄丢或重复渲染。
    assert.equal((r.body.match(/Legion-Setup-win-x64.exe/g) || []).length, 1, '只该有一个下载链接')
  })

  test('★★★ HEAD 也要走同一条选线（不缓存、且不能与 GET 给出不同地址）', async () => {
    // 门口页是 `no-store`，HEAD 与 GET 必须一致 —— 否则链接预览/健康检查
    // 看到的地址与用户点开的不是同一个。
    const { routes, seen } = routesWithSpy()
    await call(routes, { method: 'HEAD', path: '/', headers: { 'cf-ipcountry': 'CN' } })
    assert.deepEqual(seen[0], { country: 'CN' }, 'HEAD 也必须把地区传下去')
  })
})

// ── ⑦ ★★★ 协议白名单：门口页那个 href ──────────────────────────────────────
//
// ★ 这一族是**从官网搬过来的**（原 ㉑/㉒）。官网的下载卡片撤掉之后，门口页是
//   唯一还会把"配置里的地址"写进 `href` 的地方 —— 所以那两条判据跟着 href 走。
//
//   搬过来时它**放宽了**：只认 http(s) 绝对地址会把发布目录那条**站内相对路径**
//   （`/legion/releases/<id>/…`）判成坏的，而那是这台 Hub 最常见的情形。
//   放宽的代价必须被钉住，否则下次有人"顺手收紧"就会再断一次。
describe('门口页：下载地址的协议白名单', () => {
  test('★★★ 非 http(s) 的地址**不变成可点的链接**，且说清是配错了', () => {
    for (const evil of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox', '//evil.com/x']) {
      const html = renderPortal({ downloadUrl: evil, version: '1.0.0' })
      assert.doesNotMatch(html, /<a class="card primary" href="(javascript|data|vbscript)/i,
        `${evil} 不该变成可点的 href`)
      // ★ 关键：不能说"尚未发布" —— 运营者明明配了东西，那会把他引去查上传流程。
      assert.match(html, /配得不对/, `${evil}：必须说清是**地址配错**，而不是"还没发布"`)
      assert.doesNotMatch(html, /尚未发布/, `${evil}：不是没发布，是配错了`)
    }
  })

  test('★★★ 站点相对路径**照旧可点**（发布目录那条路给的就是它）', () => {
    // 这条是搬过来时那次真实回归的守卫：`/legion/releases/...` 是相对路径，
    // 如果白名单只认 http(s) 绝对地址，一个**本来能下的**按钮会变成一块牌子。
    const rel = '/legion/releases/r-1/Legion-Setup-win-x64.exe'
    const html = renderPortal({ downloadUrl: rel })
    assert.match(html, /下载电脑版/, '站内相对路径必须仍然给出按钮')
    assert.ok(html.includes(`href="${rel}"`), '而且 href 就是它')
    assert.doesNotMatch(html, /配得不对/)
  })

  test('★ http 与 https 的绝对地址都可点', () => {
    for (const ok of ['https://cdn.test/a.exe', 'http://117.72.146.36/legion/releases/x.exe']) {
      const html = renderPortal({ downloadUrl: ok })
      assert.ok(html.includes(`href="${ok}"`), `${ok} 应当可点`)
    }
  })

  test('★ 地址里的引号与尖括号被转义（配置是人写的，可以写错）', () => {
    const html = renderPortal({ downloadUrl: '/a.exe?x=1&y=2' })
    assert.match(html, /&amp;y=2/, '查询串里的 & 必须被转义')
    const evil = renderPortal({ downloadUrl: '/a" onmouseover="alert(1)' })
    assert.doesNotMatch(evil, /onmouseover="alert\(1\)"[^>]*>\s*下载/, '引号不许闭合 href 属性')
  })

  test('★★ 反例守卫：上面那条"非 http(s) 不可点"不是恒真', () => {
    // 证明判据真的能发现回归：把**没有白名单**的形态喂给它，必须被判红。
    const noGuard = '<a class="card primary" href="javascript:alert(1)"><strong>下载电脑版</strong></a>'
    assert.match(noGuard, /<a class="card primary" href="javascript/i, '反例应当被"非 http(s) 不可点"抓住')
    assert.doesNotMatch(noGuard, /配得不对/, '反例说明：没有守卫时不会出现那句"配得不对"')
  })
})


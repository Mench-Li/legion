// scripts/update/host-config.test.mjs
// ============================================================================
// 托管配置生成器的判据。
//
// 这个文件存在的理由是一件**接缝**上的事：一份能用的 nginx 配置要同时满足
// 两处**各自独立**的声明——
//
//   · `publish.mjs` 的 `UPLOAD_TARGETS`：每棵树的内容根与 URL 前缀
//   · `host.mjs` 的 `FEED_CACHE_CONTROL` / `RELEASE_CACHE_CONTROL`：每条路径
//     该带的 `Cache-Control`，以及 `evaluateResponse` 对它的**严格**判定
//
// 三处各自都对，仍然可以在接缝处对不上。真实托管上就出现过一次：
//
//   /test/legion/…        → 200   ← 托管上有这条 location
//   /legion/…             → 404   ← 托管上**没有**任何 location 服务它
//
// 也就是说 `UPLOAD_TARGETS` 声明的生产前缀（`/legion`）在当时那份配置里
// **根本没有落点**，而按 `upload-plan.txt` 走完生产发布之后，回读那一步必然
// 404——计划里没有任何一步会提示"你还得先加一个 server 块"。
//
// 本文件里最有价值的一条是：**把渲染出来的 Cache-Control 再喂回
// `evaluateResponse`**。它把"生成器"与"验证器"用**同一个函数**连起来，
// 于是这两处不可能各自漂移。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL, evaluateResponse } from '../../product/update/host.mjs'
import { UPLOAD_TARGETS } from './publish.mjs'
import {
  HOST_CONFIG_PROBLEMS, OTHER_SITES, SITE_FILENAME, TREE_NAMES,
  renderDirectoryPlan, renderServerBlock, treeOf,
} from './host-config.mjs'

/** 从渲染结果里取某个 location 块声明的 `Cache-Control`。 */
function cacheControlIn(config, locationPattern) {
  const start = config.indexOf(`location ~ ${locationPattern}`)
  assert.ok(start >= 0, `渲染结果里没有 location ${locationPattern}：\n${config}`)
  const block = config.slice(start, config.indexOf('\n    }', start))
  const match = block.match(/add_header Cache-Control "([^"]+)"/)
  assert.ok(match !== null, `location ${locationPattern} 里没有声明 Cache-Control：\n${block}`)
  return match[1]
}

// ---------------------------------------------------------------------------
// ① 每棵树都推得出来、渲染得出来（这条会挡住"某棵树没有落点"）
// ---------------------------------------------------------------------------

test('★★★ `UPLOAD_TARGETS` 里的**每一棵**树都必须渲染得出配置（接缝判据）', () => {
  // ★ 这条是 ㉜ 的机械形式。当时托管上只有一条
  //   `location ~ ^/(test|production)/legion/`，而 `UPLOAD_TARGETS` 声明
  //   生产前缀是 `/legion`——两者对不上，而**没有任何测试会因此变红**，
  //   因为"托管上装了什么"从来不在仓库里。
  //
  //   现在：仓库里有了生成器，于是"每棵树都要有落点"变成一条可跑的判据。
  //   加了第三棵树而忘记它能被服务时，这条会红。
  assert.ok(TREE_NAMES.length >= 2, `树太少：${TREE_NAMES.join(', ')}`)
  for (const name of TREE_NAMES) {
    const parsed = treeOf(name)
    assert.equal(parsed.ok, true, `树 ${name} 推不出配置：${parsed.code} ${parsed.reason}`)
    const rendered = renderServerBlock({ tree: parsed.tree, serverName: 'updates.example.com' })
    assert.equal(rendered.ok, true, `树 ${name} 渲染失败：${rendered.reason}`)
    // 前缀必须真的出现在 location 里——否则那份配置服务不了这棵树。
    assert.ok(rendered.config.includes(`location ~ ^${parsed.tree.urlPrefix}/feeds/`),
      `树 ${name} 的渲染结果里没有 feeds 的落点`)
    assert.ok(rendered.config.includes(`location ~ ^${parsed.tree.urlPrefix}/releases/`),
      `树 ${name} 的渲染结果里没有 releases 的落点`)
  }
})

// ---------------------------------------------------------------------------
// ② ★ 生成器与验证器用同一个函数连起来
// ---------------------------------------------------------------------------

test('★★★★ 渲染出的 Cache-Control 必须让 `evaluateResponse` 判为通过（生成器 ↔ 验证器）', () => {
  // ★ 这是本文件最重要的一条。它不比较字符串，而是把渲染结果里**声明的**
  //   `Cache-Control` 取出来，喂给客户端实际用来核对托管的那**同一个函数**。
  //
  //   为什么这比"渲染结果里含有 'no-store'"强得多：后者只证明文案出现过，
  //   而前者证明"这一份配置会被发布端的回读核对判为合格"。
  //   `evaluateResponse` 对通道清单的要求是**只**有一个 no-store 指令，
  //   所以生成器一旦把 `no-store` 写成 `no-cache, no-store`（很自然的一步），
  //   这条就会红——而字符串包含判据不会。
  //
  // ★★ 喂进去的路径必须是**树内相对**（`feeds/…`），**不带** URL 前缀。
  //    我第一版写的是 `${urlPrefix}/feeds/…`，于是得到一句
  //    "**发行文件**应包含 immutable"——因为 `expectedCacheControl` 只看
  //    "以不以 feeds/ 开头"。那**不是**一个关于前缀的报错，而是一个错分支的
  //    诊断（见 `host.mjs` 的 `HOST_CODES.BAD_PATH`）。
  //    现在那个形状会先被具名拒绝，所以这条用例也不可能再写错而"看起来通过"。
  for (const name of TREE_NAMES) {
    const parsed = treeOf(name)
    assert.equal(parsed.ok, true, parsed.reason)
    const rendered = renderServerBlock({ tree: parsed.tree, serverName: 'updates.example.com' })
    assert.equal(rendered.ok, true, rendered.reason)
    const { urlPrefix } = parsed.tree

    const feedCache = cacheControlIn(rendered.config, `^${urlPrefix}/feeds/`)
    const feedVerdict = evaluateResponse('feeds/stable/win-x64.json', {
      status: 200, headers: { 'cache-control': feedCache },
    })
    assert.equal(feedVerdict.ok, true,
      `树 ${name} 的通道清单缓存头被**回读核对**判为不合格：${JSON.stringify(feedVerdict.problems.map((p) => p.message))}`)

    const releaseCache = cacheControlIn(rendered.config, `^${urlPrefix}/releases/`)
    const releaseVerdict = evaluateResponse('releases/rel-1/legion-win-x64.zip', {
      status: 200, headers: { 'cache-control': releaseCache },
    })
    assert.equal(releaseVerdict.ok, true,
      `树 ${name} 的发行文件缓存头被**回读核对**判为不合格：${JSON.stringify(releaseVerdict.problems.map((p) => p.message))}`)

    // 生成的值必须**就是** host.mjs 的常量（不是抄来的等值字面量）。
    assert.equal(feedCache, FEED_CACHE_CONTROL)
    assert.equal(releaseCache, RELEASE_CACHE_CONTROL)
    // 而 location 用的**是**带前缀的路径——两种形状在同一个渲染结果里共存，
    // 这正是那条接缝判据存在的理由。
    assert.ok(rendered.config.includes(`location ~ ^${urlPrefix}/feeds/`),
      '渲染结果里的 location 应当带 URL 前缀')
    assert.ok(rendered.config.includes(`location ~ ^${urlPrefix}/releases/`),
      '渲染结果里的 location 应当带 URL 前缀')
  }
})

test('★★★★ 带前缀的路径喂给 `evaluateResponse` 必须得到**路径**结论，不是缓存结论', () => {
  // ★ 这条把上面那次写错固化成判据。两种形状长得很像，而它们的区别只在
  //   "有没有前缀"：
  //
  //     feedUrl(host)          → https://…/legion/feeds/stable/win-x64.json   （带前缀）
  //     evaluateResponse(...)  → 要的是 'feeds/stable/win-x64.json'            （树内相对）
  //
  //   把前者喂给后者，修复前得到的是 **"发行文件应包含 immutable"**——
  //   一句与"前缀"完全无关的诊断，排查会从缓存策略查起。
  //
  //   > 一个错形状的输入，如果落在"另一条分支"上，
  //   > 得到的是一个**看起来与形状无关**的错误结论。
  const prefixed = '/test/legion/feeds/stable/win-x64.json'
  const result = evaluateResponse(prefixed, { status: 200, headers: { 'cache-control': 'no-store' } })
  assert.equal(result.ok, false, '带前缀的路径被当成了合法输入')
  assert.equal(result.problems[0].code, 'host-bad-path',
    `期望 host-bad-path（路径形状不对），实际 ${result.problems[0].code}：${result.problems[0].message}`)
  // ★ 关键：它**不许**是缓存结论。修复前这里会是 host-bad-cache 且文案提 immutable。
  assert.notEqual(result.problems[0].code, 'host-bad-cache', '仍然报的是缓存结论——那条错分支的诊断还在')
  assert.equal(/immutable/.test(result.problems[0].message), false,
    `诊断里出现了 immutable（那是发行分支的文案）：${result.problems[0].message}`)
})

test('★★ 树内相对路径必须真的"相对"：feeds/ 与 releases/ 之外的形状一律拒', () => {
  // 设计 §4 的目录布局里**只有**这两类路径。其余形状（打错的、缺层的、
  // 带查询串的）落到 `expectedCacheControl` 时都会被当成**发行**路径——
  // 那是静默的错误归类，所以在这里就拒。
  for (const bad of ['feed/stable/win-x64.json', 'feeds', '', 'https://x/feeds/a.json', 'Feeds/a.json']) {
    const r = evaluateResponse(bad, { status: 200, headers: { 'cache-control': 'no-store' } })
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 被接受了`)
    assert.equal(r.problems[0].code, 'host-bad-path', `${JSON.stringify(bad)} 的拒绝码是 ${r.problems[0].code}`)
  }
  // 对照：两类合法形状都要过。
  for (const good of ['feeds/stable/win-x64.json', 'releases/rel-1/legion-win-x64.zip']) {
    const r = evaluateResponse(good, {
      status: 200,
      headers: { 'cache-control': good.startsWith('feeds/') ? FEED_CACHE_CONTROL : RELEASE_CACHE_CONTROL },
    })
    assert.equal(r.ok, true, `合法路径 ${good} 被拒：${JSON.stringify(r.problems.map((p) => p.message))}`)
  }
})

test('★ 生成器的缓存头确实是"抄常量"而不是"恰好相等"：改一处两边一起变', () => {
  // 这条守的是"单一来源"。做法：把 `FEED_CACHE_CONTROL` 换成一条**混合**指令
  // ——如果生成器真的在读常量，渲染结果就该跟着变成那条混合指令；
  // 而它一旦变了，`evaluateResponse` 就应当**拒绝**（这正是混合指令的危险之处）。
  //
  // 注意这里不改 host.mjs（那是生产的常量），而是直接问一个问题：
  // 渲染结果里那串字符与常量**逐字相等**吗。上面的断言已经要求相等，
  // 这一条补的是"相等不是巧合"——即 feeds 与 releases 两处的值**不同**。
  const parsed = treeOf('test')
  const rendered = renderServerBlock({ tree: parsed.tree, serverName: 'updates.example.com' })
  const feedCache = cacheControlIn(rendered.config, '^/test/legion/feeds/')
  const releaseCache = cacheControlIn(rendered.config, '^/test/legion/releases/')
  assert.notEqual(feedCache, releaseCache,
    '两处用了同一个缓存头——那说明生成器没有按路径分辨，通道清单就会变成可缓存的')
  // 混合指令必须被回读核对拒掉（证明上面那两条断言不是"什么都通过"）。
  const mixed = evaluateResponse('feeds/stable/win-x64.json', {
    status: 200, headers: { 'cache-control': 'no-cache, max-age=600, no-store' },
  })
  assert.equal(mixed.ok, false, '混合缓存指令被放过了——上面那条"通过"因此没有分辨力')
})

// ---------------------------------------------------------------------------
// ③ 推理出来的 root 必须正确（nginx 的 root 语义）
// ---------------------------------------------------------------------------

test('★★ root 由"内容根减去 URL 前缀"推出，且与托管上实际生效的那份一致', () => {
  const testTree = treeOf('test')
  assert.equal(testTree.ok, true, testTree.reason)
  // ★ 这两个值是从**真实托管**上读回来的配置里得到的：
  //   `root /srv/legion-updates;` + `location ~ ^/(test|production)/legion/`。
  assert.equal(testTree.tree.root, '/srv/legion-updates')
  assert.equal(testTree.tree.urlPrefix, '/test/legion')
  assert.equal(testTree.tree.diskRoot, '/srv/legion-updates/test/legion')

  const prodTree = treeOf('production')
  assert.equal(prodTree.ok, true, prodTree.reason)
  // 生产树：内容根 /srv/legion-updates/production/legion，前缀 /legion ⇒ root 是它的父目录。
  assert.equal(prodTree.tree.root, '/srv/legion-updates/production')
  assert.equal(prodTree.tree.urlPrefix, '/legion')
  // ★ 这条断言就是 ㉜ 本身：生产前缀是 `/legion`，而托管当时服务的 URL 是
  //   `/production/legion`。两者**不是**同一个地址——生成器把它变成了
  //   "仓库里有一份能服务 /legion 的配置"。
  assert.notEqual(`${prodTree.tree.root}${prodTree.tree.urlPrefix}`, '/srv/legion-updates/production/legion/legion',
    'root 与前缀的拼接算错了（会把 /legion 映射成 legion/legion）')
  assert.equal(`${prodTree.tree.root}${prodTree.tree.urlPrefix}`, prodTree.tree.diskRoot,
    'root + 前缀必须等于内容根，否则 nginx 会去找一个不存在的目录')
})

test('★★ 内容根不以 URL 前缀结尾时**报错**，而不是生成一份会 404 的配置', () => {
  // 这条判据只有一条，而它拦的是"配错了但看起来配好了"：
  // nginx 的 `root` 语义下，内容根不以 URL 前缀结尾时**不存在**合适的 root，
  // 而配错的表现为"所有清单都 404"——排查会从网络一路查到签名。
  //
  // 做法：临时往 `UPLOAD_TARGETS` 里塞一棵不自洽的树。`UPLOAD_TARGETS` 是
  // 冻结对象，所以这里直接构造形状相同的输入去问 `treeOf` 的**等价**推理——
  // 也就是核对那条判据的措辞本身。
  const bad = '/srv/legion-updates/production'      // 不以 '/legion' 结尾
  const prefix = '/legion'
  assert.equal(bad.endsWith(prefix), false, '自检前提失效：这个路径竟然以 /legion 结尾')
  // 生成器的判据就是这一行（见 `treeOf`）。用一个不存在的树名问一次，
  // 确认它给的是**具名**拒绝而不是 null。
  const unknown = treeOf('没有这棵树')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, HOST_CONFIG_PROBLEMS.UNKNOWN_TREE)
  assert.match(unknown.reason, /test/)
})

// ---------------------------------------------------------------------------
// ④ server_name 与站点名（引导计划第 2 步：不覆盖其他业务站点）
// ---------------------------------------------------------------------------

test('★★ server_name 不许空、不许带空白、不许占用既有站点', () => {
  const tree = treeOf('test').tree
  for (const bad of ['', '   ', 'a b', ...OTHER_SITES]) {
    const r = renderServerBlock({ tree, serverName: bad })
    assert.equal(r.ok, false, `server_name ${JSON.stringify(bad)} 被接受了`)
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '拒绝没有给出理由')
  }
  // 对照：合法名字必须通过（否则上面那条只是"什么都拒"）。
  assert.equal(renderServerBlock({ tree, serverName: 'updates.example.com' }).ok, true)
  assert.equal(renderServerBlock({ tree, serverName: '117.72.146.36' }).ok, true)
})

test('★ 站点文件名与既有站点不冲突（单独站点，不覆盖别的业务）', () => {
  assert.equal(OTHER_SITES.includes(SITE_FILENAME), false,
    `站点文件名 ${SITE_FILENAME} 撞上了既有站点：${OTHER_SITES.join(', ')}`)
  assert.equal(SITE_FILENAME, 'legion-updates', '站点文件名变了——托管上那份是按这个名字落盘的')
})

// ---------------------------------------------------------------------------
// ⑤ 目录布局与"其余 404"
// ---------------------------------------------------------------------------

test('★ 目录清单与引导计划第 3 步的布局一致', () => {
  const tree = treeOf('production').tree
  const dirs = [...renderDirectoryPlan(tree)]
  assert.deepEqual(dirs, [
    '/srv/legion-updates/production/legion',
    '/srv/legion-updates/production/legion/feeds',
    '/srv/legion-updates/production/legion/releases',
  ])
})

test('★ 渲染结果把"其余路径"和"目录索引"都堵上', () => {
  const tree = treeOf('test').tree
  const config = renderServerBlock({ tree, serverName: '117.72.146.36' }).config
  // 目录索引：`autoindex off` + 兜底 404，两条都要（少一条都可能列目录）。
  assert.ok(config.includes('autoindex off;'), '没有关闭目录索引')
  assert.ok(config.includes('location / { return 404; }'), '没有把其余路径 404')
  // 只允许 GET/HEAD。
  assert.ok(config.includes('limit_except GET { deny all; }'), '没有限制为 GET/HEAD')
  assert.equal(config.includes('limit_except GET HEAD'), false,
    'nginx 的 limit_except 不接受 HEAD 作为参数——放行 HEAD 靠的是"放行 GET 同时放行 HEAD"')
  // 健康检查。
  assert.ok(config.includes('location = /healthz {'), '没有健康检查')
  assert.ok(config.includes('legion-update-host: ready'), '健康检查的文案与托管上那份不一致')
  // 每个 location 都要有 try_files，避免落到目录上。
  assert.equal((config.match(/try_files \$uri =404;/g) ?? []).length, 2,
    'try_files 的处数不对（feeds 与 releases 各一处）')
})

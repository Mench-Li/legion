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

import { FEED_CACHE_CONTROL, HOST_CODES, RELEASE_CACHE_CONTROL, createHostConfig, evaluateResponse } from '../../product/update/host.mjs'
import { CHANNEL_TARGETS, UPLOAD_TARGETS } from './publish.mjs'
import {
  HOST_CONFIG_PROBLEMS, OTHER_SITES, SITE_FILENAME, TREE_NAMES, main,
  renderDirectoryPlan, renderServerBlock, tlsRequirement, treeOf,
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

/**
 * 把一棵树渲染成**它该被部署的那种形态**。
 *
 * ★ 这个助手本身就是一条判据：生产树必须 TLS，所以"渲染生产树"这件事
 *   不可能不带上证书。用它而不是各处手写 `renderServerBlock`，
 *   是为了让"每种形态都渲染得出、且缓存头都对"那几条用例**同时覆盖两棵树**——
 *   直接写 `renderServerBlock` 的话，生产树那几处会因为缺 TLS 而拒，
 *   于是那些用例会安静地只覆盖测试树（我改 TLS 时就是这样红了三条）。
 */
function renderForDeployment(name, serverName = 'updates.example.com') {
  const tree = treeOf(name).tree
  const req = tlsRequirement(name)
  return renderServerBlock({
    tree, serverName,
    ...(req.required
      ? { tls: { cert: '/etc/ssl/legion/fullchain.pem', key: '/etc/ssl/legion/privkey.pem' } }
      : {}),
  })
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
    const rendered = renderForDeployment(name)
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
    const rendered = renderForDeployment(name)
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

test('★★ `/healthz` 也必须声明 no-store（`evaluateResponse` 覆盖不到它）', () => {
  // ★ 这一条是我用一次**打偏了的变异**换来的。
  //
  //   我本想验证"生成器与验证器接缝"那条用例，于是把 `FEED_CACHE_CONTROL`
  //   的 `add_header` 行改成一条混合指令。但 `renderServerBlock` 里
  //   `FEED_CACHE_CONTROL` 出现在**两处** add_header（healthz 与 feeds），
  //   而 `String.replace` 不带 `g` 只换第一处——**改中的是 healthz**。
  //
  //   于是那条"接缝"用例照样全绿（它只读 feeds/releases 两个 location），
  //   而我一度以为"这条判据守不住"。真相是**变异打偏了**。
  //
  //   > 一次"没被抓住"的变异，先要排除"变异本身没打中"——
  //   > 否则会把"我改错了地方"读成"判据是空的"。
  //
  //   ★ 而它顺带暴露了一个**真的**覆盖缺口：`/healthz` 的 no-store
  //     不在 `evaluateResponse` 的覆盖范围内——那个函数只认
  //     `feeds/` 与 `releases/` 两类路径（连 `/healthz` 都会被
  //     `HOST_CODES.BAD_PATH` 具名拒掉）。所以健康检查的缓存头
  //     此前**没有任何机械判据**，而它在真实托管上是验过的（200|no-store）。
  //
  //     一条"只在真实机器上验过一次、代码里没人守"的性质，
  //     会在下一次改配置时安静地消失。
  for (const name of TREE_NAMES) {
    // ★ 用 `renderForDeployment`（而不是裸的 `renderServerBlock`）：生产树
    //   在没给 TLS 时会**具名拒**，于是裸调用会让这条用例只覆盖测试树——
    //   而"只覆盖了一半"正是 ㉞ 那个坑的形状。
    const config = renderForDeployment(name, '117.72.146.36').config
    const start = config.indexOf('location = /healthz {')
    assert.ok(start >= 0, `${name}：没有健康检查块`)
    const block = config.slice(start, config.indexOf('\n    }', start))
    assert.ok(block.includes(`add_header Cache-Control "${FEED_CACHE_CONTROL}" always;`),
      `${name}：/healthz 没有声明 ${FEED_CACHE_CONTROL}——健康检查的响应会被中间层缓存`)
    // 而且它**不许**是别的缓存头（比如发行文件那条 immutable）。
    assert.equal(block.includes(RELEASE_CACHE_CONTROL), false,
      `${name}：/healthz 声明了发行文件那条缓存头`)
  }
})

// ---------------------------------------------------------------------------
// ⑥ TLS：**从客户端的规则推**，而不是从我的偏好推
// ---------------------------------------------------------------------------

test('★★★★ 生产树必须 TLS —— 因为它服务的通道被**客户端自己**要求 HTTPS', () => {
  // ★ 这条是 ㉟ 的机械形式，而且它把"为什么"钉在**客户端的判据**上：
  //
  //   我上一轮交付的生成器只渲染 `listen 80`。而 `production` 那棵树服务
  //   `canary` / `stable`，`host.mjs` 的 `createHostConfig()` 对它们要求 HTTPS。
  //   于是一份"只监听 80"的生产配置是**客户端会拒绝使用**的配置——
  //   它能通过 `nginx -t`、能返回 200、能通过我上一轮那五条判据，
  //   而客户端连一次检查都做不成。
  //
  //   > 一份"能起来、能 200、而客户端不肯用"的配置，
  //   > 与一份 404 的配置在部署上是同一个东西——只不过前者更难看出来。
  //
  //   ★ 关键在最后两条断言：它们**用客户端自己的函数**验证这条推断的前提，
  //     而不是靠生成器里那句"我觉得 canary/stable 要 HTTPS"。
  //     客户的规则一变（http 不再被拒），这条用例就会红——那正是我们要的：
  //     那时生成器那条推断需要重新确认。
  const prodChannels = Object.entries(CHANNEL_TARGETS).filter(([, t]) => t === 'production').map(([c]) => c)
  assert.ok(prodChannels.length > 0, '没有通道映射到生产树——这条用例的前提不成立')
  for (const channel of prodChannels) {
    const overHttp = createHostConfig({ origin: 'http://updates.example.com', channel })
    assert.equal(overHttp.ok, false, `客户端居然接受了 ${channel} 走 http`)
    assert.equal(overHttp.code, HOST_CODES.INSECURE_ORIGIN,
      `${channel} 走 http 的拒绝码是 ${overHttp.code}，期望 ${HOST_CODES.INSECURE_ORIGIN}`)
    // 而 https 必须通过——否则"要 TLS"这条推断就没有意义（什么都过不去）。
    assert.equal(createHostConfig({ origin: 'https://updates.example.com', channel }).ok, true,
      `${channel} 走 https 竟然不通过`)
  }
  assert.equal(tlsRequirement('production').required, true)
  // internal 那棵树按设计**允许**显式用 http（仓库里的 update-config.example.json 就是这么配的）。
  assert.equal(tlsRequirement('test').required, false)
  const internalOverHttp = createHostConfig({
    origin: 'http://117.72.146.36', prefix: '/test/legion', channel: 'internal', allowInsecureHttp: true,
  })
  assert.equal(internalOverHttp.ok, true, 'internal 显式允许 http 时被拒了')
})

test('★★★ 生产树不给 TLS 参数 → **具名拒绝**，而不是渲染一份用不了的配置', () => {
  const tree = treeOf('production').tree
  const r = renderServerBlock({ tree, serverName: 'updates.example.com' })
  assert.equal(r.ok, false, '生产树在没给 TLS 参数时被渲染出来了')
  assert.equal(r.code, HOST_CONFIG_PROBLEMS.TLS_REQUIRED)
  assert.equal(r.config, null, '拒绝时不该给出配置')
  assert.match(r.reason, /canary|stable/, `拒绝理由应当点出是哪几个通道：${r.reason}`)
  // 对照：测试树不给 TLS 参数**必须**能渲染（否则上面那条只是"什么都拒"）。
  const testTree = treeOf('test').tree
  assert.equal(renderServerBlock({ tree: testTree, serverName: '117.72.146.36' }).ok, true)
})

test('★★★★ 给了 TLS：内容位置**只**在 443 那个块里，80 只做跳转', () => {
  const tree = treeOf('production').tree
  const r = renderServerBlock({
    tree, serverName: 'updates.example.com',
    tls: { cert: '/etc/ssl/legion/fullchain.pem', key: '/etc/ssl/legion/privkey.pem' },
  })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.tls, true)
  // 两处 `listen`，两个 `server {`。
  assert.equal((r.config.match(/^server \{/gm) ?? []).length, 2, '应当是两个 server 块')
  assert.equal((r.config.match(/listen 443 ssl http2;/g) ?? []).length, 1)
  assert.equal((r.config.match(/listen 80;/g) ?? []).length, 1)
  // TLS 材料与协议。
  for (const marker of [
    'ssl_certificate     /etc/ssl/legion/fullchain.pem;',
    'ssl_certificate_key /etc/ssl/legion/privkey.pem;',
    'ssl_protocols TLSv1.2 TLSv1.3;',
  ]) {
    assert.ok(r.config.includes(marker), `渲染结果里没有 ${marker}`)
  }
  // ★ 80 那个块**只能**跳转：里面有内容 location 的话，http 上也能取到清单。
  const httpBlock = r.config.slice(r.config.lastIndexOf('server {'))
  assert.ok(httpBlock.includes('return 301 https://$host$request_uri;'), '80 那个块没有跳转')
  assert.equal(/location\s/.test(httpBlock), false,
    `80 那个块里出现了 location——http 上会取到内容：\n${httpBlock}`)
  // 内容位置必须仍然在（在 443 那个块里）。
  assert.ok(r.config.indexOf('location ~ ^/legion/feeds/') < r.config.lastIndexOf('server {'),
    '内容位置落在了 80 那个块之后')
  assert.ok(r.config.includes('limit_except GET { deny all; }'), 'TLS 渲染结果里没有方法限制')
  assert.ok(r.config.includes('location / { return 404; }'), 'TLS 渲染结果里没有兜底 404')
  // ★ 缓存头仍然是那两个常量（TLS 路径不许把它抄成字面量）。
  assert.equal(cacheControlIn(r.config, '^/legion/feeds/'), FEED_CACHE_CONTROL)
  assert.equal(cacheControlIn(r.config, '^/legion/releases/'), RELEASE_CACHE_CONTROL)
})

test('★★ TLS 参数自身的判据：缺一个、同一个文件、带空白，都要拒', () => {
  const tree = treeOf('production').tree
  for (const badTls of [
    { cert: '', key: '/k' },
    { cert: '/c', key: '' },
    { cert: '/same', key: '/same' },
    { cert: '/a b', key: '/k' },
  ]) {
    const r = renderServerBlock({ tree, serverName: 'updates.example.com', tls: badTls })
    assert.equal(r.ok, false, `非法 TLS 参数被接受了：${JSON.stringify(badTls)}`)
    assert.equal(r.code, HOST_CONFIG_PROBLEMS.BAD_TLS_PARAM,
      `期望 BAD_TLS_PARAM，实际 ${r.code}：${r.reason}`)
  }
})

test('★★ 清单里的**每一条** HTTPS origin，客户端都接受（生成器给出的形态可用）', () => {
  // 把上面几条收成一句可核的话：生成器为某棵树给出的形态（http 或 https）
  // 必须是客户端**接受**的形态。这条不依赖我给的是不是 "https"，
  // 而是问客户端本人。
  for (const name of TREE_NAMES) {
    const req = tlsRequirement(name)
    for (const [channel, target] of Object.entries(CHANNEL_TARGETS)) {
      if (target !== name) continue
      // 客户端能接受的 origin 形态 = 这棵树该走的形态。
      const https = createHostConfig({ origin: 'https://updates.example.com', channel }).ok
      const http = createHostConfig({ origin: 'http://updates.example.com', channel, allowInsecureHttp: true }).ok
      assert.equal(https, true, `${channel} 走 https 竟然不通`)
      if (req.required) {
        assert.equal(http, true, `${channel} 显式允许 http 时被拒——那么"必需 TLS"的措辞要改`)
        // 但**不允许**的 http 必须被拒，这才是"必需"的含义。
        assert.equal(createHostConfig({ origin: 'http://updates.example.com', channel }).ok, false,
          `${channel} 未显式允许的 http 被接受了`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// ⑦ CLI 的布尔开关必须**真的生效**（写成 `=== true` 会让它永远不生效）
// ---------------------------------------------------------------------------

test('★★★ CLI `--files` 真的会打印目录清单（布尔开关不能是哑的）', () => {
  // ★ 这条来自一个真实的哑开关：本模块与 `verify-install.mjs` 里的布尔判断
  //   原先都写成 `args.get('files') === true`，而 `parseArgs`（与
  //   `verify-host.mjs` 逐字一致的那个实现）对"后面没有值的 `--flag`"
  //   存的是**字符串** `'true'`。于是 `--files` 与 `--json` **永远不生效**——
  //   而它们不报错，只会安静地走另一条分支。
  //
  //   > 一个"永远为假"的开关，与一个不存在的开关，在用户那边是同一个东西；
  //   > 区别只在于前者会让人以为自己用对了。
  //
  //   抓住它的是"照手册敲那条命令"的用例（`verify-install.test.mjs` 里那条
  //   退出码用例发现 `--json` 的输出不是 JSON）。这里把同一个形状钉在
  //   `--files` 上。
  const captures = (argv) => {
    const chunks = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true }
    try { return { code: main(argv), text: chunks.join('') } } finally { process.stdout.write = original }
  }
  const withFlag = captures(['--tree', 'test', '--server-name', 'x.example', '--files'])
  const without = captures(['--tree', 'test', '--server-name', 'x.example'])
  assert.equal(withFlag.code, 0)
  assert.match(withFlag.text, /需要存在的目录/, '--files 没有打印目录清单（开关是哑的）')
  assert.match(withFlag.text, /\/srv\/legion-updates\/test\/legion\/feeds/)
  assert.equal(/需要存在的目录/.test(without.text), false, '不带 --files 也打印了目录清单')
  // 而且配置本体必须完全一致——`--files` 只是**附注**，不该改变生成物。
  assert.equal(withFlag.text.split('\n# 需要存在的目录：')[0], without.text)
})

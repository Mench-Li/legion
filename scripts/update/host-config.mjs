#!/usr/bin/env node
// scripts/update/host-config.mjs —— 更新托管的 nginx 站点配置**生成器**
// ============================================================================
// 这个脚本补的是一个"装了却不在仓库里"的东西。
//
// `2026-10-04-update-host-bootstrap.md` 的第 2–5 步（单独站点、目录布局、
// 缓存策略、只允许 GET/HEAD、关闭目录索引）是在**会话里**执行完的，配置留在
// 托管机的 `/etc/nginx/sites-available/legion-updates` 上，而**仓库里没有**。
// 后果是：`verify-host.mjs` 能告诉你托管**不对**，但仓库里没有任何东西能把它
// **建对**——换一台空白机器就得凭记忆重来（而引导计划自己也写着
// "脚本已加入有界重试，尚未在新空白机器重跑"）。
//
// ## 为什么不是"把托管上那份配置抄进来"
//
// 抄一份静态文本会造出**第二个真相来源**：`publish.mjs` 声明每棵树的上传目标
// 与前缀（`UPLOAD_TARGETS`），`host.mjs` 声明每条路径该有的 `Cache-Control`
// （`FEED_CACHE_CONTROL` / `RELEASE_CACHE_CONTROL`），而 nginx 配置必须同时
// 满足这两边。抄一份文本，三边就可以各自漂移而没人发现。
//
// ★ 所以这个生成器**从另外两处推出**配置：
//
//   · 每棵树的**磁盘根**与 **URL 前缀** → `publish.mjs` 的 `UPLOAD_TARGETS`
//   · 每类路径的 `Cache-Control`     → `host.mjs` 的两个常量
//
//   而"推不出来"本身就是一条判据：某棵树的磁盘根**不以**它的 URL 前缀结尾时，
//   nginx 的 `root` 语义（文件 = root + URI）就配不出正确的映射——
//   那时生成器**报错**，而不是生成一份看起来对、实际 404 的配置。
//
// ## ★ 找到这个缺口的那一次核对
//
//   在真实托管上逐条核对引导计划的四条判据，全部通过：
//
//     GET  通道清单 → 200      HEAD → 200      POST → 403
//     目录索引 → 404           缺失清单 → 404
//     通道清单 Cache-Control: no-store
//     发行文件 Cache-Control: public, max-age=31536000, immutable
//
//   而顺着 `UPLOAD_TARGETS` 的**生产**前缀再问一次，就露出来了：
//
//     /test/legion/…        → 200   ← 托管上**有**这条 location
//     /legion/…             → 404   ← 托管上**没有**任何 location 服务它
//     /production/legion/…  → 404   ← 有 location，但生产树是空的（正常）
//
//   即：托管上那份配置把生产树放在 **`/production/legion`** 上（测试期的写法，
//   两棵树都能按 IP 手工看），而 `UPLOAD_TARGETS` 声明生产前缀是 **`/legion`**
//   （正式期的写法）。于是按 `upload-plan.txt` 走完一次生产发布之后，
//   计划里第 2/4 步那条 `verify-host --prefix /legion` **必然 404**，
//   而计划里没有任何一步会提示"你还得先加一个 server 块"。
//
//   > 两个各自都对的东西，可以在**接缝处**对不上——
//   > 而接缝处没有测试时，它会在第一次真发布时才说话。
//
// 用法（**只打印，不落盘**——写进 /etc 是运维动作，不是脚本动作）：
//
//   node scripts/update/host-config.mjs --tree test
//   node scripts/update/host-config.mjs --tree production --server-name updates.example.com
//   node scripts/update/host-config.mjs --tree test --files    # 附带目录清单
// ============================================================================

import { UPLOAD_TARGETS } from './publish.mjs'
import { FEED_CACHE_CONTROL, RELEASE_CACHE_CONTROL } from '../../product/update/host.mjs'

/** 生成物的格式名（与其余协议一样带版本）。 */
export const HOST_CONFIG_FORMAT = 'legion/update-host-config@1'

/**
 * 站点文件名。
 *
 * ★ 必须是**独立**的一个文件：引导计划第 2 步要求「配置单独站点，**不覆盖**
 *   其他业务站点」。托管上并存着 `legion-hub` 等站点，所以这里既不能叫
 *   `default`，也不能去改别的文件。
 */
export const SITE_FILENAME = 'legion-updates'

/** 托管上已存在的**其他**站点文件名；生成器不许碰它们。 */
export const OTHER_SITES = Object.freeze(['default', 'legion-hub', 'legion-hub-ip'])

/** 两棵树的名字，来自 `UPLOAD_TARGETS`（单一来源）。 */
export const TREE_NAMES = Object.freeze(Object.keys(UPLOAD_TARGETS))

export const HOST_CONFIG_PROBLEMS = Object.freeze({
  UNKNOWN_TREE: 'host-config-unknown-tree',
  BAD_REMOTE_ROOT: 'host-config-bad-remote-root',
  PREFIX_NOT_SUFFIX: 'host-config-prefix-not-suffix',
  BAD_PREFIX: 'host-config-bad-prefix',
  BAD_SERVER_NAME: 'host-config-bad-server-name',
  CLAIMS_OTHER_SITE: 'host-config-claims-other-site',
})

function problem(code, message) {
  return Object.freeze({ code, message })
}

/**
 * 把 `UPLOAD_TARGETS` 里的一条解析成生成器要的形状。
 *
 * `remoteRoot` 的形状是 `user@host:/abs/path`，其中 `/abs/path` 是
 * "这棵树的**内容**根"——也就是 `feeds/` 与 `releases/` 的父目录。
 */
export function treeOf(name) {
  const entry = UPLOAD_TARGETS[name]
  if (entry === undefined) {
    return Object.freeze({
      ok: false, code: HOST_CONFIG_PROBLEMS.UNKNOWN_TREE,
      reason: `没有这棵树：${JSON.stringify(name)}（有的是 ${TREE_NAMES.join('/')}）`, tree: null,
    })
  }
  const colon = entry.remoteRoot.indexOf(':')
  if (colon < 0) {
    return Object.freeze({
      ok: false, code: HOST_CONFIG_PROBLEMS.BAD_REMOTE_ROOT,
      reason: `remoteRoot 里没有路径部分：${entry.remoteRoot}`, tree: null,
    })
  }
  const diskRoot = entry.remoteRoot.slice(colon + 1).replace(/\/+$/, '')
  const urlPrefix = entry.prefix
  if (typeof urlPrefix !== 'string' || !urlPrefix.startsWith('/') || urlPrefix.includes('..') || urlPrefix.includes('//')) {
    return Object.freeze({
      ok: false, code: HOST_CONFIG_PROBLEMS.BAD_PREFIX,
      reason: `URL 前缀不合法：${JSON.stringify(urlPrefix)}`, tree: null,
    })
  }
  // ★ 这条是生成器里**唯一**一条真正会拦住人的判据：
  //   nginx 的文件 = `root` + URI。要让 URI `<前缀>/feeds/x`
  //   落到磁盘 `<内容根>/feeds/x`，就必须存在一个 `root` 使
  //   `root + 前缀` == 内容根。内容根**不以**前缀结尾时，这样的 root 不存在。
  if (!diskRoot.endsWith(urlPrefix)) {
    return Object.freeze({
      ok: false, code: HOST_CONFIG_PROBLEMS.PREFIX_NOT_SUFFIX,
      reason: `这棵树的内容根 ${diskRoot} 不以它的 URL 前缀 ${urlPrefix} 结尾：`
        + 'nginx 的 root 语义（文件 = root + URI）下配不出正确映射，'
        + '而配错的表现是**所有清单都 404**，不是一句配置错误',
      tree: null,
    })
  }
  const root = diskRoot.slice(0, diskRoot.length - urlPrefix.length) || '/'
  return Object.freeze({
    ok: true, code: null, reason: null,
    tree: Object.freeze({ name, diskRoot, urlPrefix, root, remoteRoot: entry.remoteRoot }),
  })
}

/**
 * 渲染一个 server 块。
 *
 * ★ 缓存头的值**直接来自** `host.mjs` 的两个常量，而不是抄一遍字面量——
 *   抄一遍的话，`host.mjs` 改了而这里没改，客户端与发布端自检就会对同一份
 *   部署给出相反结论（一个说"缓存策略错了"，一个说没问题）。
 */
export function renderServerBlock({ tree, listen = 80, serverName, healthText = 'legion-update-host: ready' }) {
  const nameCheck = serverNameCheck(serverName)
  if (!nameCheck.ok) return Object.freeze({ ok: false, code: nameCheck.code, reason: nameCheck.reason, config: null })

  const p = tree.urlPrefix
  const lines = [
    'server {',
    `    listen ${listen};`,
    `    server_name ${serverName};`,
    `    root ${tree.root};`,
    '',
    '    # 目录索引关闭、不发版本号（引导计划第 4 步）。',
    '    autoindex off;',
    '    server_tokens off;',
    '    add_header X-Content-Type-Options nosniff always;',
    '',
    '    # 健康检查：不缓存。',
    '    location = /healthz {',
    '        default_type text/plain;',
    `        add_header Cache-Control "${FEED_CACHE_CONTROL}" always;`,
    `        return 200 "${healthText}\\n";`,
    '    }',
    '',
    `    # 通道清单：必须**只**是 ${FEED_CACHE_CONTROL}。`,
    "    # ★ `limit_except GET` 同时放行 HEAD（nginx 文档明说：",
    '    #   "Allowing the GET method makes the HEAD method also allowed"），',
    '    #   所以这一行就是引导计划第 4 步的"只允许 GET/HEAD"。',
    `    location ~ ^${p}/feeds/ {`,
    '        limit_except GET { deny all; }',
    `        add_header Cache-Control "${FEED_CACHE_CONTROL}" always;`,
    '        add_header X-Content-Type-Options nosniff always;',
    '        try_files $uri =404;',
    '    }',
    '',
    `    # 发行文件：目录不可覆盖，所以可长期缓存（${RELEASE_CACHE_CONTROL}）。`,
    `    location ~ ^${p}/releases/ {`,
    '        limit_except GET { deny all; }',
    `        add_header Cache-Control "${RELEASE_CACHE_CONTROL}" always;`,
    '        add_header X-Content-Type-Options nosniff always;',
    '        try_files $uri =404;',
    '    }',
    '',
    '    # 其余一律 404：既关掉目录遍历，也避免把"路径写错"变成一次成功取件。',
    '    location / { return 404; }',
    '}',
  ]
  return Object.freeze({ ok: true, code: null, reason: null, config: `${lines.join('\n')}\n` })
}

/** `server_name` 的判据：不许空、不许空白字符、不许写成别的站点名。 */
function serverNameCheck(serverName) {
  if (typeof serverName !== 'string' || serverName.trim() === '') {
    return Object.freeze({ ok: false, code: HOST_CONFIG_PROBLEMS.BAD_SERVER_NAME, reason: 'server_name 必须显式给出（不能用空的或默认值冒充）' })
  }
  if (/\s/.test(serverName)) {
    return Object.freeze({ ok: false, code: HOST_CONFIG_PROBLEMS.BAD_SERVER_NAME, reason: `server_name 里有空白字符：${JSON.stringify(serverName)}` })
  }
  if (OTHER_SITES.includes(serverName)) {
    return Object.freeze({
      ok: false, code: HOST_CONFIG_PROBLEMS.CLAIMS_OTHER_SITE,
      reason: `server_name ${serverName} 是既有站点，不许占用`,
    })
  }
  return Object.freeze({ ok: true, code: null, reason: null })
}

/** 这棵树需要存在的目录（引导计划第 3 步的目录布局）。 */
export function renderDirectoryPlan(tree) {
  return Object.freeze([
    `${tree.diskRoot}`,
    `${tree.diskRoot}/feeds`,
    `${tree.diskRoot}/releases`,
  ])
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 装载期自检。**只检查"生成器与另两处一致"这件事**，不检查托管是否已按它配置。
 *
 * ★ 与另两处一致是本模块存在的全部理由，所以它必须自己在每次装载时验一遍：
 *   `UPLOAD_TARGETS` 里每棵树都要能推出 root，而"推不出"必须报出来
 *   （不能悄悄跳过那棵树——跳过的后果是"生成器覆盖不了那棵树"，而
 *   调用方看生成结果时**看不出少了什么**）。
 */
export function selfCheckHostConfig() {
  const problems = []

  for (const name of TREE_NAMES) {
    const parsed = treeOf(name)
    if (!parsed.ok) problems.push(`树 ${name} 推不出 nginx 配置：${parsed.reason}`)
  }

  const test = treeOf('test')
  if (test.ok) {
    // ★ 这一条钉住**当前托管上真实生效的那份配置**：root=/srv/legion-updates、
    //   前缀 /test/legion。它曾经是"只存在于托管上"的一个事实。
    if (test.tree.root !== '/srv/legion-updates' || test.tree.urlPrefix !== '/test/legion') {
      problems.push(`测试树的 root/前缀与托管上的实际配置不符：root=${test.tree.root} 前缀=${test.tree.urlPrefix}`)
    }
    const rendered = renderServerBlock({ tree: test.tree, serverName: '117.72.146.36' })
    if (!rendered.ok) problems.push(`测试树渲染失败：${rendered.reason}`)
    else {
      // 缓存头的值必须就是 host.mjs 那两个常量。
      if (!rendered.config.includes(`"${FEED_CACHE_CONTROL}"`)) problems.push('渲染结果里没有通道清单的缓存头常量')
      if (!rendered.config.includes(`"${RELEASE_CACHE_CONTROL}"`)) problems.push('渲染结果里没有发行文件的缓存头常量')
      // 只允许 GET/HEAD；目录索引关闭；其余 404。
      if (!rendered.config.includes('limit_except GET { deny all; }')) problems.push('渲染结果没有限制为 GET/HEAD')
      if (!rendered.config.includes('autoindex off;')) problems.push('渲染结果没有关闭目录索引')
      if (!rendered.config.includes('location / { return 404; }')) problems.push('渲染结果没有把其余路径 404')
      if (rendered.config.includes(SITE_FILENAME) === false) problems.push('渲染结果里没有站点名')
    }
  } else {
    problems.push(`测试树不存在：${test.reason}`)
  }

  // 站点文件名不许是既有站点里任何一个。
  if (OTHER_SITES.includes(SITE_FILENAME)) problems.push(`站点文件名 ${SITE_FILENAME} 撞上了既有站点`)

  // server_name 判据的探针：空的、带空白的、占用既有的，都必须被拒。
  const probe = treeOf('test')
  if (probe.ok) {
    for (const bad of ['', '   ', 'a b', 'legion-hub']) {
      if (renderServerBlock({ tree: probe.tree, serverName: bad }).ok) {
        problems.push(`server_name ${JSON.stringify(bad)} 被接受了`)
      }
    }
    if (!renderServerBlock({ tree: probe.tree, serverName: 'updates.example.com' }).ok) {
      problems.push('合法的 server_name 被拒了')
    }
  }
  if (treeOf('没有这棵树').ok) problems.push('不存在的树被接受了')

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    format: HOST_CONFIG_FORMAT,
    siteFilename: SITE_FILENAME,
    trees: Object.freeze(TREE_NAMES.map((name) => {
      const parsed = treeOf(name)
      return Object.freeze({
        name,
        prefix: UPLOAD_TARGETS[name].prefix,
        root: parsed.ok ? parsed.tree.root : null,
      })
    })),
  })
}

export const HOST_CONFIG_CHECKED = selfCheckHostConfig()

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 参数解析：**与 `publish.mjs` / `verify-host.mjs` 逐字一致**。
 *
 * ★ 抄一遍这段（而不是"发明一个更好用的"）是有意的：`scripts/update/` 下三个
 *   脚本的调用方式必须一样，否则运维照着一个脚本的习惯去敲另一个，得到的是
 *   "参数没生效"而不是"参数不认识"——而后者会立刻被注意到。
 *   本轮的教训之一是"改了 `--tree test` 却报『需要 --tree』"，正是因为这里
 *   一开始用了 `--key=value` 的写法。
 */
function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const name = typeof args.get('tree') === 'string' ? args.get('tree') : null
  if (name === null) {
    process.stderr.write(`host-config 需要 --tree（${TREE_NAMES.join(' / ')}）\n`)
    return 2
  }
  const parsed = treeOf(name)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.code}: ${parsed.reason}\n`)
    return 2
  }
  const serverName = typeof args.get('server-name') === 'string' ? args.get('server-name') : null
  if (serverName === null) {
    process.stderr.write('host-config 需要 --server-name：站点必须显式声明为哪个名字服务，'
      + '而"用默认值兜住"正是会覆盖别的站点的那条路\n')
    return 2
  }
  const rendered = renderServerBlock({ tree: parsed.tree, serverName })
  if (!rendered.ok) {
    process.stderr.write(`${rendered.code}: ${rendered.reason}\n`)
    return 2
  }
  process.stdout.write(`# ${SITE_FILENAME} —— 由 scripts/update/host-config.mjs 生成（${HOST_CONFIG_FORMAT}）\n`)
  process.stdout.write(`# 内容根：${parsed.tree.diskRoot}（URL 前缀 ${parsed.tree.urlPrefix}）\n`)
  process.stdout.write('# 落盘位置：/etc/nginx/sites-available/' + SITE_FILENAME + '\n')
  process.stdout.write(rendered.config)
  if (args.get('files') === true) {
    process.stdout.write('\n# 需要存在的目录：\n')
    for (const dir of renderDirectoryPlan(parsed.tree)) process.stdout.write(`#   ${dir}\n`)
  }
  return 0
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly && process.argv[1].endsWith('host-config.mjs')) {
  process.exitCode = main()
}

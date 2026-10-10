// workbench/scripts/no-classic-board.test.mjs
// ============================================================================
// BUG-015：产品的「经典看板」（v1 看板）**早就取消了**，但它的入口与整条 v1 数据源
//          还留在「军团指挥台」里 —— 用户点得到「打开经典看板 ↗」、快捷工具里有
//          「经典看板（新窗口）」、KpiBar 右下角还能改那条数据源地址；中枢探测不到时
//          指挥台会**回退**到那条 v1 只读数据源。
//
// 真因不是"少删了一个按钮"，而是**取消一条数据源时只删了服务端，没删客户端这一面**：
// 于是界面上留着一条通往死链路的入口，而且它还会在上游不可达时静默接管数据面 ——
// 用户看到的是一份**看不出是旧的**快照。
//
// 这个文件是**源码级**断言（与 dsh-models-base.test.mjs / model-library-panel.test.mjs 同
// 一个形状）：对 `workbench/src` 下的 .ts/.tsx 递归读文件，断言下面这张清单里
// 每一个字符串都**0 命中**，并对每条写清"为什么它不该出现"。
//
// ★ 断言前**剥掉整行注释**（下面 `codeOnly`）。本仓的教训（BUG-012 §7.3 / BUG-014）：
//   注释里引用旧代码（"这里从前是 `${apiBase()}/api/dsh-models`…"）会让"源码里还有
//   这个字符串"的判据**永远为假**。剥注释之后，文件头还能放心地讲清楚这段历史。
//   注意只剥整行注释：行尾注释里可能还有真代码，宁可少剥，不要剥错。
//
// 名单里唯一需要解释的例外是 `fetchConfig`：`fetchConfigBundle`（PRT-508 的配置导入导出，
// 走中枢、有生产调用方与 model-api.test.mjs 守着）**保留**，它是另一个函数，不是被
// 取消的 v1 `/api/config`。所以这一条用**词边界**匹配：`\bfetchConfig\b` 不会命中
// `fetchConfigBundle`，而 v1 的 `fetchConfig()` 一定命中。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC_DIR = join(ROOT, 'workbench', 'src')

/**
 * 去掉**整行注释**之后再断言（见文件头那段教训）。
 * 只剥整行：`// …`、块注释续行 `* …`、以及 `/* …` 开头的那一行。
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

/** 递归收集 `workbench/src` 下的 .ts / .tsx（按路径排序，报错时输出稳定）。 */
function collectSources(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectSources(full))
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const FILES = collectSources(SRC_DIR).map((path) => ({
  path: path.slice(ROOT.length + 1).replace(/\\/g, '/'),
  raw: readFileSync(path, 'utf8'),
}))
const CODE = FILES.map((f) => ({ path: f.path, code: codeOnly(f.raw) }))

/** 在剥过注释的源码里逐行找 pattern，返回 `文件:行号: 行内容`。 */
function hits(pattern) {
  const found = []
  for (const f of CODE) {
    f.code.split('\n').forEach((line, i) => {
      if (pattern.test(line)) found.push(`${f.path}:${i + 1}: ${line.trim()}`)
    })
  }
  return found
}

/**
 * 清单：`[正则, 人话理由]`。每条理由都回答"它为什么不该出现"——
 * 它们全都是**已取消的 v1 看板**留下的东西，出现即代表那条死链路又接回了界面。
 */
const BANNED = [
  [/经典看板/, 'v1 看板已取消：这个名字不该再出现在界面上（用户看到就点得到），也不该留在代码里描述现状'],
  [/\bapiBase\b/, 'v1 数据源地址解析函数已删除：任何引用都会让请求打到那个已经没人监听的老端口'],
  [/\bsetApiBase\b/, '同上：写 localStorage 的那条 v1 数据源地址已删除，留着等于给用户一条通往死链路的开关'],
  [/\bsetPaused\b/, 'v1 的全局暂停（写服务端 control.json）已随 v1 服务端一起删除：中枢侧没有这个概念'],
  [/\bopenKanban\b/, '「打开经典看板 ↗」的入口函数已删除：它是那条被取消链路的入口'],
  [/\bsubscribeBoard\b/, 'v1 看板 SSE 订阅已删除：数据面只剩中枢，这条流没有生产方'],
  [/\bsubscribeActivity\b/, 'v1 动态 SSE 订阅已删除：同上，中枢侧走 subscribeHubAudit'],
  [/\bfetchConfig\b/, 'v1 `/api/config` 读取已删除（注意：v2 的 fetchConfigBundle 是配置导入导出，不在名单里）'],
  [/fetchBoard\(/, 'v1 `/api/board` 读取已删除：中枢侧是 fetchHubTasks'],
  [/fetchActivity\(/, 'v1 `/api/activity` 读取已删除：中枢侧是 fetchHubActivity'],
  [/fetchMissions\(/, 'v1 `/api/missions` 读取已删除：中枢侧是 fetchHubMissions'],
  [/scrum\/serve/, '被取消的 v1 服务端入口：前端不该再提，更不该再叫人去启动它'],
  [/4820/, 'v1 看板的默认端口：它出现在界面上就意味着有个请求会打到那里'],
  [/v1 文件模式/, '那条只读回退模式已删除：中枢不可达时要**明确报中枢不可达**，而不是退回去显示一份旧快照'],
  [/\?api=/, '「换数据源」的查询参数已删除：换数据源只剩 `?hub=`（apiBase 那条链路没了）'],
]

test('① ★ workbench/src 里没有任何"已取消的 v1 看板"残留', () => {
  // 反向锚：先证明这次扫描**真的读到了源码**——否则"0 命中"可能只是因为目录读空了。
  assert.ok(FILES.length >= 60, `扫描到的源码文件太少（${FILES.length}）：递归读文件这一步坏了`)
  assert.ok(FILES.some((f) => f.raw.includes('hubBase')), '源码里应当有中枢地址 hubBase —— 扫描或切片出了问题')

  const report = []
  for (const [pattern, why] of BANNED) {
    const found = hits(pattern)
    if (found.length > 0) {
      report.push(`\n【${pattern.source}】${why}\n  ${found.join('\n  ')}`)
    }
  }
  assert.equal(report.length, 0,
    `workbench/src 里还有已取消的 v1 看板残留（共 ${report.length} 条判据命中）：${report.join('')}`)
})

test('② ★ 逐个点名：这些导出确实不在 api.ts 里了', () => {
  const api = CODE.find((f) => f.path.endsWith('workbench/src/api.ts'))
  assert.ok(api, '找不到 workbench/src/api.ts')
  for (const gone of [
    'DEFAULT_API', 'apiBase', 'setApiBase', 'fetchConfig(', 'fetchBoard(', 'fetchActivity(',
    'fetchMissions(', 'setPaused', 'subscribeBoard', 'subscribeActivity', 'openKanban',
  ]) {
    assert.equal(api.code.includes(gone), false, `api.ts 里还有 \`${gone}\`（v1 数据源的那一面没删干净）`)
  }
  // 反向锚：中枢那一面必须**原样保留**，不能把 v1 连同 v2 一起删掉。
  for (const kept of ['hubBase', 'setHubBase', 'probeHub', 'fetchHubTasks', 'fetchHubMissions', 'subscribeHubAudit', 'dshModelsRpc', 'hubRequest']) {
    assert.ok(api.code.includes(`function ${kept}`) || api.code.includes(kept),
      `api.ts 少了中枢侧必需的 \`${kept}\` —— 删 v1 时不能伤到 v2`)
  }
})

test('③ ★ 上下文快照打的是**中枢**（hubBase），不是别处', () => {
  // 快照存在 team-hub 里，而这个组件本来就以 hubMode 为前置：
  // 它从前拼的是那条 v1 数据源地址（默认指向另一个端口）——那是个**错误的落点**，不是"多一层代理"。
  const snap = CODE.find((f) => f.path.endsWith('workbench/src/components/SnapshotView.tsx'))
  assert.ok(snap, '找不到 workbench/src/components/SnapshotView.tsx')
  assert.match(snap.code, /import \{ hubBase \} from '\.\.\/api'/, '必须从 ../api 引入 hubBase')
  assert.equal(snap.code.includes('apiBase'), false, '快照组件不许再拼已删除的 v1 数据源地址')
  const bases = [...snap.code.matchAll(/\$\{hubBase\(\)\}/g)].length
  assert.ok(bases >= 4,
    `SnapshotView 的每个取数点都必须前缀 ${'${hubBase()}'}（实测只有 ${bases} 处）—— 漏一处就会打到别的地方`)
})

test('④ ★ 中枢不可达时不许回退：App 里没有第二条数据源分支', () => {
  const app = CODE.find((f) => f.path.endsWith('workbench/src/App.tsx'))
  assert.ok(app, '找不到 workbench/src/App.tsx')
  // 探测失败必须走 error 屏（明确报中枢不可达），而不是继续去别处取数。
  assert.match(app.code, /if \(!\(await probeHub\(\)\)\)/, '中枢探测失败必须显式判掉')
  assert.match(app.code, /setConn\('error'\)/, '探测失败要进 error 状态（界面明确报中枢不可达）')
  assert.ok(app.code.includes('无法连接中枢'), '错误屏必须说"无法连接中枢"，而不是"无法连接数据源"')
  assert.ok(app.code.includes('hubBase()'), '错误屏要说出实际用的中枢地址')
})

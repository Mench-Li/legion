// runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs
// ============================================================================
// PRT-214 补：员工 agent preset **能不能挂上**——在真 DSH 进程里问 `standingKeyFor`。
//
// ## 这一套补的是哪个缺口
//
// `employee-preset.test.mjs` 已经证过两件事：
//   ① 渲染出的 YAML 能被 **DSH 自己的 loader** 解析（`!!js` 变成表达式，不是字符串）；
//   ② 每一行 `name` 都指向检出里**真的装了**的包。
//
// 这两条加起来仍然只是"**读得进去**"，没有证明这个 preset **挂得上**——
// 没有证明 DSH 的组合层真的能把它 compose 出来、每一行真的 activate。
//
//   > 一个"能被解析器读进去"的 preset，与一个"能真的挂上"的 preset，
//   > 在渲染器的用例里是同一个东西——只不过前者的用例是绿的，
//   > 而它从未被任何 mount 读过。
//
// 本套件把那句话变成读数：真 DSH 子进程 + `ctx.agentPresets.standingKeyFor(id)`。
// 那是 DSH 自己的挂载校验（会真的 compose preset 的插件子树，同一段
// `mountPreset()` 每次 session 启动都走）。它**不是**形状检查——`list()` 的
// `broken` 字段不算校验，本套件刻意把它当**对照**读，而不是当判据：
//
//   PRESETMOUNT-HEALTHY <id> true    ← 发现层说"这个文件没问题"
//   PRESETMOUNT-ERR   <id> :: ...    ← 挂载层拒绝
//
// 两条同时成立，就是本缺口的样子。
//
// ## ★ 这一套抓到过什么（它的存在理由）
//
// 本套件**第一版**跑出来的是：渲染器把 `tool-fs-search` 那一行渲染成**不带 config**，
//
//     - id: tool-fs-search
//       name: '@deepseek-ai/dsh-tool-fs-search'
//
// 而 `@deepseek-ai/dsh-tool-fs-search` 的 schema 里
// `sampleOverCapGlobResults: z.boolean().required()` 是**必填**；唯一的兜底在
// **宿主**那一行（DSH 的 base bundle 写 `false`，随部署分发的 `standard` preset
// 也照抄了一行）——preset 里的行**不继承**宿主行的 config。于是挂载当场拒绝：
//
//     failed to apply loader entry tool-fs-search (@deepseek-ai/dsh-tool-fs-search):
//     invalid config: - $.sampleOverCapGlobResults missing required value
//
// 而且它**不是** `broken`：发现层只查形状与"包在不在"，必填 config 是它故意不查的。
// 也就是说：一个"每个字段看起来都对、登记册也认、DSH 一挂就报错"的 preset，
// 与一个"能用的" preset，在解析器用例里逐字节相同。
//
// 只要授权里出现 `read-file`（`LEGION_TOOL_ROUTING['read-file'].rows` 含
// `tool-fs-search`），渲染出的 preset 就是那一份——**每一个授权了 `read-file`
// 的员工 preset 都挂不上**。
//
//    > 一个只断言"渲染文本 == 我声明的行"的用例，
//    > 与一个断言"这份组合真的能被挂起来"的用例，
//    > 在渲染器的那套用例里是同一个东西——
//    > 只不过前者的用例是绿的，而它从未被任何 mount 读过。
//
// 渲染器已按此修好（`DSH_PRESET_ROWS['tool-fs-search'].config`，取值与四处宿主行
// 逐字一致）。本套件随之从"记录缺口"翻成**回归哨兵**：谁把那一行 config 拿掉，
// `buildPicture()` 里的前置断言会先红并说清后果。
//
// ## 诚实边界（这一套**没有**证明的东西）
//
//   · `agentPresets` 是**真的服务**：`@deepseek-ai/dsh-agent-presets` 的 `lib/index.js`
//     按绝对路径挂在 profile 自己的 `cordis.patch.yml` 上。为什么不用"官方那套
//     bundle 声明"——这一行随部署分发的家是 `@deepseek-ai/dsh-web-app` bundle
//     （实测：`bundles: ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']` 真能起、
//     真能提供 `agentPresets`，约 11.5s），但它同时把浏览器面一并点起来
//     （绑一个 127.0.0.1 临时端口、打印一个带 token 的 URL）——一套只问
//     "preset 挂不挂得上"的用例不该开始监听。所以：宿主平面用**真 bundle**
//     （`dsh-base`，profile 的 `dsh.profile.bundles` 逐字声明），roster 行挂
//     **同一个真包**。服务是真的、`standingKeyFor` 是真的、被挂的 preset 子树是真的；
//     只有"这一行由哪一层插进来"是本次用例声明的。
//   · 真进程里**没有** agent、没有 session、没有模型请求、没有网络：
//     `standingKeyFor` 的定义就是"compose 插件子树，但不起 agent/session/turn"。
//   · NOPKG 那一种损坏（行名指向不存在的包）在**发现层**就被判 `broken`，
//     所以它的读数是发现层的拒绝文案，**不是** `Cannot find package`。
//     真正的 loader 级 `Cannot find package` 由 GHOST 场景读到：让包目录**在**
//     （`package.json` 有、模块文件不在），发现层判健康，挂载时 import 才失败。
//     两种损坏必须**不同形**，否则"挂载真的在看组合"这句话没被读出来。
//
// ## 安全（与同目录那几套真实进程套件同一套纪律）
//
//   每个子进程一个 `os.tmpdir()` 下的 `mkdtempSync` 一次性 `DSH_HOME`
//   （spawn 之前断言它在本 run 的 scratch 与 tmpdir 之内）、`DSH_SNAPSHOT` 删掉、
//   `spawnSync` 带 180s 超时、`after()` 整棵删。
//   **绝不**读/写/改操作者的真实 profile 或 `~/.dsh`；**不建任何监听**。
// ============================================================================

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'

import { installEmployeePreset, renderEmployeePreset } from './employee-preset.mjs'
import { narrowToGrant, normalizeManifest } from './employee-manifest.mjs'
import { TOOL_CATALOG } from './tool-capability.mjs'

// ── 可跑性判定（沿用 `employee-preset.test.mjs` 的 guardedDsh 口径）──────
const DSH = process.env.DSH_CHECKOUT ?? null
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const AGENT_PRESETS_LIB = DSH === null
  ? null
  : join(DSH, 'packages', 'preset', 'agent-presets', 'lib', 'index.js')
const DSH_SKIP = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CLI)
    ? `DSH 检出里找不到 CLI（${CLI}）——未构建？`
    : !existsSync(AGENT_PRESETS_LIB)
      ? `DSH 检出里找不到 agent-presets 的构建产物（${AGENT_PRESETS_LIB}）——未构建？`
      : false

/**
 * 每一条真进程用例都走这里：缺 DSH 时 `t.skip(原因)`，**不失败**。
 * 只因为"DSH 不可用"而通过，必须显式表现为 `skipped`，不能表现为绿。
 */
const guarded = (name, fn) => test(name, { timeout: 240_000 }, (t) => {
  if (DSH_SKIP !== false) return t.skip(`SKIP：${DSH_SKIP}`)
  return fn(t)
})

// ── 一次性 scratch（整棵在 after() 里删）────────────────────────────────
const TMP_ROOT = resolve(tmpdir())
const SCRATCH = mkdtempSync(join(TMP_ROOT, 'legion-preset-mount-'))
const PROFILE_NAME = 'legionpresetmount'

after(() => {
  // 子进程已经退出（spawnSync），整棵 scratch 连同它下面每一个一次性 home 一起删。
  rmSync(SCRATCH, { recursive: true, force: true })
})

// ── 探针行 ──────────────────────────────────────────────────────────────
// ⚠️ 这一段是**要被写进文件的 JavaScript 源码**，装在一个模板串里：
//    里面**不能出现反引号**（会提前结束模板串），也**不能出现 `${`**（会被插值）。
//    换行符一律写成 '\\n'（模板串读出来才是源码里的 '\n'）。
//    本仓库被这件事咬过多次，别在下面加反引号。
const PROBE_SRC = `// Legion 探针行：只在真 DSH 进程里跑。所有读数都以 PRESETMOUNT- 开头。
const note = (line) => process.stderr.write(line + '\\n')

const waitFor = async (ctx, name, deadlineMs) => {
  const started = Date.now()
  for (;;) {
    const found = ctx.get(name)
    if (found !== undefined && found !== null) return found
    if (Date.now() - started > deadlineMs) return null
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

const run = async (ctx) => {
  try {
    note('PRESETMOUNT-SERVICE ' + String(ctx.get('agentPresets') !== undefined))
    // 两个登记簿在，preset 的行才有地方注册。够不着就如实记下来，不猜。
    note('PRESETMOUNT-HOST-TOOLS ' + String(await waitFor(ctx, 'tools', 60000) !== null))
    note('PRESETMOUNT-HOST-SYSTEM-PROMPT ' + String(await waitFor(ctx, 'systemPrompt', 60000) !== null))
    // 让 base 剩下的行落定（fs / subprocess / shell / shellEnv / web 都是宿主行的服务）。
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const svc = ctx.get('agentPresets')
    // ★ 名册在**挂载之前**读一次。挂载会留下 standing mount，而
    //   list() 对已挂载的 preset 不再报 broken——先挂后读会让这条对照失真。
    const roster = await svc.list()
    note('PRESETMOUNT-ROSTER ' + roster.map((row) => row.id + (row.broken === undefined ? '' : ':broken')).join(','))
    for (const id of (process.env.LEGION_PRESET_MOUNT_IDS || '').split(',').filter((value) => value !== '')) {
      const row = roster.find((entry) => entry.id === id)
      // ⚠️ 这不是校验，是对照：发现层"健康"与挂载层"能挂"是两件事。
      note('PRESETMOUNT-HEALTHY ' + id + ' ' + String(row !== undefined && row.broken === undefined))
      try {
        await svc.standingKeyFor(id)
        note('PRESETMOUNT-OK ' + id)
      } catch (error) {
        note('PRESETMOUNT-ERR ' + id + ' :: ' + String(error && error.message ? error.message : error).replace(/\\n/g, ' | '))
      }
    }
  } catch (error) {
    note('PRESETMOUNT-PROBE-THREW ' + String(error && error.message ? error.message : error))
  }
  note('PRESETMOUNT-PROBE-EXIT-0')
  process.exit(0)
}

export default {
  name: 'legion-preset-mount-probe',
  inject: ['agentPresets'],
  apply(ctx) {
    note('PRESETMOUNT-PROBE-APPLY-RAN')
    setTimeout(() => { void run(ctx) }, 0)
  },
}
`

const PROBE_MODULE = join(SCRATCH, 'legion-preset-mount-probe.mjs')
const PROBE_PATCH = join(SCRATCH, 'legion-preset-mount-probe.patch.yml')
writeFileSync(PROBE_MODULE, PROBE_SRC)
writeFileSync(PROBE_PATCH, '- insert:\n'
  + '    - id: "legion-preset-mount-probe"\n'
  + '      name: ' + JSON.stringify(PROBE_MODULE.replaceAll('\\', '/')) + '\n')

// ── 夹具：复用 `employee-preset.test.mjs` 的 employee()/render() 形状 ────
const CWD = process.platform === 'win32' ? 'C:\\w' : '/w'

/** 造一份清单 + 授权。授权**由清单推**，所以两者不会各说各话。 */
function employee(spec = {}) {
  const allowedTools = spec.allowedTools ?? ['read-file', 'git-status']
  const allowedCapabilities = spec.allowedCapabilities
    ?? [...new Set(allowedTools.flatMap((t) => TOOL_CATALOG[t]?.capabilities ?? []))]
  const maxRisk = spec.maxRisk ?? 'critical'
  const manifest = normalizeManifest({
    employeeId: spec.employeeId ?? 'e1',
    role: spec.role ?? 'reader',
    allowedTools,
    allowedCapabilities,
    maxRisk,
  })
  const grant = narrowToGrant({
    manifest,
    grant: {
      scope: 's1', actor: 'legion', action: 'write', taskId: null,
      cwd: CWD, workspaceRoot: CWD,
      allowedTools, allowedCapabilities, maxRisk,
    },
  })
  return { manifest, grant }
}

const render = (id, allowedTools) => {
  const { manifest, grant } = employee({ allowedTools })
  return renderEmployeePreset({ id, manifest, grant, persona: '你是 Legion 的一个岗位员工。' })
}

/** 现实的全工具授权：含 `read-file` → 行集里有 `tool-fs-search`。 */
const RENDERED_TOOLS = Object.freeze(['read-file', 'write-file', 'run-command', 'fetch-url'])
/**
 * 行集恰好**不**含 `tool-fs-search` 的授权（去掉 `read-file`）。
 *
 * 为什么需要它：没有它，本套件里**每一个**渲染器产出的 preset 都是 ERR，
 * 于是"探针根本读不出 OK"与"这个组合真的挂不上"就同形了。
 */
const MOUNTABLE_TOOLS = Object.freeze(['write-file', 'run-command', 'fetch-url'])

/** 行名指向一个**不存在**的包（发现层就会判 broken）。 */
const NO_SUCH_PKG = '@deepseek-ai/dsh-tool-no-such-package'
/** 行名指向一个"包目录在、模块文件不在"的包（发现层判健康，挂载时 import 失败）。 */
const GHOST_PKG = '@deepseek-ai/dsh-tool-ghost'

/**
 * 从渲染出的文本里切出**一行**（`- id: <id>` 到下一个顶层行之前，含分隔空行）。
 *
 * 为什么不用 `text.includes("- id: x\n  name: y\n")`：那问的是"这一串字符在不在"，
 * 而"行尾又跟了一行 `config:`"的文本**照样满足**这个子串——
 * 一个"已经补上 config"的渲染器可以让这种检查继续成立，
 * 于是"渲染器漏了这一行"这句前提就再也不会被检查到。
 * 行边界只能按行切。
 */
function rowBlock(text, id) {
  const lines = text.split('\n')
  const start = lines.indexOf(`- id: ${id}`)
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('- id: ')) end += 1
  return lines.slice(start, end).join('\n')
}

const IDS = Object.freeze({
  /** 渲染器产出、行集不含 tool-fs-search → 应当真的挂上。 */
  MOUNTABLE: 'legion-emp-noread',
  /** 渲染器产出、现实全工具集（含 read-file → 行集含 tool-fs-search）→ 也应当挂上。 */
  RENDERED: 'legion-emp-mount',
  /** 行名指向不存在的包。 */
  NOPKG: 'legion-emp-nopkg',
  /** 行名指向"包在、模块不在"。 */
  GHOST: 'legion-emp-ghost',
  /** 根本没安装的 id。 */
  ABSENT: 'legion-emp-absent',
})

// ── 一次性 home ─────────────────────────────────────────────────────────

/**
 * profile 自己那一层补丁：把 roster 行插进宿主组合。
 *
 * 宿主平面是**真 bundle**（`dsh.profile.bundles: ['@deepseek-ai/dsh-base']`）；
 * roster 行按**绝对路径**挂**真的** `@deepseek-ai/dsh-agent-presets` 包
 * （理由见文件头"诚实边界"：它随部署分发的家是 web-app bundle，
 * 而那会把浏览器面也点起来）。这一行与 web-app bundle 里那行逐字同 id、同包、同 config。
 */
function profilePatchText() {
  const lib = (AGENT_PRESETS_LIB ?? '/nonexistent').replaceAll('\\', '/')
  return [
    '# Legion 探针 profile 的用户层：宿主平面用真 bundle，roster 行挂真的 agent-presets 包。',
    '- insert:',
    '    - id: "agent-presets"',
    '      name: ' + JSON.stringify(lib),
    '      config:',
    '        default: "standard"',
    '',
  ].join('\n')
}

function makeHome(tag, options = {}) {
  const home = mkdtempSync(join(SCRATCH, `home-${tag}-`))
  assert.ok(resolve(home).startsWith(TMP_ROOT), `一次性 home 逃出了 tmpdir：${home}`)
  assert.ok(resolve(home).startsWith(SCRATCH), `一次性 home 逃出了本次 run 的 scratch：${home}`)

  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'startup' } },
  }, null, 2) + '\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), profilePatchText())

  if (options.ghostPackage === true) {
    // 「包在、模块不在」：发现层查得到 package.json（→ 判健康），
    // loader import 时找不到模块（→ `Cannot find package`）。
    const ghostDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tool-ghost')
    mkdirSync(ghostDir, { recursive: true })
    writeFileSync(join(ghostDir, 'package.json'), JSON.stringify({
      name: GHOST_PKG, version: '0.0.0', type: 'module', main: 'index.js',
    }, null, 2) + '\n')
  }
  return home
}

/** 把一份渲染（或改写过）的 preset 落到 `<home>/.agent-presets/<id>/`。 */
async function install(home, preset, text = null) {
  const presetRoot = join(home, '.agent-presets')
  const payload = text === null
    ? preset
    : { id: preset.id, files: { 'agent.cordis.yml': text, 'preset.yml': preset.files['preset.yml'] } }
  await installEmployeePreset({ presetRoot, preset: payload })
}

/** 跑一次真 dsh：一次性 home、删 `DSH_SNAPSHOT`、带超时、stdio 走管道。 */
function spawnDsh(home, ids) {
  const env = { ...process.env, DSH_HOME: home, LEGION_PRESET_MOUNT_IDS: ids.join(',') }
  delete env.DSH_SNAPSHOT

  const result = spawnSync(process.execPath, [CLI, '--profile', PROFILE_NAME, '--patch', PROBE_PATCH], {
    cwd: SCRATCH,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  })

  return {
    code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error === undefined ? null : String(result.error.message ?? result.error),
  }
}

// ── 读数 ────────────────────────────────────────────────────────────────

/** 从 stderr 里读一个 `KEY value` 读数；读不到返回 `null`（不猜默认值）。 */
function reading(stderr, key) {
  const match = new RegExp(`^${key} (.+)$`, 'm').exec(stderr)
  return match === null ? null : match[1].trim()
}

// id 只由 `[a-z0-9-]` 组成，直接进正则不会产生元字符；换成别的形状就要转义。
const mountOk = (stderr, id) => new RegExp(`^PRESETMOUNT-OK ${id}$`, 'm').test(stderr)
const mountErr = (stderr, id) => reading(stderr, `PRESETMOUNT-ERR ${id} ::`)
const health = (stderr, id) => reading(stderr, `PRESETMOUNT-HEALTHY ${id}`)

// ── 场景（每个场景 = 一个真子进程；同一个场景只起一次）──────────────────

const SCENARIOS = new Map()

/**
 * 一个场景只跑一次，多个用例共用它的读数。
 *
 * 为什么要共用：本套件的每一条断言都是**同一个进程里两个读数之间的关系**
 * （OK vs ERR、健康 vs 拒绝）。分成两个进程去读，两边的差异就可能是"进程不同"
 * 而不是"组合不同"——那正是这条缺口看起来像绿的那种方式。
 */
function scenario(name, build) {
  if (!SCENARIOS.has(name)) SCENARIOS.set(name, build())
  return SCENARIOS.get(name)
}

/**
 * 场景 `PICTURE`：一个进程里读齐三件事。
 *
 *   MOUNTABLE → OK        （探针能读出"挂上了"，而且是对渲染器产出读出来的）
 *   RENDERED  → OK        （现实全工具集，含 read-file → 行集含 tool-fs-search）
 *   NOPKG     → ERR       （另一种拒绝：行名指向不存在的包）
 *   ABSENT    → ERR       （第三种：id 不存在）
 *
 * ★ 第一版里 `RENDERED` 是 **ERR**：那时渲染器漏了 `tool-fs-search` 的必填
 * config，这个套件就是发现那件事的地方。修好之后它变成 OK，
 * 而"OK 不是恒真"由 `NOPKG` / `ABSENT` 两条负对照继续守着。
 */

/**
 * 从 DSH 的 **base bundle** 里读 `sampleOverCapGlobResults` 的取值。
 *
 * 读它而不是硬编码，是为了让"我们抄的是部署已有的选择"这件事**可被观测**：
 * 哪天上游把它改成 `true`，这条会跟着变，而不是我们悄悄留着一个旧值。
 *
 * 读不到时**如实返回 `null`**（而不是猜 `false`）——用例会因此红，
 * 那正是"宿主那一行找不到了，得有人去看"。
 */
async function hostRowSampleValue() {
  if (DSH === null) return null
  const file = join(DSH, 'packages', 'bundle', 'base', 'cordis.patch.yml')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const m = /^\s*sampleOverCapGlobResults:\s*(\S+)\s*$/m.exec(text)
  return m === null ? null : m[1]
}

async function buildPicture() {
  const home = makeHome('picture')

  const mountable = render(IDS.MOUNTABLE, MOUNTABLE_TOOLS)
  await install(home, mountable)

  const rendered = render(IDS.RENDERED, RENDERED_TOOLS)
  await install(home, rendered)

  // 前置断言：渲染出的那一行必须**在**，且带着必填 config。
  //
  // 本套件第一版这里断言的是**相反**的东西（"不许有 config"），因为那时
  // 渲染器真的漏了它——这个套件就是发现那件事的地方。渲染器修好之后，
  // 这里翻过来变成一条**回归哨兵**：谁把那一行 config 拿掉，
  // 这条会先红并说清后果，而不是让挂载用例以"读数变了"的形式红一次。
  const toolFsSearchRow = rowBlock(rendered.text, 'tool-fs-search')
  assert.notEqual(toolFsSearchRow, null, '渲染出的 preset 里找不到 tool-fs-search 行')
  assert.match(toolFsSearchRow, /^\s+sampleOverCapGlobResults: false$/m,
    '渲染器没有给 tool-fs-search 带上必填的 sampleOverCapGlobResults —— '
    + '这一行的 schema 是 `.required()` 且**没有兜底**，漏掉它这个 preset 就挂不上，'
    + '而发现层仍会报它健康（本套件抓到过一次）')

  // 宿主那一行写的值：我们抄的就是它。硬编码会让"跟着部署走"退化成"猜一个数"。
  const hostSampleValue = await hostRowSampleValue()

  const nopkgText = rendered.text.replace("'@deepseek-ai/dsh-tool-fs-search'", `'${NO_SUCH_PKG}'`)
  assert.notEqual(nopkgText, rendered.text, 'NOPKG 改写没生效')
  await install(home, { id: IDS.NOPKG, files: rendered.files }, nopkgText)

  const run = spawnDsh(home, [IDS.MOUNTABLE, IDS.RENDERED, IDS.NOPKG, IDS.ABSENT])
  return {
    ...run,
    texts: { mountable: mountable.text, rendered: rendered.text, toolFsSearchRow, hostSampleValue },
  }
}

/** 场景 `GHOST`：发现层判健康、挂载层才 import 失败的另一种损坏。 */
async function buildGhost() {
  const home = makeHome('ghost', { ghostPackage: true })
  const rendered = render(IDS.GHOST, RENDERED_TOOLS)
  const text = rendered.text.replace("'@deepseek-ai/dsh-tool-fs-search'", `'${GHOST_PKG}'`)
  assert.notEqual(text, rendered.text, 'GHOST 改写没生效')
  await install(home, { id: IDS.GHOST, files: rendered.files }, text)
  return spawnDsh(home, [IDS.GHOST])
}

// ── 用例 ────────────────────────────────────────────────────────────────

describe('PRT-214 员工 preset 真挂载（真 DSH 进程 × standingKeyFor）', () => {
  guarded('★★★★★ 机制是真的：渲染器产出的 preset 在真进程里**挂上了**（PRESETMOUNT-OK）', async (t) => {
    const r = await scenario('picture', buildPicture)
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `探针必须正常收尾（它是自己 exit 0 的）：\n${r.stderr}`)
    assert.match(r.stderr, /^PRESETMOUNT-PROBE-APPLY-RAN$/m, r.stderr)
    assert.equal(reading(r.stderr, 'PRESETMOUNT-SERVICE'), 'true', r.stderr)
    // 宿主平面真的起来了：两个登记簿在，preset 的行才有地方注册。
    assert.equal(reading(r.stderr, 'PRESETMOUNT-HOST-TOOLS'), 'true', r.stderr)
    assert.equal(reading(r.stderr, 'PRESETMOUNT-HOST-SYSTEM-PROMPT'), 'true', r.stderr)
    // 名册里真的有我们装进去的那几个 id（否则"not found"对每个 id 都成立，
    // 下面那些读数就全是空的）。
    const roster = reading(r.stderr, 'PRESETMOUNT-ROSTER') ?? ''
    for (const id of [IDS.MOUNTABLE, IDS.RENDERED, IDS.NOPKG]) {
      assert.ok(roster.includes(id), `名册里没有 ${id}：${roster}`)
    }
    assert.equal(roster.includes(IDS.ABSENT), false, `名册里不该有 ${IDS.ABSENT}：${roster}`)

    // ★ 本套件的正面读数：渲染器产出的 preset，真的挂上了。
    assert.equal(mountOk(r.stderr, IDS.MOUNTABLE), true,
      `渲染器产出的 preset 没挂上——探针或宿主坏了，不是"组合被拒"：\n${r.stderr}`)
    assert.equal(mountErr(r.stderr, IDS.MOUNTABLE), null)
    // ★★ 现实全工具授权（含 read-file → 行集含 tool-fs-search）也必须挂上。
    //    这一条在本套件第一版里是**反过来**的（断言 ERR）——那时渲染器漏了
    //    `tool-fs-search` 的必填 config，而这个套件就是发现那件事的地方。
    //    修好之后按文件头的维护者说明改成断言 OK。见下面那条用例。
    assert.equal(mountOk(r.stderr, IDS.RENDERED), true,
      `现实全工具授权没挂上——渲染器可能又漏了某个必填 config：\n${r.stderr}`)
    assert.equal(mountErr(r.stderr, IDS.RENDERED), null)
    t.diagnostic(`PRESETMOUNT-OK ${IDS.MOUNTABLE} + ${IDS.RENDERED}（现实全工具集）`)
  })

  guarded('★★★★★ ★ 回归哨兵：`tool-fs-search` 那一行**带着**必填 config（本套件抓到过的那个缺口）', async (t) => {
    const r = await scenario('picture', buildPicture)
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `探针必须正常收尾：\n${r.stderr}`)

    // ① 这不是"文件坏了"：发现层（形状 + 包在不在）说它健康。
    assert.equal(health(r.stderr, IDS.RENDERED), 'true', r.stderr)

    // ② ★ 渲染出的文件里那一行**确实有** config，且值是我们声明的那个。
    //
    //    这条是本套件的**第一条判据**——在渲染器修好之前，它是
    //    `assert.equal(..., false)`，也就是"这一行没有 config"。
    //
    //       > 一个"能被解析器读进去"的 preset，
    //       > 与一个"能真的挂上"的 preset，
    //       > 在渲染器的用例里是同一个东西——
    //       > 只不过前者的用例是绿的，而它从未被任何 mount 读过。
    //
    //    之所以仍按**行边界**切（`- id: x` 到下一个顶层行），而不是全文找
    //    `sampleOverCapGlobResults`：全文找的话，那个键出现在别的行里也能让
    //    这条断言成立。行边界切法还顺带钉住"config 属于这一行"。
    assert.match(r.texts.toolFsSearchRow, /^\s+config:$/m,
      `tool-fs-search 那一行没有 config —— 就是本套件抓到过的那个缺口复发了：\n${r.texts.toolFsSearchRow}`)
    assert.match(r.texts.toolFsSearchRow, /^\s+sampleOverCapGlobResults: false$/m,
      `config 里没有 sampleOverCapGlobResults: false：\n${r.texts.toolFsSearchRow}`)

    // ③ 与**宿主**行的取值逐字一致（不是我们发明的默认值）。
    //    DSH 的 README 明说这个字段"必填且没有回退值"，所以只有一处可选：
    //    跟着 `dsh-base` 与三个 shipped preset 都写的那个值走。
    assert.equal(r.texts.hostSampleValue, 'false',
      `宿主行写的不是 false —— 我们抄的那个值要跟着它变：${r.texts.hostSampleValue}`)

    // ④ 挂载层也跟着成功（同进程、同服务、同一个探针）。
    assert.equal(mountOk(r.stderr, IDS.RENDERED), true,
      `config 在文本里，挂载却仍拒绝——那"缺的就是这一行"这个因果不成立：\n${r.stderr}`)
    t.diagnostic(`PRESETMOUNT-REGRESSION ${IDS.RENDERED}=OK  config=sampleOverCapGlobResults:false`)
  })

  guarded('★★★ 负对照：id 不存在 → `not found`，与 OK 不同形（OK 不是恒真）', async (t) => {
    const r = await scenario('picture', buildPicture)
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `探针必须正常收尾：\n${r.stderr}`)

    assert.equal(health(r.stderr, IDS.ABSENT), 'false', r.stderr)
    assert.equal(mountOk(r.stderr, IDS.ABSENT), false,
      `一个根本没装的 id 报了 OK——那 OK 这个读数什么都没证明：\n${r.stderr}`)
    const err = mountErr(r.stderr, IDS.ABSENT)
    assert.notEqual(err, null, `没有读到 ${IDS.ABSENT} 的拒绝：\n${r.stderr}`)
    assert.ok(err.includes('not found'), `id 不存在的读数是 ${err}`)
    // 与"组合被拒"必须**不同形**：一个是找不到 preset，一个是找到了但挂不上。
    assert.notEqual(err, mountErr(r.stderr, IDS.RENDERED))
    t.diagnostic(`PRESETMOUNT-ERR ${IDS.ABSENT}：${err}`)
  })

  guarded('★★★ 负对照：行名指向不存在的包 → 发现层就点名（且与"id 不存在"不同形）', async (t) => {
    const r = await scenario('picture', buildPicture)
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `探针必须正常收尾：\n${r.stderr}`)

    assert.equal(health(r.stderr, IDS.NOPKG), 'false',
      `一个行名指向不存在包的 preset 被判成健康——发现层没在看包：\n${r.stderr}`)
    assert.equal(mountOk(r.stderr, IDS.NOPKG), false)
    const err = mountErr(r.stderr, IDS.NOPKG)
    assert.notEqual(err, null, `没有读到 ${IDS.NOPKG} 的拒绝：\n${r.stderr}`)
    assert.ok(err.includes('tool-fs-search'), `拒绝没点名哪一行：${err}`)
    assert.ok(err.includes(NO_SUCH_PKG), `拒绝没点名哪个包：${err}`)
    // 与"id 不存在"不同形：这条是"preset 在，行坏了"。
    assert.notEqual(err, mountErr(r.stderr, IDS.ABSENT))
    t.diagnostic(`PRESETMOUNT-HEALTHY ${IDS.NOPKG}=false  ${err}`)
  })

  guarded('★★★ 另一种损坏：包在、模块不在 → 发现层判健康，挂载时才 `Cannot find package`', async (t) => {
    const r = await scenario('ghost', buildGhost)
    assert.equal(r.spawnError, null)
    assert.equal(r.code, 0, `探针必须正常收尾：\n${r.stderr}`)
    assert.match(r.stderr, /^PRESETMOUNT-PROBE-APPLY-RAN$/m, r.stderr)

    // ★ 发现层的判据是"包目录在不在"（存在 package.json 就算在），
    //   所以这一份被判**健康**——拒绝来自挂载时的真 import。
    assert.equal(health(r.stderr, IDS.GHOST), 'true',
      `发现层把它判成 broken——那这条读数就不是"挂载真的去 import 了"：\n${r.stderr}`)
    assert.equal(mountOk(r.stderr, IDS.GHOST), false)
    const err = mountErr(r.stderr, IDS.GHOST)
    assert.notEqual(err, null, `没有读到 ${IDS.GHOST} 的拒绝：\n${r.stderr}`)
    assert.ok(err.includes('Cannot find package'), `读数不是 loader 级的缺包：${err}`)
    assert.ok(err.includes('tool-fs-search'), `拒绝没点名哪一行：${err}`)
    t.diagnostic(`PRESETMOUNT-HEALTHY ${IDS.GHOST}=true  ${err}`)
  })

  test('★ 汇总：四种拒绝与两次成功**两两不同形**（否则差别没被读出来）', async (t) => {
    if (DSH_SKIP !== false) return t.skip(`SKIP：${DSH_SKIP}`)
    const picture = await scenario('picture', buildPicture)
    const ghost = await scenario('ghost', buildGhost)

    assert.equal(picture.spawnError, null)
    assert.equal(ghost.spawnError, null)
    assert.equal(mountOk(picture.stderr, IDS.MOUNTABLE), true)
    assert.equal(mountOk(picture.stderr, IDS.RENDERED), true)
    assert.equal(mountOk(picture.stderr, IDS.NOPKG), false)
    assert.equal(mountOk(picture.stderr, IDS.ABSENT), false)
    assert.equal(mountOk(ghost.stderr, IDS.GHOST), false)

    // ★ 负对照仍然守着"OK 不是恒真"：NOPKG / ABSENT / GHOST 三种拒绝
    //   两两不同形，而且都不等于 OK。
    //
    //   第一版这里比的是**四种**拒绝（多一个"缺 config"的 RENDERED）。
    //   渲染器修好之后那一种**不再存在**——所以这条断言的个数也得跟着降。
    //   *一条"四种拒绝两两不同"的断言，在只剩三种拒绝时会红——
    //   那不是它坏了，是它如实地说"我守的那个局面已经变了"。*
    const errs = {
      nopkg: mountErr(picture.stderr, IDS.NOPKG),
      absent: mountErr(picture.stderr, IDS.ABSENT),
      ghost: mountErr(ghost.stderr, IDS.GHOST),
    }
    for (const [name, value] of Object.entries(errs)) {
      assert.notEqual(value, null, `场景 ${name} 没有拒绝读数`)
    }
    const distinct = new Set(Object.values(errs))
    assert.equal(distinct.size, 3,
      `三种拒绝里有重复的读数——那"挂载真的在看组合"这件事就没被区分开：\n${JSON.stringify(errs, null, 2)}`)

    t.diagnostic('OK=' + [IDS.MOUNTABLE, IDS.RENDERED].join(',')
      + '  ERR=' + Object.entries(errs).map(([k, v]) => `${k}(${v.slice(0, 60)}...)`).join(' | '))
  })
})

if (DSH_SKIP !== false) {
  test('PRT-214 员工 preset 真挂载（真 DSH 进程部分）本次未运行', () => {
    assert.ok(true, `SKIP 原因：${DSH_SKIP}。外部宿主测试不伪造通过——跑不了就不算跑过。`)
  })
}

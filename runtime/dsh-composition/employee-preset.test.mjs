// runtime/dsh-composition/employee-preset.test.mjs
// ============================================================================
// PRT-214：员工 agent preset（spec §6.9 的 agent 平面那一半）。
//
// ## 这一套在守什么
//
// 补丁层（host 平面）已经把强制面做完了；员工 preset 是另一半。
// 它的失败模式与强制面**不同**：强制面坏掉是"该拦的没拦"，员工 preset 坏掉是
// "该有的工具没有"——后者**不报错**，模型只是用别的办法绕，或者干脆说做不到。
//
//   > 一个"清单给了权限、preset 没给工具"的 preset，
//   > 与一个"这个岗位本来就没有这个权限"的 preset，在模型那里是同一个东西——
//   > 只不过前者会让一次本该成功的工作变成一句"我做不到"。
//
// ## 没有 DSH_CHECKOUT 时
//
// 纯渲染/覆盖逻辑（绝大多数用例）**不依赖 DSH**，照常跑；
// 只有"真 DSH loader 解析"与"包能解析得到"那几条 SKIP，逐条写明原因。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  DSH_PRESET_ROWS,
  EMPLOYEE_PRESET_CHECKED,  EMPLOYEE_PRESET_CODES,
  LEGION_TOOL_ROUTING,
  PRESET_ID_PATTERN,
  SHIPPED_PRESET_IDS,
  assertEveryRowReachable,
  coverageOf,
  dshToolNamesOf,
  executionDenialFor,
  installEmployeePreset,
  needsQuoting,
  renderEmployeePreset,
  yamlScalar,
} from './employee-preset.mjs'
import { HARD_FLOOR_CAPABILITIES } from './enforcement.mjs'
import { TOOL_CATALOG } from './tool-capability.mjs'
import { narrowToGrant, normalizeManifest } from './employee-manifest.mjs'
import { EMPLOYEE_PRESET_CONTRACT } from './patch-layer.mjs'

import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

describe('executionDenialFor：一个 Legion 工具 → 要在执行面上禁哪些名字', () => {
  test('★★★★★ 可表达的那一个：`git-push` → `bash`/`pwsh`，且连带代价被算出来', () => {
    const d = executionDenialFor('git-push')
    assert.deepEqual([...d.dshTools], ['bash', 'pwsh'])
    assert.equal(d.hosted, false)
    assert.equal(d.unrouted, false)
    // 连带代价 = **别的** Legion 工具里也落到这两个名字上、且**自己不是硬底线**的那些。
    // 是硬底线的那些本来就该被禁，算进代价会把代价说大。
    assert.deepEqual([...d.collateral], ['run-command', 'git-status', 'git-commit'])
    // 反向对照：这三个确实不是硬底线（否则上面那条断言就是把它自己的同类算成了代价）。
    for (const n of d.collateral) assert.equal(TOOL_CATALOG[n].hardFloor, false, n)
  })

  test('★★★★★ 硬底线里 2/3 在执行面上**没有名字**：`hosted` 必须说出来，不许静默跳过', () => {
    // 这三个是 `HARD_FLOOR_CAPABILITIES` 的载体，而它们各自落到哪一侧并不一样。
    const carriers = Object.values(TOOL_CATALOG)
      .filter((t) => t.capabilities.some((c) => HARD_FLOOR_CAPABILITIES.includes(c)))
      .map((t) => t.name).sort()
    assert.deepEqual(carriers, ['delete-file', 'git-push', 'write-secret'])

    const expressible = carriers.filter((n) => executionDenialFor(n).dshTools.length > 0)
    const hosted = carriers.filter((n) => executionDenialFor(n).hosted === true)
    assert.deepEqual(expressible, ['git-push'])
    assert.deepEqual(hosted, ['delete-file', 'write-secret'])
    // 这两组必须**恰好**覆盖全部载体：漏掉的那一天，一个硬底线会在
    // "既没被翻译、也没被标成不可表达"的状态下，安静地不进任何名单。
    assert.deepEqual([...expressible, ...hosted].sort(), carriers)

    // `hosted` 的两条各自带一条说得清来源的理由——修法是接线，不是改名单。
    for (const n of hosted) {
      assert.equal(executionDenialFor(n).unrouted, false, n)
      assert.equal(typeof executionDenialFor(n).reason, 'string', n)
      assert.notEqual(executionDenialFor(n).reason.trim(), '', n)
    }
  })

  test('★★★★ 路由表里没有的名字判 `unrouted`（与 `hosted` 是两件事，修法不同）', () => {
    const d = executionDenialFor('ghost-tool')
    assert.deepEqual([...d.dshTools], [])
    assert.equal(d.unrouted, true, '修法是登记路由表')
    assert.equal(d.hosted, false, '它**不是**"由宿主平面提供"——我们只是不知道它是什么')
    assert.match(d.reason, /路由表/)
  })

  test('★★★★ 每一个路由项都不会抛，而且 `dshTools` 与 `dshToolNamesOf` 对得上', () => {
    // 两个函数读同一张表，答案必须一致——不一致的那一天，
    // "名字空间对不对得上"的读数与"下限里放什么"的读数会各说各话。
    for (const name of Object.keys(LEGION_TOOL_ROUTING)) {
      const one = executionDenialFor(name)
      assert.deepEqual([...one.dshTools], [...dshToolNamesOf([name])], name)
      assert.equal(Object.isFrozen(one), true, name + ' 的返回值没冻结')
      assert.equal(Object.isFrozen(one.dshTools), true, name)
      assert.equal(Object.isFrozen(one.collateral), true, name)
    }
  })

  test('★★★★ 替身表：两张表都由参数注入（用例不该被生产表绑死）', () => {
    const d = executionDenialFor('probe-tool', {
      routing: {
        'probe-tool': { rows: ['x'], dshTools: ['probe-dsh'] },
        'other-tool': { rows: ['x'], dshTools: ['probe-dsh'] },
        'hosted-tool': { rows: [], hosted: true, reason: '探针理由' },
      },
      catalog: {},
    })
    assert.deepEqual([...d.dshTools], ['probe-dsh'])
    assert.deepEqual([...d.collateral], ['other-tool'])
    assert.equal(executionDenialFor('hosted-tool', {
      routing: { 'hosted-tool': { hosted: true, reason: '探针理由' } }, catalog: {},
    }).reason, '探针理由')
  })
})

// ── DSH 侧（可 SKIP） ────────────────────────────────────────────────────
// ★ 检出用**共享解析器**找（`tests/dsh-checkout.mjs`），不在这里手写
//   `process.env.DSH_CHECKOUT ?? null`。手写的后果实测过：变量没导出时
//   本套件整组跳过，而 CI 报的是 `PASS`——一个「跑了 0 条」的绿。
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const INCLUDE_JS = DSH === null ? null : join(
  DSH, 'packages', 'boot', 'app-boot', 'node_modules',
  '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js',
)
const JS_YAML_JS = DSH === null ? null : join(
  DSH, 'packages', 'boot', 'app-boot', 'node_modules', 'js-yaml', 'index.js',
)
const DSH_SKIP = DSH === null
  ? DSH_FOUND.reason
  : !existsSync(INCLUDE_JS)
    ? `DSH 检出里找不到 cordis-plugin-include（${INCLUDE_JS}）`
    : !existsSync(JS_YAML_JS)
      ? `DSH 检出里找不到 js-yaml（${JS_YAML_JS}）`
      : false

let entryListSchema = null
let yaml = null
if (DSH_SKIP === false) {
  ;({ entryListSchema } = await import(pathToFileURL(INCLUDE_JS).href))
  yaml = await import(pathToFileURL(JS_YAML_JS).href)
}

const guardedDsh = (name, fn) => test(name, async (t) => {
  if (DSH_SKIP !== false) return t.skip(`SKIP：${DSH_SKIP}`)
  return fn(t)
})

// ── 夹具 ────────────────────────────────────────────────────────────────
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
    ...(spec.extra ?? {}),
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

const render = (spec = {}, over = {}) => {
  const { manifest, grant } = employee(spec)
  return renderEmployeePreset({
    id: over.id ?? 'legion-emp-test',
    manifest, grant,
    persona: over.persona ?? '你是 Legion 的一个岗位员工。',
    ...over,
  })
}

describe('PRT-214 员工 agent preset', () => {
  // ── 覆盖：这是本模块存在的理由 ──────────────────────────────────────
  test('★★★ 登记表里**每一个**工具都有路由交代（漏一个就会静默少工具）', () => {
    assert.deepEqual([...EMPLOYEE_PRESET_CHECKED.routingCoversCatalog], [],
      '登记表里有工具没有路由：渲染器遇到它会抛 TOOL_UNCOVERED，' +
      '但更坏的是"有人后来加了个工具、忘了加路由"这条路径本身没人守')
    // 反向：路由里不许出现登记表没有的工具名（幽灵路由）
    const ghosts = Object.keys(LEGION_TOOL_ROUTING).filter((t) => TOOL_CATALOG[t] === undefined)
    assert.deepEqual(ghosts, [], `路由里有登记表不认识的工具：${JSON.stringify(ghosts)}`)
  })

  test('★★★ 表里**每一行**都能被某个工具到达（否则它是一行永远装不上的行）', () => {
    // 这条是补出来的：第一版 `read-file` 只路由到 `tool-fs`，
    // 于是 `tool-fs-search` 没有任何工具能到达它——表里声明了，
    // 但产出的 preset 里永远不会出现它。
    const r = assertEveryRowReachable()
    assert.deepEqual([...r.unreachable], [],
      `这些行声明了却永远装不上：${JSON.stringify(r.unreachable)}。` +
      '读表的人会以为 glob/grep 已经给了员工')
    assert.equal(r.ok, true)
    assert.deepEqual([...r.rows].sort(), Object.keys(DSH_PRESET_ROWS).sort())
  })

  test('★★★ 可达性检查本身**不是恒真的**（喂一张断链表它必须报出来）', () => {
    // 一个只能对"当前恰好正确的那张表"作答的检查，与一个恒真的检查，
    // 在"它能不能发现错误"上同形。
    const broken = assertEveryRowReachable({
      rows: { 'tool-fs': {}, 'tool-ghost': {} },
      routing: { 'read-file': { rows: ['tool-fs'] } },
    })
    assert.deepEqual([...broken.unreachable], ['tool-ghost'])
    assert.equal(broken.ok, false)
  })

  test('★★★ 授权里被授予的工具 → 推导出 preset 行（而不是手写）', () => {
    const { grant } = employee({ allowedTools: ['read-file', 'run-command'] })
    const cov = coverageOf({ grant })
    assert.deepEqual([...cov.rows], ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-pwsh'],
      '行必须由授权推导：写少了会让员工干不了活，而且不报错')
    assert.equal(cov.complete, true)
  })

  test('★★★ Legion 宿主平面的工具记为 `hosted`，**不是** missing、也不装行', () => {
    const { grant } = employee({
      allowedTools: ['read-file', 'read-secret', 'send-message'],
      allowedCapabilities: ['file:read', 'credential:read', 'message:send'],
    })
    const cov = coverageOf({ grant })
    const hosted = cov.hosted.map((h) => h.toolName).sort()
    assert.deepEqual(hosted, ['read-secret', 'send-message'])
    assert.equal(cov.complete, true, 'hosted 不算缺口：它们在 host 平面，preset 里本来就不该有')
    assert.ok(!cov.rows.includes('tool-secret'), 'preset 里不得出现承载密钥的行')
    for (const h of cov.hosted) assert.ok(typeof h.reason === 'string' && h.reason !== '', 'hosted 必须给出理由')
  })

  test('★★★ 授权里有一个登记表不认识的工具 → **失败**，不静默丢掉', () => {
    const cov = coverageOf({ grant: { allowedTools: ['no-such-tool'], allowedCapabilities: [] } })
    assert.equal(cov.complete, false)
    assert.deepEqual(cov.missing.map((m) => m.toolName), ['no-such-tool'])
    assert.throws(() => render({ allowedTools: ['no-such-tool'], allowedCapabilities: [] }),
      (e) => e.code === EMPLOYEE_PRESET_CODES.TOOL_UNCOVERED)
  })

  test('★★ 清单点名了但授权更窄 → 如实记为 notGranted，且**不**因此装行', () => {
    const { manifest } = employee({ allowedTools: ['read-file', 'git-push'] })
    // 故意把授权收窄
    const cov = coverageOf({ grant: { allowedTools: ['read-file'], allowedCapabilities: ['file:read'] }, allowedTools: manifest.allowedTools })
    assert.deepEqual([...cov.notGranted], ['git-push'])
    assert.ok(!cov.rows.includes('tool-bash'), 'git-push 没被授权，就不该为它装 shell')
  })

  // ── 平面规则 ────────────────────────────────────────────────────────
  test('★★★ 拒绝把任何强制面字段渲染进员工 preset（spec §6.9 line 493）', () => {
    const { grant } = employee()
    for (const field of ['hardFloor', 'denyTools', 'approval', 'sandbox', 'preExecute', 'answerer']) {
      assert.throws(
        () => renderEmployeePreset({
          id: 'legion-emp-test',
          manifest: { employeeId: 'e1', role: 'r', [field]: 'x' },
          grant, persona: '正文',
        }),
        (e) => e.code === EMPLOYEE_PRESET_CODES.ENFORCEMENT_ON_AGENT_PLANE,
        `强制面字段 ${field} 没被拦下`,
      )
    }
  })

  test('★★★ 提示段行不得是强制面组件（名字带 pre-execute/approval/… 一律拒绝）', () => {
    const { manifest, grant } = employee()
    for (const name of ['legion-enforcement-pre-execute', 'dsh-approval', '@x/hard-floor', '@x/tool-guard']) {
      assert.throws(
        () => renderEmployeePreset({
          id: 'legion-emp-test', manifest, grant, persona: '正文',
          promptSections: [{ id: 'x', name }],
        }),
        (e) => e.code === EMPLOYEE_PRESET_CODES.ENFORCEMENT_ON_AGENT_PLANE,
        `${name} 没被拦下`,
      )
    }
  })

  test('★★★ 会发布服务的行**必须**带 isolate realm（否则第二个 session 撞名）', () => {
    const { manifest, grant } = employee()
    assert.throws(
      () => renderEmployeePreset({
        id: 'legion-emp-test', manifest, grant, persona: '正文',
        promptSections: [{ id: 'wf', name: '@deepseek-ai/dsh-tool-workflow', provides: ['workflows'] }],
      }),
      (e) => e.code === EMPLOYEE_PRESET_CODES.SERVICE_WITHOUT_REALM,
    )
    // 带 realm 的就放行
    const ok = renderEmployeePreset({
      id: 'legion-emp-test', manifest, grant, persona: '正文',
      promptSections: [{ id: 'wf', name: '@deepseek-ai/dsh-tool-workflow', provides: ['workflows'], isolate: true }],
    })
    assert.match(ok.text, /dsh-tool-workflow/)
  })

  test('★★★ 拒绝与随部署分发的 preset 撞名（spec §6.9 line 496）', () => {
    const { manifest, grant } = employee()
    for (const id of SHIPPED_PRESET_IDS) {
      assert.throws(
        () => renderEmployeePreset({ id, manifest, grant, persona: '正文' }),
        (e) => e.code === EMPLOYEE_PRESET_CODES.SHIPPED_ID_COLLISION,
        `${id} 是随部署分发的，不该能被覆盖`,
      )
    }
    assert.deepEqual([...SHIPPED_PRESET_IDS].sort(), ['cordis', 'minimal', 'ptc', 'standard'])
  })

  test('★★ preset id 要能当目录名（与 DSH copy() 同一条规则）', () => {
    const { manifest, grant } = employee()
    for (const bad of ['', '-x', 'X', 'a b', 'a/b', '中文', null, 42]) {
      assert.throws(
        () => renderEmployeePreset({ id: bad, manifest, grant, persona: '正文' }),
        (e) => e.code === EMPLOYEE_PRESET_CODES.BAD_ID,
        `id=${JSON.stringify(bad)} 没被拦下`,
      )
    }
    assert.ok(PRESET_ID_PATTERN.test('legion-emp-reader'))
    assert.equal(PRESET_ID_PATTERN.test('legion_emp'), false)
  })

  test('★★ 没有 persona 就抛（不给默认身份）', () => {
    const { manifest, grant } = employee()
    assert.throws(() => renderEmployeePreset({ id: 'legion-emp-test', manifest, grant }),
      (e) => e.code === EMPLOYEE_PRESET_CODES.NO_MANIFEST)
    assert.throws(() => renderEmployeePreset({ id: 'legion-emp-test', manifest, grant, persona: '   ' }),
      (e) => e.code === EMPLOYEE_PRESET_CODES.NO_MANIFEST)
  })

  test('★ 契约与清单侧的对齐（两边都说"不携带强制面"）', () => {
    assert.equal(EMPLOYEE_PRESET_CONTRACT.mayCarryEnforcement, false)
    assert.equal(EMPLOYEE_PRESET_CONTRACT.plane, 'agent')
    assert.equal(EMPLOYEE_PRESET_CHECKED.contract.mayCarryEnforcement, false)
  })

  // ── YAML 生成的正确性 ───────────────────────────────────────────────
  test('★★★ 引号判定按 **YAML 解析规则**，而不是"看起来危不危险"', () => {
    // 必须加引号的
    for (const risky of ['true', 'False', 'null', '~', '123', '1.5', '1e3', ' yes ', '', '  x', 'x  ', '- a', '#c', 'a: b', 'a #b', '中文\n换行']) {
      assert.equal(needsQuoting(risky), true, `${JSON.stringify(risky)} 该加引号却没加`)
    }
    // `@` 是 YAML 的保留指示符：不能作为 plain scalar 的开头。
    // 随部署分发的 `standard` preset 也正是给它们加了引号
    // （`name: '@deepseek-ai/dsh-tool-fs'`）——那是**基准**，不是巧合。
    for (const atPkg of ['@deepseek-ai/dsh-tool-fs', '@x/y']) {
      assert.equal(needsQuoting(atPkg), true, `${atPkg} 以 @ 开头，必须加引号`)
    }
    // 不该加引号的（加了也不错，但会让"按需"这个说法失真）
    for (const safe of ['reader', 'legion-emp-reader', 'process.platform', 'file:read', 'tool-fs']) {
      assert.equal(needsQuoting(safe), false, `${JSON.stringify(safe)} 不该加引号`)
    }
    // 数字/布尔原样输出，不加引号（它们本来就是非字符串）
    assert.equal(yamlScalar(true), 'true')
    assert.equal(yamlScalar(300000), '300000')
    assert.equal(yamlScalar('300000'), "'300000'")
  })

  test('★★★ 单引号里的 `\'` 要转义成 `\'\'`（否则 YAML 直接坏掉）', () => {
    const { manifest, grant } = employee()
    const p = renderEmployeePreset({
      id: 'legion-emp-test', manifest, grant,
      persona: "员工的口号是 '不猜'。",
    })
    assert.match(p.text, /prefix: '员工的口号是 ''不猜''。'/)
  })

  test('★★ 同一份授权渲染两次 → **逐字节相同**（行序固定）', () => {
    const a = render({ allowedTools: ['run-command', 'read-file', 'write-file', 'fetch-url', 'git-push'] })
    const b = render({ allowedTools: ['fetch-url', 'git-push', 'write-file', 'read-file', 'run-command'] })
    assert.equal(a.text, b.text, '行序不固定会让每次渲染都产生一次"变更"')
    assert.equal(a.files['agent.cordis.yml'], b.files['agent.cordis.yml'])
  })

  test('★★ 生成的文本里没有 CRLF（换行符不随平台变）', () => {
    const p = render()
    assert.ok(!p.text.includes('\r'), 'agent.cordis.yml 里出现了 CR — 那会让逐字节比较在不同平台上失败')
    assert.ok(!p.files['preset.yml'].includes('\r'))
  })

  test('★★ preset.yml 有 name 与 description（没有它每个选择器里都会显示裸目录名）', () => {
    const p = render({ role: 'reader' }, { displayName: '读者', description: '只读岗' })
    assert.match(p.files['preset.yml'], /^name: '读者'$/m)
    assert.match(p.files['preset.yml'], /^description: '只读岗'$/m)
  })

  test('★★ 文件头列出了**每一个**被授予工具的去向（读的人能看出少了什么）', () => {
    const p = render({
      allowedTools: ['read-file', 'read-secret'],
      allowedCapabilities: ['file:read', 'credential:read'],
    })
    assert.match(p.text, /read-file — preset 行 tool-fs\+tool-fs-search/)
    assert.match(p.text, /read-secret — host 平面/)
    // 能力按字典序（与工具表头同一个依据，见渲染器里那段"伪变更"的说明）
    assert.match(p.text, /# 能力：credential:read、file:read/)
  })

  // ── 必填 config 必须真的**落到文本上** ────────────────────────────────
  //
  // 这一条是**真挂载套件**（`employee-preset-mount-dsh-process.test.mjs`）
  // 抓到缺口之后补的快速守卫：那个套件需要 `DSH_CHECKOUT` 才能跑，
  // 而这条不需要——所以"有人把那一行 config 删了"在**任何**环境上都会红。
  //
  // 它不替代真挂载：这条只证明"文本里有"，真挂载证明"DSH 认这个文本"。
  //   > 一个"文本里有这一行"的断言，
  //   > 与一个"组合真的挂得上"的断言，
  //   > 在没有 DSH 的那些运行里是同一个东西——只不过前者连缺口的样子都看不见。
  test('★★★ 声明了 config 的行，config 必须**出现在文本里**（不是只写在表里）', () => {
    const p = render({ allowedTools: ['read-file', 'run-command', 'fetch-url'] })
    for (const [key, spec] of Object.entries(DSH_PRESET_ROWS)) {
      if (spec.config === undefined) continue
      // 按**行边界**取，而不是全文找键名：全文找的话，那个键出现在别的行里
      // 也能让断言成立（那样这条就测不到"config 属于哪一行"）。
      const lines = p.text.split('\n')
      const at = lines.indexOf(`- id: ${key}`)
      assert.notEqual(at, -1, `渲染出的 preset 里没有 ${key} 行：${p.text}`)
      let end = at + 1
      while (end < lines.length && !/^- id: /.test(lines[end])) end++
      const block = lines.slice(at, end).join('\n')
      for (const [k, v] of Object.entries(spec.config)) {
        assert.match(block, new RegExp(`^\\s+${k}: ${String(v)}$`, 'm'),
          `${key} 声明了 config.${k}，但渲染出的那一行里没有它：\n${block}`)
      }
    }
  })

  test('★★★★★ `tool-fs-search` 必须带 `sampleOverCapGlobResults`（必填、无兜底、本人踩过）', () => {
    // 这一行是**唯一**一个"漏了它整套组合就挂不上"的 config：DSH 的 schema 是
    // `z.boolean().required()`，README 明说「必填项且没有回退值」；兜底只写在
    // **宿主**行上（`dsh-base` 与三个 shipped preset 各写一次 `false`），
    // 而 preset 里的行**不继承**宿主行的 config。
    //
    // 后果的形状很难看：只要授权含 `read-file`，这个 preset 就挂不上，
    // 而**发现层仍然报它健康**——也就是解析器用例逐字节相同、一挂就炸。
    const p = render({ allowedTools: ['read-file'] })
    const lines = p.text.split('\n')
    const at = lines.indexOf('- id: tool-fs-search')
    assert.notEqual(at, -1)
    let end = at + 1
    while (end < lines.length && !/^- id: /.test(lines[end])) end++
    const block = lines.slice(at, end).join('\n')
    assert.match(block, /^\s+sampleOverCapGlobResults: false$/m, block)

    // 取值必须与**宿主**行一致：这不是我们发明的默认值，是跟着部署已有的选择走。
    // 写死一个数会让"跟着走"退化成"猜一个数"。
    assert.equal(DSH_PRESET_ROWS['tool-fs-search'].config.sampleOverCapGlobResults, false)
  })

  // ── DSH 侧：真 loader ───────────────────────────────────────────────
  guardedDsh('★★★★★ 真 DSH loader 能解析生成的 preset（`!!js` 变成表达式，不是字符串）', async () => {
    const p = render({ allowedTools: ['read-file', 'write-file', 'run-command', 'fetch-url'] })
    const parsed = yaml.load(p.text, { schema: entryListSchema })
    assert.ok(Array.isArray(parsed), 'DSH 的 preset 必须是顶层数组（与补丁层同一条规则）')
    const ids = parsed.map((r) => r.id)
    assert.deepEqual(ids, ['persona', 'tool-fs', 'tool-fs-search', 'tool-bash', 'tool-pwsh', 'tool-web'])
    assert.equal(parsed[0].name, '@deepseek-ai/dsh-persona')
    assert.equal(parsed[0].config.prefix, '你是 Legion 的一个岗位员工。')

    const bash = parsed.find((r) => r.id === 'tool-bash')
    const pwsh = parsed.find((r) => r.id === 'tool-pwsh')
    assert.equal(typeof bash.disabled, 'object', '`!!js` 必须被读成表达式对象')
    assert.equal(typeof bash.disabled.__jsExpr, 'string')
    assert.equal(bash.disabled.__jsExpr, "process.platform === 'win32'")
    assert.equal(pwsh.disabled.__jsExpr, "process.platform !== 'win32'")
    // 平台门是**互补**的，不是同向的——同向会让两个平台各少一半 shell
    assert.notEqual(bash.disabled.__jsExpr, pwsh.disabled.__jsExpr)
  })

  guardedDsh('★★★★★ 生成的 preset 里每一行都指向一个**真的装了**的包', async () => {
    // 一个包名拼错的 preset，在 DSH 挂载时才会报 `Cannot find package`——
    // 而那时它已经是"部署起不来"，不是"渲染错了"。
    const p = render({ allowedTools: ['read-file', 'write-file', 'run-command', 'fetch-url'] })
    const parsed = yaml.load(p.text, { schema: entryListSchema })
    const names = parsed.map((r) => r.name)
    for (const name of names) {
      // `@deepseek-ai/dsh-X` → packages/**/dsh-X/package.json
      assert.ok(name.startsWith('@deepseek-ai/dsh-'), `意外的包名 ${name}`)
    }
    assert.deepEqual(names, [
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tool-web',
    ])
    // 每个包在 DSH 检出里都要有对应的 package.json。
    // ⚠️ 目录名与包名**不同**：包 `@deepseek-ai/dsh-tool-fs` 住在 `packages/fs/tool-fs/`，
    //    目录去掉了 `dsh-` 前缀。第一版直接拿包名当目录名找，于是每一条都"找不到包"——
    //    一个把"我们找错了路径"报成"包不存在"的检查，与一个真的缺包，读数一模一样。
    const { globSync } = await import('node:fs')
    for (const pkg of [...Object.values(DSH_PRESET_ROWS).map((r) => r.pkg), '@deepseek-ai/dsh-persona']) {
      const dir = pkg.replace('@deepseek-ai/', '').replace(/^dsh-/, '')
      const found = globSync(`packages/**/${dir}/package.json`, { cwd: DSH })
      assert.ok(found.length > 0, `DSH 检出里找不到包 ${pkg}（找过 packages/**/${dir}/package.json）`)
      // 而且那个 package.json 里的 name 必须**就是**我们要的包名
      const meta = JSON.parse(readFileSync(join(DSH, found[0]), 'utf8'))
      assert.equal(meta.name, pkg, `目录 ${found[0]} 里的包名是 ${meta.name}，不是 ${pkg}`)
    }
  })

  guardedDsh('★★★ 引擎产出的包名与 `standard` preset 里用的**逐字相同**', async () => {
    // 不能凭记忆写包名。`standard` 是随部署分发的那一份，拿它当基准。
    const standard = readFileSync(join(DSH, 'packages', 'preset', 'agent-presets', 'presets', 'standard', 'agent.cordis.yml'), 'utf8')
    for (const spec of Object.values(DSH_PRESET_ROWS)) {
      assert.ok(standard.includes(`'${spec.pkg}'`),
        `我们在用 ${spec.pkg}，但随部署分发的 standard preset 里没有它——` +
        '要么包名写错了，要么这个包不是 DSH 随部署提供的那一套')
    }
  })
})

// ── 安装 ────────────────────────────────────────────────────────────────
describe('PRT-214 员工 preset 安装', () => {
  test('★★★ 写到 presetRoot/<id>/ 下，两个文件都在', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'legion-preset-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const p = render()
    const out = await installEmployeePreset({ presetRoot: root, preset: p })
    assert.equal(out.dir, join(root, 'legion-emp-test'))
    assert.equal(out.files.length, 2)
    assert.equal(readFileSync(join(root, 'legion-emp-test', 'agent.cordis.yml'), 'utf8'), p.text)
    assert.match(readFileSync(join(root, 'legion-emp-test', 'preset.yml'), 'utf8'), /^name: /m)
  })

  test('★★★ 不猜路径：没给 presetRoot 就抛', async () => {
    const p = render()
    for (const root of [undefined, null, '', '   ']) {
      await assert.rejects(() => installEmployeePreset({ presetRoot: root, preset: p }),
        (e) => e.code === EMPLOYEE_PRESET_CODES.NO_ROOT,
        `presetRoot=${JSON.stringify(root)} 没被拦下`)
    }
  })

  test('★★★ 安装器**不会**往随部署分发的目录里写（即使有人手工造了个假 preset 对象）', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'legion-preset-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    // 绕过 renderEmployeePreset 直接造一个 id 是 standard 的对象
    const forged = { id: 'standard', files: { 'agent.cordis.yml': '- id: x\n', 'preset.yml': 'name: x\n' } }
    await assert.rejects(() => installEmployeePreset({ presetRoot: root, preset: forged }),
      (e) => e.code === EMPLOYEE_PRESET_CODES.SHIPPED_ID_COLLISION)
    assert.equal(existsSync(join(root, 'standard')), false, '拒绝之后不得留下任何目录')
  })

  test('★★★ 可重复安装（第二次覆盖同一目录，不报错）', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'legion-preset-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const p = render()
    await installEmployeePreset({ presetRoot: root, preset: p })
    await installEmployeePreset({ presetRoot: root, preset: p })
    assert.equal(readFileSync(join(root, 'legion-emp-test', 'agent.cordis.yml'), 'utf8'), p.text)
  })

  test('★★ 形状不对的 preset 对象被拦下', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-preset-'))
    try {
      for (const bad of [undefined, null, 'x', {}, { id: 'x' }]) {
        await assert.rejects(() => installEmployeePreset({ presetRoot: root, preset: bad }),
          (e) => e.code === EMPLOYEE_PRESET_CODES.NO_MANIFEST,
          `preset=${JSON.stringify(bad)} 没被拦下`)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

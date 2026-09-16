// runtime/dsh-composition/run-floor.test.mjs
// ============================================================================
// PRT-214 缺口①：一次 Run 的**静态 hard floor** 从控制面走到执行面的那一截，
// 落到真 DSH `ToolRuntime` 上之后**到底拦不拦得住**。
//
// ## 这一套件要回答的唯一问题
//
//   > 同一个长命 Runtime 进程里连着两次 Run、各带**不同**的下限时，
//   > 第二次的工具调用，是被**第一次**的规则判的，还是被**它自己**的规则判的？
//
// 这个问题在"只有一个 Run"的用例里**没有答案**——两次读数是同一个：
//
//   > 一个「用第一次 Run 的下限服务所有 Run」的实现，
//   > 与一个「每次 Run 都按这次的下限拒绝」的实现，
//   > 在只有一个 Run 的那些用例里是同一个东西——
//   > 只不过前者会让第二个 Run 继承第一个 Run 的规则。
//
// 所以 §4 用**两个作用域、两份下限、同一个工具名**来读它：
// 甲的下限禁 `alpha`、乙的下限禁 `beta`；然后交叉执行。
// 甲作用域里 `beta` 必须跑得起来（它没被甲的规则禁），
// 乙作用域里 `alpha` 必须跑得起来（它没被乙的规则禁）——
// **只有当两份下限真的按 Run 分开时，这两条才同时成立**。
//
// ## ★ 承重的读数为什么是"另一个作用域里它跑起来了"
//
// "本作用域拒绝"这一条，在一个把下限装成**全局** guard 的实现上也是绿的
// （全局 guard 会拒绝一切作用域）。加一条"另一个作用域里同一个工具被拒"，
// 也不足以区分——把两份下限**拼在一起**装成全局 guard 同样满足。
//
// 唯一分得开的是**交叉项**：甲的规则不许外溢到乙、乙的规则不许外溢到甲。
// 两条都真，才等于"下限是跟着 Run 走的"。
//
// ## ★ 为什么 pre-execute 那一侧要用"下游门有没有被试过"来读
//
// spec §6.8 `:456` 要求下限在 `tools/pre-execute` 上**提前拒绝**（避免无效询问），
// 而瀑布是"谁先返回非 `next()` 谁认领"（`cordis/lib/index.js:317-325`）。
// Legion 的策略门是在启动期注册的；若本模块的 listener 排在它**后面**，
// 一个注定被下限拒绝的调用会**先**进策略门（被问一次人）才被拒。
//
//   > 一个"下限排在策略门之后"的实现，
//   > 与一个"下限排在策略门之前"的实现，在**没有任何动态门**的用例里是同一个东西——
//   > 只不过前者会让每一次注定被拒的调用都多走一次审批。
//
// 所以 §5 在同一个 ctx 上另注册一个**计数用的**动态门（默认 `prepend: false`），
// 再让下限拒绝那个调用：计数器必须是 0。
//
// ## 没有 DSH_CHECKOUT 时整组 SKIP
//
// 与 `pre-execute.test.mjs` 同一纪律：**外部宿主测试不伪造通过**。
// 跳过是"这一次没跑"，不是"跑过了"。纯函数的那些用例（§1–§3）不需要检出，照跑。
// ============================================================================

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'

import {
  RUN_FLOOR_INSTALL_CHECKED,
  RUN_FLOOR_INSTALL_CODES,
  RUN_FLOOR_INSTALL_VERSION,
  RUN_FLOOR_PORT_STATES,
  RUN_FLOOR_SURFACES,
  createRunFloorInstallation,
  installRunFloorIntoAgent,
  readRunFloorPortPayload,
  runFloorCarrierOf,
  runFloorInstalledOn,
  runFloorOptionOf,
  withRunFloorCarrier,
} from './run-floor.mjs'
import { RUN_FLOOR_CODES, RUN_FLOOR_STATES } from '../contracts/run-floor.mjs'
import {
  HIGH_RISK_TOOL_NAMES,
  KNOWN_TOOL_NAMES,
  PRE_WIRING_HARD_FLOOR,
  RISK_RANK,
  TOOL_CATALOG,
} from './tool-capability.mjs'
// ★ 名字空间那一条读数的来源：Legion 工具名的映射住在 `employee-preset.mjs`
//   （`LEGION_TOOL_ROUTING`），而它到底落到哪些**执行面**工具名由 `dshToolNamesOf()`
//   算出来。用例里不抄一份映射——抄一份的用例在映射改了之后仍然绿。
import { LEGION_TOOL_ROUTING, dshToolNamesOf } from './employee-preset.mjs'

const DSH = process.env.DSH_CHECKOUT ?? null
const CORDIS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
const TOOLS = DSH === null ? null : join(DSH, 'packages', 'core', 'tools', 'lib', 'index.js')
const SCOPE = DSH === null ? null : join(DSH, 'packages', 'core', 'scope', 'lib', 'index.js')

let Context = null
let ToolRuntime = null
let defineContentToolFixture = null
let createScope = null
if (DSH !== null && existsSync(CORDIS) && existsSync(TOOLS) && existsSync(SCOPE)) {
  ;({ Context } = await import(pathToFileURL(CORDIS).href))
  ;({ ToolRuntime, defineContentToolFixture } = await import(pathToFileURL(TOOLS).href))
  ;({ createScope } = await import(pathToFileURL(SCOPE).href))
}

const NO_RUNTIME = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CORDIS) || !existsSync(TOOLS)
    ? 'DSH 检出里找不到 cordis / dsh-tools 构建产物'
    : !existsSync(SCOPE)
      ? 'DSH 检出里找不到 dsh-scope 构建产物'
      : false

const guarded = (name, fn) => test(name, async (t) => {
  if (NO_RUNTIME !== false) return t.skip(`SKIP：${NO_RUNTIME}`)
  return fn(t)
})

const LINUX = { platform: 'linux' }
const floorOf = (over = {}) => ({
  denyTools: [], denyPathPrefixes: [], platform: LINUX.platform, cwd: '/work', ...over,
})

/** 一份"有下限"的端口载荷。 */
const installedPort = (floor) => ({ state: RUN_FLOOR_PORT_STATES.INSTALLED, floor })
/** 一份"带告诫的有下限"端口载荷（PRT-214 续：告诫是**成功派生**那一档的读数）。 */
const installedPortWith = (floor, notices) => ({
  state: RUN_FLOOR_PORT_STATES.INSTALLED, floor, notices,
})
/** 一份"没有下限"的端口载荷。 */
const absentPort = () => ({ state: RUN_FLOOR_PORT_STATES.ABSENT })

// ═══════════════════════════════════════════════════════ §1 形状与三种处境

describe('PRT-214 run-floor（纯判定，不需要 DSH 检出）', () => {
  test('★ 缺席与空下限是**两个**状态，不是一个（缺席拒绝一切，空下限放行一切）', () => {
    const absent = createRunFloorInstallation(absentPort())
    const empty = createRunFloorInstallation(installedPort(floorOf()))

    assert.equal(absent.state, RUN_FLOOR_STATES.ABSENT)
    assert.equal(empty.state, RUN_FLOOR_STATES.INSTALLED)
    assert.notEqual(absent.state, empty.state,
      '两者同态 ⇒ "这次没有东西要禁止"与"这次根本没有下限"在读数上再也分不开')

    // 承载差异的读数是**同一个调用的判定**。空下限放行一切（它是一句"没有东西要禁止"）；
    // 缺席拒绝一切（spec §6.8:479 的发布前姿态，理由见 run-floor.mjs 的函数头）。
    //
    //   > 一个「拿 Legion 的能力名去比对执行面的工具名」的下限，
    //   > 与一个「名字空间对得上、于是真的拦住了高风险工具」的下限，
    //   > 在用例只喂 Legion 名字的那些日子里是同一个东西（手写的 probe 都能被拒）——
    //   > 只不过真工具名进来时，前者一个都拦不住，却在摘要里看起来在执行 §6.8:479。
    //
    // 所以"高风险被拒"那一半**不是**判别项（"按 Legion 能力名禁九个"的实现也能让它绿）。
    // 判别项在下面那条**多族名字**的用例里：真 DSH 名与名单外的名字。
    const risky = { name: 'delete-file', arguments: {} }
    const safe = { name: 'write-file', arguments: { path: '/work/a.txt' } }
    assert.equal(empty.guard(safe), undefined, '空下限必须放行——它是一句"没有东西要禁止"')
    assert.equal(empty.guard(risky), undefined, '空名单里没有 delete-file ⇒ 空下限放行它')
    assert.equal(typeof absent.guard(safe), 'string', '缺席必须拒掉低风险的 Legion 能力名')
    assert.equal(typeof absent.guard(risky), 'string', '缺席必须拒掉高风险的 Legion 能力名')

    // 拒绝理由要能让审计分清"发布前姿态 + 名字空间对不上"与"读不懂这份下限"。
    assert.match(absent.guard(risky), /delete-file/, '理由必须点名被拒的那个调用')
    assert.match(absent.guard(risky), new RegExp(RUN_FLOOR_CODES.NOT_SUPPLIED))
    assert.match(absent.guard(risky), /6\.8:479/, '理由必须点出这是 spec §6.8:479 的发布前姿态')
    assert.match(absent.guard(risky), /工具名/, '理由必须说清它比的是执行面的工具名')
    assert.equal(absent.code, RUN_FLOOR_CODES.NOT_SUPPLIED)
    assert.equal(empty.code, null)
    // ★ `denyTools: 0` 是**读数而不是判定**：这一档拒不拒绝与名字无关，
    //   而一份名字名单永远表达不出"拒绝一切"。把它读成"0 个禁止 ⇒ 没事发生"
    //   正是这一批修掉的那个错。
    assert.equal(absent.denyTools, 0, '缺席没有一份名字名单；判定不是从名单来的')
    assert.equal(absent.denyPathPrefixes, 0)
  })

  test('★★★ 缺席拒绝**每一族**名字：Legion 高风险 / Legion 低中风险 / 真 DSH 名 / 名单外的名字', () => {
    const absent = createRunFloorInstallation(absentPort())
    // 四族名字是**四个不同的读数**：
    //   · Legion 高风险名 —— 只有它时，"按 Legion 名单禁"也绿（那正是这一批修掉的）；
    //   · Legion 低/中风险名 —— "按 Legion 名单禁"会**放行**它们；
    //   · 真 DSH 工具名 —— 与两个 Legion 名单都不同名，名字名单一个都命不中；
    //   · 哪个名单里都没有的名字 —— 名字名单**不可能**提供这个性质（不在名单里一律放行）。
    const families = [
      ['Legion 高风险能力名', [...HIGH_RISK_TOOL_NAMES]],
      ['Legion 低/中风险能力名', ['read-file', 'write-file', 'git-status', 'fetch-url', 'call-external-api']],
      ['真 DSH 工具名', ['write', 'read', 'edit', 'pwsh', 'bash', 'glob', 'grep', 'web_fetch', 'read_image', 'web_search']],
      ['哪个名单里都没有的名字', ['dsh-name-in-no-legion-list', 'os.system', 'rm -rf /']],
    ]
    for (const [label, names] of families) {
      assert.ok(names.length > 0)
      for (const name of names) {
        assert.equal(typeof absent.guard({ name, arguments: {} }), 'string',
          `缺席放行了${label} ${name} —— 这一档必须是"拒绝一切"：名字名单不是 fail closed 的`)
      }
    }
  })

  test('★★★ 名字空间：`absent` 拒的是**任何**名字，而不是某个 Legion 名单（防"看起来在执行"）', () => {
    const absent = createRunFloorInstallation(absentPort())
    // ① 高风险能力名 → 执行面工具名的**映射读数**：只有 shell 那一对。
    //    这一条同时钉住"六个宿主平面能力没有执行面名字"与"三个能力共塌在两个名字上"。
    const mapped = dshToolNamesOf(HIGH_RISK_TOOL_NAMES)
    assert.deepEqual([...mapped], ['bash', 'pwsh'],
      '高风险能力名映射出来的执行面名字变了 —— 名字空间的结论要跟着重读')
    const hosted = HIGH_RISK_TOOL_NAMES.filter((n) => LEGION_TOOL_ROUTING[n]?.hosted === true)
    assert.equal(hosted.length, 6,
      '九个高风险能力里应当有六个是宿主平面能力（根本没有执行面工具名）')
    // 低风险的 git-status 与三个高风险 git/shell 能力**共用**同一对名字 ⇒
    // 按名字禁表达不出"禁高风险、放低风险"这个粒度。
    for (const name of mapped) {
      assert.equal(LEGION_TOOL_ROUTING['git-status'].dshTools.includes(name), true)
      for (const n of ['run-command', 'git-commit', 'git-push']) {
        assert.equal(LEGION_TOOL_ROUTING[n].dshTools.includes(name), true)
      }
    }
    // ② 判定**不来自名单**：报告出来的名单长度是 0，而它照样拒绝。
    //    把 `denyTools` 当执行机构读的实现会在这里说"0 个禁止 ⇒ 没事发生"。
    assert.equal(absent.denyTools, 0, '这一档一旦报出一份名单，就会有人以为判定是那份名单')
    // ③ 映射出来的真 DSH 名与一个**任何 Legion 名单里都没有**的名字都被拒。
    for (const name of [...mapped, 'a-dsh-name-that-is-not-in-any-legion-list']) {
      assert.equal(typeof absent.guard({ name, arguments: {} }), 'string',
        `缺席放行了 ${name} —— 那说明它的判定其实是一份名字名单，而不是"拒绝一切"`)
    }
  })

  test('★★ 映射缺口**留在记录里**：denyTools＝Legion 高风险名单时，真 DSH 名 `pwsh` 被**放行**', () => {
    // 这一条**故意**断言一个"坏"读数，因为它是真的、而且是这一批修正的理由：
    // `HIGH_RISK_TOOL_NAMES` 写的是 Legion 能力名，`createHardFloorGuard()` 比的是
    // 执行面工具名，两个空间不相交。若有人把这份名单直接当 `denyTools` 装，
    // 拒绝集就是空集——这条用例把那个事实钉住，免得它被"绿了就等于在生效"盖过去。
    const legionList = createRunFloorInstallation(installedPort(floorOf({
      denyTools: [...HIGH_RISK_TOOL_NAMES],
    })))
    // Legion 名字空间里它"看起来在执行"：名单命中了。
    assert.match(legionList.guard({ name: 'delete-file', arguments: {} }), /delete-file/)
    // 执行面名字空间里，同一个能力真正映射到的工具名**不在名单上** ⇒ 放行。
    assert.equal(legionList.guard({ name: 'pwsh', arguments: {} }), undefined,
      '如果这一条变红，说明两个名字空间被接上了；接上之前，按这份名单禁就是没禁')
    assert.equal(legionList.guard({ name: 'bash', arguments: {} }), undefined)
    assert.equal(legionList.guard({ name: 'read', arguments: {} }), undefined,
      '连低风险能力的执行面名字都被放行 —— 这份名单连"禁高风险"都做不到')
  })

  test('★★★ 单源：发布前姿态的名单就是登记表算出来的那一份（不是抄的九个名字）', () => {
    // ★ 承重的那一条是**引用相等**，不是深相等：深相等在两个数组"今天恰好一样"
    //   的那些日子里也成立，而它会在有人往登记表加一个高风险工具、
    //   却没想到要改这里的那一天安静地少一项。
    assert.equal(PRE_WIRING_HARD_FLOOR.denyTools, HIGH_RISK_TOOL_NAMES,
      '发布前姿态的名单不是登记表算出来的那**一个数组对象**：它开始就是一份会漂移的副本')
    // 名单的**内容**：每一条都必须真的是高风险（`risk >= high`）。
    for (const name of PRE_WIRING_HARD_FLOOR.denyTools) {
      const tool = TOOL_CATALOG[name]
      assert.notEqual(tool, undefined, `名单里的 ${name} 不在登记表里`)
      assert.ok(RISK_RANK[tool.risk] >= RISK_RANK.high,
        `名单里的 ${name} 风险是 ${tool.risk}，够不上 high —— 一条低于高风险的静态禁令会把低风险工作也禁掉`)
    }
    // 反向：至少有一个**已知**工具被排除在外。没有这一条，一份"把 14 个全禁掉"
    // 的名单也能让上面每一条断言绿——而那份名单就不再是"高风险"这一档的读数。
    // ⚠️ 这一条钉的是**数据**（`HIGH_RISK_TOOL_NAMES` 是不是"高风险及以上"那一档），
    //    不是"缺席那一档拦什么"：那份判定在 run-floor.mjs 里是"拒绝一切"，
    //    与这份名单无关（名字空间不相交，见 tool-capability.mjs 的注释）。
    const excluded = KNOWN_TOOL_NAMES.filter((n) => !PRE_WIRING_HARD_FLOOR.denyTools.includes(n))
    assert.ok(excluded.length > 0, '这一组把登记表里的**每一个**工具都算了进来 ⇒ 它不再是"高风险"这一档')
    // ★ 完整性：名单必须**正好**是"高风险及以上"那一档，不是它的一部分。
    //   只写"名单里的都 ≥ high"是不够的：一份**只剩 critical 四个**的名单同样满足它
    //   （那四个本来就 ≥ high），于是 `run-command` / `read-secret` / `send-message` /
    //   `mcp-invoke` / `git-commit` 会在没人察觉的情况下**变回放行**——
    //   而 §6.8:479 要禁的正是这九个。所以两档各点几个名，两个方向都钉。
    const mustInclude = ['delete-file', 'run-command', 'git-commit', 'git-push', 'mcp-invoke',
      'read-secret', 'write-secret', 'send-message', 'post-external-api']
    for (const name of mustInclude) {
      const tool = TOOL_CATALOG[name]
      assert.ok(HIGH_RISK_TOOL_NAMES.includes(name),
        `高风险名单里没有 ${name}（登记表里的风险是 ${tool?.risk}）——`
        + '少一个就是一条会放行它的静态禁令，而 §6.8:479 要禁的是**九个**')
    }
    // 反方向：低 / 中风险的已知工具**一个都不许**混进来（混进来就是把安全的工作也禁掉）。
    for (const name of ['read-file', 'git-status', 'write-file', 'fetch-url', 'call-external-api']) {
      assert.equal(RISK_RANK[TOOL_CATALOG[name].risk] >= RISK_RANK.high, false,
        `这条断言的前提错了：${name} 不该是高风险`)
      assert.equal(HIGH_RISK_TOOL_NAMES.includes(name), false,
        `${name} 是 ${TOOL_CATALOG[name].risk} 风险，却被放进了静态禁令——发布前姿态只禁高风险`)
    }
    // 名单不许空，也不许被冻结成"改不动"以外的别的形状。
    assert.equal(Object.isFrozen(HIGH_RISK_TOOL_NAMES), true)
    assert.equal(Object.isFrozen(PRE_WIRING_HARD_FLOOR), true)
    assert.deepEqual([...PRE_WIRING_HARD_FLOOR.denyPathPrefixes], [],
      '发布前姿态只禁工具名；前缀那一族是空的（guard 只在还有前缀时才去读 cwd，见 tool-capability.mjs）')
  })

  test('★ 装载期自检读的是**算出来的产物**，不是一个布尔', () => {
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.version, RUN_FLOOR_INSTALL_VERSION)
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.absentState, RUN_FLOOR_STATES.ABSENT)
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.emptyFloorState, RUN_FLOOR_STATES.INSTALLED)
    // ★ 缺席那一档的读数只朝一个方向：它必须拒掉一个**真 DSH 工具名**
    //   （`write`），也必须拒掉一个**不在任何 Legion 名单里**的名字。
    //   只读前者的话，一个"按 Legion 能力名名单禁"的实现照样绿——
    //   而那正是这一批修掉的那个读数（那份名单一个真工具名都拦不住）。
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.absentDeniesProbe, true)
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.absentDeniesUnlistedProbe, true)
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.absentDenyTools, 0, '自检里的名单长度必须是 0：判定不是从名单来的')
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.emptyFloorAllowsProbe, true)
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.refusedDeniesProbe, true)
    assert.equal(RUN_FLOOR_INSTALL_CHECKED.absentGuardCode, RUN_FLOOR_CODES.NOT_SUPPLIED)
  })

  test('★★ 解释不了的载荷**具名**拒绝，且每一种修法不同', () => {
    const cases = [
      [{ state: 'nope' }, RUN_FLOOR_INSTALL_CODES.UNKNOWN_STATE],
      [null, RUN_FLOOR_INSTALL_CODES.NOT_AN_OBJECT],
      [[], RUN_FLOOR_INSTALL_CODES.NOT_AN_OBJECT],
      ['installed', RUN_FLOOR_INSTALL_CODES.NOT_AN_OBJECT],
      [{ state: 'installed', floor: floorOf(), extra: 1 }, RUN_FLOOR_INSTALL_CODES.UNKNOWN_KEY],
      [{ state: 'installed' }, RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR],
      [{ state: 'installed', floor: { denyTools: 'rm' } }, RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR],
      [{ state: 'absent', floor: floorOf() }, RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR],
    ]
    for (const [payload, code] of cases) {
      const reading = readRunFloorPortPayload(payload)
      assert.equal(reading.state, RUN_FLOOR_STATES.REFUSED,
        `${JSON.stringify(payload)} 没被拒 —— 一条坏载荷照跑，就是把"派生失败"洗成"这次没有东西要禁止"`)
      assert.equal(reading.code, code, `${JSON.stringify(payload)} 的码应当是 ${code}`)
    }
  })

  test('★★★ 闭集里**每个**码都有产生者，且产生者都在闭集里（两个方向都要钉）', () => {
    // 前半：声明了却产生不了的码会让读者以为查过了（本模块**实测**过一次：
    //       `NOT_AN_IN_PROCESS_CHILD` 曾经在这一层声明，而那个条件由端口那一层先判掉，
    //       于是它永远产生不了——所以它被删掉，而不是留着"以备将来"）。
    // 后半：产生了一个不在闭集里的码，就是一处没有名字的归因。
    const produced = new Set([
      readRunFloorPortPayload({ state: 'nope' }).code,
      readRunFloorPortPayload(null).code,
      readRunFloorPortPayload([]).code,
      readRunFloorPortPayload('installed').code,
      readRunFloorPortPayload({ state: 'installed', floor: floorOf(), extra: 1 }).code,
      readRunFloorPortPayload({ state: 'installed' }).code,
      readRunFloorPortPayload({ state: 'installed', floor: { denyTools: 'rm' } }).code,
      readRunFloorPortPayload({ state: 'absent', floor: floorOf() }).code,
    ])
    const declared = new Set(Object.values(RUN_FLOOR_INSTALL_CODES))
    // 另外三个码是 `installRunFloorIntoAgent` 在**装**的时候抛的，不在载荷判定里：
    // 它们各有自己的用例（见下一组），所以这里显式认领，而不是让它们看起来"死了"。
    const atInstallTime = new Set([RUN_FLOOR_INSTALL_CODES.NO_AGENT_CONTEXT,
      RUN_FLOOR_INSTALL_CODES.NO_GUARD_SEAM, RUN_FLOOR_INSTALL_CODES.NO_EVENT_SEAM])
    for (const code of atInstallTime) {
      assert.ok(declared.has(code))
      assert.equal(produced.has(code), false, '这三个码来自安装期，不该出现在**载荷**判定的产出里')
    }
    const dead = [...declared].filter((c) => !produced.has(c) && !atInstallTime.has(c))
    assert.deepEqual(dead, [], `这些码没有任何代码会产生（它们只会让读者以为那个条件查过了）：${dead.join(', ')}`)
    for (const code of produced) {
      assert.ok(declared.has(code), `产生了一个不在闭集里的码：${code}`)
    }
    assert.equal(produced.size + atInstallTime.size, declared.size,
      '闭集的划分必须正好盖满：新增一个码就要同时把它归到"载荷判定"还是"安装期"')
  })

  test('★★ 解释不了时得到的是**拒绝一切**的 guard，不是空下限（也不是"按高风险禁"）', () => {
    const bad = createRunFloorInstallation({ state: 'nope' })
    assert.equal(bad.state, RUN_FLOOR_STATES.REFUSED)
    // ★ 这里读的是"低风险工具也被拒"：`write-file` 是高风险的**反面**。
    //   若这一档改成"按高风险禁"，本条立刻红——而这正是它必须与缺席分开的理由：
    //   读不懂的载荷连"哪些是高风险的"都不知道，猜一个"按高风险禁"是假装读懂了。
    for (const name of ['write-file', 'read-file', 'delete-file', 'anything_at_all']) {
      assert.equal(typeof bad.guard({ name, arguments: {} }), 'string',
        `坏载荷下 ${name} 被放行了 —— 这正是"派生失败"退化成"没有东西要禁止"的那一步`)
    }
    // 空的 denyTools/denyPathPrefixes 是读数，不是判定：它必须与"拒绝一切"分开。
    assert.equal(bad.denyTools, 0)
    assert.equal(bad.denyPathPrefixes, 0)
    assert.equal(createRunFloorInstallation(installedPort(floorOf())).denyTools, 0)
    // 解释不了的拒绝理由里带着**那个码**："读不懂"与"没给"在审计里是两句不同的话。
    assert.match(bad.guard({ name: 'write-file', arguments: {} }), /RUN_FLOOR_INSTALL_UNKNOWN_STATE/)
    assert.doesNotMatch(bad.guard({ name: 'write-file', arguments: {} }), /6\.8:479/,
      '读不懂的载荷不许被描述成"按 §6.8:479 的发布前姿态"——那不是这个处置')
  })

  test('★ 下限的判定逻辑来自 enforcement.mjs（工具名与路径前缀两族都通）', () => {
    const byName = createRunFloorInstallation(installedPort(floorOf({ denyTools: ['rm_rf'] })))
    assert.match(byName.guard({ name: 'rm_rf', arguments: {} }), /rm_rf/)
    assert.equal(byName.guard({ name: 'read_file', arguments: {} }), undefined)

    const byPath = createRunFloorInstallation(installedPort(floorOf({
      denyPathPrefixes: ['/work/secret'],
    })))
    assert.match(byPath.guard({ name: 'write_file', arguments: { path: '/work/secret/keys.txt' } }), /\/work\/secret/)
    assert.equal(byPath.guard({ name: 'write_file', arguments: { path: '/work/public/a.txt' } }), undefined)
  })

  test('★★ 载体按**对象身份**配对：端口选项上的键不串台', () => {
    const a = { state: RUN_FLOOR_PORT_STATES.ABSENT }
    const b = { state: RUN_FLOOR_PORT_STATES.INSTALLED, floor: floorOf({ denyTools: ['rm_rf'] }) }

    // 适配器交出去的形状：端口选项上带 `enforcementFloor`（Legion 自己的端口契约）。
    const optsA = withRunFloorCarrier({ label: 'a', enforcementFloor: a }, a)
    const optsB = withRunFloorCarrier({ label: 'b', enforcementFloor: b }, b)

    assert.equal(runFloorOptionOf({ label: 'a', enforcementFloor: a }), a,
      '端口读到的必须是**同一个对象**——按身份配对就建立在这一点上')
    assert.equal(runFloorOptionOf(optsA), a)
    assert.equal(runFloorOptionOf(optsB), b)
    assert.notEqual(runFloorOptionOf(optsA), runFloorOptionOf(optsB))

    // 原来那层 options 不被就地改写：端口"读到了什么"与适配器"交出去了什么"要能分别断言。
    const original = { label: 'a', enforcementFloor: a }
    const carried = withRunFloorCarrier(original, a)
    assert.equal('agentOptions' in original, false, 'withRunFloorCarrier 就地改了调用方的对象')
    assert.deepEqual(Object.keys(carried).sort(), ['agentOptions', 'enforcementFloor', 'label'])

    // 引擎那一侧：载体挂在 `agentOptions` 上，且是**那个对象本身**。
    assert.equal(runFloorCarrierOf({ id: 'child', options: carried.agentOptions }), a)

    // 一个**没有**载体键的选项：读出来必须是 undefined（"这次 Run 没有下限"），
    // 而不是空下限、不是 {}、也不是别的什么东西。
    assert.equal(runFloorOptionOf({ label: 'legacy' }), undefined)
    assert.equal(runFloorOptionOf(null), undefined)
    // `resolveChildAgentOptions()` 只逐字段取 provider/model/…（不是整体浅拷贝），
    // 所以父级不会"继承"到子级的载体——这里用同形的摊开模拟它。
    const parentOptions = { provider: 'p' }
    assert.equal(runFloorCarrierOf({ id: 'parent', options: parentOptions }), undefined)
    assert.equal(runFloorCarrierOf({ id: 'parent', options: { ...parentOptions, ...carried.agentOptions } }), a)
  })

  test('★ 两个面是有名字的：pre-execute 与 guard', () => {
    assert.deepEqual([...RUN_FLOOR_SURFACES], ['tools/pre-execute', 'tools.guard'])
  })

  // ── 告诫（notices）：PRT-214 续 ─────────────────────────────────────────
  //
  // 这一组的判据不是"能不能把一条告诫从端口搬到安装读数上"——那是个赋值。
  // 它盯的是 step-1 那条裁决「接受连带禁止，但**必须记录**」真正落地的那一环：
  //
  //   > 一条产生了、单测锁了、而**生产里没有任何人读**的告诫，
  //   > 与一条根本没产生的告诫，在库里和日志里是同一个东西。
  //
  // 所以下面每一条都落在一个**能被读到的出口**上（安装读数的 `notices`、
  // 或 `log` 口真的收到了那条文本），而不是落在"字段等于某个值"上。
  //
  // ★ 这里的码写成**字面量**，不 import `team-hub/run-floor.mjs` 的
  //   `RUN_FLOOR_NOTICE_CODES`。那不是省事：`runtime/ → team-hub/` 是本仓库
  //   **零处**的反向依赖（`enforcement-mapping.mjs:101` 为它写过理由），
  //   而安装点确实**不需要**认识 Legion 的告诫词表——它只把跨线来的码原样打印。
  //   所以"这一层不认识那些码"是**要被钉住的事实**，不是一处待还的技术债：
  //   真 import 进来，`runtime/` 就绑上了控制面的词表，而那份词表是会长的东西。
  const NOTICE_COLLATERAL = 'run-floor-collateral-denial'

  test('★★ 告诫从端口一路走到安装读数的 `notices`（收到它的人在这里）', () => {
    const notice = {
      code: NOTICE_COLLATERAL,
      tool: 'git-push',
      message: '为了在执行面上禁掉「git-push」，必须禁掉 ["bash","pwsh"]',
      dshTools: ['bash', 'pwsh'],
      collateral: ['run-command', 'git-status', 'git-commit'],
    }
    const installation = createRunFloorInstallation(
      installedPortWith(floorOf({ denyTools: ['bash', 'pwsh'] }), [notice]))
    assert.equal(installation.state, RUN_FLOOR_STATES.INSTALLED)
    assert.equal(installation.notices.length, 1, '告诫没有跟着下限一起被造出来')
    assert.equal(installation.notices[0].code, NOTICE_COLLATERAL)
    assert.equal(installation.notices[0].tool, 'git-push')
    assert.deepEqual([...installation.notices[0].dshTools], ['bash', 'pwsh'])
    assert.deepEqual([...installation.notices[0].collateral], ['run-command', 'git-status', 'git-commit'])
    assert.equal(Object.isFrozen(installation.notices), true)
    assert.equal(Object.isFrozen(installation.notices[0]), true)
  })

  test('★★ `log` 口**真的**收到那条告诫——这是它的生产消费者', () => {
    // 这条用例是整组的重点：断言落在"有没有人读到"上，而不是"字段在不在"上。
    const lines = []
    const installation = createRunFloorInstallation(installedPortWith(
      floorOf({ denyTools: ['bash', 'pwsh'] }),
      [{
        code: NOTICE_COLLATERAL,
        tool: 'git-push',
        message: '为了禁掉推送，整个 shell 会被禁',
        dshTools: ['bash', 'pwsh'],
        collateral: ['git-commit'],
      }],
    ))
    // 用最小的假 agent（这一条只测 `log` 口，不需要真 ToolRuntime）。
    const install = installRunFloorIntoAgent({
      agent: { id: 'agent-a', ctx: { tools: { guard: () => () => {} }, on: () => () => {} } },
      installation,
      log: (s) => lines.push(s),
    })
    assert.equal(install.state, RUN_FLOOR_STATES.INSTALLED)
    // ① 状态行仍然在（没被告诫挤掉）。
    assert.equal(lines.filter((l) => l.includes('已把这次 Run 的下限装到')).length, 1)
    // ② 告诫**单独占一行**，而且带着码、工具名与那句人话。
    const noticeLines = lines.filter((l) => l.includes(NOTICE_COLLATERAL))
    assert.equal(noticeLines.length, 1, `告诫没有被打印出来：${JSON.stringify(lines)}`)
    assert.ok(noticeLines[0].includes('git-push'), '告诫那一行没点名是哪个工具')
    assert.ok(noticeLines[0].includes('为了禁掉推送'), '告诫那一行丢了派生点写的原话')
    assert.ok(noticeLines[0].includes('bash'), '告诫那一行没说执行面上禁了哪些名字')
    assert.ok(noticeLines[0].includes('git-commit'), '告诫那一行没说连带禁了哪些 Legion 工具')
    // ③ 结构化读数也可取（`log` 文本不该是唯一出口：文本会被 grep、会被改格式）。
    assert.deepEqual(install.notices.map((n) => n.code), [NOTICE_COLLATERAL])
  })

  test('★ 没有告诫时**不**打印一句"没有告诫"', () => {
    // 缺席是"这次派生没有任何告诫"，不是一条读数为零的告诫。
    // 补一句"告诫：无"会把一个不存在的读数写进日志——而下一次有人按
    // "日志里有没有告诫行"统计时，每一行 Run 都会被算成有告诫。
    const lines = []
    installRunFloorIntoAgent({
      agent: { id: 'agent-a', ctx: { tools: { guard: () => () => {} }, on: () => () => {} } },
      installation: createRunFloorInstallation(installedPort(floorOf())),
      log: (s) => lines.push(s),
    })
    assert.equal(lines.filter((l) => l.includes('告诫')).length, 0)
  })

  test('★ 告诫的形状坏掉 → 整个端口载荷具名拒绝（不是"这条跳过")', () => {
    // 一条读不懂的告诫必须把这次安装判成 refused：跳过它继续装，
    // 与"这条告诫不存在"在读端是同一个东西——而这类告诫的全部价值就是它会被读到。
    const bad = createRunFloorInstallation(installedPortWith(floorOf(), [{ code: 'n-1' }]))
    assert.equal(bad.state, RUN_FLOOR_STATES.REFUSED)
    assert.equal(bad.code, RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR)
    // 措辞必须同时提到 floor 与 notices，否则排障的人会去查那份**正确**的下限。
    assert.ok(bad.message.includes('notices'), `文案没提 notices：${bad.message}`)
    // refused 那一档**没有**告诫可读（不是空数组以外的别的什么）。
    assert.deepEqual([...bad.notices], [])
  })
})

// ═══════════════════════════════════════════════════════ §2 装不上的时候拒绝

describe('PRT-214 run-floor（安装失败必须拒绝，不降级）', () => {
  test('★ 没有 Agent 作用域 / 没有 guard 落点 / 没有事件落点 → 各自具名抛出', () => {
    const installation = createRunFloorInstallation(installedPort(floorOf()))

    assert.throws(() => installRunFloorIntoAgent({ agent: null, installation }), (e) => {
      assert.equal(e.code, RUN_FLOOR_INSTALL_CODES.NO_AGENT_CONTEXT)
      return true
    })
    assert.throws(() => installRunFloorIntoAgent({ agent: { id: 'a' }, installation }), (e) => {
      assert.equal(e.code, RUN_FLOOR_INSTALL_CODES.NO_AGENT_CONTEXT)
      return true
    })
    // 有作用域、但里面没有 tools.guard ⇒ 最终复核没有落点
    assert.throws(() => installRunFloorIntoAgent({
      agent: { id: 'a', ctx: { on() {} } }, installation,
    }), (e) => {
      assert.equal(e.code, RUN_FLOOR_INSTALL_CODES.NO_GUARD_SEAM)
      return true
    })
    // 有 guard、但没有事件落点 ⇒ 提前拒绝没有落点
    assert.throws(() => installRunFloorIntoAgent({
      agent: { id: 'a', ctx: { tools: { guard: () => () => {} } } }, installation,
    }), (e) => {
      assert.equal(e.code, RUN_FLOOR_INSTALL_CODES.NO_EVENT_SEAM)
      return true
    })
    // 装置本身不对：不给一个"跳过安装照跑"的口子
    assert.throws(() => installRunFloorIntoAgent({ agent: { id: 'a', ctx: {} }, installation: {} }), (e) => {
      assert.equal(e.code, RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR)
      return true
    })
  })
})

// ═══════════════════════════════════════════════ §3–§5 真 ToolRuntime

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work'
let seq = 0

/**
 * 真运行时：`Context` + `ToolRuntime`（`systemPrompt` 是它的 inject）。
 */
async function runtime() {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {}, section() { return { dispose() {} } }, getSectionOrder() { return 0 },
  })
  await ctx.plugin(ToolRuntime)
  await new Promise((r) => setTimeout(r, 0))
  assert.notEqual(ctx.tools, undefined, 'ToolRuntime 没激活')
  return ctx
}

/**
 * 现造一个**真作用域**（`createScope`）并给它一个 Agent 形状的键。
 *
 * 生产里这个键就是 Agent 对象本身（`agent-loop/src/agent.ts:104`：
 * `this.scope = createScope(loopCtx, this)`），`ToolRuntime.guardReason()` 拿
 * `exec.agent` 当作用域键去走 `chainLayers()`（`tools/src/index.ts:1113`）。
 * 所以"装到哪个作用域"与"哪个 agent 发起调用"在这里是同一件事——
 * 这正是本套件能读"按 Run 分开"的原因。
 */
async function mintAgentScope(ctx, name) {
  const key = { id: name }
  let scope
  await ctx.plugin(Object.assign((inner) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  key.ctx = scope.ctx
  return { scope, key }
}

function countingTool(ctx, name) {
  const state = { ran: 0, lastArgs: null }
  ctx.tools.register(defineContentToolFixture({
    name, description: name, parameters: {},
    async execute(args) { state.ran += 1; state.lastArgs = args; return [{ type: 'text', text: `${name} ran` }] },
  }))
  return state
}

const callOf = (ctx, name, agent, args = {}) => ctx.tools.execute({
  callId: `c-${seq++}`, name, arguments: args, agent,
  signal: new AbortController().signal,
})

const textOf = (r) => (r.content ?? []).map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' | ')

/** 把一份下限装到一个作用域上，返回安装读数。 */
function installOn(key, floor) {
  return installRunFloorIntoAgent({ agent: key, installation: createRunFloorInstallation(installedPort(floor)) })
}

describe('PRT-214 run-floor（真 DSH ToolRuntime）', () => {
  guarded('★★★ 下限禁了工具名 → 工具**真的**没执行（guard 那一侧）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'rm_rf')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    installOn(key, floorOf({ denyTools: ['rm_rf'], cwd: CWD }))

    const r = await callOf(ctx, 'rm_rf', key)
    assert.equal(st.ran, 0, '下限禁了它，工具却执行了——那"静态下限"就只是一句注释')
    assert.equal(r.isError, true)
    assert.match(textOf(r), /rm_rf/)
  })

  guarded('★★★ 下限没禁的工具照旧执行（不是"一律拒绝"）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'read_file')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    installOn(key, floorOf({ denyTools: ['rm_rf'], cwd: CWD }))

    const r = await callOf(ctx, 'read_file', key)
    assert.equal(st.ran, 1,
      '★ 下限把没在名单里的工具也拒了——那种实现与"拒绝对了"在只测被禁工具时是同一个读数')
    assert.match(textOf(r), /read_file ran/)
  })

  guarded('★ 路径前缀那一族也真的拦得住（理由里带着被禁前缀）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    installOn(key, floorOf({ denyPathPrefixes: [`${CWD}/secret`], cwd: CWD }))

    const denied = await callOf(ctx, 'write_file', key, { path: `${CWD}/secret/keys.txt` })
    assert.equal(st.ran, 0)
    assert.match(textOf(denied), /secret/)

    const allowed = await callOf(ctx, 'write_file', key, { path: `${CWD}/public/a.txt` })
    assert.equal(st.ran, 1, '被禁前缀**之外**的路径必须照写——否者读不出"是那条规则拦的"')
    assert.match(textOf(allowed), /write_file ran/)
  })

  guarded('★★★★★ 两次 Run 两份下限：交叉项证明规则**不外溢**', async () => {
    // ★ 本套件的判别性用例。见文件头：只有交叉项能把"按 Run 装"
    //   与"用第一次 Run 的下限服务所有 Run"分开。
    const ctx = await runtime()
    const alpha = countingTool(ctx, 'alpha_tool')
    const beta = countingTool(ctx, 'beta_tool')
    const { key: runA } = await mintAgentScope(ctx, 'run-a')
    const { key: runB } = await mintAgentScope(ctx, 'run-b')

    // 甲这次 Run 的下限只禁 alpha；乙这次只禁 beta。
    installOn(runA, floorOf({ denyTools: ['alpha_tool'], cwd: CWD }))
    installOn(runB, floorOf({ denyTools: ['beta_tool'], cwd: CWD }))

    // 甲：alpha 拒、beta 放
    assert.equal((await callOf(ctx, 'alpha_tool', runA)).isError, true, '甲的规则没拦住 alpha')
    assert.equal(alpha.ran, 0)
    assert.equal((await callOf(ctx, 'beta_tool', runA)).isError, false,
      '★ 乙的规则外溢到甲了：那说明下限是进程级/装配级的，不是按 Run 的')
    assert.equal(beta.ran, 1)

    // 乙：beta 拒、alpha 放
    assert.equal((await callOf(ctx, 'beta_tool', runB)).isError, true, '乙的规则没拦住 beta')
    assert.equal(beta.ran, 1, 'beta 在乙里被执行了——下限没生效')
    assert.equal((await callOf(ctx, 'alpha_tool', runB)).isError, false,
      '★ 甲的规则外溢到乙了：第二次 Run 继承了第一次 Run 的下限')
    assert.equal(alpha.ran, 1)
  })

  guarded('★★★★ 缺席的下限：**任何**工具都没执行，连低风险与真 DSH 名也一样', async () => {
    // ★ 这是这一批修掉的读数在**真 ToolRuntime** 上的落点。
    //
    // `HIGH_RISK_TOOL_NAMES` 写的是 Legion 的**能力名**（`delete-file` / …），
    // 而这里的 `execution.name` 是执行面的**工具名**。只读"Legion 高风险名被拒"
    // 的话，一个"按 Legion 名单禁九个"的实现是绿的——但那个实现在这里会**放行**
    // `read-file` 与 `pwsh`，因为它一个真工具名都没命中。所以这条用例打**三个**
    // 不同空间的名字：拒掉全部才是"拒绝一切"。
    const ctx = await runtime()
    const legionRisky = countingTool(ctx, 'delete-file')
    const legionSafe = countingTool(ctx, 'read-file')
    const dshNamed = countingTool(ctx, 'pwsh')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    const reading = installRunFloorIntoAgent({
      agent: key, installation: createRunFloorInstallation(absentPort()),
    })
    assert.equal(reading.state, RUN_FLOOR_STATES.ABSENT)
    assert.equal(reading.code, RUN_FLOOR_CODES.NOT_SUPPLIED)
    assert.equal(reading.denyTools, 0, '缺席没有名字名单 —— 如果这里报出 9，判定就成了"名单"的读数')

    const deniedLegionRisky = await callOf(ctx, 'delete-file', key)
    assert.equal(legionRisky.ran, 0, '缺席的下限放行了一个 Legion 高风险能力名 —— 这一档必须是拒绝一切')
    assert.equal(deniedLegionRisky.isError, true)
    assert.match(textOf(deniedLegionRisky), new RegExp(RUN_FLOOR_CODES.NOT_SUPPLIED))
    assert.match(textOf(deniedLegionRisky), /delete-file/)
    assert.match(textOf(deniedLegionRisky), /6\.8:479/)

    const deniedLegionSafe = await callOf(ctx, 'read-file', key)
    assert.equal(legionSafe.ran, 0,
      '★ 缺席放行了低风险的 Legion 能力名 read-file ⇒ 这个实现其实是"按 Legion 能力名名单禁"，'
      + '而那份名单在真运行时里一个名字都命不中')
    assert.equal(deniedLegionSafe.isError, true)

    const deniedDsh = await callOf(ctx, 'pwsh', key)
    assert.equal(dshNamed.ran, 0,
      '★ 缺席放行了一个**真 DSH 工具名**（pwsh）——那正是"按 Legion 名单禁"的读数：'
      + '名单 ∩ 真工具名 = 空集，看起来在执行 §6.8:479，实际一个都没拦住')
    assert.equal(deniedDsh.isError, true)
  })

  guarded('★★★ 空下限：工具照样跑（"没有东西要禁止"是一个陈述）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'read_file')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    const reading = installOn(key, floorOf({ cwd: CWD }))
    assert.equal(reading.state, RUN_FLOOR_STATES.INSTALLED)

    await callOf(ctx, 'read_file', key)
    assert.equal(st.ran, 1,
      '★ 空下限拒了调用 ⇒ 它退化成"缺席"，两种处境又同形了（而它们必须分得开）')
  })

  guarded('★★★★ 下限的拒绝发生在**策略门之前**（prepend 的读数）', async () => {
    // 见文件头 §5：同一份下限，若排在动态门后面，注定被拒的调用会先被问一次。
    const ctx = await runtime()
    const st = countingTool(ctx, 'rm_rf')
    const { key } = await mintAgentScope(ctx, 'agent-a')

    // 一个默认顺序（append）的动态门：它只是**数自己被调过几次**。
    let gateAsked = 0
    ctx.on('tools/pre-execute', () => { gateAsked += 1; return { kind: 'ask', reason: '策略门问一次' } })

    installOn(key, floorOf({ denyTools: ['rm_rf'], cwd: CWD }))
    const r = await callOf(ctx, 'rm_rf', key)

    assert.equal(st.ran, 0)
    assert.match(textOf(r), /rm_rf/)
    assert.equal(gateAsked, 0,
      '★ 动态门被试过了 ⇒ 下限的 listener 排在它**后面**：每一次注定被拒的调用都会多走一次审批，'
      + '而 spec §6.8 要求下限在 pre-execute 上**提前**拒绝')
  })

  guarded('★★ 装上之后 `dispose()` 把**两个面**都撤掉', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'rm_rf')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    const reading = installOn(key, floorOf({ denyTools: ['rm_rf'], cwd: CWD }))

    assert.equal((await callOf(ctx, 'rm_rf', key)).isError, true)
    assert.equal(runFloorInstalledOn(key), true)

    reading.dispose()
    assert.equal(runFloorInstalledOn(key), false)
    assert.equal((await callOf(ctx, 'rm_rf', key)).isError, false,
      '★ 撤了之后仍然被拒 ⇒ 至少一个面的 disposer 没接上（那是一次静默泄漏）')
    assert.equal(st.ran, 1)
  })

  guarded('★ 同一个 Agent 上重复安装返回第一次那份读数（不叠两层）', async () => {
    const ctx = await runtime()
    const st = countingTool(ctx, 'rm_rf')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    const first = installOn(key, floorOf({ denyTools: ['rm_rf'], cwd: CWD }))
    const second = installOn(key, floorOf({ denyTools: ['rm_rf'], cwd: CWD }))
    assert.equal(first, second, '第二次装上去会多一个没人认领的 disposer')
    assert.equal((await callOf(ctx, 'rm_rf', key)).isError, true)
    assert.equal(st.ran, 0)
  })

  guarded('★★★ 两个面共用**同一份**判定：pre-execute 说拒时理由是 guard 那一条', async () => {
    // spec §6.8 `:486` 的不变量是"pre-execute 放行 + allowed-once 的调用不得再被 guard 拒"。
    // 它的充分实现是**两处同一个 guard 调用结果**；若两处各造一份 guard，
    // 差别只在"两份规则是否恰好一致"——所以这里读的是**理由字符串**。
    const ctx = await runtime()
    const st = countingTool(ctx, 'rm_rf')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    const seen = []
    installRunFloorIntoAgent({
      agent: key,
      installation: createRunFloorInstallation(installedPort(floorOf({ denyTools: ['rm_rf'], cwd: CWD }))),
      onGuard: (e) => seen.push(e.surface),
    })

    const r = await callOf(ctx, 'rm_rf', key)
    assert.equal(st.ran, 0)
    // 拒绝由 pre-execute 认领（提前拒绝），于是 guard 这一级不会再跑一次。
    assert.deepEqual(seen, ['tools/pre-execute'])
    assert.match(textOf(r), /hard floor/)
  })

  guarded('★★ 路径判定用的是这次 Run 的 cwd 与 platform（不是别的）', async () => {
    // 下限里带着 `cwd`/`platform` 不是装饰：`canonicalizePath` 靠它们把相对路径
    // 折成绝对、并决定 win32 小写折叠。装的时候丢掉它们，就会在
    // "写 ./secret/x" 这种相对路径上给出与规则不同的判定。
    const ctx = await runtime()
    const st = countingTool(ctx, 'write_file')
    const { key } = await mintAgentScope(ctx, 'agent-a')
    installOn(key, floorOf({ denyPathPrefixes: [`${CWD}/secret`], cwd: CWD }))

    const r = await callOf(ctx, 'write_file', key, { path: 'secret/keys.txt' })
    assert.equal(st.ran, 0, '相对路径没有被折到这次 Run 的 cwd 上——下限的 cwd 没被用起来')
    assert.match(textOf(r), /secret/)
  })
})

// product/launcher/doctor.mjs
// ============================================================================
// PRT-257：**修复入口**（Launcher 负责 DSH 运行时与补丁层的安装 / 自检 / 修复）。
//
// spec `line 854` 说「未生效时 Runtime Manager 按 `incompatible` 处理并**禁止自动执行**」，
// §6.3 表格（`line 275`）把 `incompatible` 的行为定成
// 「禁止自动执行，**提示修复或回滚**」。
//
// 在写这个模块之前，"修复"这件事的状态是：
//
//   · `REPAIR_ACTIONS`（`runtime/dsh-composition/bootstrap.mjs`）有**逐项修法表**，
//     `repairPlanFor()` 把一次自检结论翻成计划；
//   · 计划随拒绝一起走到 `refusal.repair`，服务值里带着它，日志里印得出来；
//   · 而 `product/launcher/` 里 `repairPlanFor` / `REPAIR_ACTIONS` 的出现次数是 **0**。
//
//   > 一份"算出来了、也跟着拒绝走了、但没有任何人能照着做"的修复计划，
//   > 与一份不存在的修复计划，对用户是同一个东西——
//   > 只不过前者的数据结构里写着它。
//
// `line 275` 要的是「**提示**修复或回滚」，而"提示"必须**出得去**才算提示。
// 本模块就是那个出口：把计划变成人能读的东西，并给出一个**可脚本化的**退出码。
//
// ## 一、它**只提示**，不自动修
//
// 这不是没做完，是**刻意**的，有两个理由：
//
// ① spec 用词就是"提示"。`line 854` 是「按 `incompatible` 处理并禁止自动执行」，
//    `line 275` 是「提示修复或回滚」——两句话里都没有"自动修复"。
//    把"提示"实现成"替你改了"，是在规范之外加了一条**产品自己决定改用户环境**的行为。
//
// ② 自动修在这里是**危险**的。修法表里排第一的那条是"重新应用组合补丁层"，
//    而 DSH profile 是 `patchReload: 'live'`：一次误应用能把**当前正在跑的进程**
//    的沙箱管制降级（同一个理由写在 `dsh-overlay.mjs:20-34`，那里也据此拒绝了
//    "把强制面写进用户 profile"）。一个"帮你修"的命令，在它修错的那一天，
//    用户手上没有任何东西可以回退——因为他没看见它改了什么。
//
//   > 一个能自动改用户环境的"修复"，
//   > 与一个把用户环境改坏之后只说"修好了"的脚本，
//   > 在事故复盘里是同一个东西——只不过前者多一层"是产品自己做的"。
//
// 所以本模块**零 IO**（与 `dsh-overlay.mjs` / `secrets-check.mjs` 同一做法）：
// 它不读文件、不写文件、不起进程。判据是"该提示什么、该给什么退出码"，
// 而那件事不需要碰磁盘就能逐条验证。
//
// ## 二、三个读数必须分开，尤其"没诊断"不能是 0
//
//   · `0`  没有待修项 —— 自检全过，可以自动执行；
//   · `1`  有待修项 —— 自检判未生效，**逐项**给出了修法；
//   · `3`  **拿不到诊断** —— 没做过自检、来源缺席、或来源坏了。
//
// `3` 与 `0` 分开是本模块最要紧的一条。一个"读不到诊断 ⇒ 没发现问题 ⇒ 退出 0"
// 的实现，会让**每一次接线遗漏都看起来像一次健康检查通过**：
//
//   > 一个"因为没拿到结论所以什么都没报"的体检，
//   > 与一个"结论是一切正常"的体检，在退出码上是同一个东西——
//   > 只不过前者会让一个已经坏掉的部署安静地通过门禁。
//
// 同理，`refusal` 明说了 `incompatible` 却**没带**修复计划时，那是 `NO_PLAN`（3），
// 不是 `0`：我们**知道**它坏了，只是说不出怎么修。那是比"有待修项"更坏的读数，
// 不是更好的一个。
//
// ## 三、为什么把计划**传进来**，而不是在这里算
//
// `repairPlanFor()` 住在 `runtime/dsh-composition/bootstrap.mjs`。让
// `product/launcher/` 去 import 它，会把**组合层的整条依赖**（自检、补丁层对账、
// 生成器）拖进 Launcher 的进程——而 Launcher 的职责恰恰是"在那些东西起来之前
// 先把进程看好"（同一个理由写在 `dsh-overlay.mjs:64-73`）。
//
// 于是边界是：**谁拿得到自检结论，谁负责把计划算出来；本模块只负责把它讲清楚。**
// 代价是"计划形状"这件事有两处认知——所以有一条用例把
// `repairPlanFor()` 的真产物喂进本模块，钉住两处对同一个形状的理解一致。
//
// ## 四、"回滚"必须和"修复"一起出现
//
// `line 275` 写的是「提示修复**或**回滚」。只给修复步骤等于把用户逼进一条
// 他可能修不好的路（例如 `sandbox-enforcement` 在 Windows 上的 `partial` 是
// 平台事实，把沙箱后端修到 `full` 不是用户今天能做的事）。所以报告里
// **总是**同时给出回滚这一条出路，并带上补丁层版本（有的话）。
// ============================================================================

/** 本模块的版本。落进报告，便于把一次诊断输出与一份实现对起来。 */
export const DOCTOR_VERSION = 1

/**
 * 退出码。**三个读数三档**，且 `NO_DIAGNOSIS` / `NO_PLAN` **共用 3**：
 * 从"我能不能照着这份输出动手"来看，它们是一回事——都不能。
 * 分成两个非零码只会让人以为"3 比 1 更严重"，而真正的区别在 `code` 上写着。
 */
export const DOCTOR_EXIT = Object.freeze({
  /** 自检全过。 */
  CLEAN: 0,
  /** 有待修项，逐项给了修法。 */
  ACTIONABLE: 1,
  /** 拿不到诊断，或拿到了"坏了"却给不出修法。**不是 0**。 */
  UNDIAGNOSED: 3,
})

/** 报告的具名结论。比退出码细：退出码只有"能不能动手"，这里说清是哪一种。 */
export const DOCTOR_CODES = Object.freeze({
  /** 自检全过。 */
  CLEAN: 'DOCTOR_CLEAN',
  /** 有待修项。 */
  ACTIONABLE: 'DOCTOR_ACTIONABLE',
  /** 知道它坏了，但没有修复计划（`incompatible` 却不带 `repair`）。 */
  NO_PLAN: 'DOCTOR_NO_PLAN',
  /** 根本没有诊断：没做过自检、来源缺席、或来源坏了。 */
  NO_DIAGNOSIS: 'DOCTOR_NO_DIAGNOSIS',
})

const asArray = (v) => (Array.isArray(v) ? v : [])

/**
 * 从一堆可能的输入里取出**唯一**那份修复计划。
 *
 * 刻意"只认一个来源"而不是"哪个有就用哪个"：计划与拒绝**配套**才有意义
 * （它说的是"这一次自检里哪几项没过"）。把两个来源缝起来，会造出一份
 * 从来没有任何一次自检产生过的计划。
 *
 * @returns {{items: Array, patchVersion: string|null, forbidden: boolean|null,
 *            state: string|null, reasons: string[]}|null}
 */
export function planFrom(input = {}) {
  const refusal = input?.refusal
  // ① 直接给了计划（`repairPlanFor()` 的产物，或服务值上的 `repair` 字段）。
  const raw = input?.plan ?? (refusal !== null && typeof refusal === 'object' ? refusal.repair : null)
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.items)) {
    return {
      items: raw.items,
      patchVersion: typeof refusal?.patchVersion === 'string' ? refusal.patchVersion : null,
      // `forbidden` 只在**明说**了的时候才有值。缺字段 ≠ false：
      // 把它读成 false 会让"没说"变成"允许执行"。
      forbidden: typeof refusal?.autoExecutionForbidden === 'boolean' ? refusal.autoExecutionForbidden : null,
      state: typeof refusal?.state === 'string' ? refusal.state : null,
      reasons: asArray(refusal?.reasons).map(String),
      threw: null,
    }
  }
  // ② 只有自检结论、没有计划 → 交给调用方（它才有 `repairPlanFor`）。
  //    **不在这里编一份计划**：编出来的修法是猜的，而猜的修法会让人照着做。
  return null
}

/**
 * 做一次诊断。**零 IO**：只读入参。
 *
 * @param {object} input
 * @param {object} [input.plan] `{ok, items}` —— 已经算好的修复计划
 * @param {object} [input.refusal] 拒绝值（`bindDshRuntime` 的产物）；会取它的 `repair`
 * @param {string} [input.source] 诊断是**从哪读来的**（`run-record` / `self-check` / …）。
 *   落进报告：一个不说"这是哪来的一次诊断"的报告，在两次诊断之间分不开。
 * @param {string} [input.note] 来源自己要说的一句话（例如读不到的具名原因）
 * @returns {object} 报告
 */
export function doctorReport(input = {}) {
  const source = typeof input?.source === 'string' && input.source.trim() !== '' ? input.source.trim() : null
  const note = typeof input?.note === 'string' && input.note.trim() !== '' ? input.note.trim() : null
  const found = planFrom(input)

  // 拒绝值**自己**有没有说"强制面未生效"。这是 `NO_PLAN` 与 `NO_DIAGNOSIS`
  // 分开的判据：两种都没有计划，但一种**知道**它坏了，另一种连知道都不知道。
  const refusal = input?.refusal
  const declaredIneffective = refusal !== null && typeof refusal === 'object'
    && (refusal.autoExecutionForbidden === true || refusal.state === 'incompatible')
  const refusalReasons = asArray(refusal?.reasons).map(String)

  // ── ② 知道它坏了，但给不出修法 ──────────────────────────────────────────
  // 这一支必须排在"没诊断"**之前**：一个"坏了却说不出怎么修"的读数，
  // 与一个"根本没诊断"的读数，用户能做的事不同（前者要报产品缺口，
  // 后者要去把自检跑起来）。混成一个码会把排查方向指错。
  if (found === null && declaredIneffective) {
    return report({
      code: DOCTOR_CODES.NO_PLAN,
      exitCode: DOCTOR_EXIT.UNDIAGNOSED,
      source,
      headline: '强制面**未生效**，但拒绝里没有带修复计划——说不出该怎么修',
      forbidden: true,
      patchVersion: typeof refusal?.patchVersion === 'string' ? refusal.patchVersion : null,
      state: typeof refusal?.state === 'string' ? refusal.state : null,
      items: [],
      lines: [
        '这条拒绝明说了禁止自动执行，却没有逐项修法。',
        '这是**产品侧的缺口**（拒绝该带上 `repair`），不是你操作错了。',
        '在此之前：按下面的回滚那条路走，或者人工看日志里那几项自检的名字。',
        ...(refusalReasons.length === 0 ? [] : ['拒绝给出的原因：', ...refusalReasons.map((r) => `  · ${r}`)]),
      ],
    })
  }

  // ── ③ 拿不到诊断 ────────────────────────────────────────────────────────
  // 这一支必须在**任何**"没发现问题"之前被判掉。顺序反过来就是那个假绿：
  // 一份读不到的诊断，会一路走到"没有待修项"。
  if (found === null) {
    return report({
      code: DOCTOR_CODES.NO_DIAGNOSIS,
      exitCode: DOCTOR_EXIT.UNDIAGNOSED,
      source,
      headline: '没有拿到启动自检结论——**这不等于"一切正常"**',
      forbidden: null,
      patchVersion: null,
      state: null,
      items: [],
      lines: [
        '自检结论是"强制面到底生没生效"的唯一来源。没有它，这次诊断什么都证明不了：',
        '既不能说可以自动执行，也不能说该修哪一项。',
        note === null ? '（来源没有给出原因）' : `来源说：${note}`,
        '去做一次自检（把组合层装进一个 DSH 进程启动一次），再回来看这份报告。',
      ],
    })
  }

  const items = found.items.filter((i) => i !== null && typeof i === 'object')
  const failed = items.filter((i) => {
    // 计划里的项按约定都是"没过的那一项"；但真产物也可能是 `{ok:true}` 混进来
    // （例如有人把整份 `checks` 当成计划传了）。**按 `ok` 判，不按下标判**：
    // 一个"计划里有什么就当作没过什么"的实现，在有人传了完整清单的那天
    // 会报出一堆并不存在的故障。
    return i.ok !== true
  })

  // ── ②b 计划在、但里面没有可修的项，而拒绝说不行 ──────────────────────────
  // 与上面那一支同一个结论（说不出怎么修），只是走的是"计划是空的"这条路。
  if (found.forbidden === true && failed.length === 0) {
    return report({
      code: DOCTOR_CODES.NO_PLAN,
      exitCode: DOCTOR_EXIT.UNDIAGNOSED,
      source,
      headline: '强制面**未生效**，但拒绝里没有带修复计划——说不出该怎么修',
      forbidden: true,
      patchVersion: found.patchVersion,
      state: found.state,
      items: [],
      lines: [
        '这条拒绝明说了禁止自动执行，却没有逐项修法。',
        '这是**产品侧的缺口**（拒绝该带上 `repair`），不是你操作错了。',
        '在此之前：按下面的回滚那条路走，或者人工看日志里那几项自检的名字。',
        ...(found.reasons.length === 0 ? [] : ['拒绝给出的原因：', ...found.reasons.map((r) => `  · ${r}`)]),
      ],
    })
  }

  // ── ① 有待修项 ──────────────────────────────────────────────────────────
  if (failed.length > 0) {
    return report({
      code: DOCTOR_CODES.ACTIONABLE,
      exitCode: DOCTOR_EXIT.ACTIONABLE,
      source,
      headline: `${failed.length} 项没通过：自动执行已被禁止，逐项修法如下`,
      forbidden: found.forbidden,
      patchVersion: found.patchVersion,
      state: found.state,
      items: failed,
      lines: [
        // ★ 先把**操作后果**说清楚，再说怎么修。用户第一个要知道的不是"哪一项红了"，
        //   而是"我现在能不能用"——`line 278` 说只读面在 Runtime 不可用时继续开放。
        found.forbidden === true
          ? '当前状态：**自动执行已禁止**；只读的 Workbench 与 team-hub 仍然可用。'
          : '当前状态：这一份计划来自一次未生效的自检（自动执行被禁止）。',
        '修完之后重新做一次自检——这份报告证明的是**上一次**自检的结论。',
        '',
      ],
    })
  }

  // ── ⓪ 没有待修项 ────────────────────────────────────────────────────────
  return report({
    code: DOCTOR_CODES.CLEAN,
    exitCode: DOCTOR_EXIT.CLEAN,
    source,
    headline: '启动自检全过：强制面已生效，允许自动执行',
    forbidden: found.forbidden === true ? true : false,
    patchVersion: found.patchVersion,
    state: found.state,
    items: [],
    lines: ['没有任何一项需要修。'],
  })
}

/**
 * 把报告排成人能读的文本。CLI 的 stdout 就是它。
 *
 * 未知项（`action === 'inspect-manually'`）**单独成段**并排在最后：
 * `repairPlanFor()` 刻意把认不出的检查项也留在计划里（丢掉它会让"有三项没过"
 * 变成"修了这两项就好"），这里是那条决定的**出口侧**——
 *   > 一个被留在数据里、却被排在正文之外的未知项，
 *   > 与一个在计划里就被丢掉的未知项，在用户读到的东西上是同一个。
 */
export function renderDoctor(report) {
  // `Array.isArray` 必须单独判：`typeof []` 是 `'object'`，
  // 而数组没有 `.items` —— 只写 `typeof !== 'object'` 会在这里抛。
  // 一个"对畸形输入抛异常的渲染器"，在它被喂进畸形输入的那一天
  // 会把一次诊断变成一次崩溃。
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return ''
  const L = []
  L.push(`Legion 修复入口（doctor v${DOCTOR_VERSION}）`)
  L.push(`结论：${report.code}`)
  L.push(`来源：${report.source ?? '(未说明)'}`)
  L.push('')
  L.push(report.headline)
  L.push('')

  const known = report.items.filter((i) => i.action !== 'inspect-manually')
  const unknown = report.items.filter((i) => i.action === 'inspect-manually')

  for (let n = 0; n < known.length; n++) {
    const i = known[n]
    L.push(`${n + 1}. ${i.label}（检查项 ${i.check}）`)
    L.push(`   动作：${i.action}`)
    if (typeof i.why === 'string' && i.why !== '') L.push(`   为什么非修不可：${i.why}`)
    for (const r of asArray(i.reasons)) L.push(`   现场读数：${r}`)
    L.push('')
  }

  if (unknown.length > 0) {
    L.push('以下检查项**没有预置修法**，需要人工排查（它们同样在阻止执行）：')
    for (const i of unknown) {
      L.push(`  · ${i.check}`)
      for (const r of asArray(i.reasons)) L.push(`      现场读数：${r}`)
    }
    L.push('')
  }

  for (const line of asArray(report.lines)) L.push(line)

  // ★ 回滚这条路**总是**给出来（`line 275`：「提示修复**或**回滚」）。
  //   只给修复步骤，等于告诉一个修不好的人"你没有出路"。
  L.push('')
  L.push('或者回滚：')
  L.push('  · 停掉 Legion，换回上一个可用的安装（补丁层随安装目录一起回退）')
  if (report.patchVersion !== null) L.push(`  · 这一层当前的版本是 ${report.patchVersion}，回退时对照它`)
  L.push('  · 回滚**不需要**先修好任何一项——它是修复之外的独立出路')

  if (report.code !== DOCTOR_CODES.CLEAN) {
    L.push('')
    L.push('本入口**只提示、不自动改**：修法会改动 DSH 组合层，而 profile 是 live reload，')
    L.push('一次误应用能把当前进程的沙箱管制降级。要动手时请自己执行上面的动作。')
  }
  return L.join('\n')
}

/** 组装报告对象。集中在这里，免得四个分支各拼一次、漏掉字段。 */
function report({ code, exitCode, source, headline, forbidden, patchVersion, state, items, lines }) {
  return Object.freeze({
    ok: code === DOCTOR_CODES.CLEAN,
    code,
    exitCode,
    source,
    headline,
    // `forbidden` 三态：`true` 禁止 / `false` 允许 / `null` **没说**。
    // 不合：`null` 与 `false` 在布尔上下文里都是"不禁止"，
    // 而那正是"没说"被读成"允许"的那条路。
    forbidden,
    patchVersion,
    state,
    items: Object.freeze(items),
    lines: Object.freeze(lines),
  })
}

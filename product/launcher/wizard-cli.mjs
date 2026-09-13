// product/launcher/wizard-cli.mjs
// ============================================================================
// PRT-707 收尾：**把向导接上一个真的界面**
//
// ## 本任务正文里最大的一条诚实边界
//
// > ⚠️ **没有界面**——向导是状态机，`status()`/`submit()`/`run()` 是驱动接口，
// > 但**没有任何 UI 或 CLI 子命令在用它**，所以"不打开终端"这个完成标准的
// > **呈现层还不存在**（本任务最大边界）。
//
// 这一批把它接到 CLI 上。要先把话说清楚：**CLI 仍然是终端**，
// 所以"不打开终端"那一条**没有被这一批消灭**。这一点必须留在诚实边界里，
// 否则这一批看起来像是完成了整个呈现层。
//
// 但"零调用方"是一件独立的事，而且它让向导的**全部行为**都停留在纸面上：
// 一个只有测试会调用的状态机，它的每一次改动都只能靠读代码来确认。
//
// ## 接一个界面时最容易犯的两个错，本层各有一条防线
//
// ① **把密钥当命令行参数。**
//    `--wizard-model-key=sk-xxx` 会进 shell 历史、会出现在 `ps` 的输出里、
//    会被 CI 的日志系统抄走。所以本层的密钥**只从 stdin 读**，
//    而且不接受任何"顺手也支持一下 argv"的变体——因为那种变体一定会被用。
//
//      > 一个"也支持从命令行传密钥"的界面，
//      > 与一个只能从命令行传密钥的界面，在密钥泄漏这件事上是同一个结果——
//      > 只不过前者让泄漏看起来像是用户自己选的。
//
// ② **在不可交互的环境里假装收到了输入。**
//    管道、CI、双击运行（没有 tty）都读不到回答。此时**必须**把
//    "没人能回答"如实报出来并停下，而不是拿空字符串当回答往下走——
//    后者会让向导走到 `verify`，然后报"模型不可用"，
//    而**用户根本没有地方可以填密钥**（这段推理与 `configure-model`
//    那条 `needsInputReason` 的注释是同一件事）。
// ============================================================================

import { WIZARD_CODES, WIZARD_STEP_DEFS, WIZARD_STEP_IDS, createWizard } from './wizard.mjs'

/** 界面自己的结果码。 */
export const WIZARD_CLI_CODES = Object.freeze({
  /** 非交互环境下需要用户输入。 */
  NOT_INTERACTIVE: 'WIZARDCLI_NOT_INTERACTIVE',
  /** 输入为空/不合法。 */
  BAD_INPUT: 'WIZARDCLI_BAD_INPUT',
  /** 向导某一步失败。 */
  STEP_FAILED: 'WIZARDCLI_STEP_FAILED',
  /** 前提不成立，一步都没跑。 */
  PRECONDITION_UNMET: 'WIZARDCLI_PRECONDITION_UNMET',
  /** 产品已就绪（没有再跑一次）。 */
  ALREADY_DONE: 'WIZARDCLI_ALREADY_DONE',
})

/**
 * 把一次向导运行渲染成**给用户看的话**。
 *
 * 分开写而不是塞进 `run()`：界面文本是最容易被顺手改坏的东西，
 * 而它坏了不会有任何用例变红。独立出来至少让"文本"有一个固定的入口。
 */
export function renderWizardReport(result, { write = () => {} } = {}) {
  const lines = []
  if (result.done === true) {
    lines.push('✔ 向导完成：产品已实测通过，可以开始用了')
  } else if (result.precondition === true) {
    lines.push('✖ 向导一步都没有跑：前提不成立')
    for (const u of result.unmet ?? []) lines.push(`  · ${u.message}`)
  } else if (result.needsInput === true) {
    // ★ 必须说清"在等什么"，否则用户不知道下一步干什么。
    lines.push(`⏸ 向导停在「${result.title ?? result.blockedStep}」`)
    lines.push(`  ${result.message}`)
  } else if (result.blocked === true) {
    lines.push(`✖ 向导停在「${result.title ?? result.blockedStep}」`)
    lines.push(`  ${result.message}`)
  } else {
    lines.push(`向导状态：${result.step ?? '未知'}`)
  }
  for (const l of lines) write(l)
  return lines.join('\n')
}

/**
 * 把 CLI 参数翻译成向导的**选项**（PRT-707 收尾）。
 *
 * ★ 单独抽出来，是为了让它**能被断言**。
 *
 *   第一版这段翻译写在 `cli.mjs` 的 `--wizard` 分支里，用例只能拿正则去
 *   匹配源码文本。那种断言有一个很坏的失效模式：把整段逻辑删掉、
 *   只要那几个词还留在注释里，用例就仍然是绿的——
 *   而它绿着的样子，与"真的接上了"完全一样。
 *
 *   抽成一个纯函数之后，用例可以直接问"给这些参数，你算出了什么"。
 *
 *     > 一条"匹配源码文本"的断言，与一条"匹配注释文本"的断言，
 *     > 在实现被删掉的那天是同一个读数。
 *
 * ## 三件事各自独立，不能合并
 *
 * · `presetOptIn` —— **预先回答**了可选项（`--wizard-consent=<who>`）
 * · `askOptIn`    —— 要不要**当场问**那个可选项；CLI **永不**打开它
 * · `reset`       —— 丢掉断点位置
 *
 * 特别地：**不给 `--wizard-consent` 不等于回答了"不要"**，
 * 它是"没有问过"——所以此时 `presetOptIn` 必须是**空对象**，
 * 而不是 `{'heartbeat-consent': {enabled: false}}`。后者会写出一条
 * "用户拒绝"的读数，而用户其实从没被问过。
 */
export function wizardOptionsFrom({ consentWho = null, flags = {}, layout = null } = {}) {
  const who = typeof consentWho === 'string' && consentWho.trim() !== '' ? consentWho : null
  return Object.freeze({
    layout,
    // ★ CLI **永不**当场问：一个默认去问的向导会把每次运行都变成
    //   一次需要人坐在旁边的操作，而大多数运行是重跑、脚本化或无人值守的。
    askOptIn: false,
    presetOptIn: who === null
      ? Object.freeze({})
      : Object.freeze({ 'heartbeat-consent': Object.freeze({ who, enabled: true }) }),
    reset: flags['wizard-reset'] === true,
  })
}

/**
 * 需要用户输入的步骤 → 从 stdin 读一次。
 *
 * `readLine` 由调用方注入（默认读 `process.stdin`）。它返回 `null` 表示
 * **读不到**（没有 tty、管道已关、超时）——这与"读到了空字符串"是两件事，
 * 而本层的全部要点就在于不让这两件事混起来。
 */
export async function runWizardCli({
  layout = null,
  stepActions = {},
  write = () => {},
  readLine = null,
  // 对可选项的预先回答（CLI 的 `--wizard-consent=<who>` 用它）。
  presetOptIn = {},
  // 要不要**问**那个可选项。默认不问：一个默认去问的向导会把每次运行
  // 都变成一次需要人坐在旁边的操作，而大多数运行是重跑、脚本化或无人值守的。
  askOptIn = false,
  // 丢掉断点进度，从头开始。**不删任何产品数据。**
  reset = false,
  // 向导的依赖由调用方给全（`environment`/`initialize`/`start`/`submitModelConfig`/
  // `observe`）。界面不替它造默认值：一个自己拼默认依赖的界面，
  // 会让"到底用哪个 observe"变成一个必须读两份代码才能回答的问题。
  wizardDeps = {},
} = {}) {
  const wizard = createWizard({
    ...wizardDeps,
    ...(layout === null ? {} : { layout }),
    stepActions,
    presetOptIn,
    askOptIn,
  })
  if (reset === true) wizard.reset()

  const pre = await wizard.checkPreconditions()
  if (pre.ok !== true) {
    const r = await wizard.run()
    renderWizardReport({
      precondition: true, unmet: r.unmet, message: r.message,
    }, { write })
    return Object.freeze({ ok: false, code: WIZARD_CLI_CODES.PRECONDITION_UNMET, result: r })
  }

  let result = await wizard.run()

  // ── 把"需要输入"这条路走完 ──────────────────────────────────────────
  //
  // 循环而不是一次：可选步骤之后还可能有别的输入步骤。
  // 上限用步骤数，避免某一步反复要输入时转不出来。
  for (let i = 0; i < WIZARD_STEP_IDS.length + 2; i += 1) {
    if (result.needsInput !== true) break

    const stepId = result.blockedStep
    const def = WIZARD_STEP_DEFS[stepId]
    if (typeof readLine !== 'function') {
      write('✖ 这一步需要你输入，但当前没有可用的输入方式（没有终端）')
      write(`  ${result.message}`)
      write('  请在**终端里**重跑一次向导；产品不会拿一个空回答往下走——')
      write('  那样最后会报"模型不可用"，而那时你已经没有地方可以填密钥了。')
      return Object.freeze({
        ok: false, code: WIZARD_CLI_CODES.NOT_INTERACTIVE, result, step: stepId,
      })
    }

    const value = await promptFor(stepId, def, { write, readLine })
    if (value === null) {
      // 读不到 ≠ 空回答。
      write('✖ 没能读到输入（终端已关闭或没有交互能力）')
      return Object.freeze({
        ok: false, code: WIZARD_CLI_CODES.NOT_INTERACTIVE, result, step: stepId,
      })
    }
    // ★ 密钥之类的敏感值**不进日志、不进诊断**：判据用 `validate`，
    //   而它返回的是一句问题描述，不是值本身。
    const accepted = wizard.submit(value)
    if (accepted.accepted !== true) {
      write(`✖ 输入没有被接受：${accepted.message}`)
      return Object.freeze({
        ok: false, code: WIZARD_CLI_CODES.BAD_INPUT, result, step: stepId,
        message: accepted.message,
      })
    }
    result = await wizard.run()
  }

  if (result.done === true) {
    renderWizardReport(result, { write })
    return Object.freeze({ ok: true, code: null, result })
  }
  if (result.precondition === true) {
    renderWizardReport(result, { write })
    return Object.freeze({ ok: false, code: WIZARD_CLI_CODES.PRECONDITION_UNMET, result })
  }
  renderWizardReport(result, { write })
  return Object.freeze({
    ok: false,
    code: result.needsInput === true ? WIZARD_CLI_CODES.NOT_INTERACTIVE : WIZARD_CLI_CODES.STEP_FAILED,
    result,
  })
}

/**
 * 问一个问题，拿到值。
 *
 * 每个输入步骤**各自**决定问什么、以及把什么交给 `submit`——
 * 而不是在 `submit` 那个方向按步骤分叉（见 `wizard.mjs` 里 `submit` 的说明）。
 */
async function promptFor(stepId, def, { write, readLine }) {
  if (stepId === 'configure-model') {
    write('需要配置模型。密钥**不会**回显，也不会写进任何日志。')
    const apiKey = await readLine('模型密钥：', { secret: true })
    if (apiKey === null) return null
    // ★ 空密钥在这里就停下，不往下走。往下走的话，向导会带着一个
    //   看起来配好了、其实没有密钥的模型库去 `verify`，然后报"模型不可用"。
    if (apiKey.trim() === '') return null
    const model = await readLine('模型名（可留空）：', { secret: false })
    if (model === null) return null
    return { apiKey, ...(model.trim() === '' ? {} : { model: model.trim() }) }
  }
  if (stepId === 'heartbeat-consent') {
    // 可选步骤不会走到这里（它不阻塞、不进 `needsInput`）。
    // 留这一支是为了**万一**步骤定义变了，也能说清而不是静默。
    write(`「${def?.title ?? stepId}」目前不需要交互输入。`)
    return {}
  }
  write(`「${def?.title ?? stepId}」需要输入，但这个界面不知道要问什么。`)
  return null
}

/**
 * 真终端上的读行。
 *
 * ★ 返回 `null` 只有一个含义：**读不到**（没有 tty、流已结束、用户按了 Ctrl-C）。
 *   空字符串是**另一个**东西（用户按了回车）。本层的全部要点就在于不让这两件事
 *   混起来——混起来的话，一个没有终端的运行会拿空字符串当回答往下走，
 *   最后报"模型不可用"，而那时用户已经没有任何地方可以填密钥了。
 *
 * ★ `secret: true` 时**不回显**。这不是洁癖：终端回显会被
 *   录屏、共享屏幕、以及某些终端模拟器的回滚缓冲留下。
 */
export function createStdinReader({ input = process.stdin, output = process.stdout } = {}) {
  return function readLine(prompt, { secret = false } = {}) {
    output.write(String(prompt ?? ''))
    // 没有 tty ⇒ 读不到。（管道、CI、双击运行都在这一支。）
    if (input?.isTTY !== true) return Promise.resolve(null)

    return new Promise((resolve) => {
      let buf = ''
      let done = false
      const rawCapable = typeof input.setRawMode === 'function'
      const wantRaw = secret === true && rawCapable
      const finish = (value) => {
        if (done) return
        done = true
        try { input.removeListener('data', onData) } catch { /* 尽力而为 */ }
        try { input.removeListener('end', onEnd) } catch { /* 尽力而为 */ }
        if (wantRaw) {
          try { input.setRawMode(false) } catch { /* 尽力而为 */ }
          // 不回显过的东西要自己收尾，否则后面的输出会接在提示符同一行上。
          output.write('\n')
        }
        resolve(value)
      }
      const onEnd = () => finish(null)
      const onData = (chunk) => {
        const text = String(chunk)
        for (const ch of text) {
          if (ch === '\u0003') { finish(null); return }            // Ctrl-C：取消
          if (ch === '\r' || ch === '\n') { finish(buf); return }
          if (ch === '\u007f' || ch === '\b') {                      // 退格
            if (buf.length > 0) {
              buf = buf.slice(0, -1)
              if (wantRaw === false) output.write('\b \b')
            }
            continue
          }
          buf += ch
          // 密钥不回显；其余情况让终端自己回显（非 raw 模式下它本来就会回显，
          // 这里只在 raw 模式时手动补）。
          if (wantRaw === false && secret === true) { /* 不回显 */ }
        }
      }
      input.on('data', onData)
      input.on('end', onEnd)
      if (wantRaw) { try { input.setRawMode(true) } catch { /* 尽力而为 */ } }
    })
  }
}

/**
 * 心跳同意那一步的动作。
 *
 * ★ 只有 `enabled === true` 才写同意记录。
 *
 *   "答了不要"与"没回答"都**不写**任何东西——但它们在 `status().optIn`
 *   里是**两个不同的读数**（`answered: true` vs 没有这一条）。
 *
 *   为什么不能在"答了不要"时写一条 `revoked: true`：那是**伪造一条记录**。
 *   撤回记录的含义是"这个人先同意过、后来撤回了"，
 *   而一个从没同意过的人被写成"撤回过"，会让他事后看到一段
 *   自己没做过的历史。
 *
 *     > 一份"拒绝"的记录与一份"从来没同意过"的记录，
 *     > 在审计上是同一件事；把它们区分开只会制造不存在的历史。
 */
export function heartbeatConsentAction({ layout, fs = undefined } = {}) {
  return async function applyHeartbeatConsent(value) {
    if (value?.enabled !== true) {
      return Object.freeze({
        ok: true, message: '没有开通心跳：不会有任何数据发出去，也不会写下同意记录',
      })
    }
    const { writeConsent } = await import('../heartbeat-consent.mjs')
    const r = writeConsent(layout, {
      who: String(value.who),
      ...(fs === undefined ? {} : { fs }),
    })
    if (r?.ok !== true) {
      return Object.freeze({ ok: false, message: `同意记录没有写成：${r?.message ?? '没有给出正面结论'}` })
    }
    return Object.freeze({
      ok: true,
      message: `已记录「${String(value.who)}」的同意（写在本机，不跟着配置文件走）`,
    })
  }
}

// product/heartbeat-consent.mjs
// ============================================================================
// PRT-713 收尾：**同意记录**的采集
//
// ## 原来的边界
//
// 行里写着：「没有同意流程（`consent` 由调用方传入，产品里没有界面或 CLI
// 采集它，PRT-707 向导是它的位置）」。
//
// 于是 `consent` 是一个**只有测试和假设能提供**的参数。而 `createHeartbeat`
// 里那道"没有同意就不发"的闸，因为没有人真的去采集同意，
// 它的实际效果是**永久关闭**——这恰好是安全的，所以没人会发现它是坏的。
//
//   > 一道"因为没有人能提供那个值、所以永远拦着"的闸，
//   > 与一道"真的拦得住"的闸，在用例里是同一个读数——
//   > 只不过前者会在有人**终于**接上同意流程的那一天，
//   > 变成"接上就直接开始发"。
//
// ## 这里为什么用文件 + 显式命令，而不是一个配置项
//
// 同意是「**谁**在**什么时候**同意了」这件事的记录。它必须来自用户在某个
// 具体时刻做的一个动作。放进配置文件有三个问题：
//
//   ① 配置文件会被复制、被同步、被模板化。一个跟着配置走的同意，
//      到了第二台机器上就变成"这台机器也同意了"，而**没有人在那台机器上同意过**；
//   ② 它是**可编辑的**，于是"同意"这个词退化成"这段文本存在"；
//   ③ 撤回（用户反悔）会变成"删掉一行 YAML"，而那与"从来没同意过"
//      在记录上无法区分。
//
// 所以：一个独立的记录文件、明确记下 who/when/version，且**撤回是写下一条
// 新的记录**（`revoked`），不是删文件——
// **一份被删掉的同意与一份从来没有过的同意，在事后排查时是同一个东西。**
// ============================================================================

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 同意记录的 schema 名。写进文件里，让"这是什么"不依赖文件名。 */
export const CONSENT_SCHEMA = 'legion.heartbeat-consent/1'

/** 同意记录文件在产品家目录下的位置。 */
export const CONSENT_FILENAME = 'heartbeat-consent.json'

/** 判定结果的码。 */
export const CONSENT_CODES = Object.freeze({
  /** 从未同意过（文件不存在，或只有撤回记录）。 */
  NEVER_CONSENTED: 'CONSENT_NEVER',
  /** 同意过，但后来撤回了。**与"从未同意"分开**。 */
  REVOKED: 'CONSENT_REVOKED',
  /** 同意记录读不出来（损坏/权限）。**与"从未同意"分开**： */
  UNREADABLE: 'CONSENT_UNREADABLE',
  /** 同意记录不合法（缺 who/at，或 schema 不认）。 */
  INVALID: 'CONSENT_INVALID',
})

/** 记录文件的路径。 */
export function consentPath(layout) {
  const home = layout?.productHome
  if (typeof home !== 'string' || home === '') return null
  return join(home, CONSENT_FILENAME)
}

/**
 * 读同意状态。**纯读**，不改任何东西。
 *
 * ★ 三个"没有有效同意"的原因必须分开：从未同意 / 撤回了 / 读不出来。
 *   合并成一个的话，一个**损坏的**同意文件会被读成"用户没同意过"，
 *   于是产品会安静地不发心跳——而用户明明同意过。
 *
 *   > 一个"把读不出来的记录当成没同意过"的实现，
 *   > 在用户看来与一个"忘了他的同意"的实现是同一个东西——
 *   > 只不过前者会在他重新同意之前一直不吭声。
 *
 * @returns {{consented: boolean, code: string|null, record: object|null, message: string}}
 */
export function readConsent(layout, { fs = null } = {}) {
  const p = consentPath(layout)
  if (p === null) {
    return Object.freeze({
      consented: false, code: CONSENT_CODES.NEVER_CONSENTED, record: null,
      message: '没有产品家目录，无法查同意记录',
    })
  }
  const io = fs ?? { existsSync, readFileSync }
  let text = null
  try {
    if (io.existsSync(p) !== true) {
      return Object.freeze({
        consented: false, code: CONSENT_CODES.NEVER_CONSENTED, record: null,
        message: '从未同意过（没有同意记录文件）',
      })
    }
    text = io.readFileSync(p, 'utf8')
  } catch (e) {
    return Object.freeze({
      consented: false, code: CONSENT_CODES.UNREADABLE, record: null,
      message: `同意记录读不出来：${e instanceof Error ? e.message : e}`,
    })
  }

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return Object.freeze({
      consented: false, code: CONSENT_CODES.UNREADABLE, record: null,
      message: `同意记录不是一个合法的 JSON：${e instanceof Error ? e.message : e}`,
    })
  }

  const r = validateConsentRecord(parsed)
  if (r.ok !== true) {
    return Object.freeze({
      consented: false, code: CONSENT_CODES.INVALID, record: parsed, message: r.message,
    })
  }
  if (r.record.revoked === true) {
    return Object.freeze({
      consented: false, code: CONSENT_CODES.REVOKED, record: r.record,
      message: `已于 ${r.record.revokedAt} 撤回（当初由 ${r.record.who} 于 ${r.record.at} 同意）`,
    })
  }
  return Object.freeze({
    consented: true, code: null, record: r.record,
    message: `${r.record.who} 于 ${r.record.at} 同意`,
  })
}

/**
 * 校验一条同意记录。
 *
 * 必填 `who`（谁）与 `at`（什么时候）——**这两样缺任何一个，"同意"都不是记录**，
 * 它只是一段文本。
 */
export function validateConsentRecord(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, message: '同意记录必须是一个对象' }
  }
  if (rec.schema !== CONSENT_SCHEMA) {
    return { ok: false, message: `同意记录的 schema 不认识：${JSON.stringify(rec.schema)}（期望 ${CONSENT_SCHEMA}）` }
  }
  if (typeof rec.who !== 'string' || rec.who.trim() === '') {
    return { ok: false, message: '同意记录缺 `who`：没有"谁"的话，这就不是一条同意' }
  }
  if (typeof rec.at !== 'string' || rec.at.trim() === '') {
    return { ok: false, message: '同意记录缺 `at`：没有"什么时候"的话，这就不是一条记录' }
  }
  if (rec.revoked === true && (typeof rec.revokedAt !== 'string' || rec.revokedAt.trim() === '')) {
    return { ok: false, message: '撤回记录缺 `revokedAt`' }
  }
  return { ok: true, record: rec }
}

/**
 * 写一条同意记录。**原子写**（先写临时文件再 rename）。
 *
 * 为什么要原子：写到一半断电会留下一个半截的 JSON，而它读出来是
 * `UNREADABLE`——于是用户**刚刚做过的一次同意**变成了"读不出来"。
 *
 * @returns {{ok: boolean, path: string|null, code?: string, message: string, record?: object}}
 */
export function writeConsent(layout, { who, now = () => new Date().toISOString(), fs = null, revoke = false } = {}) {
  const p = consentPath(layout)
  if (p === null) {
    return Object.freeze({ ok: false, path: null, message: '没有产品家目录，无法写同意记录' })
  }
  if (typeof who !== 'string' || who.trim() === '') {
    return Object.freeze({
      ok: false, path: p,
      message: '必须说清是**谁**同意的（`who` 不能为空）：一条没有署名的同意，事后无法查证',
    })
  }
  // ★ 这个默认 fs 里**必须有 `readFileSync`**：撤回路径要先把当前记录读回来
  //   （见下面的 `prev`），而 `readConsent` 会用它。
  //
  //   第一版漏了它，于是**撤回**永远失败，报的是
  //   「同意记录读不出来：io.readFileSync is not a function」——
  //   一句关于文件系统的抱怨，而真正的原因是这次调用的依赖清单不完整。
  //   更坏的是它**只影响撤回**：授予同意走的是另一条路，一切正常。
  //
  //     > 一个"只有撤回会失败"的同意流程，
  //     > 与一个"同意之后撤不回来"的同意流程，在用户看来是同一个东西——
  //     > 只不过前者会告诉他一个与真实原因无关的错误。
  const io = fs ?? { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync }

  // 撤回时保留原来的 who/at：**"谁在什么时候同意过、又在什么时候撤回"**
  // 是两条都要留下来的信息。删掉前一条的话，事后看到的就是
  // "这个人从来没同意过"——而那是**错的**。
  let prev = null
  if (revoke === true) {
    const cur = readConsent(layout, { fs: io })
    if (cur.consented !== true && cur.code !== CONSENT_CODES.REVOKED) {
      return Object.freeze({
        ok: false, path: p, code: cur.code ?? CONSENT_CODES.NEVER_CONSENTED,
        message: `没有可撤回的同意（${cur.message}）`,
      })
    }
    prev = cur.record
  }

  const at = now()
  const record = Object.freeze(revoke === true
    ? { ...prev, revoked: true, revokedAt: at, revokedBy: who }
    : { schema: CONSENT_SCHEMA, who: who.trim(), at, revoked: false })

  try {
    io.mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp-${process.pid}`
    io.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    io.renameSync(tmp, p)
  } catch (e) {
    return Object.freeze({
      ok: false, path: p,
      message: `写同意记录失败：${e instanceof Error ? e.message : e}`,
    })
  }

  return Object.freeze({
    ok: true, path: p, record,
    message: revoke === true
      ? `已撤回同意（${who} 于 ${at}）：后续不再发送任何心跳`
      : `已记录同意（${who} 于 ${at}）：心跳可以发送了`,
  })
}

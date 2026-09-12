// product/lifecycle/retention.mjs
// ============================================================================
// PRT-904：日志、执行事件与产物的**容量上限与保留策略**。
//
// spec §10 line 748。
//
// ## 为什么"保留最近 N 天"这句话本身不够
//
// 一条保留策略要回答两个方向的问题，而它们会打架：
//
//   · **时间**：多久以前的东西可以删；
//   · **容量**：总大小超过上限时必须删。
//
// 只有时间时，一次流量尖峰能把磁盘写满；只有容量时，一条安静的旧日志会永远留着。
// 所以策略必须**两种都表达**，且必须说清**先按哪个裁**。
//
// ## ★ 三个会安静出错的坑
//
// ### ① 算容量时只算一类
//
// 如果 `maxBytes` 的实现只统计日志、而报表把"当前用量"说成总用量，
// 那么事件与产物可以无限增长而报表显示一切正常。
//
//   > 一个「只对一个类做容量核算、却把结果当成总用量」的策略，
//   > 与一个「另外两类没有上限」的策略，是同一个东西——
//   > 只不过前者在报表上看起来是有上限的。
//
// ### ② 删掉最新而不是最旧
//
// 排序方向写反时，"删除最旧的直到低于上限"会变成"删除最新的"。
// 这个错误**不会**让任何东西报错——用量确实降下来了。
//
//   > 一个「删掉最新日志来降低占用」的保留策略，
//   > 与一个「把排障需要的那部分删掉、留下最没用的那部分」的策略，是同一个东西——
//   > 只不过它在"用量是否下降"这个指标上是完全成功的。
//
// ### ③ 删掉还被引用的东西
//
// 一个被**进行中**的 Run 引用的产物被保留策略删掉，Run 会在之后某一步失败，
// 而失败原因与保留策略之间隔了很远。
// ============================================================================

import { DATA_CLASSES, DATA_CLASS_IDS } from './data-classes.mjs'

/** 策略版本。改动默认值或判据时递增。 */
export const RETENTION_VERSION = 'legion/retention@1'

/** 受容量与保留策略约束的类。密钥、程序、工作区**不在**其中。 */
export const RETENTION_CLASSES = Object.freeze(['log', 'event', 'artifact'])

export const RETENTION_CODES = Object.freeze({
  /** 某个类没有上限。 */
  UNBOUNDED_CLASS: 'retention-unbounded-class',
  /** 用量超出上限且无法通过删除解决（比如被引用的产物）。 */
  CAP_UNREACHABLE: 'retention-cap-unreachable',
  /** 条目缺少必要字段。 */
  ENTRY_MALFORMED: 'retention-entry-malformed',
  /** 已过期但被进行中 Run 引用 —— 保留，并说明为什么没清。 */
  PINNED: 'retention-pinned-by-active-run',
})

/**
 * 默认策略。
 *
 * `maxBytes` 为 `null` 表示**不设上限**——这是一个必须**显式**写出来的值，
 * 而不是"忘了配"。缺席（`undefined`）在下面会被报成 `UNBOUNDED_CLASS`。
 */
export const DEFAULT_RETENTION = Object.freeze({
  log: Object.freeze({ maxAgeDays: 30, maxBytes: 512 * 1024 * 1024 }),
  event: Object.freeze({ maxAgeDays: 30, maxBytes: 1024 * 1024 * 1024 }),
  artifact: Object.freeze({ maxAgeDays: null, maxBytes: 4 * 1024 * 1024 * 1024 }),
})

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 计算一份保留计划。
 *
 * @param {object} args
 * @param {ReadonlyArray<{id: string, classId: string, path: string, bytes: number, atMs: number, referencedBy?: ReadonlyArray<string>}>} args.entries
 * @param {object} [args.policy]
 * @param {number} args.nowMs
 * @param {ReadonlyArray<string>} [args.activeRefs] 仍被进行中 Run 引用的 id
 * @returns {{version: string, delete: ReadonlyArray<object>, keep: ReadonlyArray<object>,
 *            findings: ReadonlyArray<object>, usageByClass: object, capByClass: object}}
 */
export function planRetention({ entries = [], policy = DEFAULT_RETENTION, nowMs, activeRefs = [] } = {}) {
  const findings = []
  const active = new Set(activeRefs)

  if (!Number.isFinite(nowMs)) {
    // 没有"现在"就无法判断"多久以前"。返回空计划 + 一条 finding，
    // **不**猜一个当前时间：猜错方向的后果是删掉不该删的。
    return Object.freeze({
      version: RETENTION_VERSION,
      delete: Object.freeze([]),
      keep: Object.freeze([...entries]),
      findings: Object.freeze([Object.freeze({
        code: RETENTION_CODES.ENTRY_MALFORMED,
        detail: '没有给 nowMs，无法判断"多久以前"——不猜当前时间，什么都不删',
      })]),
      usageByClass: Object.freeze({}),
      capByClass: Object.freeze({}),
    })
  }

  // ① 策略健全性：受约束的类都必须有上限，且必须**显式**（null 是"故意不设"，undefined 是"忘了配"）。
  for (const cls of RETENTION_CLASSES) {
    const p = policy[cls]
    if (p === undefined) {
      findings.push(Object.freeze({
        code: RETENTION_CODES.UNBOUNDED_CLASS,
        classId: cls,
        detail: `${cls} 没有保留策略——"忘了配"与"故意不设上限"必须区分，前者会无界增长`,
      }))
      continue
    }
    if (p.maxBytes === undefined || p.maxAgeDays === undefined) {
      findings.push(Object.freeze({
        code: RETENTION_CODES.UNBOUNDED_CLASS,
        classId: cls,
        detail: `${cls} 的策略缺少 maxBytes 或 maxAgeDays；不设上限要显式写 null`,
      }))
    }
  }

  const usageByClass = {}
  const capByClass = {}
  for (const cls of RETENTION_CLASSES) {
    usageByClass[cls] = entries.filter((e) => e.classId === cls).reduce((a, e) => a + (e.bytes ?? 0), 0)
    capByClass[cls] = policy[cls]?.maxBytes ?? null
  }

  const del = []
  const keep = []

  const byClass = new Map(RETENTION_CLASSES.map((c) => [c, []]))
  for (const e of entries) {
    if (byClass.has(e.classId)) byClass.get(e.classId).push(e)
    else keep.push(e)   // 不受保留策略约束的类一律保留
  }

  for (const cls of RETENTION_CLASSES) {
    const p = policy[cls]
    const list = byClass.get(cls)
    // ★ ② 排序方向：**最旧的在前**。"从最旧的开始删"必须写死在这里，
    //    写反了不会报错，只会把最有用的删掉。
    list.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0))

    const doomed = new Set()
    let total = list.reduce((a, e) => a + (e.bytes ?? 0), 0)

    // ★ 被进行中 Run 引用的条目**在任何一条规则下都不删**。
    //
    //   第一版只在**容量**那一轮里做了这个判断，漏了**时间**那一轮——
    //   于是"超过 30 天的产物"照样被删掉，哪怕它正被一个进行中的 Run 用着。
    //   用例把它打红了。这是本文件头 ③ 的原型：
    //
    //   > 一个「在两条删除规则里只有一条做了引用检查」的保留策略，
    //   > 与一个「按时间清掉的正好是还在用的那个」的策略，是同一个东西——
    //   > 只不过它在容量那一条规则上是完全正确的。
    const isPinned = (entry) => active.has(entry.id) || (entry.referencedBy ?? []).some((r) => active.has(r))

    // 先按时间裁：超过 maxAgeDays 的删掉。
    if (p !== undefined && p.maxAgeDays !== null) {
      const cutoff = nowMs - p.maxAgeDays * DAY_MS
      for (const entry of list) {
        if (!((entry.atMs ?? 0) < cutoff)) continue
        if (isPinned(entry)) {
          // 报出来：留着它是对的，但"为什么这一条没被清掉"必须可解释，
          // 否则下一个人会以为时间规则没生效。
          findings.push(Object.freeze({
            code: RETENTION_CODES.PINNED,
            classId: cls,
            id: entry.id,
            detail: `${cls} 的 ${entry.id} 已过期，但被进行中的 Run 引用——保留，等它结束后再清`,
          }))
          continue
        }
        doomed.add(entry.id)
        total -= entry.bytes ?? 0
      }
    }

    // 再按容量裁：仍然超上限时，从**剩下的最旧的**继续删。
    if (p !== undefined && p.maxBytes !== null && total > p.maxBytes) {
      for (const entry of list) {
        if (total <= p.maxBytes) break
        if (doomed.has(entry.id)) continue
        if (isPinned(entry)) continue
        doomed.add(entry.id)
        total -= entry.bytes ?? 0
      }
      if (total > p.maxBytes) {
        findings.push(Object.freeze({
          code: RETENTION_CODES.CAP_UNREACHABLE,
          classId: cls,
          detail: `${cls} 删无可删仍然超出上限（${total} > ${p.maxBytes}）——` +
            '剩下的都被进行中的 Run 引用，或本来就是不可回收的条目',
          remainingBytes: total,
          capBytes: p.maxBytes,
        }))
      }
    }

    for (const e of list) {
      const target = doomed.has(e.id) ? del : keep
      target.push(Object.freeze({
        id: e.id,
        classId: e.classId,
        path: e.path,
        bytes: e.bytes ?? 0,
        // 留下依据，报表才能解释"为什么删它"
        reason: doomed.has(e.id)
          ? (active.has(e.id) ? '不应出现' : '超过保留窗口或容量上限')
          : '在保留窗口内且未超上限',
      }))
    }
  }

  return Object.freeze({
    version: RETENTION_VERSION,
    delete: Object.freeze(del),
    keep: Object.freeze(keep),
    findings: Object.freeze(findings),
    usageByClass: Object.freeze(usageByClass),
    capByClass: Object.freeze(capByClass),
    // 计算出来的总量——**不是**某一个类的用量被当成总量（坑①）。
    usageTotal: Object.freeze({
      bytes: Object.values(usageByClass).reduce((a, b) => a + b, 0),
      classes: RETENTION_CLASSES.length,
      // 没有上限的类必须在这里能被看见，否则"总用量正常"是一句空话。
      unbounded: Object.freeze(RETENTION_CLASSES.filter((c) => (policy[c]?.maxBytes ?? null) === null)),
    }),
  })
}

/**
 * 把计划翻成"每一个受约束的类都有上限"的断言。
 * 单独一个函数，因为它是 PRT-904 真正要保证的那句话。
 */
export function assertRetentionBounded(policy = DEFAULT_RETENTION) {
  const problems = []
  for (const cls of RETENTION_CLASSES) {
    const p = policy[cls]
    if (p === undefined) { problems.push(`${cls} 缺策略`); continue }
    const hasAge = p.maxAgeDays !== undefined
    const hasBytes = p.maxBytes !== undefined
    if (!hasAge || !hasBytes) { problems.push(`${cls} 缺少 maxAgeDays 或 maxBytes（不设请显式写 null）`) }
    if (p.maxAgeDays === null && p.maxBytes === null) {
      problems.push(`${cls} 两个维度都不设上限——这一类的增长完全不受约束`)
    }
  }
  // 不受保留策略约束的类必须是"本来就不该被删"的那些。
  for (const cls of DATA_CLASS_IDS) {
    if (RETENTION_CLASSES.includes(cls)) continue
    if (!['program', 'config', 'database', 'cache', 'secret', 'workspace'].includes(cls)) {
      problems.push(`分类 ${cls} 既不在保留策略里，也不是"本来就不该被删"的类`)
    }
  }
  if (DATA_CLASSES.log.onUninstall !== 'keep' && DATA_CLASSES.log.onUninstall !== 'remove') {
    problems.push('log 类的卸载动作异常')
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems), classes: RETENTION_CLASSES })
}

export const RETENTION_CHECKED = assertRetentionBounded()

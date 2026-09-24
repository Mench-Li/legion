/**
 * 台账里非 ✅ 的每一行：**卡在"人"，还是卡在"我"？**
 *
 * ★ 起因：本会话已连续多轮在"没有可解锁的功能项"上做验证性工作。
 *   本仓的 `exp-t092` 纪律正是针对这件事：
 *   **多轮空转多为"目标已被上游验证"所致，不是任务失败或卡死**——
 *   但那句话的适用前提是"确实没有新增增量"。
 *
 * ⇒ 所以这个脚本**不猜**，只把每一行的原文摆出来，并按"缺什么"分类：
 *   · EXTERNAL —— 要业主裁定 / 真实外部用户 / 真实用户项目 / 日期闸门
 *     （这些**不可能**因为再跑一轮而改变）
 *   · INTERNAL —— 台账/文档里能看出**还有活可干**（我能做的）
 *   · UNCLEAR  —— 读不出来，需要人看一眼
 *
 * ⚠️ 分类靠**关键词**，所以它只是**索引**，不是结论。
 *   每一行下面都把原文印出来，让人能自己改判——分类错的时候不至于被藏起来。
 */
import { readFileSync } from 'node:fs'

const LEDGER = 'docs/superpowers/prt/PRT-PROGRESS.md'
const lines = readFileSync(LEDGER, 'utf8').split('\n')
const rows = []
for (let i = 0; i < lines.length; i++) {
  // ★ 必须先去掉行尾的 `\r`：本仓工作树是 CRLF，而 JS 的 `.` **不匹配 `\r`**
  //   ⇒ 下面那个 `(.*)$` 在 CRLF 文件上永远匹配不到。
  //   ⚠️ 我第一版就是这样：脚本**一行都没解析出来**，却打印"没有非 ✅ 行"——
  //   而"台账全绿"与"我的正则根本没匹配上"在输出里长得一模一样。
  const line = lines[i].replace(/\r$/, '')
  const m = /^\|\s*(PRT-\d+[^|]*?)\s*\|\s*(✅|🟡|⬜|⏸|⏳)\s*\|(.*)$/.exec(line)
  if (m) rows.push({ line: i + 1, id: m[1].trim(), status: m[2], body: m[3] })
}

// ★ 解析自检：解析不出任何行时**必须报出来**，不许静默走向"没有非 ✅ 行"。
//   *一个"台账很干净"与一个"我的正则坏了"，在只打印结论的脚本里是同一个输出。*
if (rows.length === 0) {
  console.log('★★ 一行都没解析出来 ⇒ **脚本坏了**，不是"台账全绿"。')
  console.log('   上面那行"=== 台账 0 行"不能读成"没有非 ✅ 行"。')
  process.exit(1)
}

const by = {}
for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1

console.log(`\n=== 台账 ${rows.length} 行：${JSON.stringify(by)} ===\n`)

/** 只有人能给的东西（再跑一轮也不会变）。 */
const EXTERNAL_MARKERS = [
  ['业主裁定', /业主|项目主裁定|待裁决|待人工/],
  ['真实外部用户', /真实外部用户|真实用户参与|外部用户/],
  ['真实用户项目', /真实用户项目|真实项目/],
  ['日期闸门', /日期|周后|天后再|观察期|2026-\d\d-\d\d/],
]

const nonDone = rows.filter((r) => r.status !== '✅')
if (nonDone.length === 0) {
  console.log('★ 没有非 ✅ 行。')
}

for (const r of nonDone) {
  const hits = EXTERNAL_MARKERS.filter(([, re]) => re.test(r.body)).map(([n]) => n)
  const verdict = hits.length > 0 ? `EXTERNAL（${hits.join('、')}）` : 'UNCLEAR —— 要人看一眼'
  console.log(`── ${r.id}  [${r.status}]  ${verdict}   (L${r.line})`)
  // 印出与"卡在哪"最相关的那一段：找关键词前后各 200 字
  let seg = r.body
  for (const [, re] of EXTERNAL_MARKERS) {
    const m = re.exec(r.body)
    if (m && m.index > 0) { seg = r.body.slice(Math.max(0, m.index - 200), m.index + 260); break }
  }
  const text = seg.replace(/\s+/g, ' ').trim()
  console.log(`     …${text.slice(0, 420)}…`)
  console.log('')
}

console.log('⚠️ 分类靠关键词 ⇒ 只是**索引**。上面每行都印了原文，请以原文为准。')

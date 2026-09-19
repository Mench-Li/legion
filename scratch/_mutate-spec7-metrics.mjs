// scratch/_mutate-spec7-metrics.mjs —— 变异：§7 指标与数据源（第 39 轮）（**不提交**）
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const MOD = `${ROOT}/product/metrics-spec7.mjs`
const SRC = `${ROOT}/product/metrics-spec7-source.mjs`
const TEST = 'product/metrics-spec7.test.mjs'

const origMod = readFileSync(MOD, 'utf8')
const origSrc = readFileSync(SRC, 'utf8')
let all = true

const green = () => {
  try {
    return /ℹ fail 0/.test(execFileSync('node', ['--test', TEST], { cwd: ROOT, encoding: 'utf8' }))
  } catch (e) { return /ℹ fail 0/.test(String(e.stdout ?? '') + String(e.stderr ?? '')) }
}

/** 变异打在**声明式**的文件上（`mut`）。 */
function mut(name, find, repl) {
  if (!origMod.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(MOD, origMod.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(MOD, origMod, 'utf8')
}

/** 变异打在**数据源**上（SQL / 兜底），这是这一轮最要紧的一类。 */
function mutSrc(name, find, repl) {
  if (!origSrc.includes(find)) { console.log(`⚠ ${name}: 变异串没找到`); all = false; return }
  writeFileSync(SRC, origSrc.replace(find, repl), 'utf8')
  const g = green()
  if (g) all = false
  console.log(`${g ? '✖ 漏网' : '✓ 咬住'} ${name}`)
  writeFileSync(SRC, origSrc, 'utf8')
}

try {
  // ── 一类：把"零"与"没有"弄成同形（本仓反复防的那件事）──
  // ★ 这两条的守卫在**声明模块**里（`metrics-spec7.mjs`），所以用 `mut` 而不是 `mutSrc`。
  //   第一版我打错了文件，于是变异"没找到"——而"没找到变异串"与"变异被咬住"
  //   在输出上都是"没有漏网"，只是前者会打一行 ⚠。
  mut('S1 分母为 0 时**兜底成 0%**（"还没观察过"变成"零失败"）',
    '      if (!isDenominator(den)) {', '      if (false) {')

  mut('S2 字段缺失时**兜底成 0**（读不出来变成"读数是零"）',
    '      if (!isReading(num) || !isReading(den)) {', '      if (false) {')

  mutSrc('S3 表不存在时**照样往 snapshot 里塞 0**（"没这张表"与"表是空的"同形）',
    '  } else {\n    missing.push(...[\'event-loss-rate\', \'event-duplicate-rate\'].map(',
    "  } else if (false) {\n    missing.push(...['event-loss-rate', 'event-duplicate-rate'].map(")

  // ── 二类：把分子分母换成**不同的人群**（比率失去含义）──
  mutSrc('S4 事件漏投率的**分母换成全部投递行**（把还在 pending 的也算进"终态"）',
    "      `SELECT COUNT(*) AS n FROM event_deliveries WHERE state IN (${inTerminal})${where}`,",
    "      `SELECT COUNT(*) AS n FROM event_deliveries WHERE 1=1${where}`,")

  mutSrc('S5 预算超限率的**分母换成全部预留行**（把还没花过钱的 held 也算进去）',
    "      `SELECT COUNT(*) AS n FROM budget_reservations WHERE spent_amount IS NOT NULL${where}`, ...p)",
    "      `SELECT COUNT(*) AS n FROM budget_reservations WHERE 1=1${where}`, ...p)")

  mutSrc('S6 Run 恢复率的**分子分母换成"尝试"而不是"任务"**（一个任务丢两次算两次）',
    "      `SELECT COUNT(DISTINCT task_id) AS n FROM run_attempts\n        WHERE failure_code = 'lease-expired'${where}`",
    "      `SELECT COUNT(*) AS n FROM run_attempts\n        WHERE failure_code = 'lease-expired'${where}`")

  // ★ 这一条原本我写成了 find === repl（一个**假变异体**：两个版本行为完全相同，
  //   它永远不会"咬住"，而"没咬住"会被误读成"判据漏网"）。改成真的去掉一档。
  //   > 一个 find 与 repl 相同的变异体，与一个真的没被咬住的变异体，
  //   > 在输出上长得一模一样——只不过前者的"漏网"是假的。
  mutSrc('S7 审批"没有批准"那一档**丢掉越期**（"等到过期"不算没批准）',
    "export const APPROVAL_NOT_APPROVED = Object.freeze(['denied', 'expired'])",
    "export const APPROVAL_NOT_APPROVED = Object.freeze(['denied'])")

  // ── 三类：把"如实报出来"改成"静默丢掉" ──
  mutSrc('S8 时间戳解析不了的行**静默丢掉**（中位数悄悄失去分母）',
    '      if (a === null || b === null || b < a) { unparsed += 1; continue }',
    '      if (a === null || b === null || b < a) { continue }')

  mutSrc('S9 中位数空数组**兜底成 0**（而不是 null）',
    '  if (xs.length === 0) return null', '  if (xs.length === 0) return 0')

  // ── 四类：声明侧 ──
  mut('M1 `approval-wait-ms` 去掉 `valueFrom`（生产者喂了数而这一格永远显示「—」）',
    "    valueFrom: 'approvalWaitP50Ms',\n", '')

  mut('M2 审批等待的 `dependsOn` 去掉（判据字段读不出来时照样判"适不适用"）',
    "    dependsOn: Object.freeze(['approvalsDecided']),\n", '')

  mut('M3 把"商业 Alpha"那一格从 §7 的要求里摘掉（六条要求少一条没人管）',
    "    metrics: Object.freeze(['alpha-cycle-days']),", '    metrics: Object.freeze([]),')

  mut('M4 某一格偷偷混进 §6.6 那张表（第二张表变成了第二套纪律）',
    "export const SPEC7_METRIC_KEYS = Object.freeze(Object.keys(SPEC7_METRIC_DEFS))",
    "export const SPEC7_METRIC_KEYS = Object.freeze([...Object.keys(SPEC7_METRIC_DEFS), 'queue-depth'])")
} finally {
  writeFileSync(MOD, origMod, 'utf8')
  writeFileSync(SRC, origSrc, 'utf8')
}

console.log(`\n全部咬住 ? ${all}`)
console.log(`声明逐字还原 ? ${readFileSync(MOD, 'utf8') === origMod}`)
console.log(`数据源逐字还原 ? ${readFileSync(SRC, 'utf8') === origSrc}`)
console.log(`还原后判据仍绿 ? ${green()}`)

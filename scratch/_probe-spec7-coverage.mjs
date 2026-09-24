// scratch/_probe-spec7-coverage.mjs —— 目标文档 §7 点名的每一条测试要求，套件里有没有真落点（**不提交**）
//
// ★ 方法上的诚实：这是**关键词**检索，关键词命中 **不等于** 那条要求被真的覆盖了
//   （第 31 轮的教训：一个"看起来像发现"的读数，可能只是检索器不懂惯例）。
//   所以本探针的输出要当**线索**读，每一条都还要打开文件看一眼。
import { execFileSync } from 'node:child_process'

const grep = (pat) => {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pat, '--', '*.test.mjs'], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}
const count = (pat) => {
  try {
    return execFileSync('git', ['grep', '-c', '-E', pat, '--', '*.test.mjs'], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').filter(Boolean).length
  } catch { return 0 }
}

const FAULTS = [
  ['Runtime 崩溃', 'RUNTIME_CRASHED|runtimeCrash|崩溃'],
  ['网络中断', 'ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|网络中断|networkDown|fetch 失败'],
  ['重复事件', '重复事件|duplicate|dedup|去重|lastEventId|Last-Event-ID'],
  ['审批超时', '审批超时|approvalTimeout|approval.*timeout|timeout.*approval'],
  ['凭证缺失', 'SECRET_UNAVAILABLE|SECRET_NOT_FOUND|凭证缺失|credential.*missing|missing.*credential'],
  ['预算耗尽', '预算耗尽|budgetExhaust|BUDGET_EXHAUSTED|budget.*exceed|超限'],
  ['升级失败', '升级失败|upgrade.*fail|fail.*upgrade|rollback|回滚'],
]
const SECURITY = [
  ['hard floor', 'hardFloor|hard-floor|hard_floor|不可绕过'],
  ['approval fail closed', 'failClosed|fail-closed|fail closed|拒绝即关闭|缺省拒绝'],
  ['sandbox 能力不足', 'sandbox.*(partial|不足|enforcement)|enforcement.*partial|能力不足'],
  ['密钥脱敏', 'redact|脱敏|REDACTED'],
  ['路径越权', '路径越权|pathScope|path.*escape|越权|\\.\\.'],
  ['网络越权', '网络越权|externalApi|network.*(deny|scope)|出站'],
]

for (const [title, list] of [['故障注入（§7 第 3 条，7 项）', FAULTS], ['安全（§7 第 4 条，5 项）', SECURITY]]) {
  console.log(`\n=== ${title} ===`)
  for (const [name, pat] of list) {
    const files = grep(pat)
    const mark = files.length === 0 ? '✖ 零命中' : `✔ ${files.length} 套`
    console.log(`${mark.padEnd(12)} ${name.padEnd(22)} ${files.slice(0, 4).join('、')}${files.length > 4 ? ' …' : ''}`)
  }
}

// scratch/_probe-s7-metrics.mjs —— spec §7 第 6 条那 6 个指标：有没有落点（**不提交**）
import { execFileSync } from 'node:child_process'

const REPO = 'D:/project/DSH/legion'
const grepFiles = (pat, globs = ['*.mjs', '*.ts']) => {
  try {
    return execFileSync('git', ['grep', '-l', '-I', '-E', pat, '--', ...globs],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}

// §7 第 6 条逐字列出的 6 个「持续观察」指标
const METRICS = [
  ['事件遗漏/重复率', 'eventLoss|missing.*event|遗漏|duplicateRate|重复率|dedup.*rate'],
  ['Run 恢复率', 'recoveryRate|恢复率|recovered.*rate|runRecovery'],
  ['审批等待与拒绝率', 'approvalWait|等待.*审批|approvalDeniedRate|拒绝率|approvalRate'],
  ['预算超限率', 'budgetOverrun|超限率|budgetExceededRate|overrunRate'],
  ['升级回滚成功率', 'rollbackRate|回滚成功率|upgradeSuccessRate'],
  ['商业 Alpha 交付周期', 'alphaCycle|交付周期|leadTime|cycleTime|deliveryCycle'],
]

console.log('spec §7 第 6 条：「持续观察」6 个指标\n')
for (const [name, pat] of METRICS) {
  const files = grepFiles(pat)
  const tests = files.filter((f) => f.includes('.test.'))
  console.log(`【${name}】命中 ${files.length} 个文件（用例 ${tests.length}）`)
  for (const f of files.slice(0, 5)) console.log(`    ${f}`)
  if (files.length === 0) console.log('    （零命中）')
}

// 有没有一个"指标/度量"出口（HTTP 路由或模块）
console.log('\n=== 有没有"指标出口"这种东西 ===')
for (const pat of ['/api/metrics', 'metricsReport|metricsSnapshot', 'observability', '指标汇总|度量汇总']) {
  const f = grepFiles(pat, ['*.mjs'])
  console.log(`  ${pat}  →  ${f.length ? f.slice(0, 4).join('、') : '（零命中）'}`)
}

#!/usr/bin/env node
// team-hub/scripts/run-regression-cases.mjs
// ============================================================================
// F9 · CI 跑 active 回归集（设计稿 §8.4 M7-3）
//
//   node team-hub/scripts/run-regression-cases.mjs            # 只打印 CI 会跑什么
//   node team-hub/scripts/run-regression-cases.mjs --execute   # 真的跑
//
// 退出码：0 = 全部通过（或没有 active 用例）；1 = 有用例失败；2 = 运行本身出错。
//
// ★ 两条安全边界
//   ① 默认**只打印不执行**：库里存的命令，先让人看一眼再跑；
//   ② `--execute` 时不开 shell（argv 直接切分），避免 `;` / `|` / 重定向被当成语法执行。
//      代价是 glob 不展开——回归命令请写成明确的文件列表或由测试框架自己发现。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { ensureDecisionSchema } from '../decisions.mjs'
import { ensureRegressionSchema, planRun } from '../regression-store.mjs'

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(`--${name}=`.length)
}

const dbFile = argOf('db') ?? process.env.TEAM_HUB_DB ?? join(process.cwd(), 'team.db')
const execute = process.argv.includes('--execute')
const SHELL_META = /[;&|<>`$(){}]/

const db = new DatabaseSync(dbFile)
try {
  ensureDecisionSchema(db)
  ensureRegressionSchema(db)
  const { planned, skipped } = planRun(db, { state: 'active' })

  if (!execute) {
    process.stdout.write(JSON.stringify({
      db: dbFile, executed: false, planned, skipped,
      hint: '加 --execute 才会真的跑',
    }, null, 2) + '\n')
  } else {
    const results = []
    let failed = 0
    for (const item of planned) {
      if (SHELL_META.test(item.command)) {
        results.push({ id: item.id, skipped: 'shell-meta' })
        continue
      }
      const [ bin, ...args ] = item.command.split(/\s+/).filter(Boolean)
      const run = spawnSync(bin, args, { stdio: 'inherit' })
      const ok = run.status === 0
      if (!ok) failed += 1
      results.push({ id: item.id, ok, status: run.status })
    }
    process.stdout.write(JSON.stringify({ db: dbFile, executed: true, results, failed }, null, 2) + '\n')
    if (failed > 0) process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`run-regression-cases 失败：${error?.message ?? error}\n`)
  process.exitCode = 2
} finally {
  try { db.close() } catch { /* 已关闭 */ }
}

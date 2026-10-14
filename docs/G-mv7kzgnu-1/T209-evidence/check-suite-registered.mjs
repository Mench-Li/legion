// docs/G-mv7kzgnu-1/T209-evidence/check-suite-registered.mjs
// TC-S2-06 / TC-S2-12 的机械判据：新增套件 external-avatar-parity.test.mjs 是否登记进 CI 套件清单。
// 退出码 0 = 已登记（PASS）；退出码 1 = 套件清单不完备（FAIL，点名该文件）。
import { readFileSync } from 'node:fs'
const TARGET = 'external-avatar-parity.test.mjs'
const src = readFileSync('scripts/ci/run-ci.mjs', 'utf8')
if (!src.includes(TARGET)) {
  console.error('FAIL 套件清单不完备：' + TARGET + ' 不会被任何套件执行（等于不存在的断言）')
  process.exit(1)
}
console.log('PASS 套件清单完备：' + TARGET + ' 已登记进 scripts/ci/run-ci.mjs')

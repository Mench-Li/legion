// scratch/_probe-spec-citations.mjs —— 目标文档自己引的落点，逐个看**在不在**（**不提交**）
import { existsSync } from 'node:fs'
const ROOT = 'D:/project/DSH/legion/'
const all = [
  // §1.1 阶段表「可核对落点」列
  ['§1.1 L27', 'scripts/prt/'], ['§1.1 L27', 'docs/superpowers/prt/'],
  ['§1.1 L27', 'scripts/ci/run-ci.mjs'],
  ['§1.1 L28', 'runtime/contracts/'],
  ['§1.1 L29', 'runtime/adapters/dsh/'], ['§1.1 L29', 'runtime/dsh-composition/'],
  ['§1.1 L31', 'plugins/src/index.ts'],
  ['§1.1 L32', 'docs/STATUS.md'],
  // §8 「Legion 现有参考」列
  ['§8 L277', 'team-hub/server.mjs'], ['§8 L277', 'workbench/src/hubEventStream.ts'],
  ['§8 L278', 'team-hub/permission-engine.mjs'],
  ['§8 L279', 'plugins/src/index.ts'],
  ['§8 L280', 'plugins/src/experienceRecall.ts'],
  ['§8 L281', 'services-plugin/'],
  // §1.2 依据列
  ['§1.2 L55', 'RUNTIME_STATES'],
  ['§1.2 L56', 'event-delivery.test.mjs'],
]
for (const [where, p] of all) {
  const e = existsSync(ROOT + p.replace(/\\/g, '/'))
  console.log(`  ${e ? '✔' : '✖ 不存在'}  ${where.padEnd(10)} ${p}`)
}

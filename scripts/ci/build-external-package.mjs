#!/usr/bin/env node
/** Cross-platform builder for packages generated from the DSH host checkout. */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ★ 候选列表只有**一份**：以前这里自己列了五条，与 `dsh-pin-drift.mjs`、
//   `tests/p13-fixture/host-fixture.mjs` 各写一份，而那个 Windows 字面量
//   三处大小写不一致（win32 上路径不区分大小写，所以**今天看不出来**）。
import { resolveDshCheckout } from '../lib/dsh-checkout.mjs'

const packageName = process.argv[2]
const configs = {
  plugins: [['cordis','vendor/cordis'],['@deepseek-ai/cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['schemastery','vendor/schemastery'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-tools','packages/core/tools'],['@deepseek-ai/dsh-llm','packages/llm/llm'],['@deepseek-ai/dsh-system-prompt','packages/core/system-prompt'],['@deepseek-ai/dsh-agent','packages/core/agent'],['@deepseek-ai/dsh-agent-default-model','packages/core/agent-default-model'],['@deepseek-ai/dsh-agent-presets','packages/preset/agent-presets'],['@deepseek-ai/dsh-session','packages/core/session'],['@deepseek-ai/dsh-subagent','packages/subagent/subagent'],['@types/node','node_modules/@types/node']],
  'team-hub': [['cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['schemastery','vendor/schemastery'],['@deepseek-ai/cordis','vendor/cordis'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-host-webserver','packages/host/webserver'],['@types/node','node_modules/@types/node']],
  'board-plugin': [['cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['schemastery','vendor/schemastery'],['@deepseek-ai/cordis','vendor/cordis'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-host-webserver','packages/host/webserver'],['@deepseek-ai/dsh-client-ui-slots','packages/client/ui-slots'],['@types/node','node_modules/@types/node']],
}
if (!configs[packageName]) throw new Error(`unknown external package: ${packageName || '(missing)'}`)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkgDir = join(root, packageName)
const found = resolveDshCheckout({ need: 'packages' })
const checkout = found.checkout
if (checkout === null) {
  // 保留"退出 1"（这是个构建门禁，不是核对命令），但理由说出**哪一种**缺失。
  console.error(`build: cannot locate the dsh checkout. ${found.reason}`)
  process.exit(1)
}
const tsc = join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) { console.error(`build: tsc not found at ${tsc}; install dependencies in ${checkout}`); process.exit(1) }
for (const [name, rel] of configs[packageName]) {
  const target = join(checkout, rel), link = join(pkgDir, 'node_modules', name)
  if (!existsSync(target)) throw new Error(`build: dependency target missing: ${target}`)
  rmSync(link, { recursive: true, force: true }); mkdirSync(dirname(link), { recursive: true }); symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}
const result = spawnSync(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.json')], { cwd: pkgDir, stdio: 'inherit' })
process.exit(result.status ?? 1)

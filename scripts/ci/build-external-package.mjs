#!/usr/bin/env node
/** Cross-platform builder for packages generated from the DSH host checkout. */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ★ 候选列表只有**一份**：以前这里自己列了五条，与 `dsh-pin-drift.mjs`、
//   `tests/p13-fixture/host-fixture.mjs` 各写一份，而那个 Windows 字面量
//   三处大小写不一致（win32 上路径不区分大小写，所以**今天看不出来**）。
import { resolveDshCheckout } from '../lib/dsh-checkout.mjs'

/**
 * 每个外部包的 DSH 侧依赖：`[symlink 名, 检出里的相对路径]`。
 *
 * ★★ T10（2026-09-24）**导出**它，为的是让"这些路径今天还在不在"能被一条判据核
 *    （`scripts/probes/build-targets-exist.mjs`）。
 *
 *    此前没人核过。于是 DSH 把 `dsh-agent-presets` **拆成** `dsh-agent-preset` +
 *    `dsh-agent-preset-registry` 之后，本文件仍指着已经不存在的
 *    `packages/preset/agent-presets` —— 而**读到它的每一处都在报"缺这个包"**，
 *    于是"DSH 升级把路径挪了"这件事被读成了"这个能力缺失"。
 */
export const configs = {
  plugins: [['cordis','vendor/cordis'],['@deepseek-ai/cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['schemastery','vendor/schemastery'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-tools','packages/core/tools'],['@deepseek-ai/dsh-llm','packages/llm/llm'],['@deepseek-ai/dsh-system-prompt','packages/core/system-prompt'],['@deepseek-ai/dsh-agent','packages/core/agent'],['@deepseek-ai/dsh-agent-default-model','packages/core/agent-default-model'],['@deepseek-ai/dsh-agent-preset-registry','packages/preset/agent-preset-registry'],['@deepseek-ai/dsh-session','packages/core/session'],['@deepseek-ai/dsh-subagent','packages/subagent/subagent'],['@types/node','node_modules/@types/node']],
  'team-hub': [['cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['schemastery','vendor/schemastery'],['@deepseek-ai/cordis','vendor/cordis'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-host-webserver','packages/host/webserver'],['@types/node','node_modules/@types/node']],
  'board-plugin': [['cordis','vendor/cordis'],['cosmokit','vendor/cosmokit'],['schemastery','vendor/schemastery'],['@deepseek-ai/cordis','vendor/cordis'],['@deepseek-ai/schemastery','vendor/schemastery'],['@deepseek-ai/dsh-host-webserver','packages/host/webserver'],['@deepseek-ai/dsh-client-ui-slots','packages/client/ui-slots'],['@types/node','node_modules/@types/node']],
}

/**
 * 某个外部包的依赖目标在检出里的**逐个**现状。
 *
 * ★ 判据与构建**共用这一份**：否则又会变成"判据核的名单"与"构建用的名单"各写一份
 *   （本仓为此付过学费，见上面那段注释）。
 */
export function dependencyTargets(packageName, checkout) {
  const spec = configs[packageName]
  if (spec === undefined) throw new Error(`unknown external package: ${packageName || '(missing)'}`)
  if (checkout === null || checkout === undefined) throw new Error('dependencyTargets: checkout required')
  return spec.map(([name, rel]) => {
    const target = join(checkout, rel)
    return { name, rel, target, exists: existsSync(target) }
  })
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const packageName = process.argv[2]
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
  for (const { name, target } of dependencyTargets(packageName, checkout)) {
    const link = join(pkgDir, 'node_modules', name)
    if (!existsSync(target)) throw new Error(`build: dependency target missing: ${target}`)
    rmSync(link, { recursive: true, force: true }); mkdirSync(dirname(link), { recursive: true }); symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const result = spawnSync(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.json')], { cwd: pkgDir, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

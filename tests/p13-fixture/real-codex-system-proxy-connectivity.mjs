/**
 * Manual target-node connectivity acceptance for DSH's Codex provider.
 *
 * Run from the DSH checkout:
 *   pnpm exec node D:/project/DSH/legion/tests/p13-fixture/real-codex-system-proxy-connectivity.mjs
 *
 * Uses the current local Codex authentication, `systemProxyMode: system`, a
 * read-only prompt, and a disposable empty working directory. It does not read
 * or print credential values, touch a repository, or create a Legion Attempt.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

const found = resolveDshCheckout({ need: 'cli' })
if (!found.checkout) throw new Error(`DSH checkout unavailable: ${found.reason}`)
const dshRequire = createRequire(join(found.checkout, 'packages/subagent/subagent-codex/package.json'))
const importDsh = async (name) => import(pathToFileURL(dshRequire.resolve(name)).href)

const [{ Context }, { default: SubagentRuntime }, { default: SessionProjectionRegistry },
  { default: LocalSubprocessRuntime }, codex] = await Promise.all([
  importDsh('@deepseek-ai/cordis'),
  importDsh('@deepseek-ai/dsh-subagent'),
  importDsh('@deepseek-ai/dsh-session-projection'),
  importDsh('@deepseek-ai/dsh-subprocess-local'),
  importDsh('@deepseek-ai/dsh-subagent-codex'),
])

const workspaceDir = mkdtempSync(join(tmpdir(), 'legion-system-proxy-codex-'))
const ctx = new Context()
let run

try {
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  codex.apply(ctx, {
    model: 'gpt-5.5',
    permissionMode: 'never',
    systemProxyMode: 'system',
    disposeGraceMs: 2500,
  })
  run = await ctx.subagents.start('codex', {
    prompt: [{
      type: 'text',
      text: 'Read-only connectivity check. Do not use tools, access files, or modify anything. Reply with exactly LEGION_SYSTEM_PROXY_CONNECTIVITY_LIVE_OK and nothing else.',
    }],
    parent: { id: 'legion-system-proxy-live-check', session: { header: { cwd: workspaceDir } } },
    signal: new AbortController().signal,
  })
  const result = await run.result
  const response = Array.isArray(result?.output)
    ? result.output.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    : null
  assert.equal(result?.stopReason, 'completed', 'Codex provider must complete the read-only probe')
  assert.equal(response?.trim(), 'LEGION_SYSTEM_PROXY_CONNECTIVITY_LIVE_OK')
  assert.deepEqual(readdirSync(workspaceDir), [], 'connectivity probe must leave its workspace empty')
  console.log(JSON.stringify({
    provider: 'subagent-codex',
    model: 'gpt-5.5',
    systemProxyMode: 'system',
    stopReason: result.stopReason,
    response,
    workspacePreserved: true,
  }))
} finally {
  if (run) await run.dispose().catch(() => {})
  await ctx.fiber.dispose().catch(() => {})
  if (readdirSync(workspaceDir).length === 0) rmdirSync(workspaceDir)
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pinnedFamily } from './prepare-payload.mjs'

test('pins the full recursive DSH family even when upstream ranges accept newer releases', async () => {
  const calls = []
  const result = await pinnedFamily('0.1.5-rc.2', async (name, version) => {
    calls.push(name)
    return { name, version, dependencies: name === '@deepseek-ai/dsh'
      ? { '@deepseek-ai/dsh-web': '^0.1.5-rc.2', unrelated: '^99' }
      : { '@deepseek-ai/dsh': '^0.2.0', '@deepseek-ai/dsh-web': '^0.2.0' },
      peerDependencies: name === '@deepseek-ai/dsh' ? { '@deepseek-ai/dsh-attachment': '^0.1.5-rc.2' } : {} }
  })
  assert.deepEqual(result, { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/dsh-attachment': '0.1.5-rc.2', '@deepseek-ai/dsh-web': '0.1.5-rc.2' })
  assert.equal(calls.length, 3)
})

test('rejects metadata that silently substitutes another version', async () => {
  await assert.rejects(pinnedFamily('0.1.5-rc.2', async name => ({ name, version: '0.2.0' })), /Unqualified/)
})

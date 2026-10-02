import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import row, { createRuntimeContractInputsFactory } from './runtime-contract-registrar-row.mjs'
import { setRuntimeContractInputsFactory } from './runtime-contract-server-row.mjs'

test('production registrar publishes the actual endpoint with launcher credentials', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'legion-contract-registrar-'))
  const runtimeHost = { startRun() {}, probeRuntime() {} }
  const undo = setRuntimeContractInputsFactory(createRuntimeContractInputsFactory({
    env: { LEGION_RUNTIME_TOKEN: 'test-token', LEGION_DATA_DIR: dataDir },
    hostInputs: () => ({ runtimeHost }),
  }))
  const effects = []
  const services = new Map()
  try {
    await row.apply({ provide: (key, value) => services.set(key, value), effect: fn => effects.push(fn()), get: key => services.get(key) })
    const publication = JSON.parse(readFileSync(join(dataDir, 'runtime', 'runtime-contract.json'), 'utf8'))
    assert.ok(publication.port > 0)
    assert.equal(publication.pid, process.pid)
    const response = await fetch(`http://127.0.0.1:${publication.port}/legion/runtime/v1/capabilities`)
    assert.equal(response.status, 401)
  } finally {
    for (const dispose of effects) dispose()
    undo()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

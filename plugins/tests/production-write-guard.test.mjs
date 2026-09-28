import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { decideProductionTool, toolPaths } from '../lib/productionWriteGuard.js'

const workspace = join(process.cwd(), 'worker-tree')
const granted = {
  attemptId: 'A1', epoch: 4, revision: 2, workspace,
  paths: [{ path: 'src/a.mjs', type: 'file' }], exclusive: false,
}

test('production guard checks actual write targets, lease and opaque commands', () => {
  assert.deepEqual(toolPaths('apply_patch', { patch: '*** Begin Patch\n*** Update File: src/a.mjs\n*** Move to: src/b.mjs\n*** End Patch' }, workspace).paths,
    ['src/a.mjs', 'src/b.mjs'])
  assert.equal(decideProductionTool({ toolName: 'edit', args: { file_path: join(workspace, 'src/a.mjs') }, granted, current: granted }).allow, true)
  assert.equal(decideProductionTool({ toolName: 'edit', args: { file_path: join(workspace, 'src/b.mjs') }, granted, current: granted }).code, 'OUT_OF_SCOPE')
  assert.equal(decideProductionTool({ toolName: 'edit', args: {}, granted, current: granted }).code, 'PATH_UNKNOWN')
  assert.equal(decideProductionTool({ toolName: 'bash', args: { command: 'echo x > src/b.mjs' }, granted, current: granted }).code, 'OPAQUE_COMMAND')
  assert.equal(decideProductionTool({ toolName: 'unknown-fs-tool', args: { path: 'src/a.mjs' }, granted, current: granted }).code, 'UNKNOWN_TOOL')
  assert.equal(decideProductionTool({ toolName: 'run_code', args: { code: 'await tools.edit(...)' }, granted, current: null }).code, 'TRANSPORT_ONLY')
  assert.equal(decideProductionTool({ toolName: 'edit', args: { path: 'src/a.mjs' }, granted, current: { ...granted, epoch: 5 } }).code, 'WRITE_LEASE_CHANGED')
  assert.equal(decideProductionTool({ toolName: 'edit', args: { path: '../outside.mjs' }, granted, current: granted }).code, 'PATH_UNKNOWN')
})

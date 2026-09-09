import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeArtifactPath } from '../src/artifact-policy.mjs'

const root = 'C:/repo'

test('artifact policy accepts relative paths and strips harmless ./ prefixes', () => {
  assert.deepEqual(normalizeArtifactPath('./docs/a.md', [root]).segments, ['docs', 'a.md'])
  assert.equal(normalizeArtifactPath('./docs/a.md', [root]).path, 'C:\\repo\\docs\\a.md')
})

test('artifact policy rejects traversal, git internals, and outside absolute paths', () => {
  assert.equal(normalizeArtifactPath('../secret', [root]), null)
  assert.equal(normalizeArtifactPath('docs/../secret', [root]), null)
  assert.equal(normalizeArtifactPath('docs/.git/config', [root]), null)
  assert.equal(normalizeArtifactPath('C:/outside/x', [root]), null)
})

test('artifact policy permits absolute paths only inside configured roots', () => {
  const result = normalizeArtifactPath('C:/repo/docs/a.md', [root])
  assert.equal(result?.absolute, true)
  assert.equal(result?.path, 'C:\\repo\\docs\\a.md')
})

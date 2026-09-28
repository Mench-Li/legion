import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadDeliveryConfig, hasExecutableVerification } from './verify-config.mjs'

test('本仓库交付配置可执行，验证项都有稳定 ID', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const loaded = loadDeliveryConfig(root)
  assert.equal(loaded.ok, true, loaded.errors?.join('; '))
  assert.equal(hasExecutableVerification(loaded.config), true)
  assert.equal(new Set(loaded.config.verify.map((v) => v.id)).size, loaded.config.verify.length)
})

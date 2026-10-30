// scripts/ci/verify-changed.test.mjs
// ---------------------------------------------------------------------------
// 实现阶段独立验证 runner 的**映射判据**（2026-10-30：整仓 `node --test` 跑不完，
// 每个编码任务都卡在 `unknown` 回执上，审查阶段连着领不走）。
//
// 这一组守的是"改动 → 该跑哪几套"的映射，而不是 git 交互本身：
//   · 同名套件、源码目录→测试目录、驼峰→短横线；
//   · 引用者兜底（测试 import 了被改模块）、提到者（源码断言型测试按全路径命中）；
//   · 文档/配置类改动**不**映射到任何套件（并按约定不判失败）。
//
// 运行：node --test scripts/ci/verify-changed.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { indexImporters, indexMentions, kebabCase, mapChangedToSuites } from './verify-changed.mjs'

const existsIn = (set) => (rel) => set.has(rel.replaceAll('\\', '/'))

test('① 同名套件：a/b.mjs → a/b.test.mjs', () => {
  const got = mapChangedToSuites(['team-hub/user-store.mjs'], { exists: existsIn(new Set(['team-hub/user-store.test.mjs'])) })
  assert.deepEqual(got, ['team-hub/user-store.test.mjs'])
})

test('② 源码目录 → 测试目录：plugins/src/x.ts → plugins/tests/x.test.mjs', () => {
  const got = mapChangedToSuites(['plugins/src/workspace.ts'], { exists: existsIn(new Set(['plugins/tests/workspace.test.mjs'])) })
  assert.deepEqual(got, ['plugins/tests/workspace.test.mjs'])
})

test('③ 驼峰 → 短横线：workbench/src/accountProfile.ts → workbench/scripts/account-profile.test.mjs', () => {
  assert.equal(kebabCase('accountProfile'), 'account-profile')
  assert.equal(kebabCase('AccountPanel'), 'account-panel')
  assert.equal(kebabCase('HTTPServer'), 'http-server')
  const got = mapChangedToSuites(['workbench/src/accountProfile.ts'], {
    exists: existsIn(new Set(['workbench/scripts/account-profile.test.mjs'])),
  })
  assert.deepEqual(got, ['workbench/scripts/account-profile.test.mjs'])
})

test('④ 引用者兜底：测试 import 了被改模块，就算文件名对不上也要跑', () => {
  const got = mapChangedToSuites(['workbench/src/components/AccountPanel.tsx'], {
    exists: existsIn(new Set(['workbench/scripts/account-page.test.mjs'])),
    importersOf: (stem) => (stem === 'AccountPanel' ? ['workbench/scripts/account-page.test.mjs'] : []),
  })
  assert.deepEqual(got, ['workbench/scripts/account-page.test.mjs'])
})

test('⑤ 文档/配置类改动不映射套件（也就不判失败）', () => {
  const got = mapChangedToSuites(['docs/FEATURES.md', 'README.md', 'patches/dsh/base.json'], { exists: () => true })
  assert.deepEqual(got, [])
})

test('⑥ 去重且稳定排序：同一套件被两条路径命中只跑一次', () => {
  const got = mapChangedToSuites(
    ['team-hub/user-store.mjs', 'team-hub/user-store.mjs', 'plugins/src/workspace.ts'],
    { exists: existsIn(new Set(['team-hub/user-store.test.mjs', 'plugins/tests/workspace.test.mjs'])) },
  )
  assert.deepEqual(got, ['plugins/tests/workspace.test.mjs', 'team-hub/user-store.test.mjs'])
})

test('⑦ 引用者索引：只收真正 import 了该模块的测试文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-changed-'))
  try {
    mkdirSync(join(root, 'workbench', 'scripts'), { recursive: true })
    mkdirSync(join(root, 'workbench', 'src'), { recursive: true })
    writeFileSync(join(root, 'workbench', 'src', 'accountProfile.ts'), 'export const x = 1\n')
    writeFileSync(join(root, 'workbench', 'scripts', 'account-profile.test.mjs'),
      "import { x } from '../src/accountProfile.ts'\n")
    writeFileSync(join(root, 'workbench', 'scripts', 'other.test.mjs'),
      "import { y } from '../src/somethingElse.ts'\n")
    const importers = indexImporters(root, ['workbench/scripts'])
    assert.deepEqual(importers('accountProfile'), ['workbench/scripts/account-profile.test.mjs'])
    assert.deepEqual(importers('somethingElse'), ['workbench/scripts/other.test.mjs'])
    assert.deepEqual(importers('nobody'), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑧ 提到者：源码断言型测试按**全路径**命中，裸文件名不算', () => {
  const got = mapChangedToSuites(['workbench/src/components/AccountPanel.tsx'], {
    exists: existsIn(new Set(['workbench/scripts/account-page.test.mjs'])),
    mentionedBy: (path) => (path === 'workbench/src/components/AccountPanel.tsx' ? ['workbench/scripts/account-page.test.mjs'] : []),
  })
  assert.deepEqual(got, ['workbench/scripts/account-page.test.mjs'])
})

test('⑨ indexMentions：只认仓库相对全路径（裸文件名会拉进半仓测试）', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-mentions-'))
  try {
    mkdirSync(join(root, 'workbench', 'scripts'), { recursive: true })
    mkdirSync(join(root, 'workbench', 'src', 'components'), { recursive: true })
    writeFileSync(join(root, 'workbench', 'src', 'components', 'AccountPanel.tsx'), 'export const A = 1\n')
    writeFileSync(join(root, 'workbench', 'scripts', 'account-page.test.mjs'),
      "const src = read('workbench/src/components/AccountPanel.tsx')\n")
    writeFileSync(join(root, 'workbench', 'scripts', 'unrelated.test.mjs'),
      "// 只提到文件名、没写全路径\nconst x = 'AccountPanel.tsx'\n")
    const mentionedBy = indexMentions(root, ['workbench/scripts'])
    assert.deepEqual(mentionedBy('workbench/src/components/AccountPanel.tsx'), ['workbench/scripts/account-page.test.mjs'])
    assert.deepEqual(mentionedBy('workbench/src/components/NotThere.tsx'), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

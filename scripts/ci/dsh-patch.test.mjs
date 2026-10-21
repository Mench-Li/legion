// scripts/ci/dsh-patch.test.mjs —— patches/dsh 补丁管家的判据
//
// 这一套盯的是一件容易被糊弄过去的事：**"补丁存在"不等于"修复在生效"**。
// 一次 profile 重装就能把修复抹掉，而仓库里的补丁文件、基线记录全都还在。
// 所以判据分两类：
//   · 静态一致：补丁文件 ↔ 基线记录（哈希、字节数、目标文件）必须互相对得上；
//   · 动态判定：给 `evaluateBase` 喂合成事实，确认它能分别认出
//     "DSH 升级了"、"profile 被重装、修复丢了"、"补丁被人手改了"。
//
// 运行：node --test scripts/ci/dsh-patch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deployedPackage, evaluateBase, installedDsh, loadBase, parseArgs, patchTargets, selectPatch,
} from '../dsh-patch.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATCH_DIR = join(ROOT, 'patches', 'dsh')
const base = loadBase()

const sha = (text) => createHash('sha256').update(text).digest('hex')

test('① 基线结构合法：schema、补丁条目、分支命名（绝不允许落在 master/main 上）', () => {
  assert.ok(base !== null, 'patches/dsh/base.json 必须存在（--record 生成）')
  assert.equal(base.schema, 1)
  assert.ok(Array.isArray(base.patches) && base.patches.length > 0, '至少要有一条补丁')
  for (const entry of base.patches) {
    assert.equal(typeof entry.slug, 'string')
    assert.equal(typeof entry.file, 'string')
    assert.equal(typeof entry.sha256, 'string', 'sha256 由 --record 填写')
    assert.ok(Array.isArray(entry.targets) && entry.targets.length > 0, 'targets 由 --record 从补丁正文解析')
    assert.equal(typeof entry.deployed?.package, 'string', '要记下部署的是哪个包')
    assert.ok(Array.isArray(entry.deployed?.markers) && entry.deployed.markers.length > 0,
      '必须有**内容标记**：只记哈希的话，profile 重装后你只知道"变了"，不知道"修复没了"')
    assert.match(String(entry.branch), /^legion\//, '补丁分支必须以 legion/ 开头')
    assert.notEqual(entry.branch, 'master')
    assert.notEqual(entry.branch, 'main')
  }
})

test('② 补丁文件与记录逐项对得上（改了补丁却不重录，这里必红）', () => {
  for (const entry of base.patches) {
    const path = join(PATCH_DIR, entry.file)
    assert.ok(existsSync(path), `补丁文件缺失：${entry.file}`)
    const text = readFileSync(path, 'utf8')
    assert.equal(entry.sha256, sha(text), `补丁 ${entry.file} 的哈希与基线记录不一致 —— 请 node scripts/dsh-patch.mjs --record`)
    assert.equal(entry.bytes, readFileSync(path).length, '字节数应与记录一致')
    assert.deepEqual(entry.targets, patchTargets(text), 'targets 应与补丁正文一致（`+++ b/…` 那几行）')
    // 补丁必须是可被 git 识别的格式（曾经因为 PowerShell 重定向写成 UTF-16 而整份失效）
    assert.match(text.slice(0, 200), /^From [0-9a-f]{40} /, '补丁应以 "From <sha> " 开头；否则可能被写成了 UTF-16/带 BOM')
    assert.ok(!text.includes('\u0000'), '补丁里不许出现 NUL（编码事故的迹象）')
  }
})

test('③ 基线只描述代码与测试，不带派生的文档哈希（否则永远落不到新上游）', () => {
  for (const entry of base.patches) {
    for (const target of entry.targets) {
      assert.ok(!/README|\.i18n\.yaml/i.test(target),
        `${target} 是派生文档（en/zh 哈希由 DSH 自己的工具生成）：把它放进补丁，补丁就只能落在那一版上游上`)
    }
  }
})

/** 造一个临时补丁目录 + 一份可控的基线，用来喂合成事实。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-'))
  const file = '0001-fake.patch'
  writeFileSync(join(dir, file), 'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\n+++ b/a.ts\n', 'utf8')
  const synthetic = {
    schema: 1,
    patches: [{
      slug: 'fake',
      file,
      sha256: sha(readFileSync(join(dir, file), 'utf8')),
      bytes: readFileSync(join(dir, file)).length,
      targets: ['a.ts'],
      branch: 'legion/compat-fake',
      deployed: { package: 'dsh-subagent-claude-code', markers: ['assistantText'] },
      upstream: { baseVersion: '0.2.1-rc.2' },
    }],
    installed: { appVersion: '0.2.1-rc.2', asarSha256: 'aaaa' },
  }
  return { dir, base: synthetic }
}

test('④ 事实与基线一致 ⇒ 通过（并且每条判定都要有可读的说明）', () => {
  const { dir, base: synthetic } = fixture()
  const now = {
    installed: { appVersion: '0.2.1-rc.2', asarSha256: 'aaaa' },
    deployed: { version: '0.2.1-rc.2', libSha256: 'bbbb', libText: 'const x = assistantText.join("")' },
  }
  const result = evaluateBase(synthetic, now, { patchDir: dir })
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2))
  assert.deepEqual(result.drifts, [])
  for (const check of result.checks) assert.ok(typeof check.text === 'string' && check.text.length > 0)
})

test('⑤ profile 被重装、修复丢了 ⇒ 必须红，且指出"修复已丢失"（不是"哈希变了"）', () => {
  const { dir, base: synthetic } = fixture()
  const now = {
    installed: { appVersion: '0.2.1-rc.2', asarSha256: 'aaaa' },
    // 上游原版：没有 assistantText 这个标记
    deployed: { version: '0.2.1-rc.2', libSha256: 'cccc', libText: 'const answer = successfulResult(message)' },
  }
  const result = evaluateBase(synthetic, now, { patchDir: dir })
  assert.equal(result.ok, false)
  assert.deepEqual(result.drifts, ['deployed-fix'])
  const check = result.checks.find((entry) => entry.id === 'deployed-fix')
  assert.match(check.text, /不含修复标记/)
  assert.match(check.text, /assistantText/)
  assert.match(check.text, /丢失/)
})

test('⑥ DSH 升级/重装过 ⇒ 必须红（补丁是对着旧基线写的）', () => {
  const { dir, base: synthetic } = fixture()
  const now = {
    installed: { appVersion: '0.2.1-rc.3', asarSha256: 'dddd' },
    deployed: { version: '0.2.1-rc.3', libSha256: 'eeee', libText: 'assistantText' },
  }
  const result = evaluateBase(synthetic, now, { patchDir: dir })
  assert.equal(result.ok, false)
  assert.ok(result.drifts.includes('installed-asar'), 'asar 变了必须报')
  assert.ok(result.drifts.includes('installed-version'), '版本与补丁写的基线不同也必须报')
  assert.match(result.checks.find((entry) => entry.id === 'installed-asar').text, /DSH 升级或重装过/)
})

test('⑦ 补丁被人手改过 ⇒ 必须红（基线不再描述它）', () => {
  const { dir, base: synthetic } = fixture()
  writeFileSync(join(dir, '0001-fake.patch'), 'tampered', 'utf8')
  const now = {
    installed: { appVersion: '0.2.1-rc.2', asarSha256: 'aaaa' },
    deployed: { version: '0.2.1-rc.2', libSha256: 'bbbb', libText: 'assistantText' },
  }
  const result = evaluateBase(synthetic, now, { patchDir: dir })
  assert.equal(result.ok, false)
  assert.ok(result.drifts.includes('patch-hash'))
  assert.match(result.checks.find((entry) => entry.id === 'patch-hash').text, /请重录/)
})

test('⑧ 未装 DSH ⇒ 未观察，不算失败（"没接"不等于"通过"，也不算"不通过"）', () => {
  const { dir, base: synthetic } = fixture()
  const result = evaluateBase(synthetic, { installed: null, deployed: null }, { patchDir: dir })
  assert.equal(result.checks.find((entry) => entry.id === 'installed').skipped, true)
  assert.ok(result.drifts.includes('deployed'), '但"部署缺失"仍是事实，必须报出来')
})

test('⑨ 参数解析：只有显式 --apply/--revert 才会改动检出', () => {
  assert.equal(parseArgs([]).mode, null)
  assert.equal(parseArgs(['--check']).mode, 'check')
  assert.equal(parseArgs(['--record']).mode, 'record')
  const applied = parseArgs(['--apply', '--source=D:/x', '--patch=slug'])
  assert.equal(applied.mode, 'apply')
  assert.equal(applied.source, 'D:/x')
  assert.equal(applied.patch, 'slug')
  assert.equal(parseArgs(['--check', '--strict']).strict, true)
  assert.throws(() => parseArgs(['--nonsense']), /不认识的参数/)
})

test('⑩ 多补丁时必须显式 --patch，避免"猜一条来应用"', () => {
  const two = { patches: [{ slug: 'a', file: 'a.patch' }, { slug: 'b', file: 'b.patch' }] }
  assert.equal(selectPatch(two), null, '两条时不猜')
  assert.equal(selectPatch(two, 'b').slug, 'b')
  assert.equal(selectPatch({ patches: [{ slug: 'a' }] }).slug, 'a', '只有一条时可以省略')
})

test('⑪ 本机真实判定：装了 DSH 的机器上，基线必须自洽（否则就是漂移已经发生）', () => {
  const installed = installedDsh()
  if (installed === null) return   // 未观察：这台机器没装 DSH
  const entry = selectPatch(base)
  const deployed = deployedPackage(entry.deployed.package)
  const result = evaluateBase(base, { installed, deployed })
  assert.equal(result.ok, true,
    '基线与本机现状不一致（DSH 升级过 / profile 重装过 / 补丁被改过）：\n' + JSON.stringify(result.checks, null, 2)
    + '\n修法：node scripts/dsh-patch.mjs --check 看逐项判定，必要时重新生成补丁并 --record')
})

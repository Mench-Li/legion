// workbench/scripts/skill-importer.test.mjs — 技能安装扫描/URL 校验契约测试。
// 运行：node --test workbench/scripts/skill-importer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkillDirs, buildGithubTarballUrl, sanitizeSkillId, parseYamlMeta } from './skillImporter.mjs'

function mkSkill(root, name, opts = {}) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'examples'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '@skill 主指引：' + name)
  if (opts.config) writeFileSync(join(dir, 'config.yaml'), opts.config)
  if (opts.script) writeFileSync(join(dir, 'scripts', 'run.sh'), opts.script)
  if (opts.case) writeFileSync(join(dir, 'examples', '示例.md'), opts.case)
  return dir
}

test('sanitizeSkillId：合法 id 化 + 纯中文哈希兜底', () => {
  assert.equal(sanitizeSkillId('code-review-checklist'), 'code-review-checklist')
  assert.equal(sanitizeSkillId('Bad ID!'), 'bad-id')
  assert.ok(/^skill-[a-f0-9]{8}$/.test(sanitizeSkillId('代码审查')), '纯中文 → skill-<hash>')
})

test('parseYamlMeta：解析 name/description 顶层键', () => {
  const m = parseYamlMeta('name: 代码审查\nversion: 1\ndescription: 复查边界\n')
  assert.equal(m.name, '代码审查')
  assert.equal(m.description, '复查边界')
})

test('scanSkillDirs：根技能 + 子技能，解析 config/scripts/cases', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'legion-skills-'))
  try {
    const child = mkSkill(tmp, 'code-review', { config: 'name: 代码审查清单\ndescription: 复查\n', script: '#!/bin/sh\nnpx eslint .', case: '# 案例' })
    mkdirSync(join(tmp, 'my-skill'))
    writeFileSync(join(tmp, 'my-skill', 'SKILL.md'), '@skill 根即技能')
    const cands = scanSkillDirs(tmp)
    assert.equal(cands.length, 2)
    const r = cands.find(c => c.id === 'code-review')
    assert.equal(r.name, '代码审查清单')
    assert.equal(r.description, '复查')
    assert.equal(r.scripts.length, 1)
    assert.equal(r.scripts[0].name, 'run.sh')
    assert.equal(r.cases.length, 1)
    assert.ok(cands.find(c => c.id === 'my-skill'))
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('buildGithubTarballUrl：主机白名单 + 分支解析 + 非法拒绝', () => {
  assert.equal(buildGithubTarballUrl('https://github.com/acme/skills'), 'https://codeload.github.com/acme/skills/tar.gz/HEAD')
  assert.equal(buildGithubTarballUrl('https://github.com/acme/skills/tree/main'), 'https://codeload.github.com/acme/skills/tar.gz/refs/heads/main')
  assert.equal(buildGithubTarballUrl('https://github.com/acme/skills', 'master'), 'https://codeload.github.com/acme/skills/tar.gz/refs/heads/master')
  assert.equal(buildGithubTarballUrl('https://codeload.github.com/acme/skills/tar.gz/refs/heads/main'), 'https://codeload.github.com/acme/skills/tar.gz/refs/heads/main')
  assert.throws(() => buildGithubTarballUrl('http://github.com/acme/skills'), /https/)
  assert.throws(() => buildGithubTarballUrl('https://evil.com/x'), /官方域名/)
  assert.throws(() => buildGithubTarballUrl('https://github.com/acme'), /不完整/)
  assert.throws(() => buildGithubTarballUrl('https://github.com/acme/skills/blob/main/x'), /仓库主页/)
})

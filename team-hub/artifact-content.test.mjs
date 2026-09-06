// team-hub/artifact-content.test.mjs — R-3/S3 内容通道契约测试（只读 GET /api/artifact/content 纯函数面）。
// 运行：node team-hub/artifact-content.test.mjs
// TEAM_HUB_DB 指向临时库 + spaces.local_dir 指向临时仓库根 fixture（仿 skills.test.mjs 范式，import 不占端口）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-artifact-content-'))
const repoRoot = join(tmpRoot, 'repo')
mkdirSync(join(repoRoot, 'docs'), { recursive: true })
mkdirSync(join(repoRoot, '.legion-worktrees', 'T-001', 'docs'), { recursive: true })
const MAIN_TEXT = 'MAIN\nline2\n'
const WT_TEXT = 'WORKTREE\nv2\n'
const LEGACY_WT = 'LEGACY-WORKTREE\nv1\n'
writeFileSync(join(repoRoot, 'docs', 'x.md'), MAIN_TEXT, 'utf8')
writeFileSync(join(repoRoot, '.legion-worktrees', 'T-001', 'docs', 'x.md'), WT_TEXT, 'utf8')
let mod
const TASK_ID = 'T-001'

before(async () => {
  process.env.TEAM_HUB_DB = join(tmpRoot, 'team.db')
  mod = await import('./server.mjs')
  const now = new Date().toISOString()
  mod.db.prepare('INSERT INTO spaces (id, name, private, local_dir, remote_url, createdAt, updatedAt) VALUES (?,?,0,?,?,?,?)')
    .run('software', '软件流水线', repoRoot, '', now, now)
  const insertTask = (id, artifacts) => {
    mod.db.prepare('INSERT INTO tasks (id, title, priority, status, version, scope, artifacts, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, 'fixture', 'medium', 'in_review', 1, 'software', JSON.stringify(artifacts), now, now)
  }
  insertTask(TASK_ID, [{ by: 'soldier-auto', at: now, kind: 'file', path: 'docs/x.md', title: '方案文档' }])
  insertTask('T-EMPTY', [])
  insertTask('T-URL', [{ by: 'soldier-auto', at: now, kind: 'url', path: 'https://x.example/doc', title: '外部' }])
  insertTask('T-EVIL-REL', [{ by: 'soldier-auto', at: now, kind: 'file', path: '../secret.md' }])
  insertTask('T-EVIL-GIT', [{ by: 'soldier-auto', at: now, kind: 'file', path: '.git/config' }])
  insertTask('T-EVIL-WT', [{ by: 'soldier-auto', at: now, kind: 'file', path: '.legion-worktrees/T-002/docs/other.md' }])
  insertTask('T-EVIL-ABS', [{ by: 'soldier-auto', at: now, kind: 'file', path: 'C:/Windows/win.ini' }])
  insertTask('T-MISSING', [{ by: 'soldier-auto', at: now, kind: 'file', path: 'docs/nope.md' }])
  insertTask('T-BIG', [{ by: 'soldier-auto', at: now, kind: 'file', path: 'docs/big.md' }])
  insertTask('T-BIN', [{ by: 'soldier-auto', at: now, kind: 'file', path: 'docs/bin.md' }])
  insertTask('T-BIN2', [{ by: 'soldier-auto', at: now, kind: 'file', path: 'docs/bin2.md' }])
  insertTask('T-LEGACY', [{ by: 'soldier-auto', at: now, kind: 'file', path: join(repoRoot, '.legion-worktrees', 'T-LEGACY', 'docs', 'x.md') }])
  writeFileSync(join(repoRoot, 'docs', 'bin.md'), Buffer.from([0x41, 0x00, 0x42]))
  writeFileSync(join(repoRoot, 'docs', 'bin2.md'), Buffer.from([0xff, 0xfe, 0x41, 0x42]))
  writeFileSync(join(repoRoot, 'docs', 'big.md'), Buffer.alloc(600 * 1024, 0x61))
})

after(() => {
  try { mod && mod.db && mod.db.close() } catch { /* 已关闭 */ }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('主分支态逐字一致（AC-R3-1）', () => {
  it('登记相对路径 docs/x.md → 内容与 readFileSync 逐字一致（字节 diff 为空）', () => {
    const r = mod.artifactContent(TASK_ID, '0')
    assert.equal(r.status, 200)
    assert.equal(r.body.source, 'worktree')
    assert.equal(r.body.relPath, 'docs/x.md')
    assert.equal(r.body.previewable, true)
    assert.equal(r.body.mime, 'text/markdown')
    assert.equal(r.body.content, WT_TEXT, 'worktree 优先读分支态')
  })
})

describe('分支态优先 / 主仓兜底（AC-R3-2，K5-A，零 git CLI）', () => {
  it('删除 worktree 目录后自动回退主仓库根文件（source=main）且内容逐字一致', () => {
    rmSync(join(repoRoot, '.legion-worktrees', 'T-001'), { recursive: true, force: true })
    const r = mod.artifactContent(TASK_ID, '0')
    assert.equal(r.status, 200)
    assert.equal(r.body.source, 'main')
    assert.equal(r.body.content, MAIN_TEXT)
  })
})

describe('存量绝对路径记录读取期兼容（K10，不跑迁移）', () => {
  it('绝对路径命中 .legion-worktrees/<id>/ 前缀 → 剥前缀读取，worktree 删后回退主仓', () => {
    mkdirSync(join(repoRoot, '.legion-worktrees', 'T-LEGACY', 'docs'), { recursive: true })
    writeFileSync(join(repoRoot, '.legion-worktrees', 'T-LEGACY', 'docs', 'x.md'), LEGACY_WT, 'utf8')
    const r1 = mod.artifactContent('T-LEGACY', '0')
    assert.equal(r1.status, 200)
    assert.equal(r1.body.source, 'worktree')
    assert.equal(r1.body.content, LEGACY_WT)
    rmSync(join(repoRoot, '.legion-worktrees', 'T-LEGACY'), { recursive: true, force: true })
    const r2 = mod.artifactContent('T-LEGACY', '0')
    assert.equal(r2.status, 200)
    assert.equal(r2.body.source, 'main')
    assert.equal(r2.body.content, MAIN_TEXT)
  })
  it('根外绝对路径 → 403 明确文案（不泄露外部文件）', () => {
    const r = mod.artifactContent('T-EVIL-ABS', '0')
    assert.equal(r.status, 403)
    assert.match(r.body.error, /不在允许读取范围内/)
  })
})

describe('路径安全（AC-R3-3）', () => {
  it('../ 越权 → 403 可区分', () => {
    assert.equal(mod.artifactContent('T-EVIL-REL', '0').status, 403)
  })
  it('.git 任一层 → 403', () => {
    assert.equal(mod.artifactContent('T-EVIL-GIT', '0').status, 403)
  })
  it('其他任务 worktree 目录 → 403（不可越读他人工作树）', () => {
    assert.equal(mod.artifactContent('T-EVIL-WT', '0').status, 403)
  })
})

describe('错误码可区分（K9：404 vs 400）', () => {
  it('未知任务 → 404', () => {
    assert.equal(mod.artifactContent('T-UNKNOWN', '0').status, 404)
  })
  it('无登记产物 → 400', () => {
    assert.equal(mod.artifactContent('T-EMPTY', '0').status, 400)
  })
  it('i 越界 → 400；i 缺省取最新（不越界）', () => {
    assert.equal(mod.artifactContent(TASK_ID, '9').status, 400)
    assert.equal(mod.artifactContent(TASK_ID, undefined).status, 200)
  })
  it('任务参数缺失 → 400', () => {
    assert.equal(mod.artifactContent('', '0').status, 400)
  })
  it('文件不存在 → 404', () => {
    assert.equal(mod.artifactContent('T-MISSING', '0').status, 404)
  })
  it('url 类型产物无文件内容 → 400', () => {
    assert.equal(mod.artifactContent('T-URL', '0').status, 400)
  })
})

describe('读取规范（AC-R3-6）：截断与二进制降级', () => {
  it('超过 512KB → truncated=true 且内容截断到上限，不白屏', () => {
    const r = mod.artifactContent('T-BIG', '0')
    assert.equal(r.status, 200)
    assert.equal(r.body.size, 600 * 1024)
    assert.equal(r.body.truncated, true)
    assert.equal(r.body.content.length, 512 * 1024)
  })
  it('含 NUL 字节 → previewable=false 不报错', () => {
    const r = mod.artifactContent('T-BIN', '0')
    assert.equal(r.status, 200)
    assert.equal(r.body.previewable, false)
    assert.equal(r.body.content, '')
  })
  it('非法 UTF-8（无 NUL）→ previewable=false 不报错', () => {
    const r = mod.artifactContent('T-BIN2', '0')
    assert.equal(r.status, 200)
    assert.equal(r.body.previewable, false)
    assert.equal(r.body.content, '')
  })
})

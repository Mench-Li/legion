// team-hub/file-domain-guard.test.mjs —— BUG-009-a 回归：建任务时的文件域可交付性护栏
//
// 现场（T-179）：切片的域声明成 ["scratch/"]，而 scratch/ 在 .gitignore 里 ⇒ worker 干完了
// （23KB 判定报告）却永远交付不了：分支 0 提交、git status 干净。一条 5 小时的活烂在忽略目录里。
//
// 两层判据：
//   · 纯决策层 —— 可交付 / 部分忽略 / 全部忽略 / 不可知，四个分支各自的结论；
//   · 真实 git 层 —— 用真 .gitignore + 真 runGit 探，证明"问 git"这条路径真的工作
//     （不自己重写 gitignore 语义）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { judgeFileDomain, ignoredFileDomainEntries } from './file-domain-guard.mjs'
import { runGit } from './git-plumbing.mjs'

test('① 声明域全部被忽略 ⇒ 拒绝，且文案说清"交付不了"与怎么办', () => {
  const v = judgeFileDomain(['scratch/'], ['scratch/'])
  assert.equal(v.ok, false)
  assert.equal(v.code, 'DOMAIN_ALL_IGNORED')
  assert.deepEqual(v.ignored, ['scratch/'])
  assert.match(v.message, /交付不了/)
  assert.match(v.message, /被跟踪的路径/, '文案要给出下一步，而不是只说"不允许"')
})

test('② 部分被忽略 ⇒ **放行**并告警（临时区 + 交付区是合法用法）', () => {
  const v = judgeFileDomain(['scratch/', 'docs/bugs/'], ['scratch/'])
  assert.equal(v.ok, true, '部分忽略不该拦住建任务：scratch 当临时区、docs 当交付区是正常写法')
  assert.equal(v.code, 'DOMAIN_PARTLY_IGNORED')
  assert.deepEqual(v.ignored, ['scratch/'])
  assert.match(v.message, /不会进版本库/)
})

test('③ 全部可交付 ⇒ 通过', () => {
  const v = judgeFileDomain(['team-hub/', 'docs/'], [])
  assert.equal(v.ok, true)
  assert.equal(v.code, 'DOMAIN_OK')
  assert.equal(v.message, '')
})

test('④ 探测不可知（null）⇒ **放行**（不知道就不拦人）', () => {
  const v = judgeFileDomain(['scratch/'], null)
  assert.equal(v.ok, true, '探测失败时我们不知道域是否可交付 —— 一个因为探不到 git 就建不了任务的闸门，比它要防的问题更坏')
  assert.equal(v.code, 'UNKNOWN')
})

test('⑤ 没声明域 ⇒ 不参与判定', () => {
  for (const empty of [[], null, undefined, 'scratch/']) {
    const v = judgeFileDomain(empty, ['scratch/'])
    assert.equal(v.ok, true)
    assert.equal(v.code, 'NO_DOMAIN')
  }
})

test('⑥ 真实 git：.gitignore 里的条目被认出来，未忽略的不被误报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-domain-guard-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), 'scratch/\n*.tmp\n', 'utf8')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'keep.md'), 'x', 'utf8')

    const entries = ['scratch/', 'docs/', 'docs/keep.md', 'build.tmp']
    const ignored = ignoredFileDomainEntries((args, cwd) => runGit(args, cwd), dir, entries)
    assert.deepEqual(ignored, ['scratch/', 'build.tmp'],
      '只有真正被 .gitignore 命中的条目才算被忽略（docs/ 与 docs/keep.md 必须不在里面）')

    // 端到端：拿这些读数去判定 —— 部分忽略 ⇒ 放行
    const verdict = judgeFileDomain(entries, ignored)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.code, 'DOMAIN_PARTLY_IGNORED')

    // 而"全是忽略项"时会被拒
    const all = judgeFileDomain(['scratch/', 'build.tmp'], ignored)
    assert.equal(all.ok, false)
    assert.equal(all.code, 'DOMAIN_ALL_IGNORED')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('⑦ 探测不可知的两个来源都返回 null（不是"未忽略"）', () => {
  // a) 目录给空
  assert.equal(ignoredFileDomainEntries((args, cwd) => runGit(args, cwd), '', ['scratch/']), null)
  // b) git 本身出错（这里用一个非仓库目录：check-ignore 在非仓库里是 fatal，退出码 128）
  const notRepo = mkdtempSync(join(tmpdir(), 'legion-not-a-repo-'))
  try {
    assert.equal(ignoredFileDomainEntries((args, cwd) => runGit(args, cwd), notRepo, ['scratch/']), null,
      'git 命令报错时必须是"不可知"（null），不能当成"未忽略"而放行 —— 那会让护栏在非 git 环境下假装校验过')
  } finally { rmSync(notRepo, { recursive: true, force: true }) }
})

test('⑧ 注入的 runGit 抛异常也不炸（返回不可知）', () => {
  assert.equal(ignoredFileDomainEntries(() => { throw new Error('spawn failed') }, '/tmp/x', ['a/']), null)
})

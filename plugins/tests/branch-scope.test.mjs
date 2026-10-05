import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchOwnChangesRefspec } from '../src/branchScope.ts'

// BUG-008 回归：文件域闸门必须看「**这条切片分支自己**改了什么」。
//
// 现场（2026-10-05）：`w/T-178` 自己只改 11 个文件（全在声明域内），但闸门用两点法
// `git diff --name-only main w/T-178` 得到 13 个 —— 多出来的 2 个是别人在它飞行期间合进 main 的
// `docs/bugs/BUG-006-*`；闸门据此判"越域"，把一次完全合规的交付拦在了 in_review。
// `w/T-179` 更极端：0 个提交，却被报出 14 个"越域文件"（全是 main 新增的）。
//
// 这组用例分两层：① 钉住 refspec 形状；② 用**真实 git 仓库**复现两种语义，
// 并断言"真实越域仍然抓得到"（否则就是把闸门改瞎了）。

const git = (cwd) => (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** 建一个临时仓库，返回 {dir, run, files(refspec)}。 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'legion-branch-scope-'))
  const run = git(dir)
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@example.com')
  run('config', 'user.name', 't')
  run('config', 'commit.gpgsign', 'false')
  const write = (rel, text) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text, 'utf8')
  }
  const files = (refspec) => run('diff', '--name-only', refspec).split('\n').filter(Boolean).sort()
  return { dir, run, write, files }
}

test('① refspec 必须是三点：只算分支自己的改动', () => {
  assert.equal(branchOwnChangesRefspec('main', 'w/T-178'), 'main...w/T-178')
  // 反向钉死：两点形状是不允许的（那会把主分支的新增算到切片头上）
  assert.notEqual(branchOwnChangesRefspec('main', 'w/T-178'), 'main..w/T-178')
  assert.equal(/(?<!\.)\.\.(?!\.)/.test(branchOwnChangesRefspec('main', 'w/T-178')), false,
    'refspec 里不许出现两点形态')
})

test('② 真实 git：主分支在切片飞行期间新增文件，**不许**被算成切片的改动', () => {
  const { dir, run, write, files } = repo()
  try {
    // 基线
    write('keep/base.txt', 'base\n')
    run('add', '-A'); run('commit', '-qm', 'base')

    // 切片分支：只改域内文件
    run('checkout', '-q', '-b', 'w/T-178')
    write('team-hub/inside.txt', 'slice work\n')
    run('add', '-A'); run('commit', '-qm', 'T-178: in-domain only')

    // 回来在 main 上"别人合了东西"（域外：docs/）
    run('checkout', '-q', 'main')
    write('docs/bugs/BUG-006-x.md', 'someone else\n')
    run('add', '-A'); run('commit', '-qm', 'someone else merged docs')

    // 两点法（缺陷）：把 main 的新增也报进来 —— 这就是误报的机制
    const twoDot = files('main..w/T-178')
    assert.ok(twoDot.includes('docs/bugs/BUG-006-x.md'),
      '前置：两点法本该复现误报（把 main 新增的 docs 文件算进来）；若这里不成立，说明 git 语义变了')

    // 三点法（修复）：只看到切片自己改的那个文件
    const threeDot = files(branchOwnChangesRefspec('main', 'w/T-178'))
    assert.deepEqual(threeDot, ['team-hub/inside.txt'],
      `三点法必须只给出切片自己的改动；实际=${JSON.stringify(threeDot)}`)
    assert.equal(threeDot.includes('docs/bugs/BUG-006-x.md'), false,
      '别人合进 main 的文件绝不能算到切片头上（这正是把合规交付拦住的那 2 个文件）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ 真实越域仍然抓得到（修判据不许把闸门改瞎）', () => {
  const { dir, run, write, files } = repo()
  try {
    write('keep/base.txt', 'base\n')
    run('add', '-A'); run('commit', '-qm', 'base')
    // 切片跑到了自己声明的域外（声明的域只有 team-hub/）
    run('checkout', '-q', '-b', 'w/T-999')
    write('team-hub/ok.txt', 'in domain\n')
    write('workbench/outside.txt', 'OUT OF DOMAIN\n')
    run('add', '-A'); run('commit', '-qm', 'T-999: touches outside')
    // 主分支也在动（模拟飞行期间的正常合入）
    run('checkout', '-q', 'main')
    write('docs/unrelated.md', 'unrelated\n')
    run('add', '-A'); run('commit', '-qm', 'unrelated main work')

    const changed = files(branchOwnChangesRefspec('main', 'w/T-999'))
    assert.deepEqual(changed, ['team-hub/ok.txt', 'workbench/outside.txt'])
    // 闸门的域判定是前缀匹配（见 outsideDomainFiles）；这里断言域外那个仍然在清单里
    assert.ok(changed.includes('workbench/outside.txt'),
      '切片自己改的域外文件必须仍然出现在清单里，闸门才拦得住')
    assert.equal(changed.includes('docs/unrelated.md'), false,
      'main 上无关的改动不该干扰判定')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ 切片没有自己的提交时，清单为空（不是"主分支的全部新增"）', () => {
  const { dir, run, write, files } = repo()
  try {
    write('keep/base.txt', 'base\n')
    run('add', '-A'); run('commit', '-qm', 'base')
    run('checkout', '-q', '-b', 'w/T-179')   // 建了分支但什么都没提交
    run('checkout', '-q', 'main')
    write('docs/a.md', 'a\n'); write('plugins/b.ts', 'b\n')
    run('add', '-A'); run('commit', '-qm', 'main moved on')

    // 两点法会报出 main 新增的 2 个（现场里 T-179 被报了 14 个）
    assert.deepEqual(files('main..w/T-179'), ['docs/a.md', 'plugins/b.ts'])
    // 三点法：切片自己什么都没改 ⇒ 空
    assert.deepEqual(files(branchOwnChangesRefspec('main', 'w/T-179')), [],
      '0 提交的切片必须给出空清单，而不是主分支的全部新增')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

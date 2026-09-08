// P2 重启后验收核对（将军重启 DSH web 后运行：node plugins/tests/accept-p2.mjs）
// 覆盖：① declarative promote → learnings 落盘；② kb-recall 统一检索面（drafts/learnings/skills）；
//   ③ 派工自动召回（注入段 + recalled 实账 + 同目标防噪）。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const pass = [], fail = []
const check = (name, cond, detail = '') => { (cond ? pass : fail).push(name); console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`) }
const REPO = 'D:/project/DSH/legion'

// ── ① 守护已加载 P2 新代码（uptime 短 = 刚重启；learnings 逻辑只在 P2 lib 里） ──
const daemon = JSON.parse(readFileSync(join(REPO, 'scrum/daemon.json'), 'utf8'))
check('① 守护在跑（daemon.json 可读）', !!daemon.lastSweepAt, `lastSweep=${daemon.lastSweepAt}`)
const draftDir = join(REPO, 'docs/experience/drafts')
const learningDir = join(REPO, 'docs/experience/learnings')

// ── ② declarative 形态分流已生效：若 learnings 目录存在且含 P2-① frontmatter 则验证 ──
if (existsSync(learningDir)) {
  const files = readdirSync(learningDir).filter(f => f.endsWith('.md'))
  check('② learnings 目录存在并有资产', files.length > 0, `${files.length} 条`)
  const sample = files[0]
  if (sample) {
    const raw = readFileSync(join(learningDir, sample), 'utf8')
    check('② learning 资产含 kind:declarative', raw.includes('kind: declarative'))
    check('② learning 资产含溯源 taskId', /^taskId:\s*T-\d+/m.test(raw), sample)
  }
} else {
  console.log('⏭  ② learnings 目录尚不存在（declarative promote 尚未真实发生）— 验收方式见 README：把某 declarative 草稿 createdAt 前移触发真实 promote')
}

// ── ③ 技能桥：~/.dsh/skills 同步（published skills 目录存在） ──
const skillsDir = join(process.env.USERPROFILE, '.dsh/skills')
if (existsSync(skillsDir)) {
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  check('③ 技能桥同步目录存在', dirs.length > 0, dirs.join(', '))
  const mdFiles = dirs.filter(n => existsSync(join(skillsDir, n, 'SKILL.md')))
  check('③ SKILL.md 均带 legion marker', mdFiles.every(n => readFileSync(join(skillsDir, n, 'SKILL.md'), 'utf8').includes('legion-skill:')), mdFiles.join(', '))
} else {
  console.log('⏭  ③ ~/.dsh/skills 不存在（无 published skill 同步过）')
}

// ── ④ 派工召回信号：草稿 frontmatter recalledBy 有自动召回痕迹 ──
if (existsSync(draftDir)) {
  const drafts = readdirSync(draftDir).filter(f => f.endsWith('.md'))
  const withRecall = drafts.filter(f => {
    const raw = readFileSync(join(draftDir, f), 'utf8')
    return /^recalled:\s*([1-9])/m.test(raw) || /^recalledBy:\s*\[[^\]]/m.test(raw)
  })
  if (withRecall.length > 0) {
    check('④ 有草稿获得 recalled 票', true, withRecall.join(', '))
    for (const f of withRecall.slice(0, 3)) {
      const raw = readFileSync(join(draftDir, f), 'utf8')
      const rb = /^recalledBy:\s*(.+)$/m.exec(raw)
      console.log(`     ${f} recalledBy=${rb?.[1] ?? '?'}`)
    }
  } else {
    console.log('⏭  ④ 暂无草稿获得 recalled（自动召回随真实派工发生；查看派工提示词是否含「相关团队经验」段）')
  }
}

// ── ⑤ 守护日志：P2 相关事件 ──
const log = 'C:/Users/11150/.dsh/super-injector/dsh-scrum-worker.log'
if (existsSync(log)) {
  const tail = readFileSync(log, 'utf8').split('\n').slice(-400).join('\n')
  check('⑤ 日志含自动召回/learnings/形态分流事件', /召回|learning|declarative|形态|晋升为 skill|晋升为 learning/.test(tail), '最近 400 行内')
}

console.log(`\n=== 结果：${pass.length} 通过 / ${fail.length} 失败 ===`)
if (fail.length > 0) {
  console.log('失败项：' + fail.join('；'))
  process.exitCode = 1
} else if (pass.length === 0) {
  console.log('（全部为 ⏭ 待触发项——需真实派工/promote 发生后再核对）')
}

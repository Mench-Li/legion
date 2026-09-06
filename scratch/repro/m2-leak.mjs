// M2 repro: registerSkill 内容改版回 pending 但 grants 保留 → include=pending 复审视图跨空间带出草稿
// 基线: team-hub/server.mjs @ HEAD (104f99a promote a018666/dd2fbe3, 与 T-100 审查对象逐字节一致)
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = mkdtempSync(join(tmpdir(), 'legion-m2-'))
process.env.TEAM_HUB_DB = join(tmp, 'team.db')
const mod = await import(pathToFileURL(join(process.cwd(), 'team-hub', 'server.mjs')).href)

let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) fail++
}

// 1) 建技能 S（scope=software）→ publish → grant 给 marketing
mod.registerSkill({ id: 's-csharp', name: 'C# 规范', description: 'd', prompt: 'v1: 显式类型声明', scope: 'software' })
mod.reviewSkill('s-csharp', 'publish')
let s = mod.grantSkill('s-csharp', ['scope:marketing'])
check('基线: publish 后 grants=[scope:marketing]', JSON.stringify(s.grants) === JSON.stringify(['scope:marketing']), JSON.stringify(s.grants))

// 2) B=marketing 普通视角（published only）可见 → 共享闭环正向
const bList = mod.listSkills({ scope: 'marketing' })
check('正向: marketing published-only 列表含 s-csharp', bList.some(x => x.id === 's-csharp'))

// 3) A=software 内容改版 → 回 pending v2（grants 未清 = M2 根因）
const v2 = mod.registerSkill({ id: 's-csharp', name: 'C# 规范', description: 'd', prompt: 'v2-SECRET: 禁止一切隐式类型; 仅供 A 内部审阅', scope: 'software' })
check('改版 → status=pending & version=2', v2.status === 'pending' && v2.version === 2, JSON.stringify({ status: v2.status, version: v2.version }))
check('M2根因: 改版后 grants 原样保留（未清空）', JSON.stringify(v2.grants) === JSON.stringify(['scope:marketing']), JSON.stringify(v2.grants))

// 4) B published-only 列表不再含 S → 正确（未发布不外泄给消费方）
const bList2 = mod.listSkills({ scope: 'marketing' })
check('正确: marketing published-only 已不含 pending 的 S', !bList2.some(x => x.id === 's-csharp'))

// 5) M2 泄漏点: SkillsPanel 空间视图固定 member=general&include=pending → B 复审视角看到 A 的 pending 草稿
const leakView = mod.listSkills({ scope: 'marketing', member: 'general', includePending: true })
const leaked = leakView.find(x => x.id === 's-csharp')
check('M2泄漏: B(member=general,include=pending) 不得看到 A 的 pending 草稿(AC-R1-7)', !leaked, leaked ? 'LEAKED prompt=' + leaked.prompt : '')
if (leaked) console.log('  LEAKED 证据: status=' + leaked.status + ' prompt=' + JSON.stringify(leaked.prompt))

console.log(fail === 0 ? '== M2 结论: 无泄漏（期望外行为）==' : '== M2 结论: 确认泄漏缺陷（' + fail + ' 项 FAIL）==')
mod.db.close()
rmSync(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)

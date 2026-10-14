// docs/G-mv7kzgnu-1/T209-evidence/static-checks.mjs
// T-209 静态度量：把 TEST_CASES.md 里靠「读源码/读文档」判定的用例做成可复跑脚本。
// 退出码 0 = 全部 PASS；否则打印每条 FAIL。
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(p, 'utf8')
let fails = 0
const ok = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''))
  if (!cond) fails += 1
}
const GEAR = '\u2699'
const GEAR_EMOJI = '\u2699\uFE0F'

// ── I-1 零新增运行时依赖 ──
const pkg = JSON.parse(read('workbench/package.json'))
ok('TC-S2-10/I-1 dependencies 恰好 5 个', Object.keys(pkg.dependencies).length === 5, Object.keys(pkg.dependencies).join(','))

// ── E1 / TC-S1-10 旧齿轮断言已被改写 ──
const tv = read('team-hub/team-views-routes.test.mjs')
ok('TC-S1-10 E1 旧断言 assert.equal(ext.avatar, \'⚙️\') 已不存在', !tv.includes("assert.equal(ext.avatar, '" + GEAR_EMOJI + "')"))
ok('TC-S1-10 E1 改写后断言仍在（\'\' 或 isAvatarToken）', tv.includes("ext.avatar === '' || isAvatarToken(ext.avatar)"))

// ── TC-S1-09 改动只在两个读出口 ──
const views = read('team-hub/routes/team-views.mjs')
ok('TC-S1-09 /api/roster 内编头像归一化仍为 isAvatarToken', views.includes("isAvatarToken(r.avatar) ? r.avatar.trim() : ''"))
ok('TC-S1-09 external 头像来自 externalAvatarFor', views.includes('externalAvatarFor(soldier, usedTokens)'))
// 齿轮 emoji 只允许出现在**注释**里（解释旧值），不得再作为 avatar 的代码字面量。
const viewsGearCodeLines = views.split('\n').filter((l) => l.includes(GEAR_EMOJI) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
ok('TC-S1-09 齿轮 emoji 不再作 team-views.mjs 的代码字面量', viewsGearCodeLines.length === 0, JSON.stringify(viewsGearCodeLines))

// ── TC-S5-04/05/06 文档口径 ──
for (const f of ['workbench/README.md', 'docs/FEATURES.md']) {
  const s = read(f)
  ok('TC-S5-04 ' + f + ' 无「零图片资源」', !s.includes('零图片资源'))
  // 旧口径 = 把齿轮 emoji 当作执行中条目的**现状**来描述（含「不再是齿轮 emoji」不算）
  const oldWording = new RegExp(GEAR_EMOJI + '[^。\\n]{0,20}执行中')
  ok('TC-S5-05 ' + f + ' 无「⚙️ … 执行中」旧口径', !oldWording.test(s))
  // 新口径 = 明确「未入编队/外部执行者 同样拿 human:<key> 人形令牌」（两文件措辞不同，按语义判）
  ok('TC-S5-06 ' + f + ' 含「外部/未入编队执行者拿 human:<key>」新口径', /(外部执行者|未入编队[^。\n]*执行者)/.test(s) && /human:<key>/.test(s))
}
// ── TC-S5-07 无过程叙事 ──
for (const f of ['workbench/README.md', 'docs/FEATURES.md']) {
  const s = read(f)
  const n = (s.match(/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/g) || []).length
  ok('TC-S5-07 ' + f + ' 无过程叙事', n === 0, 'hits=' + n)
}

// ── TC-S3-12 界面齿轮图标不被误伤 ──
ok('TC-S3-12 Sidebar 界面齿轮仍在', read('workbench/src/components/Sidebar.tsx').includes(GEAR))
ok('TC-S3-12 CommandBar 模型配置入口仍在', read('workbench/src/components/CommandBar.tsx').includes('模型配置'))

// ── TC-S3-01/02 两处图形化 + 同源 ──
const sidebar = read('workbench/src/components/Sidebar.tsx')
const rail = read('workbench/src/components/WorkspaceNavigation.tsx')
ok('TC-S3-01 Sidebar .user-avatar 内是 <AgentAvatar>', /<div className="user-avatar">\s*<AgentAvatar/.test(sidebar))
ok('TC-S3-01 Sidebar 不再把齿轮当头像（user-avatar\">\s*⚙ = 0）', !new RegExp('user-avatar\">\\s*' + GEAR).test(sidebar))
ok('TC-S3-02 左轨 .workspace-user 内是 <AgentAvatar>', /className="workspace-user"[\s\S]{0,160}<AgentAvatar/.test(rail))
ok('TC-S3-02 左轨不再用「管」当徽标', !/className="workspace-user"[^>]*>管</.test(rail))
ok('TC-S3-03 两处均从 external-agents 取常量', /external-agents/.test(sidebar) && /external-agents/.test(rail))

// ── TC-S4-01/02/03 S8 技能授权标签 ──
const sp = read('workbench/src/components/SkillsPanel.tsx')
const nAvatars = (sp.match(/<AgentAvatar/g) || []).length
ok('TC-S4-01 S8 三处 <AgentAvatar>', nAvatars >= 3, 'count=' + nAvatars)
ok('TC-S4-01 S8 引用 external-agents 兜底', /external-agents/.test(sp))
ok('TC-S4-02 无「目录查不到就不渲染」形态', !/\{a\s*&&\s*<AgentAvatar/.test(sp))
ok('TC-S4-03 无第二套视觉表 / 无 <img 破图路径', !/const AVATARS\s*=/.test(sp) && !sp.includes('AVATAR_CHOICES') && !/<img[^>]*avatar/i.test(sp))

console.log('static-checks: ' + (fails === 0 ? 'PASS（全部静态度量通过）' : 'FAIL（' + fails + ' 项）'))
process.exit(fails === 0 ? 0 : 1)

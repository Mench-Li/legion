// workbench/scripts/scene-office-wiring.test.mjs
// 办公室场景的**接线判据**：布景/看板/气泡/走看板这四件事必须真的接上，且颜色不许有第二份。
//
// 为什么用"读源码"而不是 import 组件：这些是 `.tsx`（需要 React 运行时与 DOM），
// 而这一组要守的恰恰是**结构性质** —— "谁引了谁""两处是不是同一个常量""颜色表有没有第二份"。
// 这类缺陷的共同点是**不报错**：少挂一个组件 = 那一块根本不出现；常量抄成两个数 =
// 人走到一半被弹回工位；颜色表抄第二份 = 同一件任务两种颜色。三者都不会让任何测试变红，
// 除非有人**专门为它们**写这样一组判据（与 plugins 侧 hub-read-auth 同一手法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')

/** 递归收集 src 下的 .ts/.tsx（不含 .css：样式里的色号是另一层，见文件头）。 */
function sourceFiles(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue }
    if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

test('① Scene3D 真的挂上了布景与看板，并把两样数据传下去', () => {
  const scene = read('components/Scene3D.tsx')
  assert.match(scene, /import \{ OfficeDressing \} from '\.\/OfficeDressing'/, '布景要 import 进来')
  assert.match(scene, /<OfficeDressing layout=\{layout\} theme=\{theme\}/, '布景必须拿到 layout 与主题（位置全靠 layout 推导，见其文件头）')
  assert.match(scene, /import \{ TaskBoard3D \} from '\.\/TaskBoard3D'/, '看板要 import 进来')
  assert.match(scene, /<TaskBoard3D cards=\{boardTasks\} staff=\{boardStaff\} names=\{names\} board=\{layout\.board\} activeVisit=\{activeVisit\} \/>/,
    '看板必须收到卡片、按员工汇总、显示名、位置、"正被办的那张卡"五样')
  assert.match(scene, /boardVisits=\{boardVisits\}/, 'Scene3D 要把 boardVisits 接进 OfficeWorld')
  assert.match(scene, /boardStandX=\{layout\.board\.x \+ lane\}/, '走过去要站到板前（按 lane 错位，不叠在一点）')
  assert.match(scene, /const liveCues = cues\.filter/, '提示仍要按有效期过滤')
  // 过期重渲染必须把"走看板"也算进去，否则最后一位会僵在板前
  assert.match(scene, /\.\.\.boardVisits\.map\(visit => visit\.expiresAtMs\)/, '到期重渲染要把 boardVisits 一起算')
})

test('② 气泡常驻且能展开全部任务；颜色表**只有一份**', () => {
  const bubble = read('components/AgentBubble.tsx')
  assert.match(bubble, /import \{ MOOD_STYLE, STATUS_STYLE \} from '\.\.\/scene\/sceneBoard'/, '气泡的颜色必须取自 sceneBoard 那一份')
  assert.match(bubble, /agent\.tasks\.map\(/, '悬浮要列出**全部**任务（不是"前 N 条"）')
  assert.match(bubble, /--bubble-color/, '气泡底色由气色驱动')
  const employee = read('components/Employee3D.tsx')
  assert.match(employee, /<AgentBubble agent=\{agent\} expanded=\{hovered\}/, '员工头顶要挂气泡')
  assert.doesNotMatch(employee, /const STATUS = \{/, '员工里不许再有第二份状态色表（那正是会漂移的那一份）')
  assert.doesNotMatch(employee, /const LABEL = \{/, '员工里不许再有第二份状态中文名表')
  assert.match(employee, /MOOD_STYLE\[agent\.mode\]/, '气色取自 sceneBoard')
})

test('③ 走看板由"起点时间 + 同一条总时长"驱动（不许退化成布尔值）', () => {
  const employee = read('components/Employee3D.tsx')
  assert.match(employee, /import \{ BOARD_VISIT_MS, MOOD_STYLE, STATUS_STYLE \} from '\.\.\/scene\/sceneBoard'/,
    '总时长必须与提示有效期是同一个常量')
  assert.match(employee, /visitStartedAt\.current = performance\.now\(\)/, '要记下这一趟的起点')
  assert.match(employee, /\(performance\.now\(\) - visitStartedAt\.current\) \/ BOARD_VISIT_MS/, '进度按"距起点多久"算')
  assert.match(employee, /visitStartedAt\.current/, '半路提示过期也必须走完（否则会被瞬移回工位）')
  assert.doesNotMatch(employee, /position\.y = .*1\.35/, '办事是站着抬手，不许把人抬到半空')
})

test('④ 面板与 App 把两样数据一路送到场景（少一环 = 那一块永不出现）', () => {
  const panel = read('components/CenterPanel.tsx')
  assert.match(panel, /sceneVisits\?: SceneBoardVisit\[\]/, '面板要收 sceneVisits')
  assert.match(panel, /boardVisits=\{sceneVisits\.filter\(visit => visit\.scope === scope\)\}/, '要按当前空间过滤后传给场景')
  assert.match(panel, /boardTasks=\{visibleSceneTasks\(sceneFacts\?\.tasks \?\? \[\]\)\.map\(task => \(\{/, '看板卡片来自本空间任务，且过**同一份**可见性过滤')
  assert.match(panel, /import \{ byStaff, visibleSceneTasks \} from '\.\.\/scene\/sceneBoard'/, '过滤与汇总函数必须取自 sceneBoard（不许在这里另写一份）')
  assert.match(panel, /import \{ taskOwnerRole \} from '\.\.\/scene\/agentOwnership'/, '归属人也要走唯一那份规则（与"谁走过去"同源）')
  assert.match(panel, /boardStaff=\{byStaff\(/, '按员工汇总要在面板算好（顶部条与板底共用一份）')
  assert.doesNotMatch(panel, /task\.status !== 'canceled'/, '面板里不许再留一份"取消不上板"的判断 —— 那是同一规则的第二份副本')
  const app = read('App.tsx')
  assert.match(app, /const \[sceneVisits, setSceneVisits\] = useState<SceneBoardVisit\[\]>\(\[\]\)/, 'App 要有这一份状态')
  assert.match(app, /onSnapshot: \(facts, cues, visits\) =>/, '回调要收第三个产物')
  assert.match(app, /setSceneVisits\(visits\)/, '并且要存下来')
  assert.match(app, /sceneVisits=\{sceneVisits\}/, '还要传进 CenterPanel')
  const controller = read('scene/sceneController.ts')
  assert.match(controller, /import \{ deriveBoardVisits \} from '\.\/sceneBoard\.ts'/, '控制器负责派生')
  assert.match(controller, /const visits = deriveBoardVisits\(previous, current, candidates, nowMs, canSee\)/, '用同一批事件、同一个时间窗')
  assert.match(controller, /options\.onSnapshot\(current, cues, visits\)/, '三个产物一起回调（分成两次会让时间窗对不齐）')
})

test('⑤ 状态颜色在全 workbench/src 里**只出现一次**（再抄一份这条就红）', () => {
  // 五种状态的代表色：任何 sceneBoard.ts 之外的文件里出现它们，就是又抄了一份颜色表
  const owned = ['#5b8cff', '#40ffa0', '#ffd54a', '#ff5c5c', '#8fa3bd']
  const offenders = []
  for (const file of sourceFiles()) {
    if (file.endsWith(join('scene', 'sceneBoard.ts'))) continue
    const text = readFileSync(file, 'utf8')
    for (const color of owned) if (text.includes(color)) offenders.push(`${file.slice(SRC.length + 1)} 出现 ${color}`)
  }
  assert.deepEqual(offenders, [], `状态颜色只许定义在 sceneBoard.ts：\n${offenders.join('\n')}`)
})

test('⑥ 场景样式放在自己的 CSS 里，不往全站的 index.css 里塞', () => {
  // 多人同时改 index.css 必然冲突；场景的 DOM 覆盖层（气泡/看板标签）自成一档
  const scene = read('components/Scene3D.tsx')
  assert.match(scene, /import '\.\.\/scene\/officeScene\.css'/, '场景样式由 Scene3D 自己 import')
  const css = read('scene/officeScene.css')
  for (const cls of ['.agent-bubble', '.agent-bubble-panel', '.task-board-column', '.task-board-tip', '.task-board-footer']) {
    assert.ok(css.includes(cls), `officeScene.css 缺少 ${cls}（组件里用到它，缺了会渲染成裸文本）`)
  }
  assert.match(css, /max-height: 168px; overflow-y: auto/, '气泡清单要限高可滚（全部任务都列，但气泡不许无限长高）')
})

test('⑦ 新套件已登记进 CI（没登记的判据等于不存在）', () => {
  const runCi = readFileSync(join(SRC, '..', '..', 'scripts', 'ci', 'run-ci.mjs'), 'utf8')
  for (const suite of ['workbench/scripts/scene-board.test.mjs', 'workbench/scripts/scene-office-wiring.test.mjs']) {
    assert.ok(runCi.includes(suite), `run-ci.mjs 未登记 ${suite}`)
  }
})

test('⑧ 四面墙必须"剖视"：相机背后的那一面要隐去（否则房间只剩一堵墙）', () => {
  const dressing = read('components/OfficeDressing.tsx')
  // 四面墙都要有（少一面就不是房间了）
  for (const wall of ['back', 'front', 'left', 'right']) {
    assert.match(dressing, new RegExp(`ref=\\{walls\\.${wall}\\}`), `${wall} 墙没挂 ref（剖视就管不到它）`)
  }
  assert.match(dressing, /useFrame\(\(\{ camera \}\)/, '剖视必须每帧按相机位置决定')
  assert.match(dressing, /walls\.back, camera\.position\.z > /, '相机在房间前方 ⇒ 显示后墙')
  assert.match(dressing, /walls\.front, camera\.position\.z < /, '相机在后 ⇒ 显示前墙')
  assert.match(dressing, /walls\.left, camera\.position\.x > /, '相机在右侧 ⇒ 显示左墙')
  assert.match(dressing, /walls\.right, camera\.position\.x < /, '相机在左侧 ⇒ 显示右墙')
  // 阈值必须与房间尺寸成比例：写死成 0 会让俯视时来回闪
  assert.match(dressing, /half\.z \* 0\.12/, '阈值按房间深度取，不能写成常数')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑨ 将军 2026-10-14 的两条改口：
//    · 「已完成的就不要显示了」
//    · 「显示任务编号即可，悬停时展示完整任务内容」
//    这两条都不是实现细节而是**需求**，所以要有判据守着它们不会被改回去。
// ══════════════════════════════════════════════════════════════════════════

test('⑨★ 看板不列"完成"列，且卡片上只写编号、悬浮才出完整内容', () => {
  const board = read('scene/sceneBoard.ts')
  assert.match(board, /SCENE_HIDDEN_STATUSES: readonly CardStatus\[\] = \['canceled', 'done'\]/,
    '已完成与已取消必须都在隐藏名单里（唯一一份）')
  assert.match(board, /export function visibleSceneTasks/, '要有一个公开的过滤函数给调用方复用')
  assert.doesNotMatch(board, /\{ key: 'done'/, '看板不许再有"完成"列')
  const tip = read('components/TaskBoard3D.tsx')
  assert.match(tip, /className="task-board-card-id"/, '卡片上要显示任务编号')
  assert.match(tip, /\{task\.id\}<\/span>/, '卡片上写的是任务编号')
  assert.match(tip, /className="task-board-tip-title"/, '悬浮提示里要出完整标题（单独一行，可换行）')
  // 卡片文字不许挡住它自己的悬浮事件（否则鼠标一放上去提示就没了）
  assert.match(tip, /zIndexRange=\{\[23, 0\]\} style=\{\{ pointerEvents: 'none' \}\}/, '编号文字要 pointerEvents:none')
})

test('⑨★ 气泡每行只写编号、鼠标停在该行才展开完整标题；已完成同样不出现', () => {
  const bubble = read('components/AgentBubble.tsx')
  assert.match(bubble, /const \[hoverTask, setHoverTask\] = useState<string \| null>\(null\)/, '要记下鼠标停在哪一行')
  assert.match(bubble, /onPointerEnter=\{event => \{ event\.stopPropagation\(\); setHoverTask\(task\.id\) \}\}/, '停到某行 ⇒ 展开它')
  assert.match(bubble, /\{open && <span className="agent-bubble-task-title">\{task\.title\}<\/span>\}/,
    '完整标题只在悬浮那一行时出现（平时只有编号）')
  assert.match(bubble, /<b style=\{\{ color: taskStyle\.color \}\}>\{task\.id\}<\/b>/, '行里显示的是任务编号')
  // 常驻形态也改成显示编号（原来显示的是最要紧那条的标题）
  assert.match(bubble, /<div className="agent-bubble-focus">\{agent\.tasks\[0\]\.id\}<\/div>/, '常驻形态显示最要紧那条的编号')
  const css = read('scene/officeScene.css')
  assert.match(css, /\.agent-bubble-task-title \{[\s\S]{0,120}flex-basis: 100%/, '标题要独占一行（换行显示，不挤在编号旁）')
  assert.match(css, /\.task-board-card-id \{/, '看板编号要有自己的样式（否则与卡片色块糊在一起看不清）')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑩ 将军 2026-10-14 的另两条：
//    · 「直接不显示暂无进行中任务，没有就不显示」
//    · 「底部办公室员工可以收起」/「明亮的背景色」/「足够的空间展示」
// ══════════════════════════════════════════════════════════════════════════

test('⑩★ 气泡：没有任务时**什么都不显示**（不再有"暂无进行中任务"那句）', () => {
  const bubble = read('components/AgentBubble.tsx')
  // ⚠ 判据只看**真正会渲染出来的 JSX**：先切出 `return (` 之后的部分，再**剥掉 JSX 注释**。
  //   第一版只切了 `return (`，结果被我自己写的那句说明注释绊倒 ——
  //   （注释里引述了被删掉的文案）。判据要盯"用户看得见什么"，不是"文件里有哪些字"。
  const render = bubble.slice(bubble.indexOf('return (')).replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  assert.doesNotMatch(render, /暂无进行中的任务/, '那句空态文案必须删掉（将军：没有就不显示）')
  assert.doesNotMatch(render, /agent-bubble-empty/, '空态那个元素也不该再被渲染')
  // 清单与"看完整内容"的提示都必须挂在 taskCount > 0 上（否则空气泡会拖一条空面板）
  assert.match(render, /\{agent\.taskCount > 0 && \(expanded/, '清单要有"有任务"这个前提')
  assert.match(render, /\{expanded && agent\.taskCount > 0 && <div className="agent-bubble-more">/, '底部提示同理')
  const css = read('scene/officeScene.css')
  assert.doesNotMatch(css, /\.agent-bubble-empty \{/, '那条空态样式也删掉（留着会让人以为还在用）')
})

test('⑩★ 底部员工列表可收起，收起后把那 68px 让给画面', () => {
  const scene = read('components/Scene3D.tsx')
  assert.match(scene, /const \[listOpen, setListOpen\] = useState\(true\)/, '要有展开状态（默认展开）')
  assert.match(scene, /onClick=\{\(\) => setListOpen\(value => !value\)\} aria-expanded=\{listOpen\}/, '工具栏要有可访问的收起按钮')
  assert.match(scene, /收起员工列表/, '按钮文案要说明当前能做什么')
  assert.match(scene, /\{listOpen && <SceneAgentList agents=\{agents\} onAgentClick=\{onAgentClick\} \/>\}/,
    '收起时**不渲染**列表（不是只藏起来：canvas 是 flex:1，省下的高度必须真的给它）')
  const css = read('scene/officeScene.css')
  assert.match(css, /\.pixel-scene-toolbar-actions \{ display: flex/, '两个按钮要成组（否则一个左一个右）')
})

test('⑩★ 背景是亮的，且取景来自可测的纯函数（接线不许再写死）', () => {
  const scene = read('components/Scene3D.tsx')
  assert.match(scene, /import \{ SCENE_BACKGROUND, SCENE_GROUND_BOUNCE, SCENE_THEMES \} from '\.\.\/scene\/sceneTheme'/, '背景色要取自主题模块')
  assert.match(scene, /<color attach="background" args=\{\[SCENE_BACKGROUND\]\} \/>/, '背景必须用常量（不许再写死深色）')
  assert.doesNotMatch(scene, /'#0b111a'/, '那个近黑的背景必须消失')
  assert.match(scene, /ortho\.zoom = framingZoom\(\{ width: size\.width, height: size\.height \}, layout\)/,
    '取景必须调纯函数 framingZoom（它决定"够不够空间展示"，写死在组件里就测不到）')
  const theme = read('scene/sceneTheme.ts')
  assert.match(theme, /export const SCENE_BACKGROUND = '#/, '主题模块要导出背景常量')
  assert.match(theme, /地板 < 背景 < 墙/, '明度关系要写在注释里（下一个人改色号时才知道约束是什么）')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑫ 将军 2026-10-14 的三条：
//    · 「任务看板 0项统计可以固定在场景顶部，不随场景旋转」
//    · 「看板放大，可以标注具体的任务编号」
//    · 「下方编队，进行中的提示可以随员工固定并收缩」
// ══════════════════════════════════════════════════════════════════════════

test('⑫★ 顶部统计条是**屏幕空间**的 DOM（所以不随场景旋转），且不重复渲染 3D 抬头', () => {
  const scene = read('components/Scene3D.tsx')
  assert.match(scene, /<div className="scene-status-bar">/, '顶部要有一条固定的统计条')
  assert.match(scene, /<span className="scene-status-title">\{boardHeadline\(boardSnapshot\)\}<\/span>/, '抬头文案来自唯一那一个纯函数')
  assert.match(scene, /const boardSnapshot = \{/, '读数要先算好一份（条与面板共用，不许各算一次）')
  // 屏幕空间 = 它不在 Canvas 里：位置必须在 <Canvas> 之后、且在 canvas 容器之外
  const barIndex = scene.indexOf('className="scene-status-bar"')
  const canvasIndex = scene.indexOf('<Canvas ')
  assert.ok(barIndex > 0 && barIndex < canvasIndex, '统计条要排在 Canvas **之前**（屏幕层，不在 3D 里）')
  assert.match(scene, /<i style=\{\{ background: STATUS_BAR_COLOR\[column\.key\]/, '每一条的条色取自同一份颜色契约')
  assert.match(scene, /<b style=\{\{ width: `\$\{share\}%` \}\} \/>/, '要有比例条（一眼看出分布）')
  const css = read('scene/officeScene.css')
  assert.match(css, /\.scene-status-bar \{[\s\S]{0,160}background: #101b2a/, '统计条要自成一层底色（压在画布上）')
})

test('⑫★ 悬停看板时给一份**固定**的明细面板（编号 + 归属人 + 标题）', () => {
  const scene = read('components/Scene3D.tsx')
  assert.match(scene, /<details className="scene-board-tip">/, '用 details 做点开/收起（不需要额外状态）')
  assert.match(scene, /<summary>📋 看板 \{boardTasks\.length\} 项 · 悬停看明细<\/summary>/, '摘要要报总数')
  assert.match(scene, /<code>\{task\.id\}<\/code>/, '明细里要有任务编号')
  assert.match(scene, /<em>\{task\.role \? \(agents\.find\(agent => agent\.role === task\.role\)\?\.name \?\? task\.role\) : '未认领'\}<\/em>/,
    '明细里要有归属人（认不出来就写"未认领"，不编名字）')
  assert.match(scene, /<span title=\{task\.title\}>\{task\.title\}<\/span>/, '明细里要有完整标题')
  assert.match(scene, /columnTasks\.length > 8 && <span className="scene-board-tip-more">/, '一列超过 8 项要说明"还有 N 项"，不许静默截断')
})

test('⑫★ 气泡可收缩（slim）且受阻有红标；看板放大后卡片带归属人', () => {
  const bubble = read('components/AgentBubble.tsx')
  assert.match(bubble, /className=\{`agent-bubble \$\{minimal && !expanded \? 'slim' : ''\}`\}/, '未悬浮时收缩成 slim')
  assert.match(bubble, /\{\(!minimal \|\| expanded\) && <span className="agent-bubble-mood">/, '收缩时省掉"进行中"三个字，只留件数')
  assert.match(bubble, /<span className="agent-bubble-blocked" title=\{`受阻 \$\{blocked\} 项`\}>⚠\{blocked\}<\/span>/, '受阻件数要有红标')
  const employee = read('components/Employee3D.tsx')
  assert.match(employee, /blocked=\{blockedCount\}/, '员工要把受阻数透给气泡')
  assert.match(employee, /minimal=\{compact && !hovered\}/, '人多时默认收缩（悬浮即展开）')
  const board = read('components/TaskBoard3D.tsx')
  assert.match(board, /className="task-board-tip-role">\{who \?\? '未认领'\}/, '看板悬浮提示要带归属人')
  assert.match(board, /staff\.slice\(0, 4\)\.map\(row =>/, '板底那一行改成按员工汇总')
  assert.match(board, /const maxCards = 12/, '板子加高后每列放到 12 张')
  const css = read('scene/officeScene.css')
  assert.match(css, /\.agent-bubble\.slim \{/, '收缩形态要有样式')
  assert.match(css, /\.task-board-tip-role \{/, '归属人要有个位置（右浮）')
})

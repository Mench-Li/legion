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
  assert.match(scene, /<TaskBoard3D tasks=\{boardTasks\} board=\{layout\.board\} activeVisit=\{activeVisit\}/,
    '看板必须收到任务、位置、"正被办的那张卡"三样')
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
  assert.match(panel, /boardTasks=\{\(sceneFacts\?\.tasks \?\? \[\]\)/, '看板卡片来自本空间任务')
  assert.match(panel, /\.filter\(task => task\.status !== 'canceled'\)/, '取消的任务不上板')
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

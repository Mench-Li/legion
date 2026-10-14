// workbench/scripts/workflow-panel-layering.test.mjs
//
// ============================================================================
// 「Agent 工作流」面板的**分层**判据（2026-10-13，② 常用/高级分层 + ① 减法）。
//
// 为什么用源码级断言：这几条不变量活在 JSX 结构里，没有能单独调用的函数 ——
// 而它们**正是会被无意破坏**的那类东西（下次有人往面板里加一节，很容易加错位置）。
// 本仓已有同样的先例（`plugins/tests/multi-space.test.mjs` 直接读 `src/index.ts`）。
//
// ★ 最要紧的一条是「**错误不许被折进高级区**」：
//   能力位里有一条会**拦下发布**（读数说 outputSchema=false）。若它跟着高级选项
//   一起收进折叠区，用户看到的就是"一切正常"，而问题藏在一次点击之后。
//
//     > 一个"把高级选项收起来"的改动，
//     > 与一个"把错误也一起收起来"的改动，
//     > 在**没有错误的时候**是同一个东西 ——
//     > 区别只在真出问题的那次，而那时用户看到的是"一切正常"。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const SRC = readFileSync(join(root, 'src', 'components', 'AgentWorkflowConfigurator.tsx'), 'utf8')

/** 每一个 `<details>` 的正文区间（用开始/结束标记切出来）。 */
function detailsBodies(src) {
  const bodies = []
  let from = 0
  for (;;) {
    const open = src.indexOf('<details', from)
    if (open < 0) break
    const close = src.indexOf('</details>', open)
    if (close < 0) break
    bodies.push(src.slice(open, close))
    from = close + 1
  }
  return bodies
}
/** 去掉所有折叠区之后剩下的源码 = **始终可见**的部分。 */
function outsideDetails(src) {
  let out = src
  for (const body of detailsBodies(src)) out = out.split(body).join('')
  return out
}

describe('面板分层：什么必须始终可见', () => {
  const outside = outsideDetails(SRC)
  const inside = detailsBodies(SRC).join('\n')

  test('★★★ 能力位的 blocker / warning **不许**落在折叠区里', () => {
    // 这条是本文件存在的主要理由：那一块里有一条能拦下发布。
    assert.ok(outside.includes('nativeDerivation.blockers'), 'blockers 必须在折叠区之外')
    assert.ok(outside.includes('nativeDerivation.warnings'), 'warnings 也必须在折叠区之外')
    assert.ok(!inside.includes('nativeDerivation.blockers'), '❌ blockers 被折进去了 —— 出问题时用户会看到"一切正常"')
  })

  test('★★ 三行岗位/工具必须始终可见（这是"最短路径"）', () => {
    assert.ok(outside.includes('(Object.keys(ROLE_LABEL) as RoleKey[]).map'), '三行岗位要在折叠区之外')
    // 工具下拉里那三个选项也必须可见
    for (const label of ['Claude Code', 'DSH', 'Codex']) {
      assert.ok(outside.includes(`>${label}</option>`), `工具选项 ${label} 必须可见`)
    }
    assert.ok(!inside.includes('(Object.keys(ROLE_LABEL) as RoleKey[]).map'), '三行岗位不该在折叠区里')
  })

  test('★★ 底部按钮（保存/关闭自动交接/刷新）必须始终可见', () => {
    for (const label of ['保存闭环配置', '关闭自动交接', '刷新']) {
      assert.ok(outside.includes(label), `${label} 按钮必须可见`)
    }
  })

  test('★ 就绪度读数与告警必须始终可见（"我能不能用"的正面回答）', () => {
    assert.ok(outside.includes('readinessSummary'), '就绪度读数要在折叠区之外')
    assert.ok(outside.includes('externalToolsChosen'), '外部工具告警要在折叠区之外')
    assert.ok(outside.includes('bundleRemedy'), '缺 bundle 的修法要在折叠区之外')
  })

  test('★ 高级区确实存在，且把"不常用但有用"的那些装进去了', () => {
    const bodies = detailsBodies(SRC)
    assert.ok(bodies.length >= 1, '要有折叠区')
    const advanced = bodies.find((b) => b.includes('高级设置')) ?? ''
    assert.ok(advanced !== '', '要有一个「高级设置」折叠区')
    for (const [needle, why] of [
      ['能力声明', '能力位声明'],
      ['审查返工上限', '返工上限'],
      ['可复用工作流 DAG', '自定义交接链 DAG'],
      ['发布为可复用工作流版本', '冻结版本'],
      ['DSH 执行服务 注册名', 'DSH provider 注册名'],
    ]) {
      assert.ok(advanced.includes(needle), `${why}（${needle}）应当在高级区里`)
    }
  })

  test('★ 高级区的标题要**列出里面有什么**（否则用户不知道点开值不值）', () => {
    const summary = SRC.slice(SRC.indexOf('<summary'), SRC.indexOf('</summary>'))
    for (const part of ['能力声明', 'DAG', '发布为可复用工作流版本']) {
      assert.ok(summary.includes(part), `summary 里应当提到「${part}」`)
    }
  })
})

describe('面板减法：删掉的东西不许悄悄回来', () => {
  test('★★ 手工「登记节点」输入框已删（守护会自注册）', () => {
    assert.ok(!SRC.includes('节点 ID，如 workstation-a'), '那个要求用户猜 ID 的输入框不该回来')
    assert.ok(!SRC.includes('>登记节点</button>'), '登记按钮不该回来')
    assert.ok(!SRC.includes('registerAgentNode'), 'registerAgentNode 调用/导入应已移除')
    assert.ok(!SRC.includes('const createNode'), 'createNode 应已移除')
  })

  test('★★ sessionResume 不再由用户设置（零消费方）', () => {
    assert.ok(!SRC.includes('支持会话续接'), '那个复选框的标签不该回来')
    assert.ok(!SRC.includes('nativeSessionResume'), '它的状态不该回来')
    // 但**数据字段**要留着：hub 的 schema 要求每个能力位被显式声明
    assert.ok(SRC.includes('sessionResume: false'), '数据模型里仍要显式给出这一位')
  })

  test('★ localAgent 不许被"顺手一起删掉"（集成模式下真的会拦人）', () => {
    assert.ok(SRC.includes('提供本地 Agent 拦截能力'), 'localAgent 的声明必须保留')
  })

  test('★ 节点为空时的话术要指向"会自己登记"，而不是让用户去登记', () => {
    assert.ok(SRC.includes('会自己登记'), '要告诉用户不需要手工登记')
  })
})

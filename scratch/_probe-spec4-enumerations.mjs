// scratch/_probe-spec4-enumerations.mjs —— §4 正文里那些**可枚举的名目**，逐个查代码里有没有（**不提交**）
//
// ★ 第 30 轮的方法（"谁读它？"）找到了 env 那一格。这一轮把它做成批量：
//   §4 的每条功能正文里都有一串**具名**的东西（接口方法名、事件类型、状态取值、
//   档位、渠道…）。具名 ⇒ 可机械核对 ⇒ 能回答"这一条**名目**上齐了吗"。
//
// ★★ 方法上的诚实（本轮已经吃过三次假发现）：
//   关键词零命中 **不等于** 没实现——`审批超时` 零命中，而它由 `approval-ttl.mjs`
//   （40 例）实现着，只是代码里说的是 **TTL**。
//   ⇒ 所以本探针把"零命中"单独列出来，**每一条都要人再打开看一眼**才算数。
import { execFileSync } from 'node:child_process'

/** 在**所有被跟踪的**源码里找一个 token（含测试；测试也算"有落点"）。 */
function hits(token) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-F', token, '--', '*.mjs', '*.ts'],
      { encoding: 'utf8', maxBuffer: 1 << 26 })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { return [] }
}

const GROUPS = [
  ['F-01 唯一接口（7 个方法）', ['getHealth', 'getCapabilities', 'listModels', 'validateProfile', 'execute', 'cancel', 'recover']],
  ['F-01 RunEvent 类型', ['run.started', 'model.selected', 'message.delta', 'tool.', 'usage.updated', 'artifact.produced']],
  ['F-05 投递状态（6 态）', ['pending', 'delivering', 'delivered', 'suppressed', 'failed', 'unknown']],
  ['F-10 权限模式（5 档）', ['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy']],
  ['F-14 发布渠道（3 档）', ['internal', 'canary', 'stable']],
  ['F-16 计划字段', ['skip-on-overlap', 'timezone', 'catchup', 'catch-up', '补跑']],
  ['F-19 Manifest 固化（7 项）', ['prompt', 'skills', 'tools', 'permissions', 'model', 'connectors', 'budget']],
  ['F-20 能力包校验（4 项）', ['signature', 'dependencies', 'permissions', 'runtimeContract']],
  ['F-12 Launcher 动作', ['install', 'configure', 'start', 'stop', 'restart', 'diagnose', 'logs']],
]
const ZERO = []
for (const [title, tokens] of GROUPS) {
  console.log(`\n=== ${title} ===`)
  for (const t of tokens) {
    const f = hits(t)
    if (f.length === 0) ZERO.push(`${title} → ${t}`)
    console.log(`  ${f.length === 0 ? '✖' : '✔'} ${String(f.length).padStart(4)} 处  ${t}`)
  }
}
console.log(`\n★ 零命中的 token ${ZERO.length} 个（**每一个都要人工再确认**，不构成结论）：`)
for (const z of ZERO) console.log(`   · ${z}`)

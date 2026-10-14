// workbench/src/avatar/external-agents.ts
// 外部执行者（未入编队、由 tasks.soldier 合成的伪成员）的「名字 → 头像令牌」共享模块。
//
// 它是 team-hub/agent-avatars.mjs 的 EXTERNAL_AVATAR_TOKENS 的**客户端镜像**：
// 两端表由 workbench/scripts/external-avatar-parity.test.mjs 逐项 deepEqual 锁死 ——
// 只改一端会在提交时变红（先例：slots.ts ↔ mobile/avatar.mjs 由 avatar-parity 锁死）。
//
// ★ 这里**只**是「名字 → 令牌」的映射，不定义任何颜色/形状 ⇒ 不构成第二套视觉表
//   （单一来源纪律仍成立：令牌由 slots.ts 解析成位面、由 AgentAvatar 渲染）。
//   它的存在理由：外部执行者不在 /api/agents 目录里（read-models 只投影 roster），
//   而侧栏用户卡 / 左轨徽标 / 技能授权标签需要在没有目录行时也能拿到同一个头像。

/**
 * 外部执行者身份名 → 令牌。与 team-hub 端 EXTERNAL_AVATAR_TOKENS **逐项相同**。
 *
 * 位面 key 取空闲备用池 s11..s15：不与 25 个内置岗位 key 撞，也不与 software
 * 8 个内编岗位当前使用的 key 撞（AC-R3-3/AC-R4-2）。
 */
export const EXTERNAL_AGENT_AVATARS: Readonly<Record<string, string>> = {
  general: 'human:s11',
  'soldier-a': 'human:s12',
  'soldier-b': 'human:s13',
  'soldier-auto': 'human:s14',
  'soldier-market': 'human:s15',
}

/**
 * 身份名 → 令牌；未登记 / 空 / 非字符串返回 `''`（由 <AgentAvatar> 落确定性占位人形）。
 *
 * ★ 纯函数：同一 name 恒返回同一值，不含随机/时钟/网络（AC-R5-3）。
 * 客户端只解析「已点名」的外部身份；未登记名字交给占位人形，不在客户端再造一套
 * 兜底分配（那会让两端口径分叉，而 parity 套件锁的是这张表）。
 */
export function externalAvatarToken(name: string | null | undefined): string {
  if (typeof name !== 'string') return ''
  const key = name.trim()
  if (!key) return ''
  return EXTERNAL_AGENT_AVATARS[key] ?? ''
}

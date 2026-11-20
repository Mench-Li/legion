// workbench/src/goalPublishNotice.ts
// ============================================================================
// 发布目标之后那句提示的**措辞**（纯函数，不碰 DOM / 不发请求）。
//
// ## 为什么它值得单独一个模块
//
// 这句提示是"目标到底跑不跑得起来"的**唯一**读数，而它从前无条件地说：
//
//     目标已发布，但**这个空间现在不会自动开工**：<第一条阻塞>（另有 N 项）
//     → 修复：<命令>（**链任务已建好**，开通执行 / 守护上线后会自动认领，**不必重发**）
//
// 现场（2026-11-20，新空间 `personal-profile`，编队为空 + 流水线为空）：
//
//     POST /api/goal → 200（目标确实建了）
//     tasks 表          → **0 行**（建链 = 编队 ∩ 流水线启用岗位，两者都空 ⇒ 0 环）
//     界面              → 「链任务已建好…不必重发」
//
// 于是"建了 0 条"被说成"已经建好、等认领就行"。用户照它等下去，什么也不会发生；
// 而真正该做的事（配好编队/流水线之后**重新发布**）被这句话明确否掉了。
//
//   > 一句"不必重发"的错误提示，比没有提示更贵：
//   > 它让人主动放弃唯一有效的那一步。
//
// 所以措辞必须由**服务端回执里的真实建链数**（`publishGoal` 的 `task.stages`）决定，
// 而不是由"发布成功"这一件事决定。三种情形分开说：
//
//   ① 建了 0 条        → 明说"一条都没建"，并指出：配好之后**需要重新发布**；
//   ② 建了 N 条 + 有阻塞 → 沿用原措辞（这条链确实建好了，解开阻塞就会自动认领）；
//   ③ 回执没给建链数     → **不猜**：说"没法确认建了几环"，让人去看任务中心。
// ============================================================================

/** `GET /api/spaces/provision` 的一条检查项（只取本模块用得上的字段）。 */
export interface ProvisionBlockLike {
  level?: string
  code?: string
  message?: string
  fix?: string | null
}

export interface GoalPublishNoticeInput {
  /** 预检里 `level === 'error'` 的那些项（空数组 = 这个空间现在能自动开工）。 */
  blocked: readonly ProvisionBlockLike[]
  /** 服务端回执里的建链数（`publishGoal` 的 `task.stages`）；`null` = 回执没给（老中枢/形状变了）。 */
  builtStages: number | null
}

export interface GoalPublishNotice {
  tone: 'ok' | 'info'
  text: string
}

const MARK = '⚠ 目标已发布，但'

/** 把阻塞项压成一句话尾巴（首条 + 「另有 N 项」+ 可执行修复命令）。 */
function blockedTail(blocked: readonly ProvisionBlockLike[]): string {
  if (blocked.length === 0) return ''
  const first = blocked[0]
  const more = blocked.length > 1 ? `（另有 ${blocked.length - 1} 项）` : ''
  const fix = typeof first.fix === 'string' && first.fix.trim() !== '' ? ` → 修复：${first.fix}` : ''
  return `${first.message ?? first.code ?? '（预检给了一条没有说明的阻塞）'}${more}${fix}`
}

/**
 * 算发布目标后的那句提示。**纯函数**：同样的输入永远同一句话。
 *
 * @see 文件头 —— 三种情形为什么必须分开说。
 */
export function goalPublishNotice({ blocked, builtStages }: GoalPublishNoticeInput): GoalPublishNotice {
  const tail = blockedTail(blocked)
  const stageCount = typeof builtStages === 'number' && Number.isFinite(builtStages) && builtStages >= 0
    ? builtStages
    : null

  // ① 一条链任务都没建出来 —— 这种空间**必须重新发布**，不是"等认领"。
  if (stageCount === 0) {
    return {
      tone: 'info',
      text: `${MARK}**一条链任务都没建出来**${tail ? `：${tail}` : '（这个空间的编队与流水线都还是空的）'}`
        + '（建链 = 编队 ∩ 流水线启用岗位，两者都空就是 0 环）'
        + '——配好编队与流水线后**需要重新发布这条目标**：链是在发布那一刻建的，旧目标不会自己补建。',
    }
  }

  // ② 建了 N 条，但有阻塞 —— 链是真的、阻塞也是真的，两件事分开说。
  if (stageCount !== null && blocked.length > 0) {
    return {
      tone: 'info',
      text: `${MARK}这个空间现在不会自动开工：${tail}`
        + `（${stageCount} 环链任务已建好，开通执行 / 守护上线后会自动认领，不必重发）`,
    }
  }

  // ③ 回执没给建链数 —— 不猜成"建好了"，也不猜成"没建"。
  if (stageCount === null && blocked.length > 0) {
    return {
      tone: 'info',
      text: `${MARK}这个空间现在不会自动开工：${tail}`
        + '（这台中枢的回执没带"建了几环"，所以**无法确认链任务是否已建**——'
        + '请到任务中心看这次目标下有没有任务；没有就在配好编队与流水线后重新发布）',
    }
  }

  // ④ 建了 N 条且没有阻塞。
  if (stageCount !== null) {
    return { tone: 'ok', text: `🎯 已发布目标（${stageCount} 环链任务已建好，与既有目标并存）` }
  }

  // ⑤ 既没建链数也没阻塞：如实说"已发布"，不添加任何关于链的断言。
  return { tone: 'ok', text: '🎯 已发布目标（与既有目标并存；本次回执未带建链数，任务数请以任务中心为准）' }
}

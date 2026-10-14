import type { CardStatus, HubAuditEvent, HubTask, RosterAgent } from '../types'
import { taskOwnerRole } from './agentOwnership.ts'

/**
 * 场景里的**状态 → 颜色/文字**契约（气泡、看板卡片、工位光环共用一份）。
 *
 * ## 为什么必须只有一份
 *
 * 在这之前，颜色散在两处：`Employee3D.tsx` 里一份 `STATUS`/`LABEL`（工位光环），
 * 而看板卡片本来会再写一份。两处一旦漂移，症状是**同一件任务在同一个画面里两种颜色**
 * ——而它不报错、不消失，只是让人开始不信任颜色。
 *
 * 所以把这张表立成唯一真相：气泡底色、看板列色、卡片色、工位光环**全从这里取**。
 * 有一条判据钉住"每个任务状态都能在这里查到颜色"（新增状态时它会先红）。
 *
 * ⚠ 与 `workbench/src/types.ts` 的 `CardStatus` 是**同一个枚举**：这里只加颜色与中文名，
 * 不加新状态。新增状态时先改类型，再回来补这张表（那时判据会提醒你）。
 */
export const STATUS_STYLE: Record<CardStatus, { color: string; label: string }> = {
  backlog: { color: '#5b8cff', label: '待办' },
  todo: { color: '#5b8cff', label: '待办' },
  in_progress: { color: '#40ffa0', label: '进行中' },
  in_review: { color: '#ffd54a', label: '待验收' },
  blocked: { color: '#ff5c5c', label: '受阻' },
  done: { color: '#8fa3bd', label: '完成' },
  canceled: { color: '#455063', label: '已取消' },
}

/**
 * 看板的列定义。**按状态集合**分组，而不是一个状态一列 ——
 * 这样"待办"下能把 `backlog` 与 `todo` 合成一列（办公室里那块板只有这么宽）。
 *
 * 顺序就是看板从左到右的顺序，也是"任务走到哪一步"的顺序。
 * 判据钉住：除 `canceled` 外**每个状态恰好落在一列**里（不多不少）。
 */
export const BOARD_COLUMNS: ReadonlyArray<{ key: string; label: string; statuses: readonly CardStatus[] }> = [
  { key: 'todo', label: '待办', statuses: ['backlog', 'todo'] },
  { key: 'in_progress', label: '进行中', statuses: ['in_progress'] },
  { key: 'in_review', label: '待验收', statuses: ['in_review'] },
  { key: 'blocked', label: '受阻', statuses: ['blocked'] },
  { key: 'done', label: '完成', statuses: ['done'] },
]

/** 卡片/气泡上用的最小任务形状：只带"显示得出来"的三样，不把整个 HubTask 拖进 3D。 */
export interface SceneTaskChip {
  id: string
  title: string
  status: CardStatus
}

/** Agent 的气色。与 `SceneAgent.mode` 是同一个类型（别名，避免两处各立一个枚举）。 */
export type AgentMood = 'idle' | 'busy' | 'review' | 'blocked'

/**
 * 工位光环与气泡底色。`idle` 借"待办"的蓝、`busy` 借"进行中"的绿 ——
 * **刻意复用任务状态的颜色**：一个 Agent 显示什么颜色，等于"他手上最要紧的那件事"什么颜色。
 * 这样看板上的卡片色与头顶的气泡色天然一致，不需要第二套心智模型。
 */
export const MOOD_STYLE: Record<AgentMood, { color: string; label: string }> = {
  idle: STATUS_STYLE.todo,
  busy: STATUS_STYLE.in_progress,
  review: STATUS_STYLE.in_review,
  blocked: STATUS_STYLE.blocked,
}

/**
 * 一个 Agent 该显示什么气色 —— 取他手上**最要紧**的那件事：
 * 受阻 > 待验收 > 进行中 > 待命。
 *
 * 这条顺序与看板从右往左的"需要人管"程度一致：一块红牌比一堆绿牌更该被看见。
 * `projectSceneAgents` 的 `mode` 与气泡颜色**都调这一个函数**（一次判定，两处使用）。
 */
export function moodFor(tasks: readonly Pick<SceneTaskChip, 'status'>[]): AgentMood {
  if (tasks.some(task => task.status === 'blocked')) return 'blocked'
  if (tasks.some(task => task.status === 'in_review')) return 'review'
  if (tasks.some(task => task.status === 'in_progress')) return 'busy'
  return 'idle'
}

/** 某个状态属于哪一列（找不到 ⇒ `null`；`canceled` 刻意没有列）。 */
export function boardColumnFor(status: CardStatus): string | null {
  return BOARD_COLUMNS.find(column => column.statuses.includes(status))?.key ?? null
}

/**
 * 把任务按列分好，供看板渲染。
 *
 * ★ `canceled` **不进任何列**：一块办公室看板上不该有"已取消"的卡片占位，
 *   而那批任务本来也不出现在任何 Agent 名下（见 `agentOwnership`）。
 * ★ 每列内按 `id` 稳定排序：刷新一次卡片就换位置的话，人眼会以为"任务变了"。
 */
export function groupTasksByColumn(tasks: readonly SceneTaskChip[]): Map<string, SceneTaskChip[]> {
  const grouped = new Map<string, SceneTaskChip[]>(BOARD_COLUMNS.map(column => [column.key, []]))
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = boardColumnFor(task.status)
    if (key !== null) grouped.get(key)?.push(task)
  }
  return grouped
}

/** 看板上那一行小字：`进行中 3 / 12`。没有任务时给一句"空"，不显示 `0/0`。 */
export function columnCounter(columnTasks: readonly SceneTaskChip[], total: number): string {
  if (total === 0) return '空'
  return `${columnTasks.length}/${total}`
}

/**
 * 走一趟看板要多久（毫秒）：走过去 → 办一下 → 走回来。
 *
 * ★ 这一个常量**同时**是"提示的有效期"（派生端）与"动画的总时长"（渲染端）。
 *   分成两个数就会出现"人还在路上，提示已经过期"——表现为走到一半突然弹回工位，
 *   而那种抖动没人会归因到两个常量不同步。
 */
export const BOARD_VISIT_MS = 2800

/** 办事的动作：`claim` = 从看板上**取**一张卡（认领），`complete` = 把卡**贴到完成列**（完结）。 */
export type BoardVisitKind = 'claim' | 'complete'

export interface SceneBoardVisit {
  id: string
  scope: string
  kind: BoardVisitKind
  /** 谁去（岗位名）：他名下那条任务的归属人。 */
  role: string
  taskId: string
  title: string
  /** 去办的这件事对应的状态 —— 看板卡片闪光与气泡配色都用它。 */
  status: CardStatus
  eventSeq: number
  expiresAtMs: number
}

/** 派生走看板所必需的事实（与 `SceneFacts` 结构相同；用它避免 sceneBoard ↔ sceneState 互相 import）。 */
export interface BoardVisitFacts {
  scope: string
  roster: readonly RosterAgent[]
  tasks: readonly HubTask[]
}

/**
 * 从审计事件派生"谁现在该去走一趟看板"。
 *
 * ## 为什么是审计事件，而不是轮询状态
 *
 * 状态只能说明"现在是什么样"，说不出"刚刚发生了什么"。而"走向看板"是一个**动作**提示：
 * 它必须由**那一刻的事件**触发，否则每次刷新都会让所有人在看板前排队。
 *
 * 所以两个动作各有一条**必须同时成立**的判据（缺一条就会演出假的）：
 *
 *   · **认领**（`claim`）：事件是 claim、`payload.soldier` 就是新执行者、任务**这一刻**进 `in_progress`
 *     （之前不是）、且算得出归属人。少任何一条，就可能是"改派/重复认领/机器人自言自语"。
 *   · **完结**（`advance` 或 transition→done）：之前不是 `done`、这一刻是 `done`、且算得出归属人。
 *
 * 时间窗与 `deriveSceneCues` 同规矩：**8 秒内已经发生的**事件才算（否则重连补数据会把
 * 半小时前的历史重演一遍），且不接受"未来 1 秒以后"的事件（时钟漂移下的假事件）。
 *
 * 与 `deriveSceneCues` 的关系：那个函数产出"表演提示"（庆祝、交接连线），本函数产出
 * "要去哪办事"。两者**各自独立**判断，因为一次认领可以同时是"交接"和"去取卡"，
 * 而一次完结只有后者。
 */
export function deriveBoardVisits(
  previous: BoardVisitFacts | null,
  current: BoardVisitFacts,
  events: readonly HubAuditEvent[],
  nowMs: number,
  visible: boolean,
): SceneBoardVisit[] {
  if (!previous || !visible || previous.scope !== current.scope) return []
  const before = new Map(previous.tasks.map(task => [task.id, task]))
  const after = new Map(current.tasks.map(task => [task.id, task]))
  const visits: SceneBoardVisit[] = []
  for (const event of events) {
    if (event.scope !== current.scope || !event.taskId) continue
    const at = Date.parse(event.ts)
    if (nowMs - at > 8000 || at > nowMs + 1000) continue
    const was = before.get(event.taskId)
    const now = after.get(event.taskId)
    if (!was || !now) continue
    const role = taskOwnerRole(now, current.roster)
    if (role === null) continue
    const claimed = event.action === 'claim' && event.payload?.soldier === now.soldier
      && was.status !== 'in_progress' && now.status === 'in_progress'
    const completed = (event.action === 'advance' || (event.action === 'transition' && event.payload?.to === 'done'))
      && was.status !== 'done' && now.status === 'done'
    if (!claimed && !completed) continue
    visits.push({
      id: `${event.seq}:${now.id}:${claimed ? 'claim' : 'complete'}`,
      scope: current.scope,
      kind: claimed ? 'claim' : 'complete',
      role,
      taskId: now.id,
      title: now.title,
      status: now.status,
      eventSeq: event.seq,
      expiresAtMs: nowMs + BOARD_VISIT_MS,
    })
  }
  return visits
}

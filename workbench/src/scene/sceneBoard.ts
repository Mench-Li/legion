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
 * 判据钉住：**每个"要显示"的状态恰好落在一列**里（不多不少）——见 `isTaskVisibleInScene`。
 *
 * ★ 2026-10-14（将军："已完成的就不要显示了"）：**去掉了"完成"列**。
 *   一块看板的意义是"现在有什么要办"，而完成的任务是历史 —— 它会平白占掉一排位置，
 *   把真正在动的列挤窄。历史要看，去任务中心（那里有筛选与详情）。
 */
export const BOARD_COLUMNS: ReadonlyArray<{ key: string; label: string; statuses: readonly CardStatus[] }> = [
  { key: 'todo', label: '待办', statuses: ['backlog', 'todo'] },
  { key: 'in_progress', label: '进行中', statuses: ['in_progress'] },
  { key: 'in_review', label: '待验收', statuses: ['in_review'] },
  { key: 'blocked', label: '受阻', statuses: ['blocked'] },
]

/**
 * ★★ 哪些状态**不进场景**（看板不列、气泡不显示、也不计进任务数）。
 *
 * 只有这一份名单：`CenterPanel` 传卡片、`groupTasksByColumn` 分列、
 * `projectSceneAgents` 算气色与计数，四处都问它。
 * 分成多份的后果是"看板上不显示但气泡里还在"这类**不一致**：
 * 不报错，只是同一个东西在两个地方一个有、一个没有。
 *
 * ⚠ 与 `BOARD_COLUMNS` 的关系由判据钉住：这份名单 + 各列状态 = 全部 `CardStatus`，
 *   不多不少（新增状态时那条判据会先红，提醒你决定它该不该进场景）。
 */
export const SCENE_HIDDEN_STATUSES: readonly CardStatus[] = ['canceled', 'done']

/** 这件任务要不要出现在场景里（看板列 + 气泡清单 + 计数，都用这一个判断）。 */
export function isTaskVisibleInScene(status: CardStatus): boolean {
  return !SCENE_HIDDEN_STATUSES.includes(status)
}

/** 过滤出该进场景的任务（`HubTask` 或任何带 `status` 的东西，保持调用方的类型）。 */
export function visibleSceneTasks<T extends { status: CardStatus }>(tasks: readonly T[]): T[] {
  return tasks.filter(task => isTaskVisibleInScene(task.status))
}

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
  idle: { ...STATUS_STYLE.todo, label: '待命' },
  busy: STATUS_STYLE.in_progress,
  review: STATUS_STYLE.in_review,
  blocked: STATUS_STYLE.blocked,
}

/**
 * 一个 Agent 该显示什么气色 —— 取他手上**最要紧**的那件事：
 * 受阻 > 待验收 > 进行中 > 待命。
 *
 * 这条顺序与看板从左到右的"需要人管"程度一致：一块红牌比一堆绿牌更该被看见。
 * `projectSceneAgents` 的 `mode` 与气泡颜色**都调这一个函数**（一次判定，两处使用）。
 *
 * ⚠ 传进来的任务**应当已经过 `visibleSceneTasks`**（气泡与计数用的是同一批）。
 *   不然会出现"气泡写着 2 项、列出的却是 0 条"这种自相矛盾 —— 不报错，但没人数得对。
 */
export function moodFor(tasks: readonly Pick<SceneTaskChip, 'status'>[]): AgentMood {
  if (tasks.some(task => task.status === 'blocked')) return 'blocked'
  if (tasks.some(task => task.status === 'in_review')) return 'review'
  if (tasks.some(task => task.status === 'in_progress')) return 'busy'
  return 'idle'
}

/** 某个状态属于哪一列（找不到 ⇒ `null`：被隐藏的状态刻意没有列）。 */
export function boardColumnFor(status: CardStatus): string | null {
  return BOARD_COLUMNS.find(column => column.statuses.includes(status))?.key ?? null
}

/**
 * 把任务按列分好，供看板渲染。
 *
 * ★ 隐藏状态（`canceled` / `done`）**不进任何列** —— 统一由 `isTaskVisibleInScene` 决定，
 *   不在这里另写一份判断（那份判断正是会与别处漂移的东西）。
 * ★ 每列内按 `id` 稳定排序：刷新一次卡片就换位置的话，人眼会以为"任务变了"。
 */
/**
 * 把任务按列分好，供看板渲染。
 *
 * ★ 隐藏状态（`canceled` / `done`）**不进任何列** —— 统一由 `isTaskVisibleInScene` 决定，
 *   不在这里另写一份判断（那份判断正是会与别处漂移的东西）。
 * ★ 每列内按 `id` 稳定排序：刷新一次卡片就换位置的话，人眼会以为"任务变了"。
 * ★ 泛型 `<T extends SceneTaskChip>`：看板卡片是 `SceneBoardCard`（多一个 `role`），
 *   分组**必须把那个字段带出去** —— 写成 `SceneTaskChip` 会把归属人削掉，
 *   而 TypeScript 只会在读取处报错（那一处离原因很远）。
 */
export function groupTasksByColumn<T extends SceneTaskChip>(tasks: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>(BOARD_COLUMNS.map(column => [column.key, []]))
  for (const task of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isTaskVisibleInScene(task.status)) continue
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

// ══════════════════════════════════════════════════════════════════════════
// 看板抬头、按员工汇总、全景统计（将军 2026-10-14）
//
//   > 「任务看板 0项统计可以固定在场景顶部，不随场景旋转」
//   > 「看板放大，可以标注具体的任务编号」
//
// 两件事各有一个**数据上的前提**：
//   · 顶部那条统计要"按员工看得懂" ⇒ 需要 `byStaff` 汇总（谁身上几件、几件受阻）；
//   · 板子放大之后"这个编号归谁"要一眼可见 ⇒ 卡片要带 `role`。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 看板卡片：最小任务形状 + **归属人**。
 * 归属人是渲染侧用 `taskOwnerRole` 算好传进来的（同一条规则不能算两遍 ——
 * 否则会出现"卡片上写的名字"与"走过去的那个人"不是同一个，且不报错）。
 */
export interface SceneBoardCard extends SceneTaskChip {
  /** 归属岗位名；`null` = 还没有人认领。 */
  role: string | null
}

/** 按员工汇总一行：顶部统计条、板底那一行、气泡抬头共用同一份口径。 */
export interface BoardStaffRow {
  role: string
  name: string
  /** 他手上**在办**的任务数（已完成/已取消不算 —— 与 `visibleSceneTasks` 同源）。 */
  total: number
  /** 其中受阻的件数（>0 时那一行要显眼：这是最需要人管的一类）。 */
  blocked: number
  /** 他最要紧那件事的状态（配色用它）。 */
  mood: AgentMood
}

/**
 * 把"在办任务"按员工汇总。
 *
 * ★ 口径必须与看板列、气泡清单**完全一致**：同一批 `visibleSceneTasks` 输入、
 *   同一份 `moodFor` 判定。三处各算一次的话，会出现"顶部说 5 件、板上一共 4 张卡"
 *   —— 这种不一致不报错，只会让人开始不信这些数字。
 *
 * ⚠ 未认领的任务（`role === null`）**不进任何员工行**：它们在看板的"待办"列里等着，
 *   但不是任何人的活。硬塞给某个人会让"他在干什么"变成假话。
 */
export function byStaff(
  cards: readonly SceneBoardCard[],
  roster: readonly { role: string; name: string }[],
): BoardStaffRow[] {
  const names = new Map(roster.map(member => [member.role, member.name]))
  const rows = new Map<string, BoardStaffRow>()
  for (const card of cards) {
    if (card.role === null) continue
    const row = rows.get(card.role) ?? {
      role: card.role, name: names.get(card.role) ?? card.role,
      total: 0, blocked: 0, mood: 'idle' as AgentMood,
    }
    row.total += 1
    if (card.status === 'blocked') row.blocked += 1
    rows.set(card.role, row)
  }
  // 气色复用**同一个** moodFor：把这一行的卡片交给它，别再写一份优先级
  for (const row of rows.values()) row.mood = moodFor(cards.filter(card => card.role === row.role))
  // 排序：受阻优先（最需要人管），其次件数多，最后按岗位名稳定
  return [...rows.values()].sort((a, b) => b.blocked - a.blocked || b.total - a.total || a.role.localeCompare(b.role))
}

/**
 * 顶部统计条那行字的**唯一**来源（顶部条与板面抬头共用，避免两处口径不同）。
 * 没有在办任务时给一句明确的"暂无"，而不是一串 0。
 */
export function boardHeadline(snapshot: {
  total: number
  staff: number
  blocked: number
  busiest?: { name: string; total: number } | null
}): string {
  if (snapshot.total === 0) return '任务看板 · 暂无在办任务'
  const parts = [`任务看板 · 在办 ${snapshot.total} 项`, `员工 ${snapshot.staff} 人`]
  if (snapshot.blocked > 0) parts.push(`受阻 ${snapshot.blocked}`)
  if (snapshot.busiest) parts.push(`最多 ${snapshot.busiest.name} ${snapshot.busiest.total} 项`)
  return parts.join(' · ')
}

/** 顶部统计条里每类的**条色**：复用 `STATUS_STYLE`（同一份颜色契约），只取会进场景的四类。 */
export const STATUS_BAR_COLOR: Record<string, string> = {
  todo: STATUS_STYLE.todo.color,
  in_progress: STATUS_STYLE.in_progress.color,
  in_review: STATUS_STYLE.in_review.color,
  blocked: STATUS_STYLE.blocked.color,
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

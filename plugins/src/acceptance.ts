// plugins/src/acceptance.ts
// ============================================================================
// PRT-315（第 5 个切片）：**验收与沉淀**（验收边界）
//
// ## 这一批在做什么
//
// 前四个切片各自取了 `spaceWorker()` 的一条边界：第 1 个（`./mediation.ts`）交接边界的合入调解；
// 第 2 个（`./reclamation.ts`）仓储边界的租约回收；第 3 个（`./stateMachine.ts`）状态机的
// 任务迁移决策；第 4 个（`./workspace.ts`）workspace 边界的 worktree 隔离。本文件是**第 5 个切片**，
// 取「验收边界」——任务 `done` 之后、下一轮派工之前，每轮扫单尾部那段**结算与自检**
// （`sweep()` 里的 `// 4.2` ~ `// 4.5a` 四段）：
//
//   · `settleExperience(t)`（4.2 经验沉淀）：done 任务结算一次 friction 打分，高分任务把
//     「将军评语 + evidence 摘录」落成 `docs/experience/drafts/<taskId>.md`；
//   · `sweepExperienceVotes(tasks)`（4.3 置信度晋升管线）：草稿票务更新
//     （recalled / upvoted / 30 天衰减）→ prune → promote 判定；
//   · `runRuleDoctorNow()`（4.4 规则资产 doctor）：desired 规则单元逐条对照**最近一次真实注入
//     产物**，回答「将军的规则到底有没有进士兵提示词」；
//   · `syncSkillsToDsh()`（4.5a 技能桥）：本 scope published skills 幂等收敛到 DSH 原生技能目录。
//
// 为什么这四件算**同一个边界**：它们的共同前提是「任务已经做完了」——输入不是待派工的任务，
// 而是**已经产出的东西**（done 任务、草稿文件、注入产物、published skills），动作是**结算与
// 自检**而不是调度。它们改的都是**资产的记账**（草稿 frontmatter、doctor 报告、技能目录），
// 不动任务状态机。放错边界的代价不是报错，而是**静默地漏结算**：少写一份草稿、漏一次票、
// 或者 doctor 报了个「全部进了提示词 ✓」而其实没进。
//
// ## 这个模块**没有**改变任何行为
//
// 代码逐段搬过来，除了下面 §「依赖」写明的注入改写，一行都没有动：日志串、`activity(...)` 的
// 调用与顺序、`try/catch` 的吞错范围、**两次「跳过」的判定次序**（见下）、friction 阈值、
// 文件/目录名的拼法，以及 `// 4.2 → 4.3 → 4.4 → 4.5a` 的调用顺序。
//
// 顺序在这里不是风格问题：4.3 读的是 `docs/experience/drafts/` 的**目录现状**，而 4.2 在同一轮里
// 可能刚往里写了一份新草稿——把 4.3 提到 4.2 之前，本轮新草稿就要等下一轮才参与事件扫描
// （promote 慢一轮，且「落盘了但没票」的窗口期被拉长）。本切片的用例按 frontmatter 钉住这条。
//
// ## ★ 两种「跳过」是**两个**判定，不能合并
//
// `settleExperience` 的幂等有**两道**闸门，且次序本身是语义的一部分：
//
//     if (expSettled.has(t.id)) return      // ① 本实例内存里结算过 → 连磁盘都不看
//     expSettled.add(t.id)                  //   先记，再干活
//     const file = join(draftDir(), `${t.id}.md`)
//     if (existsSync(file)) return          // ② 文件已在盘上（可能人工修订过）→ 不覆盖
//
// ① 是「本进程已经算过」（每轮 sweep 都会把 done 任务全捞一遍），② 是「上一进程 / 人工已经写过」。
// 两者在**不同输入下**可观测地不同：只有 ② 会在「内存里没有、盘上有」时拦住写入；只有 ① 会在
// 「盘上文件被删了、内存里记过」时拒绝重算。把两道并成一道（例如统一查文件），症状是人工删掉
// 草稿后这一轮被重新生成、覆盖人工修订——不报错。所以用例必须**分开**制造这两种局面。
//
// ## 依赖：可变绑定传**取值函数**；`ruleDoctor` 传**访问器**；promote 传**兄弟能力**
//
// ① **取值函数**（运行期会被重新赋值的 `let`）：
//    · `useHub` / `hubUrl`：`detectHub()` 探测成功后两个 `let` 都被改写（与 mediation /
//      reclamation / workspace 同源）——传值 = 技能桥永远看不到 hub，published skills 一次都
//      同步不出去；
//    · `normsGlobalText`：`refreshNorms()` 每轮刷新（失败保留旧值）；
//    · `injectedNorms`：`buildWorkerPrompt()` 每次派工写一次，是 doctor 「注入产物」的数据源。
//    传值 = 模块从构造那一刻起看着一份**冻结的旧快照**，症状是 doctor 拿一份空产物去比对，
//    把**全部**规则判成 missing——或者反过来，永远报「全部进了提示词」。
//
//        > 一个"构造时快照了可变配置"的模块，
//        > 与一个"每次用之前重新取值"的模块，在只跑一次的场景里是同一个东西——
//        > 只不过前者会在配置变化之后，安静地继续按旧的来。
//
// ② **访问器** `ruleDoctor: { get, set }`：`lastRuleDoctor` 由本模块**写**，但 `writeDaemonStatus`
//    （daemon.json 的 `rulesDoctor` 字段，**非**验收边界）**读**它。这与 `workspace.ts` 的 `binding`
//    同一形态：本模块是那个写者，不是那个拥有者，所有权留在 `spaceWorker()` 闭包里。
//    用 `{ get, set }` 而不是「返回值由调用方回写」，是因为 doctor 的**状态变化比较**
//    （`prev === null || key(prev) !== key(report)`）必须在 set **之前**读到旧值——回写会把读取
//    推到调用方，而调用方手里没有「上一次的报告」。
//
// ③ **兄弟能力** `promoteDraft`：promote 要 `ensureForeman` + 执行面子代理 + `hubPost` 三件
//    本模块不该碰的东西（新增文件里出现执行面记号会直接触发 `dsh-boundary` 棘轮）。所以本模块
//    只做**票务与判定**，promote 的**动作**由构造点注入——与 `mediation.ts` 注入 `safeComment` /
//    `advanceTo` 是同一条理由：模块只声明「我需要一个能晋升草稿的东西」，不关心它怎么实现。
//
//        > 也就是说 4.3 是**半个切片**：`sweepExperienceVotes`（谁被 recall、谁该 decay、
//        > 谁够格 promote）搬了，`promoteDraft`（真的去 AI 改写、去 register、去落 learnings）没搬。
//        > 这条边界不是按行数划的，是按**依赖方向**划的：票务逻辑只读草稿目录与任务文本，
//        > promote 动作要拉起子代理、要写 hub——后者跨的是执行面边界。
//
// ## 状态：工厂闭包（每实例一份），不是模块级
//
// `expSettled`（已结算集合）活在本工厂的闭包里——**不是**模块级变量。`superviseSpaces()` 会在
// **同一进程**里按空间把 `spaceWorker` mount 成多个子实例（`index.ts` 的 `mountRunner`），
// 它们共用一个模块注册表；一个模块级 `expSettled` 会让空间 A 的 done 任务把空间 B 的
// **同名 taskId** 一起挡住——多空间部署里任务 id 只在空间内唯一，跨空间撞号是常态而不是意外。
//
//     > 一个"每实例一份"的闭包 Set，
//     > 与一个"每进程一份"的模块级 Set，在只有一个守护实例的部署里是同一个东西——
//     > 只不过多空间部署下，后者会让第二个空间的 done 任务**静默地不被结算**。
//
// `pendingRecallRefs`（P2-③ 派工注入登记的召回引用）则**不属于本边界**：它是召回注入（worker
// 提示词装配）的产物，本模块只是消费方（读 + `clear()`）。故由调用方持有、以**同一份 Map** 注入——
// 传副本 = recalled 事件永远算不出来（症状：经验确实注入了、票一张没有）。
//
// ## `config` 为什么用**结构性类型**而不是 import `Config`
//
// 与 mediation / reclamation / stateMachine / workspace 同源：`Config` 是 `index.ts` 里由 zod
// schema 推出来的值，import 它形成**真的**运行时循环依赖。这里只声明本切片真正读的两个字段；
// 调用点传的是**真的** `Config`，TypeScript 在赋值处校验可赋值性——字段改名的那天红在**调用点**，
// 而不是让这里安静地读到 `undefined`（`dshSkillsDir` 一旦读不到，技能桥会去写用户级真实技能目录：
// 这是那种「不报错、只是写错地方」的坏症状）。
//
// ## 真实文件系统副作用（诚实边界）
//
// `settleExperience` 与 `syncSkillsToDsh` 会**真的**写盘：前者写仓库根的 `docs/experience/drafts/`，
// 后者写 `config.dshSkillsDir`（未配置时才回落到 `~/.dsh/skills`）。本模块**不**把这两条路径
// 硬编码在内部逻辑里：草稿目录由 `draftDir` 注入（仓库根解析属 workspace 边界），技能目录由既有的
// `config.dshSkillsDir` 配置位给出——两者的用例都指向 `os.tmpdir()` 下的临时目录，绝不碰
// 操作员真实的 `~/.dsh`。
// ============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { collectSignals, shouldDraft, buildDraft, type ExpTaskInput } from './experience.js'
import {
  parseDraftState, renderFrontmatter, replaceFrontmatter, applyVote,
  detectRecalledTaskIds, detectUpvotedTaskIds,
  shouldPromote, shouldPrune,
} from './experienceVotes.js'
import { runRuleDoctor, type RuleDoctorReport } from './ruleAssets.js'
import type { NormFile } from './norms.js'
import { formatSkill, type SkillRef } from './skillsCache.js'
import { parseSkillTombstones, planSkillSync, type PublishedSkill } from './skillsBridge.js'
import type { Task } from './types.js'

/** 规则 doctor 报告的跨边界状态访问器（**由 `spaceWorker()` 闭包持有**，理由见文件头）。 */
export interface RuleDoctorAccess {
  get: () => RuleDoctorReport | null
  set: (report: RuleDoctorReport) => void
}

export interface AcceptanceDeps {
  /** 只声明本切片读到的字段（理由见文件头）。 */
  config: {
    mode: string
    dshSkillsDir: string
  }
  log: (msg: string) => void
  /** 本 worker 实例的 scope（技能桥拉取 published skills 的 scope）。 */
  scope: string
  activity: (kind: string, taskId: string, text: string) => void
  /** 经验草稿目录（`docs/experience/drafts/`）；仓库根解析属 workspace 边界，故注入。 */
  draftDir: () => string
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  useHub: () => boolean
  /** 取值函数：`detectHub()` 探测成功后会被改写。 */
  hubUrl: () => string
  /** P2-③ 派工注入登记的召回引用（**与召回注入共享同一份**，故由外部持有）。 */
  pendingRecallRefs: Map<string, string[]>
  /** 兄弟能力：草稿晋升的**动作**（留在 `index.ts`，理由见文件头）。 */
  promoteDraft: (draftTaskId: string, body: string) => Promise<void>
  /** 规范注入源文件族（已含 label/content）；norms 边界，故注入。 */
  readRepoNormsFiles: () => NormFile[]
  /** 规范 tombstone 停用集合；norms 边界，故注入。 */
  readNormsTombstones: () => Set<string>
  /** 即时拼装的分层规范段（守护从未派工时的降级产物）；norms 边界，故注入。 */
  readNormsSync: () => { sections: string[]; truncated: boolean }
  /** 取值函数：`refreshNorms()` 每轮刷新（失败保留旧值）。 */
  normsGlobalText: () => string
  /** 取值函数：`buildWorkerPrompt()` 每次派工写一次。 */
  injectedNorms: () => { text: string; truncated: boolean }
  /** 规则 doctor 报告的读写访问器（**由调用方持有**，理由见文件头）。 */
  ruleDoctor: RuleDoctorAccess
}

/** `createAcceptance` 交回给 `index.ts` 的东西（调用顺序即 `index.ts` 里的 `// 4.2` → `// 4.5a`）。 */
export interface Acceptance {
  settleExperience: (t: Task) => Promise<void>
  sweepExperienceVotes: (tasks: Task[]) => Promise<void>
  runRuleDoctorNow: () => RuleDoctorReport
  syncSkillsToDsh: () => Promise<void>
}

export function createAcceptance(deps: AcceptanceDeps): Acceptance {
  const {
    config, log, scope, activity, draftDir, useHub, hubUrl, pendingRecallRefs, promoteDraft,
    readRepoNormsFiles, readNormsTombstones, readNormsSync, normsGlobalText, injectedNorms, ruleDoctor,
  } = deps

  // ── P0-2 经验沉淀：done 结算 → friction 打分 → 经验草稿落盘（docs/experience/drafts/）──
  // 方案：docs/research/teamai-cli-review.md §4.2。将军验收 done 或带真实摩擦的任务，
  // 由守护结算打分并把将军评语 + 关键 evidence 落成「待晋升」草稿文件。
  // 幂等：内存 Set + 草稿文件已存在则跳过（守护重启不重复结算、打回期间重复 done 不覆盖人工修订）。

  const expSettled = new Set<string>()
  /** done 结算：friction 高分任务生成经验草稿。任何失败只记日志，不影响派工主流程。 */
  async function settleExperience(t: Task): Promise<void> {
    try {
      if (t.status !== 'done') return
      if (expSettled.has(t.id)) return
      expSettled.add(t.id)
      const file = join(draftDir(), `${t.id}.md`)
      if (existsSync(file)) return // 已落盘（可能人工修订过），不覆盖
      const input: ExpTaskInput = {
        id: t.id, title: t.title, description: t.description,
        role: t.role, soldier: t.soldier, goalId: t.goalId, scope: t.scope ?? scope,
        status: t.status, comments: t.comments ?? [],
        evidence: t.evidence ?? [], artifacts: t.artifacts ?? [],
      }
      const sig = collectSignals(input)
      if (!shouldDraft(input, sig)) return
      mkdirSync(dirname(file), { recursive: true })
      const now = new Date().toISOString()
      writeFileSync(file, buildDraft(input, sig, { createdAt: now }), 'utf8')
      activity('experience', t.id, `经验草稿已生成：docs/experience/drafts/${t.id}.md（friction=${sig.score.toFixed(2)}）`)
      log(`${t.id} → 经验草稿落盘：${file}（friction=${sig.score.toFixed(2)}，打回${sig.rework}/验收${sig.reviewRounds}/将军评语${sig.generalNotes}）`)
    } catch (e) {
      log(`${t.id} 经验草稿生成失败：${String(e)}`)
    }
  }

  // ── P0-3 置信度晋升管线：草稿 votes→confidence→promote（docs/research/teamai-cli-review.md §4.3）──
  // 守护每轮扫本 scope 任务文本，把「被后续任务引用=recalled」「将军采纳=upvoted」写进草稿
  // frontmatter（增量、幂等：recalledBy/upvotedBy 记录已投者）；confidence 30 天衰减；草稿满足
  // promote 四门槛（观察窗/recalled≥2/upvoted≥1/confidence≥0.5）→ AI 改写为正式 skill →
  // team-hub skills register（pending，将军 review publish = 最终人工关）→ 草稿原件留溯源。
  // 失败只记日志不影响派工；promote 的 AI 改写每轮至多派一个（异步），退避防热循环。
  /** 读单个任务的可扫文本（title/description/评论拼接，供事件检测）。 */
  const taskScanText = (t: Task): string => [
    t.title ?? '', t.description ?? '',
    ...(t.comments ?? []).map(c => `${c.by ?? ''}: ${c.text ?? ''}`),
  ].join('\n')
  /** 扫描任务文本里的草稿引用事件：recalled（借鉴语义词+任务id）与 upvoted（将军采纳语义词+任务id）。 */
  function collectVoteEvents(tasks: Task[]): { byTask: Map<string, string[]>; byGeneral: Map<string, string[]> } {
    const byTask = new Map<string, string[]>()   // draftTaskId → [引用任务id]
    const byGeneral = new Map<string, string[]>() // draftTaskId → [将军身份]
    for (const t of tasks) {
      const text = taskScanText(t)
      for (const target of detectRecalledTaskIds(text)) {
        if (target === t.id) continue // 自引用不计
        const list = byTask.get(target) ?? []
        if (!list.includes(t.id)) list.push(t.id)
        byTask.set(target, list)
      }
      for (const target of detectUpvotedTaskIds(text)) {
        if (target === t.id) continue
        // upvote 只认将军（by=general / 将军）评论行
        const byLine = t.comments?.find(c => (c.text ?? '').includes(target) && (c.by === 'general' || c.by === '将军'))
        if (!byLine) continue
        const list = byGeneral.get(target) ?? []
        if (!list.includes(byLine.by)) list.push(byLine.by)
        byGeneral.set(target, list)
      }
    }
    return { byTask, byGeneral }
  }
  // promoteDraft（promote 的**动作**：AI 改写 → register / 落 learnings）**不搬**：它要拉起
  // 执行面子代理、要 ensureForeman、要 hubPost——跨的是执行面边界，仍留在 index.ts，
  // 由构造点作为兄弟能力注入（理由见文件头 §依赖 ③）。

  /** P0-3 每轮扫草稿目录：更新票数/衰减状态 → promote/prune。返回本轮是否有 promote 动作在进行。 */
  async function sweepExperienceVotes(tasks: Task[]): Promise<void> {
    try {
      const dir = draftDir()
      if (!existsSync(dir)) return
      const files = readdirSync(dir).filter(f => f.endsWith('.md'))
      if (files.length === 0) return
      const { byTask, byGeneral } = collectVoteEvents(tasks)
      const now = new Date().toISOString()
      // P2-③：把派工注入过相关经验的（taskId → [draftTaskId]）并入 byTask——
      //  注入 = 一次真实召回（任务文本里可能没写「参考 T-xxx」，但经验确实被带到了士兵面前）。
      for (const [taskId, refs] of pendingRecallRefs) {
        for (const ref of refs) {
          const list = byTask.get(ref) ?? []
          if (!list.includes(taskId)) list.push(taskId)
          byTask.set(ref, list)
        }
      }
      pendingRecallRefs.clear() // 消费完即清：任务重派会重新登记，applyVote 按 recalledBy 去重
      let promotedThisRound = 0
      for (const f of files.sort()) {
        const file = join(dir, f)
        try {
          const raw = readFileSync(file, 'utf8')
          const cur = parseDraftState(raw)
          if (cur.status === 'promoted' || cur.status === 'stale') continue
          // 增量投票（幂等：recalledBy/upvotedBy 已投者跳过）
          let next = cur
          for (const refTask of byTask.get(cur.taskId) ?? []) next = applyVote({ state: next, recalledByTaskId: refTask, now })
          for (const gen of byGeneral.get(cur.taskId) ?? []) next = applyVote({ state: next, upvotedBy: gen, now })
          // prune 保守判定：从未有票且落盘 ≥90 天 → stale
          if (shouldPrune(next, now)) next = { ...next, status: 'stale', lastActivityAt: now }
          // frontmatter 有变化才写回（无事件不覆盖人工修订的计数）
          if (renderFrontmatter(next) !== renderFrontmatter(cur)) {
            writeFileSync(file, replaceFrontmatter(raw, renderFrontmatter(next)), 'utf8')
          }
          // promote 判定（在最新状态上）
          if (next.status === 'draft') {
            const gate = shouldPromote(next, now)
            if (gate.promote && promotedThisRound === 0) {
              promotedThisRound += 1
              void promoteDraft(cur.taskId, raw).catch(() => undefined)
            }
          }
        } catch (e) {
          log(`经验草稿 ${f} 票务更新失败：${String(e)}`)
        }
      }
    } catch (e) {
      log(`经验票务扫单失败：${String(e)}`)
    }
  }

  // ── P1-4.4 规则资产 doctor：校验"将军的规则是否真的进了士兵提示词" ──
  // 方案：docs/research/teamai-cli-review.md §4.4（首步 rules 端到端原型）。
  // desired-set = 注入源文件族（含 tombstone 停用）+ team-hub 全局层；注入产物 =
  // 最近一次 buildWorkerPrompt 真实拼装的 norms 文本。逐规则单元断言其内容确实在
  // 产物里（预算截断会吞掉尾部规则 → doctor 报 missing，将军能发现"规则没进提示词"）。
  // doctor 结果每轮写进 daemon.json（`rulesDoctor` 字段，serve.mjs /api/daemon 可见），
  // 状态变化（ok→bad 或反之 / missing 集变化）才 log + activity，避免每轮噪音。
  /** 每轮跑一次规则 doctor（sweep 内调用）；结果缓存供 writeDaemonStatus 附带输出。 */
  function runRuleDoctorNow(): RuleDoctorReport {
    const files = readRepoNormsFiles() // 已含 tombstone 过滤（不注入的源也不进 desired）
    // 注入产物：优先最近一次真实派工产物；守护从未派工（无任务）时降级即时拼装（同一拼装函数）
    const injected = injectedNorms().text.length > 0
      ? injectedNorms()
      : { text: readNormsSync().sections.join('\n'), truncated: false }
    const report = runRuleDoctor({
      files,
      globalText: normsGlobalText(),
      removed: readNormsTombstones(),
      injectedText: injected.text,
      truncated: injected.truncated,
    })
    // 状态变化检测：与上次报告比较（ok 翻转 或 missing 单元集变化）
    const prev = ruleDoctor.get()
    const key = (r: RuleDoctorReport): string => `${r.ok}|${r.truncated}|${r.items.filter(i => !i.present).map(i => `${i.source}:${i.title}`).join(',')}|${r.removedSources.join(',')}`
    if (prev === null || key(prev) !== key(report)) {
      const total = report.items.length
      const present = total - report.items.filter(i => !i.present).length
      if (total > 0) {
        const missing = report.items.filter(i => !i.present)
        if (missing.length > 0) {
          log(`【规则 doctor】${report.ok ? '恢复' : '告警'}：${present}/${total} 规则单元进了提示词；缺失 ${missing.map(m => `${m.source}#${m.title}`).join('、')}${report.truncated ? '（预算截断）' : ''}`)
          activity('rules-doctor', '*', `规则注入缺失 ${missing.length} 条：${missing.map(m => `${m.source}#${m.title}`).join('、')}（truncated=${report.truncated}）`)
        } else {
          log(`【规则 doctor】${present}/${total} 规则单元全部进了提示词 ✓`)
        }
      }
    }
    ruleDoctor.set(report)
    return report
  }

  // ── P1-4.5 技能桥：published skills → ~/.dsh/skills（DSH 原生技能目录 = teamai 同步目标）──
  // 方案：docs/research/teamai-cli-review.md §4.5 + §2.2 收敛协议。
  // teamai 只向 DSH 同步 skills（toolPaths dsh.skills → ~/.dsh/skills，rank 400，DSH 源码已证），
  // 而 Legion 沉淀的技能在 team-hub 表里、不在该目录 → 双向缺"发送端"：本桥补上。
  // 语义：本 scope published（+授权共享，与 fetchSkills 同口径）→ planSkillSync 收敛
  // （contentHash 未变不重写；tombstone ~/.dsh/skills/.removed 确认停用才删；非本桥目录不碰）。
  const dshSkillsDir = (): string => {
    const d = (config.dshSkillsDir || join(homedir(), '.dsh', 'skills')).trim()
    return d
  }
  /** 读目标目录现状：<目录名> → SKILL.md 全文（缺 SKILL.md 的目录忽略）。 */
  function readExistingDshSkills(dir: string): Map<string, string> {
    const out = new Map<string, string>()
    try {
      if (!existsSync(dir)) return out
      for (const name of readdirSync(dir)) {
        const p = join(dir, name, 'SKILL.md')
        try { if (existsSync(p)) out.set(name, readFileSync(p, 'utf8')) } catch { /* 单目录读取失败跳过 */ }
      }
    } catch { /* 目录不可读：返回空（守护会当首次同步全写） */ }
    return out
  }
  /** 执行收敛计划（写/删 + tombstone 落盘），返回是否发生变化。 */
  function applySkillPlan(dir: string, plan: { writes: Array<{ id: string; content: string }>; deletes: Array<{ id: string }> }): boolean {
    if (plan.writes.length === 0 && plan.deletes.length === 0) return false
    try {
      mkdirSync(dir, { recursive: true })
      for (const w of plan.writes) {
        const d = join(dir, w.id)
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, 'SKILL.md'), w.content, 'utf8')
      }
      for (const del of plan.deletes) {
        rmSync(join(dir, del.id), { recursive: true, force: true })
      }
      return true
    } catch (e) {
      log(`技能桥落盘失败：${String(e)}`)
      return false
    }
  }
  /** 每轮同步 published skills → DSH 技能目录（幂等；失败只记日志不影响派工）。 */
  async function syncSkillsToDsh(): Promise<void> {
    if (!useHub() || config.mode === 'mediator') return // 公共调解员不写用户级技能目录（多空间归属不清）
    const dir = dshSkillsDir()
    if (dir === '') return
    try {
      const res = await fetch(`${hubUrl()}/api/skills?scope=${encodeURIComponent(scope)}`)
      if (!res.ok) return
      const skills = await res.json() as SkillRef[]
      const desired: PublishedSkill[] = skills
        .filter(s => typeof s.id === 'string' && s.id.length > 0 && !s.id.includes('/') && !s.id.includes('..'))
        .map(s => ({
          id: s.id,
          name: s.name ?? s.id,
          description: s.description ?? '',
          body: formatSkill(s),
          contentHash: s.contentHash ?? '',
        }))
      // tombstone 从目标目录 .removed 读（将军/团队在目标侧停用）
      const removedPath = join(dir, '.removed')
      const removed = parseSkillTombstones(existsSync(removedPath) ? readFileSync(removedPath, 'utf8') : null)
      const plan = planSkillSync(desired, readExistingDshSkills(dir), removed)
      if (plan.changed) {
        const applied = applySkillPlan(dir, plan)
        if (applied) {
          log(`技能桥：${dir} 同步 ${plan.writes.length} 写 / ${plan.deletes.length} 删（scope=${scope}，${desired.length} 个 published）`)
          activity('skills-bridge', '*', `published skills → ${dir}：写 ${plan.writes.map(w => w.id).join('、') || '无'}${plan.deletes.length ? `，删 ${plan.deletes.map(d => d.id).join('、')}` : ''}`)
        }
      }
    } catch (e) {
      log(`技能桥同步失败：${String(e)}`)
    }
  }

  return { settleExperience, sweepExperienceVotes, runRuleDoctorNow, syncSkillsToDsh }
}

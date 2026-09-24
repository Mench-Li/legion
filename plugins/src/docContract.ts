// plugins/src/docContract.ts
// ============================================================================
// PRT-1007「编排提取」片 1：**岗位文档契约纯函数**
//
// ## 为什么这一片是它
//
// `index.ts` 2854 行、170 KB，其中 `spaceWorker` **一个函数**占 486–2668 行（约 2180 行）。
// 批次 3 的入口是「**一个切片一次对拍**」（`docs/review/PRT-PRE-REFACTOR-CANDIDATES.md:140`），
// 而规格 §13 的停止条件只禁「**大规模**编排提取」（同文件 `:144`，原文：
// "M1.5 未达标，就不要启动阶段 3 的大规模编排提取"）—— 逐片不在禁令内。
//
// 挑这一片当第一刀的三条理由：
//   ① **它已经是纯函数**：只读解析、无副作用、不碰 `ctx`/`config`/子进程 ⇒
//      搬它**不可能**改行为；
//   ② **它有独立的判据**：`tests/doc-contract.test.mjs`（20 处断言）与
//      `tests/space-pipeline.test.mjs`（13 处）；
//   ③ **它没有私有依赖**：只用到 `node:crypto` / `node:fs` 与两个类型，而 `spaceWorker`
//      那一坨要靠 `ctx`、`config`、spawn 与文件系统 —— 那种片要先有接缝才能搬。
//
// ## 这一片**没有**搬什么（写下来，免得下一个人以为漏了）
//
// `hashStr`（`:349`）、`runGit`（`:356`）、`runTaskctl`（`:321`）留在 `index.ts`：
// 前两个是**进程与工具**面（spawn 子进程），不是数据模型解析面；`runTaskctl` 同理。
// 把它们一起搬会扩大这次改动的面积，而**这次改动的全部意义是"行为零变化"**
// —— 面积越大，能证明的越少。（同一句话在本仓上一次提取里写过：`types.ts:25-30`。）
//
// ## 怎么证明"行为零变化"（这就是本片的验收）
//
//   1. **逐字对拍**（`node scripts/probes/probe-slice-verbatim.mjs`，量具）
//      —— 六个函数在新位置的文本与**旧位置**逐字相同，且旧位置**不再留实现**
//      （两份实现各自漂移，是这类搬家最危险的失效：它编译得过、测试也过）；
//   2. **公开面**：`index.ts` 把同名符号用**带 `from` 的再导出**送出 ⇒
//      消费者从 `lib/index.js` import 的写法一条都不用改；
//   3. **类型检查**：`tsc -p plugins/tsconfig.json --noEmit` 的错**不多一条**。
//      ★ 本机读数（2026-09-24）：工作树 **1** 处错、对照组（源码退回 HEAD）**1** 处同类错，
//      且它是 `:30` 的 `@deepseek-ai/dsh-agent-presets` 缺包 —— **先于本片存在**。
//      （tsc 不在本仓：要借 `D:\project\DSH\dsh\deepseek-harness\node_modules\typescript`。）
//
// ⚠️ **本片证明不了什么**（写下来，免得被读成"跑过了"）：
//
//   * `cd plugins && npm test`（先 build 再跑 38 个套件）**在本机跑不了** ——
//     build 要 DSH 检出里有 `packages/preset/agent-presets`（`46a7f68` 上没有），
//     而 `plugins/lib/` 是 **gitignore** 的（产物不入库）⇒ 仓库里没有可跑的旧产物。
//     ★ 于是"六个函数在新位置**执行**行为相同"**没有被执行过**；
//     它目前只由"文本逐字相同 + 类型检查不多一条错"支撑。
//   * `node scripts/ci/dsh-boundary.mjs --check` 对本片**不敏感**：它只钉 **DSH 包**
//     的执行面依赖（`@deepseek-ai/*`），而本片搬的是 `node:*` 与本地类型 ——
//     它报 PASS 是真的，但这个 PASS **不构成对本片的证据**。
//     （原本我在这一节里预测"基线会显示 `node:crypto` 1→0"—— 那是**错的**，
//      实测之后改成了这段话。一个判据"报绿"与"它看得见这件事"是两件事。）
// ============================================================================

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { DiscussionDef, StageDef } from './types.js'

/** 某 stage 的契约文档相对路径模板：docs 数组字段优先（合法字符串项），缺省回退既有 artifact 单值语义（researcher 等价）；未知角色/无 docs/空数组一律返回空数组（不报错，前置兼容）。 */
export function stageContractDocs(stage: { docs?: unknown; artifact?: string } | null | undefined): string[] {
  if (!stage) return []
  if (Array.isArray(stage.docs)) {
    const list = stage.docs
      .filter((x): x is string => typeof x === 'string')
      .map(x => x.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter(x => x.length > 0)
    if (list.length > 0) return list
  }
  const artifact = typeof stage.artifact === 'string' ? stage.artifact.trim() : ''
  return artifact.length > 0 ? [artifact.replace(/\\/g, '/').replace(/^\.\//, '')] : []
}

/** 契约模板按任务展开：把 {taskId} 占位替换为真实任务 id（reviewer 等动态命名文档），返回规范化相对路径。 */
export function resolveStageDocPaths(stage: { docs?: unknown; artifact?: string } | null | undefined, taskId: string): string[] {
  return stageContractDocs(stage).map(p => p.replace(/\{taskId\}/g, taskId).replace(/\\/g, '/').replace(/^\.\//, ''))
}

/** R-4/D2（RC-2 修复，T-117 实测）：docSync（用户可见行为变更）任务的契约路径 = 岗位 stage 契约 + docs/FEATURES.md + README.md。
 *  纯函数供 registerContractDocs（登记/判缺）与结算门禁（contractPaths 非空判定）共用——hub 侧 docSync 声明列上线前
 *  这三处消费点 t.docSync 恒 undefined（断言 H-1 未满足）；本函数把「docSync=true → 追加功能手册+README」固化为可测单元。
 *  非 docSync 任务原样返回（不改岗位既有契约）。 */
export function resolveStageDocPathsWithDocSync(stage: { docs?: unknown; artifact?: string } | null | undefined, taskId: string, docSync: boolean | null | undefined): string[] {
  const paths = resolveStageDocPaths(stage, taskId)
  if (docSync === true) {
    for (const p of ['docs/FEATURES.md', 'README.md']) if (!paths.includes(p)) paths.push(p)
  }
  return paths
}

/** 文件内容 sha256（契约登记幂等比对用：同 path 同字节不重复登记）。 */
export function fileDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * SP-P0：hub 空间流水线载荷（GET /api/pipeline 的 stages）→ 守护消费的 StageDef[]。
 *
 * 纯函数、防御式：坏数据整条丢弃（返回空数组即"该空间未配置数据面流水线"→ 回退部署面 rolesFile），
 * 绝不因远端配置缺陷让守护崩或进入半更新态。只接受守护真正消费的字段：
 *   role（空则丢）、label（缺省回落 role）、prompt、next（空串 → null = 末环）、gate、artifact、docs。
 */
/**
 * SP-P0：解析「需求讨论群聊」配置来源。
 *
 * 数据面（`space_stages` / `POST /api/pipeline`）目前**不承载** `discussion`（属 SP-P1），
 * 所以当活动流水线来自 hub 且未带 discussion 时，必须回落到部署面文件的配置——
 * 否则「切到 hub 来源」会让已在文件里配好讨论的实例**静默失去讨论功能**（P0 的兼容底线：
 * 已有空间行为零差异）。hub 若将来带上 discussion，则以数据面为准。
 */
export function resolveDiscussion(
  active: { discussion?: DiscussionDef } | null,
  filePipeline: { discussion?: DiscussionDef } | null,
): DiscussionDef | undefined {
  return active?.discussion ?? filePipeline?.discussion
}

export function stagesFromHubPayload(raw: unknown): StageDef[] {
  if (!Array.isArray(raw)) return []
  const out: StageDef[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    const role = typeof s.role === 'string' ? s.role.trim() : ''
    if (role === '') continue
    const label = typeof s.label === 'string' && s.label.trim() !== '' ? s.label.trim() : role
    const docs = Array.isArray(s.docs)
      ? s.docs.filter((d): d is string => typeof d === 'string' && d.trim() !== '').map(d => d.trim())
      : undefined
    const artifact = typeof s.artifact === 'string' && s.artifact.trim() !== '' ? s.artifact.trim() : undefined
    out.push({
      role,
      label,
      prompt: typeof s.prompt === 'string' ? s.prompt : '',
      next: typeof s.next === 'string' && s.next.trim() !== '' ? s.next.trim() : null,
      gate: s.gate === true,
      ...(artifact !== undefined ? { artifact } : {}),
      ...(docs !== undefined && docs.length > 0 ? { docs } : {}),
    })
  }
  return out
}

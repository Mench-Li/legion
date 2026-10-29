export const WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX = 'agent-workflow-stage-checkpoint:'

/**
 * 上游阶段清单里**最新一个**可用的冻结提交；没有就返回 null。
 *
 * ## 它是干什么用的
 *
 * 下游阶段（尤其审查）新建 `w/<任务id>` 时，基线应当取**上游冻结提交本身**，
 * 而不是 `main` 的 HEAD。理由在 `materializeWorkflowCheckpoints` 那一侧：
 * 从 HEAD 建分支之后再把旧基线的冻结提交 merge 进来，只要 main 在两轮之间改过
 * 同一段代码，merge 就必然冲突、自动回滚、整条阶段停摆（现场：T-219 导入
 * T-218 的提交时与 main 的同一段 `app.mjs` 冲突，派工直接中止）。
 * 从冻结提交建分支时，那次 merge 天然是空操作，冲突被挪到**真正要合入 main
 * 的那一刻**——那才是人该做决定的地方。
 *
 * `upstreamStages` 是**由新到旧**排的（materialize 反过来逐个合入，让最新的最后落），
 * 所以基准取第一个带有效 checkpoint 的阶段。
 *
 * ## 为什么这里读坏了返回 null 而不是抛
 *
 * 本函数只决定「分支从哪建」。格式坏掉时，判据的严格版本在
 * `materializeWorkflowCheckpoints`：它会带着阶段名抛出「缺少有效的冻结 Git 提交证据」，
 * 那条错误才该被看到。这里再抛一次只会让同一个原因有两条不同的文案。
 */
export function latestUpstreamCheckpoint(workflowContext) {
  const upstream = workflowContext?.upstreamStages
  if (!Array.isArray(upstream)) return null
  for (const stage of upstream) {
    if (typeof stage?.stageId !== 'string' || typeof stage?.taskId !== 'string') continue
    const evidence = Array.isArray(stage.evidence) ? stage.evidence : []
    const checkpoints = evidence.filter((item) => typeof item?.text === 'string' && item.text.startsWith(WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX))
    const last = checkpoints.at(-1)
    if (last === undefined) continue
    let parsed = null
    try { parsed = JSON.parse(last.text.slice(WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX.length)) } catch { continue }
    if (parsed?.stageId === stage.stageId && /^[0-9a-f]{40,64}$/i.test(parsed?.sourceCommit ?? '')) {
      return Object.freeze({ stageId: stage.stageId, taskId: stage.taskId, sourceCommit: parsed.sourceCommit })
    }
  }
  return null
}

/** Merge completed ancestor stage commits into the current stage's isolated branch. */
export async function materializeWorkflowCheckpoints({ workflowContext, workdir, runGit } = {}) {
  if (typeof workdir !== 'string' || workdir.trim() === '') throw new TypeError('workdir is required')
  if (typeof runGit !== 'function') throw new TypeError('runGit must be a function')
  const upstream = workflowContext?.upstreamStages
  if (!Array.isArray(upstream) || upstream.length === 0) {
    if ((workflowContext?.designArtifacts?.length ?? 0) > 0 || workflowContext?.implementation !== null && workflowContext?.implementation !== undefined) {
      throw new Error('工作流交接上下文包含设计/实现引用，但缺少上游阶段提交清单')
    }
    return Object.freeze([])
  }

  const checkpoints = []
  for (const stage of [...upstream].reverse()) {
    if (typeof stage?.taskId !== 'string' || typeof stage?.stageId !== 'string' || stage.stageId.trim() === '') {
      throw new Error('上游工作流阶段缺少 taskId 或 stageId，无法导入冻结提交')
    }
    const evidence = Array.isArray(stage.evidence) ? stage.evidence : []
    const checkpointRecords = []
    for (const item of evidence.filter((entry) => typeof entry?.text === 'string' && entry.text.startsWith(WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX))) {
      let parsed
      try { parsed = JSON.parse(item.text.slice(WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX.length)) } catch {
        throw new Error(`上游工作流阶段 ${stage.stageId} 的冻结提交证据格式无效`)
      }
      checkpointRecords.push(parsed)
    }
    const checkpoint = checkpointRecords.at(-1)
    if (checkpoint?.stageId !== stage.stageId || !/^[0-9a-f]{40,64}$/i.test(checkpoint.sourceCommit ?? '')) {
      throw new Error(`上游工作流阶段 ${stage.stageId}（${stage.taskId}）缺少有效的冻结 Git 提交证据`)
    }
    checkpoints.push({ stageId: stage.stageId, taskId: stage.taskId, sourceCommit: checkpoint.sourceCommit })
  }

  const seen = new Set()
  const ordered = checkpoints.filter((item) => {
    if (seen.has(item.sourceCommit)) return false
    seen.add(item.sourceCommit)
    return true
  })
  for (const checkpoint of ordered) {
    const exists = await runGit(workdir, ['cat-file', '-e', `${checkpoint.sourceCommit}^{commit}`])
    if (exists.code !== 0) {
      throw new Error(`上游阶段 ${checkpoint.stageId} 的冻结提交不在当前本机 Git 对象库中：${checkpoint.sourceCommit}`)
    }
    const ancestor = await runGit(workdir, ['merge-base', '--is-ancestor', checkpoint.sourceCommit, 'HEAD'])
    if (ancestor.code === 0) continue
    if (ancestor.code !== 1) throw new Error(`无法判断上游提交是否已包含在当前分支历史：${checkpoint.sourceCommit}`)
    const merged = await runGit(workdir, ['merge', '--no-edit', '--no-ff', checkpoint.sourceCommit])
    if (merged.code !== 0) {
      const aborted = await runGit(workdir, ['merge', '--abort'])
      const detail = (merged.err || merged.out || '').trim().slice(0, 400)
      throw new Error(`导入上游阶段 ${checkpoint.stageId} 的冻结提交失败${aborted.code === 0 ? '（合并已回滚）' : '（自动回滚失败，工作区需人工检查）'}：${detail || checkpoint.sourceCommit}`)
    }
    const included = await runGit(workdir, ['merge-base', '--is-ancestor', checkpoint.sourceCommit, 'HEAD'])
    if (included.code !== 0) throw new Error(`上游提交合并后仍无法证明其属于当前分支历史：${checkpoint.sourceCommit}`)
  }
  return Object.freeze(ordered)
}

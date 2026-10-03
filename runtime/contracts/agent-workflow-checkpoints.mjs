export const WORKFLOW_CHECKPOINT_EVIDENCE_PREFIX = 'agent-workflow-stage-checkpoint:'

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

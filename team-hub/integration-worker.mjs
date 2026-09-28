// team-hub/integration-worker.mjs
// ============================================================================
// 单仓库集成 worker（并行任务文件冲突治理 S3 / R-4 / 设计 §6.2）
//
// 一个受管仓库对应一个唯一集成入口：候选合并与验证都在**临时隔离区**完成，
// 只有干净、已验证、且目标 ref 仍为 expected_head 的候选才被快进接入。
// journal 四阶段 prepared → applying → ref-updated → finalized 持久落库，
// 崩溃后靠 Git SHA 对账恢复：已应用未记账只补记，结果不明就暂停（不删分支）。
//
// 纪律：不假装 Git+SQLite 原子；不在用户工作区重做冲突调解；不跳过验证标已交付；
// 候选过期不复用绿色结果；所有 git 调用走非管道 stdio（git-plumbing）。
// ============================================================================
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as defaultGit from './git-plumbing.mjs'
import { hasExecutableVerification } from './verify-config.mjs'

export const INTEGRATION_OUTCOMES = Object.freeze({
  INTEGRATED: 'integrated',
  NEEDS_REVIEW: 'needs-review',
  PAUSED: 'paused',
})

/** 非管道 stdio 运行任意 argv（验证命令用；禁止 shell 字符串）。 */
export function runCommand(argv, cwd, timeoutMs = 120000) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-verify-'))
  const out = join(dir, 'out.txt')
  const err = join(dir, 'err.txt')
  const ofd = openSync(out, 'w')
  const efd = openSync(err, 'w')
  const started = Date.now()
  let status = null
  let error = null
  try {
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd, stdio: ['ignore', ofd, efd], windowsHide: true, timeout: timeoutMs,
    })
    status = r.status
    error = r.error ? r.error.code : null
  } finally {
    closeSync(ofd)
    closeSync(efd)
  }
  return Object.freeze({
    exitCode: status, error, durationMs: Date.now() - started,
    stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8'),
  })
}

function advanceTo(deliveryStore, deliveryId, target, extra = {}) {
  let d = deliveryStore.getDelivery(deliveryId)
  if (!d) return null
  const order = { 'awaiting-acceptance': 0, ready: 1, preparing: 2, validating: 3, integrated: 4 }
  const want = order[target]
  while (order[d.state] !== undefined && order[d.state] < want) {
    const next = d.state === 'awaiting-acceptance' ? 'ready'
      : d.state === 'ready' ? 'preparing'
        : d.state === 'preparing' ? 'validating'
          : 'integrated'
    const r = deliveryStore.transitionDelivery({
      id: deliveryId, version: d.version, to: next, actor: extra.actor,
      gitSha: next === 'integrated' ? extra.integratedCommit : null,
      integratedCommit: next === 'integrated' ? extra.integratedCommit : null,
      detail: extra.detail,
    })
    if (!r.ok) return d
    d = r.delivery
  }
  return d
}

export function createIntegrationWorker({
  deliveryStore,
  repoDir,
  repoId = repoDir,
  targetRef,
  verifyConfig = null,
  workspaceDir = null,
  git = defaultGit,
  verifyRunner = runCommand,
  maxRecompute = 2,
  env = null,
  worktreeRoot = null,
  actor = 'integration-worker',
  releaseReservation = null,
  hooks = {},
} = {}) {
  if (!deliveryStore) throw new TypeError('createIntegrationWorker 缺 deliveryStore')
  if (!repoDir) throw new TypeError('createIntegrationWorker 缺 repoDir')
  if (!targetRef) throw new TypeError('createIntegrationWorker 缺 targetRef')

  function pauseJob(jobId, leaseEpoch, code, detail) {
    deliveryStore.transitionIntegrationJob({ id: jobId, leaseEpoch, to: 'paused', errorCode: code, actor, detail })
  }

  function markNeedsReview(deliveryId) {
    const d = deliveryStore.getDelivery(deliveryId)
    if (!d) return null
    if (d.state === 'ready' || d.state === 'preparing') {
      const mid = advanceTo(deliveryStore, deliveryId, 'validating', { actor })
      if (mid && mid.state === 'validating') {
        return deliveryStore.transitionDelivery({ id: deliveryId, version: mid.version, to: 'needs-review', actor, detail: { code: 'integration-validation' } }).delivery
      }
    }
    if (d.state === 'validating') {
      return deliveryStore.transitionDelivery({ id: deliveryId, version: d.version, to: 'needs-review', actor }).delivery
    }
    return d
  }

  function runVerification(candidateCommit) {
    if (!hasExecutableVerification(verifyConfig)) {
      return Object.freeze({
        passed: false, code: 'NO_VERIFY_CONFIG',
        report: Object.freeze({ candidateSha: candidateCommit, commands: Object.freeze([]) }),
      })
    }
    const wtBase = worktreeRoot ?? mkdtempSync(join(tmpdir(), 'legion-integration-'))
    const wt = join(wtBase, 'worktree')
    const added = git.worktreeAdd(repoDir, wt, candidateCommit)
    if (!added.ok) {
      return Object.freeze({
        passed: false, code: 'WORKTREE_FAILED',
        report: Object.freeze({ candidateSha: candidateCommit, commands: Object.freeze([]), stderr: added.stderr }),
      })
    }
    const commands = []
    let passed = true
    try {
      for (const v of verifyConfig.verify) {
        const cwd = v.cwd ? join(wt, v.cwd) : wt
        const r = verifyRunner(v.argv, cwd, v.timeoutMs)
        commands.push(Object.freeze({
          id: v.id, argv: Object.freeze([...v.argv]), exitCode: r.exitCode, error: r.error ?? null,
          durationMs: r.durationMs, stdoutTail: String(r.stdout ?? '').slice(-2000), stderrTail: String(r.stderr ?? '').slice(-2000),
        }))
        if (r.exitCode !== 0 || r.error) { passed = false; break }
      }
    } finally {
      try { git.worktreeRemove(repoDir, wt) } catch { /* 清理可重试 */ }
    }
    return Object.freeze({
      passed,
      code: passed ? null : 'VALIDATION_FAILED',
      report: Object.freeze({ candidateSha: candidateCommit, verifyConfigTargetRef: verifyConfig.targetRef, commands: Object.freeze(commands) }),
    })
  }

  return {
    /**
     * 执行一次集成 job。返回结构化结果；绝不抛 git 错误作为控制流。
     */
    runJob({ jobId = null, deliveryId = null, leaseEpoch = null } = {}) {
      const job = jobId ? deliveryStore.getIntegrationJob(jobId) : null
      if (!job) return Object.freeze({ ok: false, code: 'NOT_FOUND' })
      if (leaseEpoch !== null && leaseEpoch !== undefined && Number(job.leaseEpoch) !== Number(leaseEpoch)) {
        return Object.freeze({ ok: false, code: 'EPOCH_STALE', currentEpoch: job.leaseEpoch })
      }
      const dlvId = deliveryId ?? job.deliveryId
      const delivery = deliveryStore.getDelivery(dlvId)
      if (!delivery) return Object.freeze({ ok: false, code: 'DELIVERY_NOT_FOUND' })

      // 1. 绑定工作区必须整体干净；否则暂停（不 stash、不覆盖用户改动）。
      const checkDir = workspaceDir ?? repoDir
      const clean = git.isWorktreeClean(checkDir)
      if (!clean.clean) {
        pauseJob(jobId, job.leaseEpoch, 'DIRTY_WORKSPACE', { reasons: clean.reasons })
        return Object.freeze({ ok: false, code: 'DIRTY_WORKSPACE', reasons: clean.reasons, targetRefUnchanged: true })
      }

      let recompute = 0
      for (;;) {
        const expectedHead = git.revParse(repoDir, targetRef)
        if (!expectedHead) return Object.freeze({ ok: false, code: 'TARGET_REF_MISSING' })
        const source = git.revParse(repoDir, delivery.sourceCommit)
        if (!source) {
          pauseJob(jobId, job.leaseEpoch, 'SOURCE_MISSING')
          return Object.freeze({ ok: false, code: 'SOURCE_MISSING', targetRefUnchanged: true })
        }

        const merged = git.mergeTree(repoDir, expectedHead, source)
        if (!merged.ok) {
          if (merged.code === 'GIT_CONFLICT') {
            pauseJob(jobId, job.leaseEpoch, 'GIT_CONFLICT', { conflicts: merged.conflicts })
            markNeedsReview(dlvId)
            return Object.freeze({ ok: false, code: 'GIT_CONFLICT', conflicts: merged.conflicts, targetRefUnchanged: true })
          }
          pauseJob(jobId, job.leaseEpoch, 'GIT_ERROR', { stderr: merged.stderr })
          return Object.freeze({ ok: false, code: 'GIT_ERROR', targetRefUnchanged: true, stderr: merged.stderr })
        }

        // 第一父 = expected_head，第二父 = 任务源提交：目标提交才**包含** source commit
        // （设计 §6.2 第 6 条核对项；单父候选会让 source 不可达）。
        const candidateParents = source !== expectedHead ? [expectedHead, source] : [expectedHead]
        const candidate = git.commitTree(repoDir, merged.treeOid, candidateParents, 'integrate ' + dlvId, { env })
        if (!candidate.ok) {
          pauseJob(jobId, job.leaseEpoch, 'COMMIT_TREE_FAILED', { stderr: candidate.stderr })
          return Object.freeze({ ok: false, code: 'COMMIT_TREE_FAILED', targetRefUnchanged: true })
        }
        deliveryStore.transitionIntegrationJob({
          id: jobId, leaseEpoch: job.leaseEpoch, to: 'applying', phase: 'prepared',
          preparedCommit: candidate.commit, expectedHead, actor,
        })

        // 2. 在候选提交上跑登记验证（隔离 worktree）。
        const verification = runVerification(candidate.commit)
        if (!verification.passed) {
          pauseJob(jobId, job.leaseEpoch, verification.code, { report: verification.report })
          markNeedsReview(dlvId)
          return Object.freeze({
            ok: false, code: verification.code, report: verification.report,
            targetRefUnchanged: true, targetRef, expectedHead,
          })
        }

        if (typeof hooks.beforeApply === 'function') hooks.beforeApply({ recompute, expectedHead, candidateCommit: candidate.commit })

        // 3. 最终提交前重新确认目标 ref 未被别人推进。
        const headNow = git.revParse(repoDir, targetRef)
        if (headNow !== expectedHead) {
          recompute += 1
          if (recompute > maxRecompute) {
            pauseJob(jobId, job.leaseEpoch, 'HEAD_ADVANCED_LIMIT', { recompute, headNow, expectedHead })
            markNeedsReview(dlvId)
            return Object.freeze({ ok: false, code: 'HEAD_ADVANCED_LIMIT', recompute, targetRefUnchanged: true })
          }
          continue
        }

        // 4. 仅允许快进接入（expectedOld = expectedHead，CAS）。
        deliveryStore.transitionIntegrationJob({ id: jobId, leaseEpoch: job.leaseEpoch, to: 'applying', phase: 'applying', actor })
        const applied = git.fastForwardCheckedOut(checkDir, targetRef, candidate.commit, expectedHead)
        if (!applied.ok) {
          if (applied.code !== 'HEAD_ADVANCED') {
            pauseJob(jobId, job.leaseEpoch, applied.code ?? 'FAST_FORWARD_FAILED', { stderr: applied.stderr, reasons: applied.reasons })
            return Object.freeze({ ok: false, code: applied.code ?? 'FAST_FORWARD_FAILED', targetRefUnchanged: git.revParse(repoDir, targetRef) === expectedHead })
          }
          recompute += 1
          if (recompute > maxRecompute) {
            pauseJob(jobId, job.leaseEpoch, 'REF_CAS_FAILED', { recompute, stderr: applied.stderr })
            markNeedsReview(dlvId)
            return Object.freeze({ ok: false, code: 'HEAD_ADVANCED_LIMIT', recompute, targetRefUnchanged: true })
          }
          continue
        }

        deliveryStore.transitionIntegrationJob({ id: jobId, leaseEpoch: job.leaseEpoch, to: 'ref-updated', phase: 'ref-updated', gitSha: candidate.commit, actor })
        if (!git.isAncestor(repoDir, source, targetRef)) {
          pauseJob(jobId, job.leaseEpoch, 'APPLY_UNVERIFIED', { candidate: candidate.commit })
          return Object.freeze({ ok: false, code: 'APPLY_UNVERIFIED', targetRefUnchanged: false })
        }
        advanceTo(deliveryStore, dlvId, 'validating', { actor })
        const done = advanceTo(deliveryStore, dlvId, 'integrated', { actor, integratedCommit: candidate.commit })
        if (typeof releaseReservation === 'function') releaseReservation({ deliveryId: dlvId })
        deliveryStore.transitionIntegrationJob({ id: jobId, leaseEpoch: job.leaseEpoch, to: 'finalized', phase: 'finalized', gitSha: candidate.commit, actor })
        return Object.freeze({
          ok: true, outcome: INTEGRATION_OUTCOMES.INTEGRATED,
          integratedCommit: candidate.commit, targetRef, delivery: done, report: verification.report,
        })
      }
    },

    /**
     * 崩溃恢复：读 journal + Git SHA 对账，判定「未应用／已应用未记账／结果不明」。
     */
    recover({ jobId = null } = {}) {
      const jobs = deliveryStore.listIntegrationJobs(repoId).filter((j) => j.state !== 'finalized' && j.state !== 'failed' && (jobId === null || j.id === jobId))
      const actions = []
      for (const job of jobs) {
        const targetHead = git.revParse(repoDir, targetRef)
        const prepared = job.preparedCommit
        const applied = Boolean(prepared && targetHead && (targetHead === prepared || git.isAncestor(repoDir, prepared, targetRef)))
        const recorded = job.state === 'ref-updated' || job.state === 'finalized'
          || (job.deliveryId ? deliveryStore.getDelivery(job.deliveryId)?.state === 'integrated' : false)
        const workspaceClean = git.isWorktreeClean(workspaceDir ?? repoDir).clean
        const verifiedApplyStarted = job.journalPhase === 'applying' || job.journalPhase === 'ref-updated'
        if (applied && !workspaceClean) {
          pauseJob(job.id, job.leaseEpoch, 'WORKSPACE_OUT_OF_SYNC', { prepared, targetHead })
          actions.push(Object.freeze({ jobId: job.id, action: 'pause', deleteBranch: false, rerunMerge: false, reason: '目标 ref 与绑定工作区文件/索引不一致或有本地改动' }))
        } else if (applied && !verifiedApplyStarted) {
          pauseJob(job.id, job.leaseEpoch, 'VALIDATION_UNCONFIRMED', { prepared, targetHead })
          actions.push(Object.freeze({ jobId: job.id, action: 'pause', deleteBranch: false, rerunMerge: false, reason: '候选验证通过的证据不完整' }))
        } else if (applied && !recorded) {
          advanceTo(deliveryStore, job.deliveryId, 'integrated', { actor, integratedCommit: prepared })
          if (typeof releaseReservation === 'function') releaseReservation({ deliveryId: job.deliveryId })
          deliveryStore.transitionIntegrationJob({ id: job.id, leaseEpoch: job.leaseEpoch, to: 'finalized', phase: 'finalized', gitSha: prepared, actor, detail: { recovered: 'record-only' } })
          actions.push(Object.freeze({ jobId: job.id, action: 'record-only', integratedCommit: prepared, deleteBranch: false, rerunMerge: false }))
        } else if (applied && recorded && job.state === 'ref-updated') {
          if (typeof releaseReservation === 'function') releaseReservation({ deliveryId: job.deliveryId })
          deliveryStore.transitionIntegrationJob({ id: job.id, leaseEpoch: job.leaseEpoch, to: 'finalized', phase: 'finalized', gitSha: prepared, actor, detail: { recovered: 'finalize-recorded' } })
          actions.push(Object.freeze({ jobId: job.id, action: 'finalize-recorded', integratedCommit: prepared, deleteBranch: false, rerunMerge: false }))
        } else if (!applied && !recorded && (job.state === 'applying' || job.state === 'leased')) {
          pauseJob(job.id, job.leaseEpoch, 'UNAPPLIED_AFTER_CRASH', { prepared, targetHead })
          actions.push(Object.freeze({ jobId: job.id, action: 'retry-ready', deleteBranch: false, rerunMerge: false }))
        } else if (targetHead && prepared && !applied && recorded) {
          actions.push(Object.freeze({ jobId: job.id, action: 'pause', deleteBranch: false, rerunMerge: false, reason: 'ref 与账不符' }))
        } else {
          actions.push(Object.freeze({ jobId: job.id, action: 'noop', deleteBranch: false, rerunMerge: false }))
        }
      }
      return Object.freeze({ actions: Object.freeze(actions) })
    },
  }
}

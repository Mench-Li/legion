import { resolveRepoIdentity } from '../packages/shared/src/repo-identity.mjs'
import { createDeliveryStore, ensureDeliverySchema } from './delivery-store.mjs'
import { createWriteIntentStore, ensureWriteIntentSchema } from './write-intent-store.mjs'
import { createIntegrationWorker } from './integration-worker.mjs'
import { loadDeliveryConfig } from './verify-config.mjs'
import { revParse, runGit } from './git-plumbing.mjs'

/** Execute one ready delivery against the server-bound checked-out repository. */
export function runDeliveryJob({ db, repoDir, repoId, targetRef, deliveryId, actor = 'integration-runner' }) {
  ensureDeliverySchema(db)
  ensureWriteIntentSchema(db)
  const identity = resolveRepoIdentity(repoDir)
  if (identity.capability !== 'git' || identity.repoId !== repoId) return { ok: false, code: 'REPO_BINDING_CHANGED' }
  const checkedOut = runGit(['symbolic-ref', '-q', 'HEAD'], repoDir)
  if (!checkedOut.ok || checkedOut.stdout.trim() !== targetRef) return { ok: false, code: 'TARGET_NOT_CHECKED_OUT' }
  const deliveries = createDeliveryStore(db)
  const intents = createWriteIntentStore(db, { caseInsensitive: process.platform === 'win32' })
  const delivery = deliveries.getDelivery(deliveryId)
  if (!delivery || delivery.state !== 'ready' || delivery.targetRef !== targetRef) return { ok: false, code: 'DELIVERY_NOT_READY' }
  const config = loadDeliveryConfig(repoDir)
  if (!config.ok || config.config.targetRef !== targetRef) {
    deliveries.transitionDelivery({ id: delivery.id, version: delivery.version, to: 'needs-review', actor, detail: { code: 'INVALID_VERIFY_CONFIG', errors: config.errors } })
    return { ok: false, code: 'INVALID_VERIFY_CONFIG', errors: config.errors ?? ['验证配置目标分支不匹配'] }
  }
  if (!revParse(repoDir, delivery.sourceCommit)) return { ok: false, code: 'SOURCE_MISSING' }
  const reservation = intents.listActiveReservations(repoId).find((r) => r.taskId === delivery.taskId && r.attemptId === delivery.attemptId)
  if (!reservation || reservation.state !== 'reserved') return { ok: false, code: 'WRITE_RESERVATION_MISSING' }
  const expectedHead = revParse(repoDir, targetRef)
  if (!expectedHead) return { ok: false, code: 'TARGET_REF_MISSING' }
  const claimed = deliveries.claimIntegrationJob({ repoId, targetRef, deliveryId, expectedHead, owner: actor, leaseEpoch: 1 })
  if (!claimed.ok) return claimed
  let releaseWarning = null
  const worker = createIntegrationWorker({
    deliveryStore: deliveries, repoDir, repoId, workspaceDir: repoDir, targetRef,
    verifyConfig: config.config, actor,
    releaseReservation: () => {
      const result = intents.release({ repoId, taskId: delivery.taskId, attemptId: reservation.attemptId, epoch: reservation.leaseEpoch })
      if (result.ok) db.prepare("UPDATE tasks SET scheduling_state='released' WHERE id=?").run(delivery.taskId)
      else releaseWarning = result
    },
  })
  const result = worker.runJob({ jobId: claimed.job.id, deliveryId, leaseEpoch: claimed.job.leaseEpoch })
  return { ...result, jobId: claimed.job.id, ...(releaseWarning ? { warning: 'RESERVATION_RELEASE_FAILED', releaseWarning } : {}) }
}

/** Call only after the previous integration process has been confirmed stopped. */
export function recoverDeliveryJob({ db, repoDir, repoId, targetRef, jobId, actor = 'integration-recovery' }) {
  ensureDeliverySchema(db)
  ensureWriteIntentSchema(db)
  if (resolveRepoIdentity(repoDir).repoId !== repoId) return { ok: false, code: 'REPO_BINDING_CHANGED' }
  const deliveries = createDeliveryStore(db)
  const intents = createWriteIntentStore(db, { caseInsensitive: process.platform === 'win32' })
  const job = deliveries.getIntegrationJob(jobId)
  if (!job || job.repoId !== repoId || job.targetRef !== targetRef) return { ok: false, code: 'JOB_NOT_FOUND' }
  const delivery = deliveries.getDelivery(job.deliveryId)
  if (!delivery) return { ok: false, code: 'DELIVERY_NOT_FOUND' }
  const worker = createIntegrationWorker({
    deliveryStore: deliveries, repoDir, repoId, workspaceDir: repoDir, targetRef, actor,
    releaseReservation: () => {
      const reservation = intents.listActiveReservations(repoId).find((r) => r.taskId === delivery.taskId && r.attemptId === delivery.attemptId)
      if (!reservation) return
      const released = intents.release({ repoId, taskId: delivery.taskId, attemptId: reservation.attemptId, epoch: reservation.leaseEpoch })
      if (released.ok) db.prepare("UPDATE tasks SET scheduling_state='released' WHERE id=?").run(delivery.taskId)
    },
  })
  const recovered = worker.recover({ jobId })
  const action = recovered.actions.find((entry) => entry.jobId === jobId)
  return { ok: Boolean(action && action.action !== 'pause' && action.action !== 'noop'), ...recovered }
}

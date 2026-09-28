import { workerData, parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { runDeliveryJob, recoverDeliveryJob } from './integration-runner.mjs'

const db = new DatabaseSync(workerData.dbFile)
let result
try {
  db.exec('PRAGMA busy_timeout=5000')
  result = workerData.recoverJobId
    ? recoverDeliveryJob({ db, repoDir: workerData.repoDir, repoId: workerData.repoId, targetRef: workerData.targetRef, jobId: workerData.recoverJobId })
    : runDeliveryJob({ db, repoDir: workerData.repoDir, repoId: workerData.repoId, targetRef: workerData.targetRef, deliveryId: workerData.deliveryId })
} catch (error) {
  result = { ok: false, code: error?.code ?? 'INTEGRATION_RUNNER_ERROR', message: error?.message ?? String(error) }
} finally {
  db.close()
}
parentPort.postMessage(result)

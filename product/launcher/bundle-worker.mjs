import { parentPort, workerData } from 'node:worker_threads'
import { importBundledRuntime } from './bundled-runtime.mjs'

const abort = new AbortController()
parentPort.on('message', message => { if (message?.type === 'cancel') abort.abort() })
try {
  const result = await importBundledRuntime({ ...workerData, signal: abort.signal,
    onProgress: payload => parentPort.postMessage({ type: 'progress', payload }) })
  parentPort.postMessage({ type: 'result', ok: true, result })
} catch (error) {
  parentPort.postMessage({ type: 'result', ok: false,
    code: error.name === 'AbortError' ? 'PREPARATION_CANCELLED' : error.code ?? 'BUNDLE_IMPORT_FAILED' })
} finally { parentPort.close() }

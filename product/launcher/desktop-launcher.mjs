import { Worker } from 'node:worker_threads'
import { createLauncher } from './launcher.mjs'
import { acquireSingleInstance } from './single-instance.mjs'
import { initializeProductDir } from '../init.mjs'
import { assertDesktopSetupLayout, writeDesktopIdentity, writeDesktopSettings } from './desktop-settings.mjs'

export function prepareInWorker(input, { signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bundle-worker.mjs', import.meta.url), { workerData: input })
    let result = null
    const cancel = () => worker.postMessage({ type: 'cancel' })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    worker.on('message', message => {
      if (message?.type === 'progress') onProgress(message.payload)
      if (message?.type === 'result') result = message
    })
    worker.once('error', () => { result = { ok: false, code: 'BUNDLE_WORKER_FAILED' } })
    worker.once('exit', code => {
      signal?.removeEventListener('abort', cancel)
      if (code !== 0 || result?.ok !== true) {
        reject(Object.assign(new Error('Runtime preparation failed'), { code: result?.code ?? 'BUNDLE_WORKER_FAILED' }))
      } else resolve(result.result)
    })
  })
}

// One product owner spans preparation and normal service supervision. The bridge
// owns no filesystem lock; the same lock handle is handed to the existing Launcher.
export function createDesktopLauncher(options, {
  launcherFactory = createLauncher, acquireLock = acquireSingleInstance, prepare = prepareInWorker,
} = {}) {
  let lease = null
  let inner = null
  let preparing = null
  let abort = null
  async function ensureLease() {
    if (lease !== null) return
    const acquired = await acquireLock({ dataDir: options.layout.dataDir, pid: process.pid })
    if (acquired.ok !== true) throw Object.assign(new Error('Product already owned'), { code: acquired.code })
    lease = acquired
  }
  function release() {
    if (lease === null) return null
    const outcome = lease.handle.release()
    if (outcome?.ok !== true) throw Object.assign(new Error('DataDir lease release failed'), { code: 'INSTANCE_LOCK_RELEASE_FAILED' })
    lease = null
    return outcome
  }
  async function prepareRuntime() {
    if (preparing) return preparing
    abort = new AbortController()
    preparing = (async () => {
      await ensureLease()
      try {
        return await prepare({ ...options.bundledRuntime, dataDir: options.layout.dataDir, installDir: options.layout.installDir },
          { signal: abort.signal, onProgress: options.onPrepareProgress })
      } catch (error) { release(); throw error }
    })()
    try { return await preparing } finally { preparing = null; abort = null }
  }
  return {
    prepareRuntime,
    async configureWorkspace() {
      if (inner || preparing) throw Object.assign(new Error('Services already started'), { code: 'DESKTOP_SETUP_BUSY' })
      assertDesktopSetupLayout(options.layout)
      await ensureLease()
      try {
        const result = initializeProductDir(options.layout)
        if (result.ok !== true) throw Object.assign(new Error('Initialization failed'), {
          code: result.diagnostics.find(item => item.severity === 'error')?.code ?? 'INIT_FAILED',
        })
        return writeDesktopSettings(options.layout)
      } catch (error) { release(); throw error }
    },
    async configureIdentity(input) {
      if (inner || preparing) throw Object.assign(new Error('Services already started'), { code: 'DESKTOP_SETUP_BUSY' })
      assertDesktopSetupLayout(options.layout)
      await ensureLease()
      try { return writeDesktopIdentity(options.layout, input) }
      catch (error) { release(); throw error }
    },
    cancelPreparation() { abort?.abort() },
    async start() {
      await prepareRuntime()
      if (lease === null) throw Object.assign(new Error('Preparation ownership lost'), { code: 'PREPARATION_CANCELLED' })
      // A packaged desktop always uses the verified bundled runtime pointer.
      inner = launcherFactory({ ...options, runtimeCommand: null, dshProfile: 'legion-desktop', acquireInstanceLockImpl: async () => ({
        ...lease, handle: { release },
      }) })
      return inner.start()
    },
    async stop(input) {
      abort?.abort()
      if (preparing) { try { await preparing } catch { /* cancellation is expected */ } }
      if (inner) {
        const result = await inner.stop(input)
        release()
        return result
      }
      release()
      return { results: [], states: [] }
    },
    status() {
      if (preparing) return { state: 'preparing', processes: [] }
      return inner?.status() ?? { state: 'unavailable', processes: [] }
    },
  }
}

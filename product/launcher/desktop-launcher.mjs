import { Worker } from 'node:worker_threads'
import { createLauncher } from './launcher.mjs'
import { acquireSingleInstance } from './single-instance.mjs'
import { initializeProductDir } from '../init.mjs'
import { assertDesktopSetupLayout, writeDesktopIdentity, writeDesktopModelVerified, writeDesktopSettings } from './desktop-settings.mjs'

const MODEL_KEY_REF = 'model/api-key'
const MODEL_PROFILE = Object.freeze({ id: 'deepseek-official', provider: 'deepseek-official',
  model: 'deepseek-flash', endpoint: 'https://api.deepseek.com', secretRef: MODEL_KEY_REF })

function validateDesktopModelInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'apiKey')
    || typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/u.test(input.apiKey)) {
    throw Object.assign(new Error('Model setup invalid'), { code: 'MODEL_INPUT_INVALID' })
  }
  return input.apiKey
}

async function probeDeepSeekModel(apiKey) {
  const [{ createModelProbe }, { createHttpTransport }] = await Promise.all([
    import('../../runtime/probe/index.mjs'), import('../../runtime/probe/http.mjs'),
  ])
  const probe = createModelProbe({ transport: createHttpTransport(), resolveSecret: async ref => {
    if (ref !== MODEL_KEY_REF) throw Object.assign(new Error('Unexpected model secret reference'), { code: 'SECRET_REF_INVALID' })
    return apiKey
  } })
  return probe.probe({ profile: MODEL_PROFILE, force: true })
}

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
  openSecrets = null, probeModel = probeDeepSeekModel,
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
    async configureModel(input) {
      if (inner || preparing) throw Object.assign(new Error('Services already started'), { code: 'DESKTOP_SETUP_BUSY' })
      assertDesktopSetupLayout(options.layout)
      const apiKey = validateDesktopModelInput(input)
      await ensureLease()
      const verdict = await probeModel(apiKey, MODEL_PROFILE)
      if (verdict?.ok !== true) {
        throw Object.assign(new Error('DeepSeek model verification failed'), {
          code: typeof verdict?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(verdict.code)
            ? `MODEL_PROBE_${verdict.code}` : 'MODEL_PROBE_FAILED',
        })
      }
      const opened = typeof openSecrets === 'function'
        ? await openSecrets({ layout: options.layout, requireProtected: true })
        : await (await import('../secrets.mjs')).openProductSecrets({ layout: options.layout, requireProtected: true })
      if (opened?.ok !== true || opened?.store?.protection?.().protected !== true) {
        throw Object.assign(new Error('Protected SecretStore unavailable'), { code: 'SECRETS_STORE_UNAVAILABLE' })
      }
      try {
        const metadata = await opened.store.put(MODEL_KEY_REF, apiKey, { purpose: 'model' })
        return writeDesktopModelVerified(options.layout, { credentialUpdatedAt: metadata?.updatedAt })
      } catch (error) {
        if (/^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code ?? '')) {
          throw Object.assign(new Error('Could not save model configuration'), { code: error.code })
        }
        throw Object.assign(new Error('Could not save model configuration'), { code: 'MODEL_SECRET_STORE_FAILED' })
      }
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

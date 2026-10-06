import { fileBackend } from '../../../security/secrets/store.mjs'
const [file, ref, timeout] = process.argv.slice(2)
try {
  fileBackend({ file, lockTimeoutMs: Number(timeout), lockRetryMs: 2 })
    .write(ref, { blob: 'enc:X', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
  console.log('OUTCOME=ok')
} catch (e) { console.log('OUTCOME=' + e.code) }

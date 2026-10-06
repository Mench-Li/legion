import { fileBackend } from '../security/secrets/store.mjs'
const file = process.argv[2], ref = process.argv[3], timeout = Number(process.argv[4])
const b = fileBackend({ file, lockTimeoutMs: timeout, lockRetryMs: 2 })
try {
  b.write(ref, { blob: 'enc:X', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
  console.log('OUTCOME=wrote')
} catch (e) { console.log('OUTCOME=' + e.code) }

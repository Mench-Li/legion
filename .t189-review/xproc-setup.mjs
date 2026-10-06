import { fileBackend } from '../security/secrets/store.mjs'
const file = process.argv[2]
const b = fileBackend({ file })
b.write('legion/a', { blob: 'enc:A', meta: { scheme: 'dpapi', purpose: 'model-credential' } })
console.log('SETUP=ok')

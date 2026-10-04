// 证据：.legion/delivery.json 是否通过它自己服务的校验器（team-hub/verify-config.mjs）
import { pathToFileURL } from 'node:url'
const repoRoot = process.argv[2]
const mod = await import(pathToFileURL(repoRoot + '/team-hub/verify-config.mjs').href)
const r = mod.loadDeliveryConfig(repoRoot)
console.log(JSON.stringify({ ok: r.ok, errors: r.errors, verifyCount: Array.isArray(r.config?.verify) ? r.config.verify.length : null }, null, 2))

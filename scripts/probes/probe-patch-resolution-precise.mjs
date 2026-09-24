// 精确定位：`resolveDshBaseBundlePatchPath()` 返 null 是哪一步断的。
import { isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { resolveDshBaseBundlePatchPath } from '../../product/launcher/run-credential-materialization.mjs'

const ENTRY = 'D:/project/DSH/dsh/deepseek-harness/apps/cli/lib/bin.js'

console.log('① 入口本身：', ENTRY)
console.log('   isAbsolute =', isAbsolute(ENTRY))
console.log('   匹配 /\\\\.(mjs|cjs|js)$/i =', /\.(?:mjs|cjs|js)$/i.test(ENTRY))

console.log('\n② 直接用 createRequire 解析：')
try {
  const req = createRequire(ENTRY)
  console.log('   ->', req.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))
} catch (e) {
  console.log('   ERR', e.code, String(e.message).slice(0, 160))
}

console.log('\n③ 走生产函数（不注入任何东西）：')
console.log('   ->', resolveDshBaseBundlePatchPath({ runtimeCommand: { args: [ENTRY] } }))

console.log('\n④ 走生产函数（注入一个 createRequire(ENTRY)）：')
console.log('   ->', resolveDshBaseBundlePatchPath({ runtimeCommand: { args: [ENTRY] }, requireFn: createRequire(ENTRY) }))

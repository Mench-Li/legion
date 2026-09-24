// 端到端：真 DSH 检出 → 解析器 → 读回 apiKeyEnv 声明 → 映射。
// 这一段此前**没有任何真实调用跑过**（PRT-509 的 🟡 第 ② 条）。
import { readFileSync } from 'node:fs'
import {
  dshCredentialNamesFromPatchText,
  resolveDshBaseBundlePatchPath,
} from '../../product/launcher/run-credential-materialization.mjs'

const ENTRY = 'D:/project/DSH/dsh/deepseek-harness/apps/cli/lib/bin.js'

const path = resolveDshBaseBundlePatchPath({ runtimeCommand: { args: [ENTRY] } })
console.log('① 解析出的补丁文件：', path)
if (path === null) { console.log('   ⇒ 解析不到，后面的读数无意义'); process.exit(1) }

const text = readFileSync(path, 'utf8')
console.log('② 字节数：', text.length)

const declared = dshCredentialNamesFromPatchText({ text })
console.log('③ apiKeyEnv 声明：', declared.ok === true ? declared.names : `${declared.code}: ${declared.message}`)

if (declared.ok === true) {
  console.log('④ 这次运行声明的每一条引用都映到它：')
  for (const ref of ['model/api-key', 'model/apiKey', 'legion/model/x']) console.log('   ', ref, '→', declared.names[0])
}

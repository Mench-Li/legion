// 临时探针（未跟踪）：生产入口 `productionExecutorProviderFromEnv` 在真实环境变量形状下
// 到底给出什么读数。目的：把「执行引擎接线缺什么」量出来，而不是读代码断言。
import { productionExecutorProviderFromEnv } from '../orchestrator/worker/executor-binding.mjs'

const env = {
  TEAM_HUB_URL: 'http://127.0.0.1:8787',
  TEAM_HUB_TOKEN: 't',
  LEGION_DATA_DIR: 'C:\\Users\\11150\\AppData\\Local\\Legion\\data',
  // 契约端点（Launcher 启动时才会真的注入；这里按"注入过"的形状试）
  LEGION_RUNTIME_URL: 'http://127.0.0.1:54321',
  LEGION_RUNTIME_TOKEN: 'rt',
}

// ① 与 product/orchestrator/worker.mjs 的调用点**逐字同形**：没有 canRead。
const asProduction = await productionExecutorProviderFromEnv({
  env,
  fetchImpl: async () => { throw new Error('不该走到网络：权限来源的缺失应当先被拦住') },
})
console.log('[生产调用点原样]', asProduction.ok, asProduction.code)
console.log('   message =', asProduction.message)
for (const r of asProduction.reasons ?? []) console.log('   reason  =', r)

// ② 补上 canRead 再看下一步（会把读数推进到别处）。
const withCanRead = await productionExecutorProviderFromEnv({
  env,
  canRead: () => true,
  fetchImpl: async () => { throw new Error('网络不可达（本机没有契约监听器）') },
})
console.log('[补上 canRead]', withCanRead.ok, withCanRead.code)
console.log('   message =', withCanRead.message)

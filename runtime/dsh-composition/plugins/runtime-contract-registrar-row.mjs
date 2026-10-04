import { createRuntimeHostInputsFactory } from './runtime-host-registrar-row.mjs'
import { runtimeContractServerRow, setRuntimeContractInputsFactory } from './runtime-contract-server-row.mjs'

/** 本行读取的 env 键名表（PRT-254 的口径：`runtime/` 里不留**字面量成员访问**）。
 *
 *  为什么要有这张表：字面量成员访问（`env.LEGION_RUNTIME_TOKEN`）在扫描器眼里与普通属性
 *  读写同形，只有 `env[表.成员]` 这种下标形态才会被动态规则命中、从而被
 *  `runtime/config-schema.mjs` 的 `dynamicEnvReads` 与 `config.test.mjs` 的并集判据盯住。
 *  同 `root-row.mjs` 的 DECIDE_ENV_KEYS / SPOOL_ENV_KEYS：读取点与键名表写在同一处，
 *  改一边忘另一边时那条判据会红。
 *
 *  两个键都已在 `runtime/config-schema.mjs` 的 fields 里声明（runtimeToken / dataDir）。 */
export const REGISTRAR_ENV_KEYS = Object.freeze({
  runtimeToken: 'LEGION_RUNTIME_TOKEN',
  dataDir: 'LEGION_DATA_DIR',
})

export function createRuntimeContractInputsFactory({ env = process.env, hostInputs = createRuntimeHostInputsFactory() } = {}) {
  return ctx => ({
    runtimeHost: hostInputs(ctx).runtimeHost,
    token: env[REGISTRAR_ENV_KEYS.runtimeToken] ?? null,
    dataDir: env[REGISTRAR_ENV_KEYS.dataDir] ?? null,
    bindPort: 0,
    host: '127.0.0.1',
  })
}

setRuntimeContractInputsFactory(createRuntimeContractInputsFactory())

export default { ...runtimeContractServerRow, inject: ['subagents'] }

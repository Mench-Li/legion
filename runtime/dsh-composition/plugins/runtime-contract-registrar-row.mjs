import { createRuntimeHostInputsFactory } from './runtime-host-registrar-row.mjs'
import { runtimeContractServerRow, setRuntimeContractInputsFactory } from './runtime-contract-server-row.mjs'

export function createRuntimeContractInputsFactory({ env = process.env, hostInputs = createRuntimeHostInputsFactory() } = {}) {
  return ctx => ({
    runtimeHost: hostInputs(ctx).runtimeHost,
    token: env.LEGION_RUNTIME_TOKEN ?? null,
    dataDir: env.LEGION_DATA_DIR ?? null,
    bindPort: 0,
    host: '127.0.0.1',
  })
}

setRuntimeContractInputsFactory(createRuntimeContractInputsFactory())

export default { ...runtimeContractServerRow, inject: ['subagents'] }

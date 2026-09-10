// config-schema.d.mts — plugins/config-schema.mjs 的类型面（.mjs/.d.mts 配对，同 artifact-policy 先例）
import type { ConfigSchema, ConfigRuleViolation } from '../packages/shared/src/config.mjs'

export declare const DEFAULT_CHAT_CTX_BUDGET_CHARS: number
export declare const DEFAULT_CHAT_CTX_DIGEST_BUDGET_CHARS: number
export declare const DEFAULT_CHAT_CTX_FILE_CAP_CHARS: number
export declare const DEFAULT_NORMS_GLOBAL_MAX: number
export declare const DEFAULT_NORMS_SPACE_MAX: number
export declare const DEFAULT_NORMS_TOTAL_MAX: number

export declare const SCHEMA: ConfigSchema
export declare function normsAndCtxRules(values: Record<string, unknown>): ConfigRuleViolation[]

export default SCHEMA

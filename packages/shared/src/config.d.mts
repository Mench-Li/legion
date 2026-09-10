// config.d.mts — 统一配置引擎（packages/shared/src/config.mjs）的类型面。
//
// 存在的理由：引擎是 .mjs，TS 消费者（plugins/src/*.ts，rootDir=src）直接 import 会报 TS7016
// （`Could not find a declaration file ... implicitly has an 'any' type`）。仓库既有先例是
// `artifact-policy.d.mts`——`.mjs` 与同名 `.d.mts` 配对，不改引擎本身。
// 声明与实现保持同步的责任在 P3-2 的 config 套件：`scripts/config/config.test.mjs` 会比对
// schema 字段默认值与真实代码常量（漂移即失败）。
export type ConfigSource = 'cli' | 'env' | 'default'
export type ConfigFieldType = 'string' | 'int' | 'bool' | 'enum' | 'csv' | 'path'

export interface ConfigField {
  key: string
  env: string
  cli?: string
  type: ConfigFieldType
  default?: unknown
  sensitive: boolean
  choices?: readonly string[]
  min?: number
  max?: number
  required?: boolean
  doc?: string
  redact?: (value: unknown) => unknown
}

export interface ConfigRuleViolation {
  level: 'error' | 'warning'
  code: string
  message: string
  hint?: string
}

export interface ConfigInject {
  env: string
  from?: string
  value?: string | number
  note?: string
}

export interface ConfigSchema {
  readonly process: string
  readonly title: string
  readonly prefixes: readonly string[]
  readonly fields: readonly ConfigField[]
  readonly nonEnvLiterals: readonly string[]
  readonly dynamicEnvReads: readonly unknown[]
  readonly foreignEnv: readonly unknown[]
  readonly notes: readonly string[]
  readonly injects: readonly ConfigInject[]
  readonly rules: readonly ((values: Record<string, unknown>) => ConfigRuleViolation[])[]
  envNames(): string[]
  keys(): string[]
  field(key: string): ConfigField | undefined
  secretKeys(): string[]
}

export interface ConfigResolved {
  values: Record<string, any>
  sources: Record<string, ConfigSource>
  errors: { key: string; env: string; message: string }[]
  warnings: { key: string | null; message: string }[]
  unknownEnv: string[]
}

export declare const SOURCE: Readonly<{ CLI: 'cli'; ENV: 'env'; DEFAULT: 'default' }>
export declare const TYPES: readonly ConfigFieldType[]

export declare function maskSecret(value: unknown): string
export declare function defineSchema(spec: Record<string, unknown>): ConfigSchema
export declare function parseArgv(argv?: readonly string[]): Map<string, string>
export declare function coerce(field: ConfigField, raw: unknown): { ok: true; value: any } | { ok: false; message: string }
export declare function resolveConfig(
  schema: ConfigSchema,
  options?: { env?: Record<string, string | undefined>; argv?: readonly string[]; checkUnknownEnv?: boolean },
): ConfigResolved
export declare function redactConfig(schema: ConfigSchema, values: Record<string, unknown>): Record<string, any>
export declare function formatSummary(
  schema: ConfigSchema,
  resolved: ConfigResolved,
  options?: { showSource?: boolean },
): string
export declare function summaryObject(
  schema: ConfigSchema,
  resolved: ConfigResolved,
  options?: { showSource?: boolean },
): { process: string; title: string; values: Record<string, any>; sources?: Record<string, ConfigSource>; warnings: string[]; errors: string[] }
export declare function loadConfig(
  schema: ConfigSchema,
  options?: { env?: Record<string, string | undefined>; argv?: readonly string[]; checkUnknownEnv?: boolean },
): ConfigResolved & { redacted: Record<string, any>; summary: string }

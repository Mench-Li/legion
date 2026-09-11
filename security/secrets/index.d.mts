// security/secrets/index.d.mts
// ============================================================================
// 密钥库类型声明（PRT-505 / PRT-258 第四份契约）。
//
// 本目录被 `scripts/ci/dsh-boundary.mjs` 判为 must-be-zero：
// 这里**不得** import 任何 `@deepseek-ai/*` 类型，也不读 `process.env`。
// ============================================================================

// ---------------------------------------------------------------- 引用

export declare const SECRET_REF_MAX_LENGTH: 128
export declare const SECRET_REF_RE: RegExp
export declare const LEGION_SECRET_NAMESPACE: 'legion/'
export declare function isSecretRef(value: unknown): boolean
export declare function isLegionSecretRef(value: unknown): boolean
export declare function assertSecretRef(value: unknown, opts?: { field?: string }): string

// ---------------------------------------------------------------- 错误

export type SecretErrorCode =
  | 'SECRET_REF_INVALID'
  | 'SECRET_VALUE_EMPTY'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_STORE_UNREADABLE'
  | 'SECRET_STORE_UNSUPPORTED_PLATFORM'
  | 'SECRET_STORE_UNPROTECTED'
  | 'SECRET_STORE_WRITE_FAILED'
  | 'SECRET_DECRYPT_FAILED'
  | 'SECRET_STORE_CORRUPT'

export declare const RUNTIME_CODE_FOR: Readonly<Record<SecretErrorCode, string>>
export declare const SECRET_ERROR_HINTS: Readonly<Record<SecretErrorCode, string>>

export declare class SecretStoreError extends Error {
  constructor(code: SecretErrorCode, context?: { ref?: string | null; platform?: string; cause?: string | null })
  readonly name: 'SecretStoreError'
  readonly code: SecretErrorCode
  readonly ref: string | null
  readonly runtimeCode: string
  get runtimeErrorCode(): string
}

export declare function isSecretStoreError(value: unknown): boolean

// ---------------------------------------------------------------- DPAPI

export declare const DPAPI_SCHEME: 'dpapi-user'
export declare const POWERSHELL_CANDIDATES: readonly string[]
export declare function resolvePowershell(opts?: { platform?: string; candidates?: readonly string[] }): string | null
export declare function probeDpapi(opts?: { platform?: string; candidates?: readonly string[] }):
  | { readonly available: true; readonly scheme: 'dpapi-user'; readonly exe: string; readonly reason: null; readonly hint: null }
  | { readonly available: false; readonly scheme: null; readonly reason: string; readonly hint: string }
export declare function protectValue(plaintext: string, opts?: { exe?: string; platform?: string }): string
export declare function unprotectValue(blob: string, opts?: { exe?: string; platform?: string }): string

// ---------------------------------------------------------------- 保护器

export type ProtectionScheme = 'none' | 'dpapi-user'

export interface Protector {
  readonly scheme: ProtectionScheme
  readonly protected: boolean
  protect(value: string): string
  unprotect(blob: string): string
}

export declare function nullProtector(): Protector
export declare function createProtector(input: {
  scheme: Exclude<ProtectionScheme, 'none'>
  protect(value: string): string
  unprotect(blob: string): string
}): Protector
export declare function createDpapiProtector(opts?: { exe?: string | null; platform?: string }): Protector

// ---------------------------------------------------------------- 后端

export interface SecretBackend {
  readonly kind: string
  read(ref: string): Promise<{ blob: string; meta: Record<string, unknown> } | null> | { blob: string; meta: Record<string, unknown> } | null
  write(ref: string, record: { blob: string; meta: Record<string, unknown> }): unknown
  remove(ref: string): unknown
  entries(): unknown
}

export declare function memoryBackend(): SecretBackend & { rawBlob(ref: string): string | null }
export declare function fileBackend(opts: { file: string; fs?: object | null }): SecretBackend & { readonly file: string }

// ---------------------------------------------------------------- store

export declare const SECRET_STORE_VERSION: 1
export declare const PROTECTION_SCHEMES: readonly ProtectionScheme[]
export declare const SECRET_META_FIELDS: readonly ['purpose']
export declare const AUDIT_ACTIONS: readonly string[]

export interface SecretMeta {
  readonly ref: string
  readonly purpose: string
  readonly scheme: ProtectionScheme | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly rotatedAt: string | null
}

export interface SecretStore {
  protection(): { readonly scheme: ProtectionScheme; readonly protected: boolean }
  put(ref: string, value: string, opts?: { purpose?: string }): Promise<SecretMeta>
  rotate(ref: string, value: string, opts?: { purpose?: string }): Promise<SecretMeta>
  get(ref: string): Promise<{ readonly ref: string; readonly value: string; readonly resolvedAt: string }>
  has(ref: string): Promise<boolean>
  describe(ref: string): Promise<SecretMeta | null>
  list(): Promise<readonly SecretMeta[]>
  remove(ref: string): Promise<boolean>
  toJSON(): { protection: { scheme: ProtectionScheme; protected: boolean }; refs: string }
  toString(): string
}

export declare function createSecretStore(input: {
  backend: SecretBackend
  protector: Protector
  now?: () => string
  onAudit?: ((event: { action: string; ref: string; at: string; purpose?: string | null }) => void) | null
}): SecretStore

export declare function assertProtectedStore(store: SecretStore, opts?: { allowedSchemes?: readonly ProtectionScheme[] }): SecretStore
export declare function createProductSecretStore(input?: {
  file: string
  platform?: string
  now?: () => string
  onAudit?: ((event: object) => void) | null
  exe?: string | null
}): SecretStore

// product/index.d.mts
// ============================================================================
// 产品层类型声明（PRT-258）。
//
// 运行期实现是 `.mjs`（与仓库既有约定一致：`node --test` 直接 import，
// 不需要 --experimental-strip-types）；本文件是给消费者（Launcher、Workbench、
// 后续阶段）用的类型面。
//
// 本目录被 `scripts/ci/dsh-boundary.mjs` 判为 must-be-zero：
// 这里**不得** import 任何 `@deepseek-ai/*` 类型。
// ============================================================================

// ---------------------------------------------------------------- paths

export type DirRole = 'install' | 'data' | 'workspace' | 'cache' | 'log'
export type WritableRole = 'data' | 'workspace' | 'cache' | 'log'
export type ConfigLayerName =
  | 'builtin-defaults'
  | 'product-config'
  | 'workspace-config'
  | 'user-settings'
  | 'env'
export type DiagnosticSeverity = 'error' | 'warn'

export declare const DIR_ROLES: readonly DirRole[]
export declare const WRITABLE_ROLES: readonly WritableRole[]
export declare const CONFIG_LAYERS: readonly ConfigLayerName[]
export declare const CONFIG_LAYER_LABELS: Readonly<Record<ConfigLayerName, string>>
export declare const DIAGNOSTIC_SEVERITIES: readonly DiagnosticSeverity[]
export declare const LEGION_ENV: Readonly<{
  HOME: 'LEGION_HOME'
  INSTALL_DIR: 'LEGION_INSTALL_DIR'
  DATA_DIR: 'LEGION_DATA_DIR'
  WORKSPACE_DIR: 'LEGION_WORKSPACE_DIR'
  CACHE_DIR: 'LEGION_CACHE_DIR'
  LOG_DIR: 'LEGION_LOG_DIR'
  PRODUCT_CONFIG: 'LEGION_PRODUCT_CONFIG'
}>

export interface ProductLayout {
  readonly platform: string
  readonly productHome: string | null
  readonly productHomeSource: string
  readonly installDir: string | null
  readonly dataDir: string | null
  readonly cacheDir: string | null
  readonly logDir: string | null
  readonly workspaceDir: string | null
  readonly productConfigPath: string | null
}

export interface LayoutDiagnostic {
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly role: string
  readonly message: string
}

export declare function pathApi(platform?: string): { resolve(...p: string[]): string; join(...p: string[]): string; sep: string; isAbsolute(p: string): boolean; parse(p: string): { root: string } }
export declare function normalizePath(p: string, platform?: string): string
export declare function samePath(a: string | null, b: string | null, platform?: string): boolean
export declare function isPathInside(parent: string | null, child: string | null, platform?: string): boolean
export declare function pathsOverlap(a: string, b: string, platform?: string): boolean

export declare function defaultProductHome(input?: {
  platform?: string
  env?: Record<string, string | undefined>
  homeDir?: string
  appDataDir?: string
}): { readonly root: string | null; readonly source: string }

export declare function resolveLayout(input?: {
  platform?: string
  env?: Record<string, string | undefined>
  installDir?: string
  dataDir?: string
  cacheDir?: string
  logDir?: string
  workspaceDir?: string
  productConfigPath?: string
  homeDir?: string
  appDataDir?: string
}): { layout: ProductLayout; diagnostics: readonly LayoutDiagnostic[] }

export declare function layoutDiagnostics(layout: ProductLayout): readonly LayoutDiagnostic[]
export declare function hasBlockingDiagnostic(diagnostics: readonly LayoutDiagnostic[]): boolean
export declare function assertLayoutUsable(layout: ProductLayout, opts?: { diagnostics?: readonly LayoutDiagnostic[] | null }): ProductLayout

export interface MergedConfig {
  readonly value: Readonly<Record<string, unknown>>
  readonly provenance: Readonly<Record<string, ConfigLayerName>>
  readonly sources: readonly ConfigLayerName[]
}

export declare function mergeConfigLayers(
  layers: readonly { source: ConfigLayerName; values: Record<string, unknown> }[],
): MergedConfig
export declare function provenanceOf(merged: MergedConfig, dottedPath: string): ConfigLayerName | null
export declare function findPlaintextSecretsInConfig(values: unknown): string[]
export declare function assertConfigWritable<T>(values: T): T

// ---------------------------------------------------------------- process manifest

export declare const PROCESS_MANIFEST_VERSION: 1
export declare const DEFAULT_PORTS: Readonly<{ runtime: number; 'team-hub': number; workbench: number; whiteboard: number }>
export declare const LOOPBACK_HOSTS: readonly string[]
export declare const PROCESS_KEYS: readonly string[]
export declare const MANIFEST_KNOWN_GAPS: readonly { code: string; process: string; detail: string }[]

export interface ProcessSpec {
  readonly key: string
  readonly label: string
  readonly kind: 'server' | 'worker'
  readonly required: boolean
  readonly dependsOn: readonly string[]
  readonly entry: { kind: 'node-file'; path: string } | { kind: 'configured'; configKey: string }
  readonly cwd: string
  readonly argsTemplate: readonly string[]
  readonly portKey: string | null
  readonly defaultPort: number | null
  readonly host: string | null
  readonly readiness: { kind: 'http' | 'tcp' | 'none'; path?: string; expectStatus?: number; timeoutMs?: number; intervalMs?: number; verified: boolean }
  readonly writesRoles: readonly DirRole[]
  readonly envNames: readonly string[]
  readonly milestone: string
}

export declare const PROCESS_SPECS: readonly ProcessSpec[]
export declare function specFor(key: string): ProcessSpec | null

export interface ProcessPlanEntry {
  readonly key: string
  readonly label: string
  readonly kind: 'server' | 'worker'
  readonly required: boolean
  readonly dependsOn: readonly string[]
  readonly entryPath: string | null
  readonly entryKind: 'node-file' | 'configured'
  readonly command: { readonly file: string; readonly args: readonly string[] } | null
  readonly cwd: string
  readonly port: number | null
  readonly host: string | null
  readonly url: string | null
  readonly readiness: ProcessSpec['readiness']
  readonly writesRoles: readonly DirRole[]
  readonly envNames: readonly string[]
  readonly milestone: string
}

export interface ProcessDiagnostic {
  readonly severity: DiagnosticSeverity
  readonly code: string
  readonly process: string
  readonly message: string
}

export declare function materializeProcessPlan(input: {
  layout: ProductLayout
  ports?: Record<string, number>
  runtimeCommand?: string | { file: string; args?: string[] } | null
  nodePath?: string
  extraArgs?: Record<string, string[]>
}): { readonly processes: readonly ProcessPlanEntry[]; readonly diagnostics: readonly ProcessDiagnostic[]; readonly waves: readonly (readonly string[])[] }

export declare function splitCommandLine(line: string): string[]
export declare function startupWaves(processes: readonly { key: string; dependsOn?: readonly string[] }[]): readonly (readonly string[])[]
export declare function validateProcessPlan(
  plan: { processes: readonly ProcessPlanEntry[]; diagnostics?: readonly ProcessDiagnostic[] },
  opts?: { installRoot?: string | null; platform?: string | null; exists?: ((p: string) => boolean) | null },
): readonly ProcessDiagnostic[]
export declare function hasBlockingProcessDiagnostic(diagnostics: readonly ProcessDiagnostic[]): boolean
export declare function entryAbsolutePath(proc: ProcessPlanEntry, installRoot: string | null, platform?: string): string | null
export declare function entryEscapesInstall(proc: ProcessPlanEntry, installRoot: string | null, platform?: string): boolean

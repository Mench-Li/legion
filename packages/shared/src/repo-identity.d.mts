export interface RepoCapability {
  capability: 'git' | 'degraded'
  repoId: string | null
  reason: string | null
  readOnlyAllowed: true
  singleWriterRequired: boolean
}
export interface RepoFacts { isGit: boolean, gitAvailable: boolean, commonDir: string | null }
export interface GitResult { status: number | null, error: string | null, stdout: string, stderr: string }
export declare const REPO_CAPABILITIES: Readonly<{ GIT: 'git', DEGRADED: 'degraded' }>
export function defaultRunGit(args: string[], cwd?: string): GitResult
export function repoIdFromCommonDir(commonDir: unknown): string | null
export function detectRepoCapability(facts?: Partial<RepoFacts>): RepoCapability
export function readOnlyAllowed(): true
export function probeRepoFacts(cwd: string, opts?: { runGit?: (args: string[], cwd?: string) => GitResult }): RepoFacts
export function resolveRepoIdentity(cwd: string, opts?: { runGit?: (args: string[], cwd?: string) => GitResult }): RepoCapability

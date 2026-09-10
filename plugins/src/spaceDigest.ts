/**
 * 空间摘要纯模块（R-2 决策 C1，S4）：从绑定仓库目录确定性只读构造「工作空间只读上下文」文本。
 *
 * 纪律（对齐 RESEARCH §4.2 C1 规格与 TEST_CASES TC-S4-01..09）：
 *   - 组成：(a) 空间元数据块（可选，scopeMeta）→ (b) 顶层结构块（readdir 一级；目录在前；跳过噪声）
 *     → (c) allowlist 关键文件内容（README.md/README.zh.md/LEGION.md/AGENTS.md/docs/FEATURES.md/PLUGINS.md/package.json/COMMAND.md，存在即读）；
 *   - 噪声目录（.git/node_modules/dist/build/.legion-worktrees/.turbo/coverage 等）绝不入摘要（TC-S4-02）；
 *   - 确定性：同输入两次输出完全一致（排序固定、allowlist 顺序固定，TC-S4-03）；
 *   - 预算：摘要合计 ≤ budget（默认 CHAT_CTX_DIGEST_BUDGET_CHARS 的摘要子预算，默认 4000），单文件片段 ≤ fileCap
 *     （默认 CHAT_CTX_FILE_CAP_CHARS=4000），截断处带「已截断」标记（AC-R4-1 / TC-S4-04/05）；
 *   - 只读纪律：仅 node:fs 读（无 child_process/spawn，TC-S4-07）；UTF-8 解码失败即跳过该文件（不崩）；
 *   - 边界：目录不存在/空目录/不可读 → 不抛，返回空 text + reason（TC-S4-06，S5 降级占位消费）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pluginConfig } from './config.js'

/** 顶层结构噪声（首层目录/文件名命中即跳过；allowlist 命中不受此影响）。 */
const NOISE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.legion-worktrees', '.turbo', 'coverage', 'out', '.next', '.cache', '.idea', '.vscode'])

/** allowlist 关键文件（仓库根相对路径；存在即读、固定顺序；单文件 ≤ fileCap）。 */
export const DEFAULT_ALLOWLIST = ['README.md', 'README.zh.md', 'LEGION.md', 'AGENTS.md', 'docs/FEATURES.md', 'PLUGINS.md', 'package.json', 'COMMAND.md']

/** 单文件片段上限默认值（P3-4：统一配置引擎解析 env CHAT_CTX_FILE_CAP_CHARS，默认 4000）。 */
export function defaultFileCap(): number {
  return pluginConfig.chatCtxFileCapChars
}

/** 摘要子预算默认值（P3-4：env CHAT_CTX_DIGEST_BUDGET_CHARS，默认 4000；整次回复总预算见 S6 分配）。 */
export function defaultDigestBudget(): number {
  return pluginConfig.chatCtxDigestBudgetChars
}

export interface ScopeMeta {
  name?: string
  id?: string
  localDir?: string
  remoteUrl?: string
}

export interface SpaceDigestOptions {
  /** 空间绑定本地仓库目录（无绑定/不可读 → 返回空 text + reason）。 */
  dir: string
  /** 摘要合计预算（默认 defaultDigestBudget）。 */
  budget?: number
  /** 单文件片段上限（默认 defaultFileCap）。 */
  fileCap?: number
  /** 空间元数据（可选，存在则生成元数据块）。 */
  meta?: ScopeMeta
  /** allowlist 覆盖（默认 DEFAULT_ALLOWLIST）。 */
  allowlist?: string[]
}

export interface SpaceDigestResult {
  text: string
  truncated: boolean
  /** 实际读取成功的 allowlist 相对路径清单。 */
  sources: string[]
  /** 空摘要时的原因（目录不存在/不可读等；无则省略）。 */
  reason?: string
}

/** UTF-8 fatal 校验；失败 → null（该文件跳过）。 */
function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}

/** 顶层结构文本：目录在前、文件在后，各按 localeCompare 稳定排序；最多展示前 120 条。 */
function structureBlock(dir: string): { text: string; truncated: boolean } {
  let entries: string[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }))
      .filter((e) => !NOISE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
      .map((e) => (e.isDir ? e.name + '/' : e.name))
  } catch {
    return { text: '', truncated: false }
  }
  const cap = 120
  const truncated = entries.length > cap
  const shown = entries.slice(0, cap)
  const text = shown.length > 0 ? shown.join('，') + (truncated ? '（结构过多，已截断）' : '') : '（无内容）'
  return { text, truncated }
}

/** 主入口：确定性只读摘要。 */
export function buildSpaceDigest(opts: SpaceDigestOptions): SpaceDigestResult {
  const dir = typeof opts?.dir === 'string' ? opts.dir.trim() : ''
  const budget = Number.isFinite(opts?.budget) ? Number(opts.budget) : defaultDigestBudget()
  const fileCap = Number.isFinite(opts?.fileCap) ? Number(opts.fileCap) : defaultFileCap()
  const allowlist = Array.isArray(opts?.allowlist) ? opts.allowlist.filter((p) => typeof p === 'string' && p.trim().length > 0) : DEFAULT_ALLOWLIST
  if (dir.length === 0 || !existsSync(dir)) {
    return { text: '', truncated: false, sources: [], reason: `空间目录不可读：${dir || '（未绑定）'}` }
  }
  let stat
  try { stat = readdirSync(dir) } catch {
    return { text: '', truncated: false, sources: [], reason: `空间目录不可读：${dir}` }
  }
  void stat

  // (a) 空间元数据块（有则加，键序固定保证确定性）
  const metaLines: string[] = []
  if (opts?.meta && typeof opts.meta === 'object') {
    const m = opts.meta as ScopeMeta
    if (typeof m.name === 'string' && m.name.length > 0) metaLines.push('名称：' + m.name)
    if (typeof m.id === 'string' && m.id.length > 0) metaLines.push('id：' + m.id)
    if (typeof m.remoteUrl === 'string' && m.remoteUrl.length > 0) metaLines.push('远程仓库：' + m.remoteUrl)
    if (typeof m.localDir === 'string' && m.localDir.length > 0) metaLines.push('本地目录：' + m.localDir)
  }

  // (b) 顶层结构
  const struct = structureBlock(dir)

  // (c) allowlist 文件内容（存在即读；单文件 UTF-8 失败/超长按规则跳过或截断）
  const sources: string[] = []
  const fileBlocks: string[] = []
  let anyFail = false
  for (const rel of allowlist) {
    const abs = join(dir, rel)
    if (!existsSync(abs)) continue
    let raw: Buffer
    try { raw = readFileSync(abs) } catch { continue }
    const text = decodeUtf8(raw)
    if (text === null) continue // 二进制/非 UTF-8 → 跳过该文件
    const head = '—— ' + rel + ' ——\n'
    const limited = text.length > fileCap ? text.slice(0, fileCap) + '…（文件过长已截断）' : text
    fileBlocks.push(head + limited)
    sources.push(rel)
    if (text.length > fileCap) anyFail = true
  }

  // 组装 + 预算截断（确定性顺序：元数据 → 顶层结构 → 关键文件）
  const chunks: string[] = []
  if (metaLines.length > 0) chunks.push('【空间信息】' + metaLines.join('；'))
  chunks.push('【顶层结构】' + struct.text)
  if (fileBlocks.length > 0) chunks.push('【关键文件】\n' + fileBlocks.join('\n\n'))
  let text = chunks.join('\n')
  let truncated = struct.truncated || anyFail
  if (text.length > budget) {
    truncated = true
    const marker = '…（已截断）'
    const keep = Math.max(0, budget - marker.length)
    text = (keep > 0 ? text.slice(0, keep) : '') + marker
  }
  return { text, truncated, sources: sources, ...(text.length === 0 ? { reason: '（空间无内容）' } : {}) }
}

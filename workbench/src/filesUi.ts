/**
 * 文件中心增强（P2-7）的**纯判定层**：不碰 DOM、不碰网络，只做决策与文案。
 *
 * 为什么单独成模块：这些判定（冲突策略、分片切分与续传、git 标记映射、diff 分类、批量结果汇总）
 * 是本轮最容易出错、也最该被钉住的部分，抽出来后可用 `node --test --experimental-strip-types` 直接断言，
 * 无需引入 jsdom/react 渲染设施。组件只负责把返回值渲染出去（**每个导出都有生产调用点**，
 * 不做「测试绿但线上未用」的假接线）。
 *
 * 服务端为权威：策略名、冲突决策、上传会话与 git 数据都来自 serve.mjs；此处只镜像其契约。
 */
import type { GitFileStatus, GitStatusResponse, UploadStrategy } from './api'

// ───────────────────────── ① 上传冲突策略 ─────────────────────────

/** 与服务端 UPLOAD_STRATEGIES 一致（顺序即选择器展示顺序）。 */
export const UPLOAD_STRATEGIES: readonly UploadStrategy[] = ['ask', 'overwrite', 'skip', 'rename']

export const STRATEGY_LABELS: Record<UploadStrategy, string> = {
  ask: '每次询问（默认）',
  overwrite: '覆盖同名文件',
  skip: '跳过同名文件',
  rename: '自动改名（-1/-2）',
}

/** 策略中文名（选择器与提示统一用它，避免两处文案漂移）。 */
export function strategyLabel(s: UploadStrategy): string {
  return STRATEGY_LABELS[s] ?? s
}

/** 校验持久化的策略值（localStorage 可能被改坏）→ 非法一律回落 ask。 */
export function normalizeStrategy(raw: unknown): UploadStrategy {
  return typeof raw === 'string' && (UPLOAD_STRATEGIES as readonly string[]).includes(raw) ? raw as UploadStrategy : 'ask'
}

/** 策略记忆读写（storage 注入以便单测；不可用时静默降级为 ask，不抛错）。 */
export const STRATEGY_STORAGE_KEY = 'dsh.files.uploadStrategy'

export interface StrategyStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function readStoredStrategy(store: StrategyStore | null | undefined): UploadStrategy {
  try {
    return normalizeStrategy(store?.getItem(STRATEGY_STORAGE_KEY) ?? null)
  } catch {
    return 'ask' // 隐私模式/配额异常：降级而非崩界面
  }
}

export function writeStoredStrategy(store: StrategyStore | null | undefined, s: UploadStrategy): void {
  try {
    store?.setItem(STRATEGY_STORAGE_KEY, s)
  } catch {
    /* 写失败不影响本次上传 */
  }
}

/** 上传结果提示：区分 落盘 / 跳过 / 改名 / 覆盖（服务端回传实际落盘名）。 */
export function uploadResultText(name: string, res: { skipped?: boolean; file?: { name: string }; strategy?: UploadStrategy }): string {
  const finalName = res.file?.name ?? name
  if (res.skipped) return `已跳过（同名已存在）：${name}`
  if (finalName !== name) return `已改名上传：${name} → ${finalName}`
  if (res.strategy === 'overwrite') return `已覆盖：${finalName}`
  return `已上传：${finalName}`
}

/** ask 策略遇到 409 时的询问文案（前端确认后以明确策略重试）。 */
export function conflictPrompt(name: string): string {
  return `文件「${name}」已存在。\n\n确定 = 覆盖　取消 = 跳过此次（原文件保持不变）`
}

// ───────────────────────── ② 分片上传与断点续传 ─────────────────────────

/** 超过该大小走分片上传（更小的一次 PUT 更省事；服务端单次上限仍为 64MB）。 */
export const CHUNK_THRESHOLD_BYTES = 8 * 1024 * 1024
/** 无服务端建议分片大小时的兜底（serve.mjs 默认 4MB）。 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

export function shouldUseChunked(size: number, threshold = CHUNK_THRESHOLD_BYTES): boolean {
  return Number.isFinite(size) && size > threshold
}

/**
 * 下一片切分：返回 null 表示已传完。`received` 必须等于服务端已收字节（顺序语义），
 * 因此本函数以「当前已收」为唯一输入，天然支持断点续传（算出的片可直接发）。
 * chunkSize 只在**不可用**（非正数/NaN）时回落默认值——不静默忽略调用方传入的合法值。
 */
export function nextChunk(received: number, total: number, chunkSize = DEFAULT_CHUNK_SIZE): { offset: number; length: number } | null {
  if (!Number.isFinite(received) || !Number.isFinite(total)) return null
  if (received >= total) return null
  const size = Number.isFinite(chunkSize) && chunkSize >= 1 ? Math.floor(chunkSize) : DEFAULT_CHUNK_SIZE
  return { offset: received, length: Math.min(size, total - received) }
}

/** 片数（仅用于展示「共 N 片」）。 */
export function chunkCount(total: number, chunkSize = DEFAULT_CHUNK_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 0
  const size = Number.isFinite(chunkSize) && chunkSize >= 1 ? Math.floor(chunkSize) : DEFAULT_CHUNK_SIZE
  return Math.ceil(total / size)
}

/** 进度百分比（0..100，整数；非法输入按 0 处理，避免 NaN 宽度）。 */
export function uploadPercent(received: number, total: number): number {
  if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)))
}

/** 人类可读字节数（B/KB/MB/GB，保留一位小数）。 */
export function sizeText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** 上传进度文案：续传时必须显式说明「从 X% 继续」，否则用户会以为要重传整个文件。 */
export function uploadProgressText(received: number, total: number): string {
  const pct = uploadPercent(received, total)
  const head = received > 0 ? `续传中 ${pct}%` : `上传中 ${pct}%`
  return `${head}（${sizeText(received)} / ${sizeText(total)}）`
}

// ───────────────────────── ③ 搜索与批量 ─────────────────────────

/** 搜索命中高亮切分：按查询串（大小写不敏感）把名称切成 [命中/未命中] 片段，供逐段渲染。 */
export function splitHighlight(name: string, query: string): Array<{ text: string; hit: boolean }> {
  const q = query.trim()
  if (q.length === 0 || name.length === 0) return [{ text: name, hit: false }]
  const hay = name.toLowerCase()
  const needle = q.toLowerCase()
  const out: Array<{ text: string; hit: boolean }> = []
  let i = 0
  for (;;) {
    const at = hay.indexOf(needle, i)
    if (at < 0) break
    if (at > i) out.push({ text: name.slice(i, at), hit: false })
    out.push({ text: name.slice(at, at + needle.length), hit: true })
    i = at + needle.length
  }
  if (i < name.length) out.push({ text: name.slice(i), hit: false })
  return out.length > 0 ? out : [{ text: name, hit: false }]
}

/** 结果截断提示（不静默丢结果）。 */
export function searchSummary(count: number, truncated: boolean, recursive: boolean): string {
  const scopeText = recursive ? '（含子目录）' : '（仅当前目录）'
  if (count === 0) return `无匹配${scopeText}`
  return `命中 ${count} 项${scopeText}${truncated ? ' · 已达上限，请缩小关键词或目录范围' : ''}`
}

export interface BatchResult { okCount: number; failed: number; items: Array<{ path: string; ok: boolean; error?: string; to?: string }> }

/** 批量结果汇总：成功/失败计数 + 首条失败原因（逐项成败是服务端契约，汇总只做展示）。 */
export function batchResultText(res: BatchResult): string {
  const firstFail = res.items.find(i => !i.ok)
  const head = `成功 ${res.okCount} 项，失败 ${res.failed} 项`
  if (res.failed === 0) return head
  return `${head}：${firstFail?.path ?? '?'}（${firstFail?.error ?? '未知原因'}）`
}

/** 批量操作的确认文案（删除必须显式说不可撤销）。 */
export function batchConfirmText(action: 'delete' | 'move', count: number, toDir?: string): string {
  if (action === 'delete') return `将永久删除 ${count} 项（不可撤销，需 confirm=yes 二次确认）。确定继续？`
  return `将把 ${count} 项移动到「${toDir ?? ''}」。同名冲突的项会失败并保留原文件。确定继续？`
}

/** 移动目标目录输入校验（前端先挡明显错误，服务端仍会再校验一次）。 */
export function normalizeMoveTarget(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (v.length === 0) return { ok: false, error: '请输入目标目录（相对空间根，如 archive/2026）' }
  if (/^[a-zA-Z]:/.test(v)) return { ok: false, error: '必须是相对路径（不能是盘符路径）' }
  if (v.split('/').includes('..')) return { ok: false, error: '不能包含 ..（禁止越出空间根）' }
  return { ok: true, value: v }
}

/** 勾选集合辅助（返回新 Set，避免就地修改引发的漏渲染）。 */
export function toggleInSet(set: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) next.add(key)
  else next.delete(key)
  return next
}

export function allSelected(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(p => p.length > 0)
}

// ───────────────────────── ④ git 只读展示 ─────────────────────────

/** 把 scope 根与仓库根都归一成小写、正斜杠、无尾斜杠，便于前缀比较（Windows 盘符大小写不敏感）。 */
function norm(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 仓库根相对空间根的**前缀**：git 状态里的 path 是「仓库根相对」，而文件列表条目是「空间根相对」，
 * 只有加上这段前缀才能正确对上（空间根是仓库子目录时尤其如此）。返回 '' 表示二者同一层。
 */
export function repoPrefixOf(scopeRoot: string, repoRoot: string): string {
  const s = norm(scopeRoot)
  const r = norm(repoRoot)
  if (s.length === 0 || r.length === 0) return ''
  if (s === r) return ''
  if (s.startsWith(r + '/')) return s.slice(r.length + 1)
  if (r.startsWith(s + '/')) return '' // 仓库根在空间根之下：条目路径本就相对空间根，前缀为空
  return '' // 无关路径：不做映射（避免误标）
}

/** 目录条目 → git 标记（无标记返回 null）。 */
export function gitMarkerFor(entryPath: string, repoPrefix: string, files: readonly GitFileStatus[] | undefined): GitFileStatus | null {
  if (!files || files.length === 0) return null
  const full = repoPrefix.length > 0 ? `${repoPrefix}/${entryPath}` : entryPath
  return files.find(f => norm(f.path) === norm(full)) ?? null
}

export interface GitMarkerView { code: string; label: string; tone: 'add' | 'mod' | 'del' | 'new' | 'conflict'; title: string }

/** 标记视图：区分已暂存/未暂存/未跟踪/冲突（title 给出 git 原始两位状态，便于排查）。 */
export function gitMarkerView(f: GitFileStatus): GitMarkerView {
  const raw = `git status: "${f.index}${f.worktree}"`
  if (f.conflicted) return { code: 'U', label: '冲突', tone: 'conflict', title: `${raw} 合并冲突，需人工解决` }
  if (f.untracked) return { code: '??', label: '新', tone: 'new', title: `${raw} 未跟踪（尚未纳入版本控制）` }
  const code = f.code
  if (code === 'A') return { code: 'A', label: '新增', tone: 'add', title: `${raw} 已暂存的新增` }
  if (code === 'D') return { code: 'D', label: '删除', tone: 'del', title: `${raw} 已删除${f.staged ? '（已暂存）' : '（未暂存）'}` }
  if (code === 'R') return { code: 'R', label: '改名', tone: 'mod', title: `${raw} ${f.from ?? ''} → ${f.path}` }
  // M 及少见码（T 等）：按修改呈现，但把暂存与否写进 title
  return {
    code: code === 'M' ? 'M' : code,
    label: '改动',
    tone: 'mod',
    title: `${raw} 已修改${f.staged && f.worktree !== ' ' ? '（暂存区与工作区都有改动）' : (f.staged ? '（已暂存，未提交）' : '（未暂存）')}`,
  }
}

/** 仓库头部文案：分支 + 领先/落后 + 改动汇总。 */
export function gitHeadText(st: Pick<GitStatusResponse, 'branch' | 'ahead' | 'behind' | 'summary' | 'total'>): string {
  const parts: string[] = []
  parts.push(`分支 ${st.branch ?? '(detached)'}`)
  if (typeof st.ahead === 'number' && st.ahead > 0) parts.push(`↑${st.ahead}`)
  if (typeof st.behind === 'number' && st.behind > 0) parts.push(`↓${st.behind}`)
  const s = st.summary
  if (s) {
    const bits: string[] = []
    if (s.staged > 0) bits.push(`暂存 ${s.staged}`)
    if (s.unstaged > 0) bits.push(`未暂存 ${s.unstaged}`)
    if (s.untracked > 0) bits.push(`未跟踪 ${s.untracked}`)
    if (s.conflicted > 0) bits.push(`冲突 ${s.conflicted}`)
    parts.push(bits.length > 0 ? bits.join(' · ') : '工作区干净')
  }
  return parts.join('　')
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx'

/** unified diff 逐行分类（渲染只做颜色/前缀映射，不解析语义）。 */
export function diffLines(diff: string): Array<{ kind: DiffLineKind; text: string }> {
  const raw = String(diff ?? '')
  if (raw.length === 0) return []
  return raw.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('Binary files ')) {
      return { kind: 'meta' as const, text: line }
    }
    if (line.startsWith('@@')) return { kind: 'hunk' as const, text: line }
    if (line.startsWith('+')) return { kind: 'add' as const, text: line }
    if (line.startsWith('-')) return { kind: 'del' as const, text: line }
    return { kind: 'ctx' as const, text: line }
  })
}

/** diff 统计（+N/-M；仅统计内容行，不计 +++/--- 头）。 */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const { kind } of diffLines(diff)) {
    if (kind === 'add') added += 1
    else if (kind === 'del') removed += 1
  }
  return { added, removed }
}

/** diff 头文案：把「无差异 / 二进制 / 截断 / 未跟踪」如实说出来，不显示空白面板让人猜。 */
export function diffHeadText(res: { diff?: string; binary?: boolean; truncated?: boolean; note?: string | null; staged?: boolean }): string {
  const stat = diffStat(res.diff ?? '')
  const stage = res.staged ? '已暂存 vs HEAD' : '工作区 vs 索引'
  if (res.binary) return `二进制文件 · ${stage}（不展示逐行差异）`
  if ((res.diff ?? '').length === 0) return res.note ?? `无差异（${stage}）`
  const cut = res.truncated ? ' · 内容已截断' : ''
  return `${stage} · +${stat.added} / −${stat.removed}${cut}`
}

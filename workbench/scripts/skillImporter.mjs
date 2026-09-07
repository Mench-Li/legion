/**
 * 技能导入器（技能仓库安装）：目录扫描 / GitHub tarball 拉取 → 生成技能 bundle 候选。
 * 纯函数 + 只读 fs，供 workbench serve.mjs 端点复用，并可直接 node --test 单测。
 *
 * 技能识别约定（官方技能包形态）：一个「技能」= 包含 SKILL.md 的文件夹。
 *   SKILL.md        → 主提示 main（必须）
 *   config.yaml     → 配置 config（可选；顺带解析 name/description 元信息）
 *   scripts/*       → 脚本 scripts[]（文件名→name，内容→content）
 *   cases/ examples/* → 案例 cases[]（文件名→name，内容→content）
 *
 * 安全：仅做「根内扫描」（扫描根由 serve.mjs 的 resolveInsideRoot 保证在空间工作区内）；
 *       跳过 .git 与隐藏目录；单文件内容上限防超大文件撑爆内存。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, extname } from 'node:path'
import { createHash } from 'node:crypto'

/** 单部件（脚本/案例）文件内容上限（字节）——防超大/二进制撑爆注入上下文。 */
export const PART_FILE_MAX = 64 * 1024

/** 二进制扩展名黑名单（案例/脚本读取时跳过，不入 skill 包）。 */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.bin', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.sqlite', '.db', '.jar', '.class', '.pyc', '.map'])

/** 目录名 → 合法技能 id（^[a-z0-9][a-z0-9-]{0,63}$）；纯中文名残留过短时用确定性哈希兜底。 */
export function sanitizeSkillId(name) {
  let s = String(name ?? '').trim().toLowerCase()
  s = s.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length === 0) return 'skill-' + createHash('sha1').update(String(name ?? '')).digest('hex').slice(0, 8)
  if (!/^[a-z0-9]/.test(s)) s = 'skill-' + s
  s = s.slice(0, 64)
  if (s.length < 3) s = 'skill-' + createHash('sha1').update(String(name ?? '')).digest('hex').slice(0, 8)
  return s
}

/** 目录名 → 人类可读名称（kebab → 空格；保留中文）。 */
export function humanizeName(id) {
  return String(id ?? '').replace(/-+/g, ' ')
}

/** 极简 YAML 顶层键值解析（仅 name/description，单行 `key: value`），非完整 YAML。 */
export function parseYamlMeta(text) {
  const out = {}
  if (!text) return out
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/.exec(line)
    if (m && (m[1] === 'name' || m[1] === 'description')) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** 读取一个子目录下的所有普通文件为部件 [{name, content}]；跳过隐藏/.git/二进制/超限。 */
function readPartFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  let names
  try { names = readdirSync(dir) } catch { return [] }
  for (const n of names) {
    if (n.startsWith('.')) continue
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isFile()) continue
    if (st.size > PART_FILE_MAX) continue
    const ext = extname(n).toLowerCase()
    if (BINARY_EXT.has(ext)) continue
    try { out.push({ name: n, content: readFileSync(p, 'utf8') }) } catch { /* 跳过不可读 */ }
  }
  return out
}

/** 读取一个技能文件夹 → 候选 bundle（无 SKILL.md 返回 null）。 */
export function readSkillDir(dir) {
  const skillMd = join(dir, 'SKILL.md')
  if (!existsSync(skillMd) || !statSync(skillMd).isFile()) return null
  const id = sanitizeSkillId(basename(dir))
  const configPath = join(dir, 'config.yaml')
  const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const meta = parseYamlMeta(config)
  const main = readFileSync(skillMd, 'utf8')
  return {
    id,
    name: meta.name || humanizeName(id),
    description: meta.description || '',
    main,
    config,
    scripts: readPartFiles(join(dir, 'scripts')),
    cases: [...readPartFiles(join(dir, 'cases')), ...readPartFiles(join(dir, 'examples'))],
    sourceDir: dir,
  }
}

/** 扫描根目录：根自身若为技能 + 每个直接子目录（含 SKILL.md）为一枚技能。 */
export function scanSkillDirs(rootDir) {
  const out = []
  if (!existsSync(rootDir)) return out
  const rootSelf = readSkillDir(rootDir)
  if (rootSelf) out.push(rootSelf)
  let names
  try { names = readdirSync(rootDir) } catch { return out }
  for (const n of names) {
    if (n.startsWith('.')) continue
    if (n.toLowerCase() === '.git') continue
    const p = join(rootDir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    const s = readSkillDir(p)
    if (s) out.push(s)
  }
  return out
}

const GH_HOSTS = new Set(['github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'api.github.com'])

/**
 * GitHub 仓库 URL → codeload tarball 下载 URL（受控拉取）。仅放行 GitHub 生态域名，
 * 拒绝其它主机 / 非 https / 带凭证。支持：
 *   https://github.com/<owner>/<repo>
 *   https://github.com/<owner>/<repo>/tree/<branch>
 *   https://codeload.github.com/<owner>/<repo>/tar.gz/...（原样回传）
 */
export function buildGithubTarballUrl(input, branchOverride) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('请填写 GitHub 仓库 URL')
  let u
  try { u = new URL(raw) } catch { throw new Error('GitHub URL 无法解析') }
  if (u.protocol !== 'https:') throw new Error('仅支持 https 的 GitHub 仓库地址')
  if (u.username || u.password) throw new Error('仓库地址不能包含凭证')
  const host = u.hostname.toLowerCase()
  if (!GH_HOSTS.has(host)) throw new Error('仅允许从 GitHub 官方域名安装（github.com）')
  const segs = u.pathname.split('/').filter(Boolean)
  if (host === 'codeload.github.com') return raw // 已是归档地址，原样用于下载
  if (host === 'raw.githubusercontent.com' || host === 'api.github.com') throw new Error('请提供仓库主页地址（如 https://github.com/owner/repo），而非 raw/API 地址')
  if (segs.length < 2) throw new Error('仓库 URL 不完整：需要 https://github.com/<owner>/<repo>')
  const [owner, repo] = segs
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error('仓库所有者/名称含非法字符')
  // 仅接受仓库主页或 /tree/<分支>；blob/commits 等文件/提交地址无法映射为仓库归档，拒绝。
  if (segs.length > 2 && segs[2] !== 'tree') throw new Error('请提供仓库主页地址（如 https://github.com/owner/repo 或 /tree/<分支>）')
  const urlBranch = segs[2] === 'tree' ? (segs[3] || 'HEAD') : 'HEAD'
  const branch = (branchOverride && /^[\w.-]+$/.test(branchOverride)) ? branchOverride : urlBranch
  // codeload：默认分支用 tar.gz/HEAD（特殊 ref）；具体分支用 tar.gz/refs/heads/<branch>（支持带 / 的分支名）。
  if (!branch || branch === 'HEAD') return `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`
}

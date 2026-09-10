// sync.mjs — 把根配置引擎同步到白板的本地副本（P3-2）
//
// 为什么需要副本：白板是独立可部署子项目，Dockerfile 的构建上下文是 whiteboard/
//（只 COPY packages/apps/scripts），因此它**不能** import 仓库根的 packages/shared。
// 为了不出现「两份实现」（脱敏逻辑分叉会导致摘要泄漏 token），采用「单一实现 + 同步副本」：
//   · 根 packages/shared/src/config.mjs 是唯一实现
//   · whiteboard/packages/shared/src/config.mjs 是同步副本
//   · `node scripts/config/sync.mjs --check`（CI 调用）在两者不一致时失败
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
export const SOURCE = join(ROOT, 'packages', 'shared', 'src', 'config.mjs')
export const TARGET = join(ROOT, 'whiteboard', 'packages', 'shared', 'src', 'config.mjs')

/** 副本头部说明（逐行固定，剥离时按行精确去掉，避免与根文件自身的顶部注释混淆） */
export const HEADER_LINES = [
  '// ⚠️ 本文件是同步副本，请勿直接编辑。',
  '// 唯一实现：packages/shared/src/config.mjs',
  '// 同步命令：node scripts/config/sync.mjs        校验：node scripts/config/sync.mjs --check',
  '// ---- 以下内容与根实现逐字节一致 ----',
]
const HEADER = HEADER_LINES.join('\n') + '\n'

/** 换行归一化：本仓库在 Windows 上 `core.autocrlf` 会把检出文件转成 CRLF
 *（git 会提示 "LF will be replaced by CRLF"），因此比对必须归一化换行，
 *  否则「工作树通过、主检出失败」这种环境相关失败会反复出现。 */
export const normalizeEol = (text) => text.replace(/\r\n/g, '\n')

export function readPair() {
  const source = existsSync(SOURCE) ? readFileSync(SOURCE, 'utf8') : null
  const targetRaw = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null
  const target = targetRaw === null ? null : stripHeader(targetRaw)
  return { source, target, targetRaw }
}

/** 精确剥离同步头部（去掉固定行数的头，保留根文件自身的顶部注释）；CRLF 已归一化 */
export function stripHeader(text) {
  const lines = normalizeEol(text).split('\n')
  for (const [i, h] of HEADER_LINES.entries()) {
    if (lines[i] !== h) throw new Error(`副本头部第 ${i + 1} 行不符合预期：${JSON.stringify(lines[i])}`)
  }
  return lines.slice(HEADER_LINES.length).join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const source = existsSync(SOURCE) ? readFileSync(SOURCE, 'utf8') : null
  if (source === null) {
    console.error('sync: FAIL —— 找不到根实现 packages/shared/src/config.mjs')
    process.exit(1)
  }
  if (check) {
    // 校验路径才需要读副本；写入路径不读副本（避免旧头部格式导致失败）
    const { target } = readPair()
    if (target === null) {
      console.error('sync: FAIL —— 白板副本不存在：whiteboard/packages/shared/src/config.mjs')
      process.exit(1)
    }
    if (target !== normalizeEol(source)) {
      console.error('sync: FAIL —— 白板副本与根实现不一致（运行 node scripts/config/sync.mjs 后重试）')
      process.exit(1)
    }
    console.log('sync: PASS（白板副本与根实现一致）')
    return
  }
  mkdirSync(dirname(TARGET), { recursive: true })
  writeFileSync(TARGET, HEADER + source)
  console.log(`sync: 已写入 ${TARGET.replace(ROOT, '.').replace(/\\/g, '/')}（${source.length} 字节）`)
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/config/sync.mjs')
if (isMain) main()

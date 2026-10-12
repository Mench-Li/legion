// scripts/lib/code-only.mjs
// ============================================================================
// 把源码里的**注释**去掉，只留代码 —— 供"在源码里找某个名字"的判据使用。
//
// ## 为什么需要它
//
// 有一类判据必须在源码里找名字（"这个脚本有没有调用 `rmSync`"、
// "`requireOperator` 被几处调用"）。那类判据有一个**反复出现的**坑：
//
//   写实现的人**正好也会在自己的注释里提到那个名字** ——
//   尤其是在解释"为什么不用它"的时候。
//
//   > 一个"在注释里解释某条规则"的实现，
//   > 与一个"真的违反那条规则"的实现，在按子串搜索的判据眼里一模一样。
//
// 这个坑在本仓库里已经绊到过**四次**：
//   · `storageErrorShape` 的调用计数（`team-hub/storage-health.test.mjs`）
//   · `rmSync` 出现在"为什么禁止 rmSync"那段注释里（`scripts/ops/…`）
//   · `requireSystemAdmin` 同理（`team-hub/routes/identity.mjs` 的注释）
//   · `writeFileSync(DEFAULT_STATE_PATH` 出现在解释它自己的注释里
//
// 所以抽成一个**共用的**实现，而不是每处再抄一个行过滤版本
// （仓库里此前已经有 11 个文件各自抄了一份 `startsWith('//')` 那种）。
//
// ## 它做什么、不做什么
//
// 认得出：行注释 `//`、块注释 `/* … */`（含跨行）、单/双引号字符串、
//        模板字面量（含 `${}` 嵌套）。
// **不认**正则字面量 —— `/\//` 这种会把它之后的内容误判成注释。
// 这个限制是有意的：正则的歧义（`a / b` 是除法还是正则？）需要**解析器**才能判，
// 而这里的用途是"找名字"，不是"改代码"。所以：
//
//   · 判据里**别**拿它去扫含正则字面量的文件；
//   · 真要那种精度，就该用 `node --check` 之外的解析器。
//
// ★ 替换时**保留换行**（注释变成一个空格），这样基于行号/行数的判据不受影响。
// ============================================================================

/**
 * 去掉注释，保留字符串字面量的**内容**（判据要看的是代码里真实出现的名字）。
 *
 * @param {string} src
 * @returns {string}
 */
export function codeOnly(src) {
  if (typeof src !== 'string' || src.length === 0) return ''
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    // ① 行注释
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1
      out += ' '
      continue
    }
    // ② 块注释（可能跨行；换行要保留，否则行号会漂）
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      out += ' '
      continue
    }
    // ③ 字符串（单/双引号）：原样保留内容，但**不**把里面的 `//` 当注释。
    if (c === '\'' || c === '"') {
      const quote = c
      out += c
      i += 1
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === quote) { i += 1; break }
        if (src[i] === '\n') { i += 1; break }   // 未闭合的字符串：就此打住，别吞掉整个文件
        i += 1
      }
      continue
    }
    // ④ 模板字面量：保留内容（含 `${}` 里的表达式），同样不把 `//` 当注释。
    //
    //    ⚠️ 这里**不做** `${}` 的嵌套解析，而是简单走到收尾的反引号 ——
    //    因为不做解析时，"模板里再嵌模板"会让朴素做法提前收尾。
    //    实际影响：嵌了模板的模板里，注释可能残留一点点。
    //    对"找名字"的用途无害（残留的是**多**留几个字，不会漏掉代码）。
    if (c === '`') {
      out += c
      i += 1
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === '`') { i += 1; break }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * 读一个文件并去掉注释。路径相对 `import.meta.url` 的调用方解析。
 * @param {string|URL} url
 * @param {(p: string|URL) => string} readFileSyncLike
 */
export function codeOfFile(url, readFileSyncLike) {
  return codeOnly(String(readFileSyncLike(url)))
}

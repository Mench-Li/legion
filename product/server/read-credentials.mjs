// product/server/read-credentials.mjs
// ============================================================================
// 读凭据：**纯 JSON 优先**，纯文本兜底，两者都做同一组断言。
//
// ## 为什么 JSON 优先
//
// 实测踩过：用户把口令写在 `新口令：<口令>` 这一行里，而那行在冒号后带了
// **两个不可见字符**。我按行解析，于是把口令读成了「2 个不可见字符 + 真口令」，
// 表现为"口令不正确"，而用户看到的是一串莫名其妙的方块。
//
//   > 一个"人写的文件按行解析"的取值方式，与一个"值旁边多了空白也算值"的
//   > 取值方式，是同一个东西——只不过前者把责任推给了用户。
//
// JSON 把这个歧义**从根上消掉**：`JSON.parse` 给出的值是精确的，
// 它不猜"空白算不算内容"——JSON 里字符串就是引号之间的全部字节。
//
// ## 为什么仍然接受纯文本
//
// 服务器自己写的口令文件（`rebootstrap.sh` 用 `printf '%s\n'` 落盘）
// 是**机器写的**，不存在歧义，没必要改成 JSON。
// 所以两种都收，但对**两者**做同一组断言：可打印 ASCII、无首尾空白。
// 断言不是为了限制用户用什么口令（那会在下一层被拒），
// 而是为了让"取到的值不是我以为的那个"当场可见，而不是十分钟后表现为
// "口令不正确"。
// ============================================================================
import { readFileSync } from 'node:fs'

export const CRED_ERRORS = Object.freeze({
  NOT_FOUND: 'CREDENTIALS_NOT_FOUND',
  BAD_JSON: 'CREDENTIALS_BAD_JSON',
  MISSING_PASSWORD: 'CREDENTIALS_MISSING_PASSWORD',
  UNPRINTABLE: 'CREDENTIALS_UNPRINTABLE',
  SURROUNDING_WHITESPACE: 'CREDENTIALS_SURROUNDING_WHITESPACE',
})

export class CredentialsError extends Error {
  constructor(code, message) { super(message); this.name = 'CredentialsError'; this.code = code }
}

const assertClean = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CredentialsError(CRED_ERRORS.MISSING_PASSWORD, `${label} 为空`)
  }
  // ★ **先查首尾空白，再查不可打印字符** —— 顺序是有用的，不是随意的。
  //
  // 制表符同时属于两类（它是空白，也是控制字符）。先报"首尾有空白"
  // 比先报"含控制字符"更有用：前者直接指出**东西在边上**，
  // 而后者要人自己去找它在哪。
  // 判据的分界也很干净：`trim()` 能去掉的就是空白（在边上），去不掉的就是值本身带的。
  if (value !== value.trim()) {
    throw new CredentialsError(CRED_ERRORS.SURROUNDING_WHITESPACE,
      `${label} 首尾有空白（中间的空格不算——那是内容）——这是一个**取值错误**的` +
      '典型症状，不是口令本身的问题：首尾空白在口令框里看不见')
  }
  // 允许 0x20（空格）：口令中间有空格是**合法**的，把它叫成"不可打印字符"
  // 是一句错话，而错话会让人去改一个本来没问题的口令。
  // 真正要拦的是控制字符（0x00-0x1f）与非 ASCII（>0x7e）——复制粘贴带进来的常客，
  // 而在口令框里它们**不可见**，于是表现为"我打对了呀"。
  const bad = [...value].filter((c) => { const cp = c.codePointAt(0); return cp < 0x20 || cp > 0x7e })
  if (bad.length > 0) {
    throw new CredentialsError(CRED_ERRORS.UNPRINTABLE,
      `${label} 含 ${bad.length} 个不可打印字符（控制字符或非 ASCII）——` +
      '这类字符在口令框里看不见，是"我明明打对了却登不上"的典型成因。' +
      '如果你确实要用非 ASCII 口令，请告诉我，不要绕过这个检查')
  }
  return value
}

/**
 * @param {string} file `.json` 结尾按 JSON 解析，其余按纯文本
 * @returns {{ userName: string|null, password: string }}
 */
export function readCredentials(file) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch {
    throw new CredentialsError(CRED_ERRORS.NOT_FOUND, `凭据文件不存在或读不到：${file}`)
  }
  if (/\.json$/i.test(file)) {
    let parsed
    try { parsed = JSON.parse(raw) } catch (e) {
      // 常见成因：JSON 文件里写了注释（`#` 或 `//`）——JSON 不允许注释。
      // 如实說出来，因为"JSON 里不能写注释"正是本文件存在的理由。
      throw new CredentialsError(CRED_ERRORS.BAD_JSON,
        `${file} 不是合法 JSON：${e.message.split('\n')[0]}。` +
        '（常见成因：文件里写了注释——JSON 不允许注释。人读的说明请另放一个文件。）')
    }
    const password = assertClean(parsed?.password, 'password')
    const userName = typeof parsed?.user_name === 'string' && parsed.user_name.length > 0 ? parsed.user_name : null
    return { userName, password }
  }
  // 纯文本：整份内容去掉结尾换行即是口令。**只去换行**，不去首尾空白——
  // 首尾空白要被下面的断言抓住，而不是被静默抹掉（抹掉就掩盖了取值错误）。
  return { userName: null, password: assertClean(raw.replace(/[\r\n]+$/, ''), '口令文件内容') }
}

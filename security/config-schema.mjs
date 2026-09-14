// security/config-schema.mjs
// ============================================================================
// security（安全面库：凭证引用语法 / ACL / DPAPI / 凭证文档解析）的配置面声明（PRT-254 起）
//
// ## `fields` 是空的，而且是刻意的
//
// 本目录**不读进程环境**，这是它自己的设计约束，不是遗漏：
//   · `security/secrets/index.mjs` 的文件头：「密钥层不得出现任何 DSH 执行面记号，也不读 `process.env`」；
//   · `security/secrets/store.mjs` 的文件头：「**不读 `process.env`**：配置面读取点必须可被
//     `scripts/config/scan.mjs` 扫描」。
//
// 本次重新扫描（git-tracked、排除 `*.test.mjs`）与之一致：8 个源文件、真实 env 读取点 **0** 个。
//
// 于是出现一个真实的两难：`defineSchema` 原本要求**非空 fields**，而"门禁要能扫这个目录"
// 又必须有一份 schema。此时为了凑过校验往里编一个字段，就是让这份声明开始说谎——
// 一个凭空来的环境变量与一个真的存在的环境变量，在 `scan --check` 与 `config check`
// 的输出里长得一模一样，而这份声明的全部价值就是它说的每一句都是真的。
//
// 所以 `defineSchema` 加了一个**显式**开关（`packages/shared/src/config.mjs`）：
// 确实一个 env 键都不读的扫描范围写 `allowEmptyFields: true`；漏写 `fields` 仍然报错。
//
//   > 一个"可以被默认空数组悄悄绕过"的校验，
//   > 与一个"要么给非空 fields、要么明确说自己没有"的校验，区别就在这里。
//
// ## 那为什么还要登记它
//
// 因为它有 59 个"像 env 键的字面量"（`DSH_CREDENTIALS_*` 具名错误码、`SECRET_*` 码、`ENOENT`…）。
// 库目录最容易成为无人检查的角落——它没有入口、没有就绪判据，
// 也就没有一个"该由谁来登记它"的时刻。
//
// `nonEnvLiterals` 由脚本用 `scan.mjs` 自己的 `extractEnvReads` 从源码重新推出（不手抄），
// 每条后面挂着它来自哪个文件。`config.test.mjs` 断言它与扫描结果**逐条相等**。
//
// ## ⚠️ 那处 `env[names[0]]` 动态下标是**假阳性**
//
// `security/secrets/dsh-credentials.mjs:582` 的 `env` 不是进程环境，是**YAML 映射节点**：
// 同文件 470–475 行写着 `env.t !== 'map'` 与 `for (const [name, value] of env.v)`——
// `t` 是节点类型标签、`v` 是节点值。`names` 是 `Object.keys(record.env)`。
//
// 扫描器的动态规则按 `env[` 字面匹配，于是把它报成一处动态访问（而且表达式被截成
// `env[names[0]`：`]` 不在规则允许的字符集 `[^\]'"]` 里）。**既不登记、也不改生产代码去迁就它**：
// 为一个假阳性去改局部变量的名字，等于让扫描器的误报决定代码怎么读。
// 这里如实记下来历，报告里也写明了它是假阳性。
// ============================================================================
import { defineSchema } from '../packages/shared/src/config.mjs'

/** 本库从进程环境读取的键：**一个都没有**（见文件头）。保留导出是为了与其它 schema 同形。 */
export const ENV_NAMES = Object.freeze([])

/** 不是 env 键、但写法上形如 env 键的字面量（具名错误码 / 错误码前缀 / Node 系统错误码）。 */
export const NON_ENV_LITERALS = Object.freeze([
  // ── security/secrets/acl.mjs（7 条）
  'ACL_HARDEN_FAILED', // security/secrets/acl.mjs
  'ACL_NO_RUNNER', // security/secrets/acl.mjs
  'ACL_NOT_CREATED', // security/secrets/acl.mjs
  'ACL_OK', // security/secrets/acl.mjs
  'ACL_TOO_PERMISSIVE', // security/secrets/acl.mjs
  'ACL_UNSUPPORTED_PLATFORM', // security/secrets/acl.mjs
  'ACL_UNVERIFIABLE', // security/secrets/acl.mjs
  // ── security/secrets/dpapi.mjs（4 条）
  'SECRET_DECRYPT_FAILED', // security/secrets/dpapi.mjs 等 3 个文件
  'SECRET_STORE_UNSUPPORTED_PLATFORM', // security/secrets/dpapi.mjs 等 3 个文件
  'SECRET_STORE_WRITE_FAILED', // security/secrets/dpapi.mjs 等 3 个文件
  'SECRET_VALUE_EMPTY', // security/secrets/dpapi.mjs 等 3 个文件
  // ── security/secrets/dsh-credentials.mjs（42 条）
  'DSH_CREDENTIALS_ALIAS', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_ANCHOR', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_API_KEY_VALUE_INVALID', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_BAD_ENTRY', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_BAD_INDENT', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_BAD_VERSION', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_BLOCK_SCALAR', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_DIRECTIVE', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_DOCUMENT_MARKER', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_DUPLICATE_KEY', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_ENV_NAME_INVALID', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_ENV_NOT_MAPPING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_ENV_VALUE_INVALID', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_FLOW_STYLE', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_GRANT_PAYLOAD_MISSING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_INLINE_MAPPING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_MIXED_BLOCK', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_NO_VERSION', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_PAYLOAD_NOT_JSON', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_QUOTED_SCALAR', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_KEY_INVALID', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_NO_KIND', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_NOT_A_STRING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_NOT_MAPPING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_UNKNOWN_FIELD', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_UNKNOWN_KIND', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_RECORD_VALUE_AMBIGUOUS', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_REF_KEY_INVALID', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_REF_VALUE_MISSING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_REF_VALUE_NOT_STRING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_ROOT_IS_SEQUENCE', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_ROOT_NOT_MAPPING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_SECTION_NOT_MAPPING', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_TAB_INDENT', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_TAG', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_TOO_LARGE', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_TRAILING_CONTENT', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_UNKNOWN_TOP_KEY', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_UNREADABLE', // security/secrets/dsh-credentials.mjs
  'DSH_CREDENTIALS_UNSAFE_CHARACTER', // security/secrets/dsh-credentials.mjs
  'ENOENT', // security/secrets/dsh-credentials.mjs
  'SECRET_REF_INVALID', // security/secrets/dsh-credentials.mjs 等 3 个文件
  // ── security/secrets/errors.mjs（2 条）
  'DSH_CREDENTIALS_', // security/secrets/errors.mjs
  'SECRET_UNAVAILABLE', // security/secrets/errors.mjs
  // ── security/secrets/index.d.mts（4 条）
  'SECRET_NOT_FOUND', // security/secrets/index.d.mts、security/secrets/store.mjs
  'SECRET_STORE_CORRUPT', // security/secrets/index.d.mts、security/secrets/store.mjs
  'SECRET_STORE_UNPROTECTED', // security/secrets/index.d.mts、security/secrets/store.mjs
  'SECRET_STORE_UNREADABLE', // security/secrets/index.d.mts、security/secrets/store.mjs
])

export const SCHEMA = defineSchema({
  process: 'security',
  title: '安全面库（`security/`：凭证引用/ACL/DPAPI/凭证文档解析；PRT-254 起纳入扫描）',
  // 显式声明"不读任何 env"：空 fields 不是默认放行的结果，是这个目录的**实测结论**。
  allowEmptyFields: true,
  fields: [],
  nonEnvLiterals: NON_ENV_LITERALS,
  notes: [
    'fields 为空 = 本库**没有**任何进程环境读取点。这不是"还没登记"，是实测结论：8 个源文件、0 个读取点。',
    '本库里的 `env` 指的是**凭证文档里的 `env:` 段**（YAML 映射节点），不是 `process.env`——' +
      '扫描器在 security/secrets/dsh-credentials.mjs:582 报出的那处动态下标是假阳性，来历见文件头。',
    '`security/secrets/errors.mjs` 的 `DSH_CREDENTIALS_` 是错误码的**前缀**（拼码用），不是环境变量名。',
  ],
})

export default SCHEMA

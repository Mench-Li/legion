// runtime/dsh-composition/patch-format.mjs
// ============================================================================
// PRT-214 的第一件事：**让补丁层成为一份 DSH 真的能读的文件**。
//
// ## 为什么需要这个模块
//
// 此前 `render.mjs` 生成的 `legion-host.patch.yml` 长这样：
//
//     patch:                       # ← 顶层是**映射**
//       - id: legion-enforcement-hard-floor
//         insert: after:tools      # ← insert 是一个**字符串** "after:tools"
//         plane: host              # ← plane 不是 PatchOptions 的字段
//     permission:                  # ← 第二个顶层键，补丁文件里没这个地方
//       presets: { ... }
//
// 而 DSH 的 `parsePatchList` 只接受**一个顶层 YAML 数组**，顶层不是数组就抛：
//
//     `${binName}: config ${absoluteConfigPath} must be a top-level YAML array of entries`
//
// 即便顶层换成数组，`applyEntryPatches` 会直接对 `patch.insert` 调
// `.forEach(...)` —— 一个字符串会当场 TypeError。
//
// 用 DSH 自己的 yaml 解析器读那份文件，实测结论：
//   顶层 type = object（应为 array）
//   每一行 insert type = string（应为 array）
//
// ## 为什么仓库里的用例看不见这件事
//
// `composition.test.mjs` 断言的是「磁盘上的 YAML == `renderPatchYaml()`」，
// 也就是**生成物与它自己的声明一致**。那个断言是真的，也一直绿着——
// 而它从来没有让任何解析器去读那份文件。
//
//   > 一个"与自己的声明完全一致"的补丁层，
//   > 与一个"能被 DSH 加载"的补丁层，在用例上是同一个东西——
//   > 只不过前者的用例是绿的，而它从未被任何解析器读过。
//
// 所以本模块做两件事：
//   ① 用 **DSH 的 `PatchOptions` 字段表**把"能被加载"变成可判定的形状；
//   ② 自己生成 YAML，且**字符串一律加引号**——见下面 `scalarOf`。
//
// ## 本模块**不是**一个 YAML 解析器
//
// 它是一个**生成器 + 形状检查器**。这里的判据取自 DSH 的
// `lib/types/index.d.ts` 与 `parsePatchList` 的实际断言，而不是"我们再读一遍
// 觉得应该是什么"。真解析器在 DSH 那边；本模块保证**生成**的东西满足它。
// ============================================================================

/** 改动生成规则/字段表时递增。 */
export const PATCH_FORMAT_VERSION = 1

export const PATCH_DOCUMENT_CODES = Object.freeze({
  /** 顶层不是数组 —— DSH 会直接抛。 */
  NOT_AN_ARRAY: 'PATCH_DOCUMENT_NOT_AN_ARRAY',
  /** 数组里有 null / 数组 / 标量。 */
  ENTRY_NOT_OBJECT: 'PATCH_DOCUMENT_ENTRY_NOT_OBJECT',
  /** `insert` 存在但不是数组 —— DSH 会对它 `.forEach`。 */
  INSERT_NOT_ARRAY: 'PATCH_DOCUMENT_INSERT_NOT_ARRAY',
  /** `insert` 的某一项不是对象。 */
  INSERT_ENTRY_NOT_OBJECT: 'PATCH_DOCUMENT_INSERT_ENTRY_NOT_OBJECT',
  /** `insert` 的某一项没有可加载的模块名（`name`）。 */
  INSERT_ENTRY_NO_NAME: 'PATCH_DOCUMENT_INSERT_ENTRY_NO_NAME',
  /** `config` 存在但不是普通对象。 */
  CONFIG_NOT_OBJECT: 'PATCH_DOCUMENT_CONFIG_NOT_OBJECT',
  /**
   * `insert` 与 `id` 同时出现。
   *
   * DSH 对它的解释是「把这些行插进**那一行的 config 数组**」，要求那一行
   * **已经存在**且是 `group: true`。拿 Legion 自己的行 id 当靶子时那一行还不存在
   * （它正是要被插进去的），于是 `patch insert: entry %C not found` → warn-and-skip。
   */
  INSERT_WITH_TARGET_ID: 'PATCH_DOCUMENT_INSERT_WITH_TARGET_ID',
  /** 出现了 `PatchOptions` 之外的键 —— DSH **静默忽略**它。 */
  UNKNOWN_KEY: 'PATCH_DOCUMENT_UNKNOWN_KEY',
  /** 某一行的插件模块还不存在，因此这一行造不出来。 */
  ROW_MODULE_MISSING: 'PATCH_DOCUMENT_ROW_MODULE_MISSING',
})

/**
 * `PatchOptions` 的字段表，逐字抄自 DSH 的
 * `@deepseek-ai/cordis-plugin-include/lib/types/index.d.ts`：
 *
 *     interface PatchOptions {
 *       id?: string; insert?: EntryOptions[]; name?: string; config?: any
 *       group?: boolean | null; disabled?: boolean | null
 *       inject?: any; intercept?: any; isolate?: any; [key: string]: any
 *     }
 *
 * ★ 末尾那个索引签名是关键：**DSH 不会拒绝多出来的键**，它会静静地不用。
 *   所以"形状合法"这件事不能靠 DSH 来判——必须由我们自己把不认识的键挑出来。
 *   这正是 `plane: host` 此前会消失得无影无踪的原因。
 */
export const PATCH_OPTIONS_KEYS = Object.freeze([
  'id', 'insert', 'name', 'config', 'group', 'disabled', 'inject', 'intercept', 'isolate',
])

/** 只接受普通对象（不是 null、数组、Date 之类）。 */
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 一份文档里出现的、`PatchOptions` 不认识的键（连同它出现在哪一行）。 */
export function unknownPatchKeys(doc) {
  if (!Array.isArray(doc)) return []
  const out = []
  doc.forEach((entry, i) => {
    if (!isPlainObject(entry)) return
    for (const k of Object.keys(entry)) {
      if (!PATCH_OPTIONS_KEYS.includes(k)) out.push({ index: i, id: entry.id ?? null, key: k })
    }
  })
  return out
}

/**
 * 断言一份文档**能被 DSH 加载**。
 *
 * 这些判据不是"我们觉得 YAML 应该怎样"，而是 `parsePatchList` /
 * `applyEntryPatches` 实际会抛或会静默吃掉的那几件事：
 *
 *   · 顶层不是数组          → parsePatchList 抛（"must be a top-level YAML array"）
 *   · `insert` 不是数组      → applyEntryPatches 对字符串调 `.forEach` → TypeError
 *   · `insert` 的项没有 name → 没有模块可加载，那一行什么也不会发生
 *   · 多出来的键            → **不抛**，静默忽略（最危险的一种，见上面字段表）
 *
 * @returns {ReadonlyArray<{index:number, id:string|null, code:string, detail:string}>}
 *   空数组表示可以加载。**返回清单而不是抛**，因为调用方常常要把全部问题一次报出来。
 */
export function patchDocumentProblems(doc) {
  const problems = []
  const push = (index, id, code, detail) => problems.push(Object.freeze({ index, id, code, detail }))

  if (!Array.isArray(doc)) {
    push(-1, null, PATCH_DOCUMENT_CODES.NOT_AN_ARRAY,
      `顶层是 ${doc === null ? 'null' : Array.isArray(doc) ? 'array' : typeof doc}；` +
      'DSH 的 parsePatchList 只接受顶层 YAML 数组，否则直接抛')
    return Object.freeze(problems)
  }

  doc.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      push(i, null, PATCH_DOCUMENT_CODES.ENTRY_NOT_OBJECT,
        `第 ${i} 项是 ${entry === null ? 'null' : typeof entry}，不是普通对象`)
      return
    }
    const id = typeof entry.id === 'string' ? entry.id : null

    // `insert` 是**新增行**的载体。DSH 直接 `.forEach` 它。
    if ('insert' in entry) {
      if (!Array.isArray(entry.insert)) {
        push(i, id, PATCH_DOCUMENT_CODES.INSERT_NOT_ARRAY,
          `insert 是 ${typeof entry.insert}（${JSON.stringify(entry.insert)}）；` +
          'DSH 会对它调用 .forEach —— 一个非数组会当场 TypeError')
      } else {
        // ★ `insert` 与 `id` 同时出现时，DSH 的语义**不是**"给这一行取个 id"，
        //   而是「把这些项插进 `id` 那一行的 config 数组」，且要求那一行
        //   **已存在**且 `group: true`。实测（真 applyEntryPatches）：
        //     · 靶子不存在 → `patch insert: entry "X" not found` → warn-and-skip
        //     · 靶子不是 group → `patch insert: entry "tools" is not a group` → warn-and-skip
        //   两者都**不抛**，只是什么也不发生。
        //
        //   这正是本模块存在的理由：一个"文件看起来装好了"的补丁层。
        if (typeof entry.id === 'string' && entry.id !== '') {
          push(i, id, PATCH_DOCUMENT_CODES.INSERT_WITH_TARGET_ID,
            `第 ${i} 项同时带 id=${JSON.stringify(entry.id)} 与 insert —— ` +
            'DSH 读作「插进那一行的 config 数组」，要求那一行**已存在**且是 group；' +
            '它不是"给这次插入命名"。要新增根级行就不要带 id，' +
            '要插进某个 group 就让 id 指向那个已存在的 group 行')
        }
        entry.insert.forEach((e, j) => {
          if (!isPlainObject(e)) {
            push(i, id, PATCH_DOCUMENT_CODES.INSERT_ENTRY_NOT_OBJECT,
              `insert[${j}] 是 ${e === null ? 'null' : typeof e}，不是普通对象`)
            return
          }
          // 没有 `name` 就没有模块可加载：这一行**会被 warn-and-skip**。
          //
          //   > 一个"能被 DSH 接受、然后被 warn-and-skip 掉"的补丁行，
          //   > 与一个"从未被写进补丁层"的补丁行，在组合树里长得一模一样——
          //   > 只不过前者的文件看起来是装好的。
          if (typeof e.name !== 'string' || e.name.trim() === '') {
            push(i, id, PATCH_DOCUMENT_CODES.INSERT_ENTRY_NO_NAME,
              `insert[${j}] 没有可加载的模块名 name——这一行会被 warn-and-skip，什么也不会发生`)
          }
        })
      }
    }

    // `config` 是 patch-over 的载体（DSH 语义：**替换整个 config**，不是合并）。
    if ('config' in entry && !isPlainObject(entry.config)) {
      push(i, id, PATCH_DOCUMENT_CODES.CONFIG_NOT_OBJECT,
        `config 是 ${entry.config === null ? 'null' : typeof entry.config}，不是普通对象`)
    }
  })

  for (const u of unknownPatchKeys(doc)) {
    push(u.index, u.id, PATCH_DOCUMENT_CODES.UNKNOWN_KEY,
      `键 ${JSON.stringify(u.key)} 不在 DSH 的 PatchOptions 里——` +
      '它有索引签名，所以**不会抛**，只会静默忽略。' +
      '一个会被静默忽略的字段，与一个不存在的字段，在组合树上没有任何区别')
  }

  return Object.freeze(problems)
}

/** 遇到第一个问题就抛。用例与安装器用这个。 */
export function assertPatchDocumentLoadable(doc) {
  const problems = patchDocumentProblems(doc)
  if (problems.length > 0) {
    const err = new Error(
      `补丁层文档不能被 DSH 加载（${problems.length} 处）：\n` +
      problems.map((p) => `  · [${p.code}] ${p.detail}`).join('\n'),
    )
    err.code = problems[0].code
    err.problems = problems
    throw err
  }
  return doc
}

/**
 * 由补丁层声明造出文档。
 *
 * ## ★ 两种 patch 形状，别搞混（实测于真 `applyEntryPatches`）
 *
 * | 形状 | DSH 的解释 | 靶子 |
 * | --- | --- | --- |
 * | `{ insert: [...] }`（**无 id**） | 把行**追加到根** | 不需要靶子 |
 * | `{ id, config }` | **替换**那一行的整个 config | 那一行必须已存在 |
 * | `{ id, insert: [...] }` | 把行插进那一行的 **config 数组** | 那一行必须已存在且 `group: true` |
 *
 * 第三种的坑在于它**看起来**像"给这次插入取个 id"。实测把它用在 Legion 自己的
 * 行 id 上会得到 `patch insert: entry "legion-enforcement-hard-floor" not found`
 * —— warn-and-skip，什么都不发生，也不抛。
 *
 * 所以新增行一律走**第一种**（与 DSH 自己的 `packages/bundle/base/cordis.patch.yml`
 * 同一个形状：一个 `- insert:` 顶层项装下全部行）。
 *
 * ## ★ `mount.after` 不进文件
 *
 * 声明里的 `mount: { anchor: 'insert', after: 'tools' }` 带一个"插在 `tools` 之后"
 * 的意图，但 **DSH 没有 after 字段**，而且行顺序**不携带加载语义**
 * （base bundle 的注释写明：activation is service-availability driven）。
 *
 * 把它字面翻译成 `{ id: 'tools', insert: [...] }` 就是上表第三种，
 * 而 `tools` 不是 group —— 实测得到 `patch insert: entry "tools" is not a group`，
 * 又是静默失效。所以 `after` 只作为**阅读提示**留在声明里，绝不进文件。
 *
 * @param {object} cfg
 * @param {ReadonlyArray<object>} cfg.rows `PATCH_LAYER_ROWS`
 * @param {object} cfg.presets `LEGION_PERMISSION_PRESETS`
 * @param {(m: string|null) => string|null} [cfg.moduleUrlOf]
 *   把声明的 `module` 转成可加载的模块名。返回 `null` 表示**这个模块还不存在**。
 *   默认实现直接返回 `row.module`（`null` 就是不存在）。
 * @returns {{document: object[], unbuildable: object[]}}
 *   `document` 是**能造出来的那部分**（可加载）；`unbuildable` 是造不出来的行。
 */
export function toPatchDocument({ rows = [], presets = {}, moduleUrlOf = null } = {}) {
  const resolve = typeof moduleUrlOf === 'function' ? moduleUrlOf : (m) => m ?? null
  const inserts = []
  const overrides = []
  const unbuildable = []

  for (const row of rows) {
    if (row?.mount?.anchor === 'patch-over') {
      // patch-over 不需要模块：它按 id 覆盖**既有**行的 config。
      //
      // ★ 只带 `config`，不带 `plane`、也不带 Legion 的行 id。
      //   `id` 在这里是**被覆盖的目标**（`permission`），不是 Legion 的行 id；
      //   `plane` 不是 PatchOptions 的字段，写进去会被静默忽略（见字段表）。
      overrides.push(Object.freeze({
        id: String(row.mount.target),
        config: Object.freeze({ presets: Object.freeze({ ...presets }) }),
      }))
      continue
    }

    const name = resolve(row?.module)
    if (typeof name !== 'string' || name.trim() === '') {
      unbuildable.push(Object.freeze({
        id: row?.id ?? null,
        code: PATCH_DOCUMENT_CODES.ROW_MODULE_MISSING,
        detail: `行 ${row?.id} 的插件模块还不存在（声明里 module=${JSON.stringify(row?.module ?? null)}）——` +
          '没有模块可加载，插进去的行会被 warn-and-skip',
      }))
      continue
    }
    inserts.push(Object.freeze({ id: String(row.id), name: name.trim() }))
  }

  const document = []
  // ★ 根级 insert：**不带 id**，与 base bundle 同一个形状。
  //   一个补丁项装下全部新增行，这样"哪些行靠同一次插入进来"在文件里是可见的。
  if (inserts.length > 0) document.push(Object.freeze({ insert: Object.freeze(inserts) }))
  document.push(...overrides)

  return Object.freeze({
    document: Object.freeze(document),
    unbuildable: Object.freeze(unbuildable),
  })
}

// ---------------------------------------------------------------- YAML 生成
//
// 自己写而不引第三方：本仓库零依赖（`deps` 阶段会把新增依赖判红）。
// 只需要覆盖补丁层用到的那几种值：字符串、数字、布尔、null、数组、普通对象。

/** 合法的裸 YAML 键：`[A-Za-z_][A-Za-z0-9_-]*`。其余一律加引号。 */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * 一个标量怎么印。
 *
 * ★ **字符串一律用双引号**，不做"看起来危险才加引号"的判断。
 *
 * YAML 的双引号标量与 JSON 的字符串字面量是兼容的（JSON 是 YAML 1.2 的子集），
 * 所以 `JSON.stringify` 的输出可以直接当 YAML 双引号标量用。
 *
 * 为什么不用"需要时才加"：
 *
 *   > 一个"只在看起来危险时才加引号"的生成器，
 *   > 与一个"该加的时候恰好没加"的生成器，在它漏的那一天之前是同一个东西。
 *
 * 而且双引号标量**永远不会**被当成 tag —— 于是 `!!js` 这一整类注入
 * （DSH 的补丁文件支持 `!!js` 表达式）在生成侧被彻底关掉，
 * 靠的不是一个判据，而是"没有任何一条路径能产出裸标量"。
 */
export function scalarOf(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`YAML 生成器不接受非有限数：${value}`)
    }
    return String(value)
  }
  throw new Error(`YAML 生成器不接受 ${typeof value} 类型的标量：${JSON.stringify(value)}`)
}

function emit(value, indent, lines) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) { lines.push('[]'); return }
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        // `- ` 之后承接嵌套内容的缩进是 indent + 2
        const sub = []
        emit(item, indent + 2, sub)
        lines.push(`${pad}- ${sub[0].trimStart()}`)
        for (let i = 1; i < sub.length; i += 1) lines.push(sub[i])
      } else {
        lines.push(`${pad}- ${scalarOf(item)}`)
      }
    }
    return
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) { lines.push('{}'); return }
    for (const k of keys) {
      const key = BARE_KEY.test(k) ? k : JSON.stringify(k)
      const v = value[k]
      if (isPlainObject(v) || Array.isArray(v)) {
        const empty = (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0)
        if (empty) {
          lines.push(`${pad}${key}: ${Array.isArray(v) ? '[]' : '{}'}`)
        } else {
          lines.push(`${pad}${key}:`)
          emit(v, indent + 2, lines)
        }
      } else {
        lines.push(`${pad}${key}: ${scalarOf(v)}`)
      }
    }
    return
  }
  lines.push(`${pad}${scalarOf(value)}`)
}

/**
 * 把文档印成 YAML 文本。
 *
 * `header` 是注释行数组（每行不含 `#`，函数自己加）。注释里可以写中文，
 * 但**不能**写会被当成配置的东西——所以调用方只放散文。
 */
export function renderPatchYamlText(document, { header = [] } = {}) {
  assertPatchDocumentLoadable(document)
  const lines = header.map((h) => (h.startsWith('#') ? h : `# ${h}`))
  if (lines.length > 0) lines.push('')
  const body = []
  emit(document, 0, body)
  lines.push(...body)
  return `${lines.join('\n')}\n`
}

// ------------------------------------------------------------------ 自检
//
// 与仓库里其它模块同一个手法：留**算出来的值**，不留一个 ok 布尔。
// 这里特别要证明的是"坏形状**真的**会被拦下"——否则这个检查本身就是
// 一个永远不会触发的守卫。

function selfCheck() {
  const problems = []
  const mustReject = [
    [PATCH_DOCUMENT_CODES.NOT_AN_ARRAY, { patch: [] }],
    [PATCH_DOCUMENT_CODES.ENTRY_NOT_OBJECT, [null]],
    [PATCH_DOCUMENT_CODES.ENTRY_NOT_OBJECT, ['x']],
    [PATCH_DOCUMENT_CODES.INSERT_NOT_ARRAY, [{ id: 'a', insert: 'after:tools' }]],
    [PATCH_DOCUMENT_CODES.INSERT_ENTRY_NOT_OBJECT, [{ id: 'a', insert: [1] }]],
    [PATCH_DOCUMENT_CODES.INSERT_ENTRY_NO_NAME, [{ id: 'a', insert: [{}] }]],
    [PATCH_DOCUMENT_CODES.CONFIG_NOT_OBJECT, [{ id: 'permission', config: 'x' }]],
    // ★ 这一条就是我自己写错过的形状：拿 Legion 自己的行 id 当 insert 的靶子。
    //   实测（真 applyEntryPatches）→ warn-and-skip，什么都不发生。
    [PATCH_DOCUMENT_CODES.INSERT_WITH_TARGET_ID, [{ id: 'legion-enforcement-hard-floor', insert: [{ name: 'x' }] }]],
    [PATCH_DOCUMENT_CODES.UNKNOWN_KEY, [{ id: 'a', plane: 'host' }]],
  ]
  // `[]` 是 DSH 自己写的模板，必须**合法**——它不是"被拒绝"的例子。
  const emptyOk = patchDocumentProblems([]).length === 0
  if (!emptyOk) problems.push('空数组被拒绝了，而 DSH 自己的模板就是 []')

  const checked = []
  for (const [code, doc] of mustReject) {
    const got = patchDocumentProblems(doc).map((p) => p.code)
    if (!got.includes(code)) problems.push(`预期 ${code}，实际 ${JSON.stringify(got)}`)
    else checked.push(code)
  }

  // 反例：`insert: after:tools` 这个**字符串**就是此前磁盘上那份文件的真实形状。
  // 把它当作样本留在自检里，是因为它是"看起来像锚点、其实是个标量"的原型。
  const legacy = [{ id: 'legion-enforcement-hard-floor', insert: 'after:tools', plane: 'host' }]
  const legacyCodes = patchDocumentProblems(legacy).map((p) => p.code)
  if (!legacyCodes.includes(PATCH_DOCUMENT_CODES.INSERT_NOT_ARRAY)
    || !legacyCodes.includes(PATCH_DOCUMENT_CODES.UNKNOWN_KEY)) {
    problems.push(`旧格式样本没有被同时认出 insert 与未知键：${JSON.stringify(legacyCodes)}`)
  }

  // 一份**好**的文档必须零问题，且能被印成 YAML。
  const good = [{
    id: 'permission',
    config: { presets: { 'legion-attended': { sandbox: 'workspace-write', approval: 'ask', name: 'Legion · 有人值守' } } },
  }, { insert: [{ id: 'legion-enforcement-hard-floor', name: 'file:///x/y.js' }] }]
  if (patchDocumentProblems(good).length !== 0) {
    problems.push(`好文档被判成坏的：${JSON.stringify(patchDocumentProblems(good))}`)
  }
  let yamlText = ''
  try { yamlText = renderPatchYamlText(good) } catch (e) { problems.push(`好文档印不出来：${e.message}`) }

  // ★ 造出来的文档必须**自己**是合法的。这一条把生成器与检查器钉在一起：
  //   生成器吐出的东西如果通不过检查器，那么"能造出来"与"能加载"就是两件事，
  //   而这正是本模块要消灭的那道缝。
  const built = toPatchDocument({
    rows: [
      { id: 'legion-enforcement-hard-floor', mount: { anchor: 'insert', after: 'tools' }, module: null },
      { id: 'legion-enforcement-permission-presets', mount: { anchor: 'patch-over', target: 'permission' }, module: null },
    ],
    presets: { 'legion-attended': { sandbox: 'workspace-write', approval: 'ask' } },
  })
  const builtProblems = patchDocumentProblems(built.document)
  if (builtProblems.length !== 0) {
    problems.push(`生成器造出的文档通不过自己的检查：${JSON.stringify(builtProblems)}`)
  }
  // 而且必须**报出**那一行造不出来（module 是 null）。
  if (built.unbuildable.length !== 1) {
    problems.push(`module=null 的行没有被报成 unbuildable（得到 ${built.unbuildable.length} 条）`)
  }
  // ★ `after: 'tools'` 绝不能变成 `{ id: 'tools', insert: [...] }`——
  //   那正是静默失效的形状。造出来的文档里不该出现任何 `id`+`insert` 的组合。
  if (built.document.some((d) => 'insert' in d && 'id' in d)) {
    problems.push('生成器把 after 锚点翻成了 id+insert —— 那会被 warn-and-skip')
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    // ★ 留下**真的被触发过**的拒绝码，而不是一句"检查过了"。
    checkedRefusals: Object.freeze(checked),
    version: PATCH_FORMAT_VERSION,
    patchOptionKeys: PATCH_OPTIONS_KEYS,
    sampleYaml: yamlText,
    legacySampleCodes: Object.freeze(legacyCodes),
  })
}

/** 装载时算一次。`problems` 非空即本模块自己的判据不自洽。 */
export const PATCH_FORMAT_CHECKED = selfCheck()

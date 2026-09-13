// runtime/dsh-composition/patch-layer.mjs
// ============================================================================
// Legion DSH 组合补丁层定义（PRT-214）
//
// ## 这一层解决什么问题
//
// §6.8 的强制面映射要成为**安全保证**，前提是强制面挂载在正确的组合平面上。
// DSH 逐层 patch 组合：`dsh-base` 打底，模式 bundle 覆盖其上，用户 profile 层再覆盖。
// 静态 hard floor / 策略 listener / approval answerer / preset 表**必须**在 host 组合层，
// 不能只放在 agent preset —— preset 按 session 挂载、可替换、可被 shadow，
// 把安全下限放在其中，等于让「不可绕过的下限」取决于当前 session 恰好挂了哪个 preset。
//
// ## 本文件是**声明**，不是执行
//
// 这里只描述「这一层由哪些行组成、每行挂什么、锚点在哪、版本是多少」，
// 以及**自检要按什么判据认定「已生效」**。真正的行挂载由宿主组合加载器完成。
//
// 之所以把声明与挂载分开：补丁层的**定义**可以在没有 DSH 的环境里被测试、
// 被逐条审阅、被版本比对；而挂载只能在装了 DSH 的环境里发生。
// 若两者写在一起，这一层就又变成「只能在 DSH 在场时才能验证」的东西 ——
// 而它恰恰是安全下限，最需要能独立审阅。
//
// ## 零 DSH import
//
// 本目录**不 import 任何 DSH 包**（`dsh-boundary` 对本目录的依赖计数为 0）。
// 与 `runtime/adapters/dsh/port.mjs` 同一立场：耦合方式改为**注入**。
// 结果是本目录的 DSH 记号数为 0，棘轮里 `adapterPrefixes` 的豁免**存在但不用**。
// ============================================================================

/**
 * 组合补丁层版本（PRT-214 / spec §6 的 `dshCompositionPatchVersion`）。
 *
 * 它与 `dshVersion` **强绑定**：补丁层通过 patch 锚点作用于 DSH bundle，
 * 锚点随 DSH 版本变化。因此两者必须成对验证，
 * 不允许出现「DSH 已升级但补丁层仍是旧锚点」的组合。
 *
 * 版本号只在**锚点或行组成发生实质变化**时递增。
 * 改动文案、注释、错误消息不递增 —— 否则这个号会变成噪音，
 * 而噪音版本号等于没有版本号。
 */
export const DSH_COMPOSITION_PATCH_VERSION = 1

/**
 * Legion 自有 permission preset 表。
 *
 * **不复用 DSH 默认表**。默认表把 `workspace-write`↔`ask` 与
 * `danger-full-access`↔`never` 绑定；若按默认表实现「无人值守 = never」，
 * 沙箱会**同时**被降级为 `danger-full-access`，与最小权限要求直接冲突。
 *
 * 注意这里的键名是**产品语义**（attended / unattended），不是沙箱模式名。
 * 用沙箱模式名当 preset 名会把「谁在看着」这个决策维度藏进「能写多少」里，
 * 于是「无人值守」在 UI 上看起来像「权限更大」。
 */
export const LEGION_PERMISSION_PRESETS = Object.freeze({
  'legion-attended': Object.freeze({
    sandbox: 'workspace-write',
    approval: 'ask',
    name: 'Legion · 有人值守',
    description: '在 workspace 内可写；越界写入需要人工批准。',
  }),
  'legion-unattended': Object.freeze({
    sandbox: 'workspace-write',
    approval: 'never',
    name: 'Legion · 无人值守',
    description: '在 workspace 内可写；越界写入直接拒绝（无人可问，不降级为放行）。',
  }),
})

/** DSH 默认 preset 表里那个**必须被覆盖**的默认（记录它，才能证明我们没在用它）。 */
export const DSH_DEFAULT_PRESETS = Object.freeze({
  'workspace-write': Object.freeze({ sandbox: 'workspace-write', approval: 'ask' }),
  'danger-full-access': Object.freeze({ sandbox: 'danger-full-access', approval: 'never' }),
})

/** 补丁层行 id 前缀。用来在组合树里认出「哪些行是 Legion 注入的」。 */
export const LEGION_ROW_PREFIX = 'legion-enforcement-'

/**
 * 补丁层的行清单。
 *
 * `anchor` 是 patch 目标：`insert` 表示新增行，`patch-over` 表示按 id 覆盖既有行
 * （DSH 的 patch 语义：**替换目标行的整个 config**，而不是合并进去）。
 *
 * ## ★ `module` 字段（PRT-214 补记）
 *
 * `insert` 在 DSH 的 `PatchOptions` 里是 **`EntryOptions[]`**，而一个
 * `EntryOptions` 必须带 `name`（要加载的模块）。DSH 对**匹配不到任何东西**的
 * 补丁行是 **warn-and-skip**：它不会报错，只是什么也不做。
 *
 *   > 一个"能被 DSH 接受、然后被 warn-and-skip 掉"的补丁行，
 *   > 与一个"从未被写进补丁层"的补丁行，在组合树里长得一模一样——
 *   > 只不过前者的文件看起来是装好的。
 *
 * 所以每一行**显式**记下自己的模块。`null` 的意思是"这个模块还不存在"，
 * 于是 `toPatchDocument()` 会把这一行归到 `unbuildable` 而不是造一个
 * 加载不了的空壳。这个字段让"PRT-214 没做完"变成一件**机械可查**的事，
 * 而不是一句散文。
 */
export const PATCH_LAYER_ROWS = Object.freeze([
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}hard-floor`,
    plane: 'host',
    kind: 'guard',
    purpose: '静态 hard floor：同步、确定性、最终单调拒绝',
    mount: Object.freeze({ anchor: 'insert', after: 'tools' }),
    // 依据 §6.8：guard 只有降级语义、没有 allow 语义。
    // 因此这一行**永远不能**成为唯一防线 —— 它只负责「不可能被说成可以」的那部分。
    registrations: Object.freeze(['ctx.tools.guard']),
    // ★ 路径是**相对于补丁文件自己所在目录**的。
    //
    // 这不是我挑的写法：DSH 的 `parsePatchList` 会调
    // `anchorInsertedPluginNames(patches, file)`，把 `./` 或 `../` 开头的
    // `name` 按 `dirname(patchFile)` 解析成 file:// URL
    // （`packages/boot/app-boot/src/index.ts:326-336`）。
    //
    //   > 一个"写成机器绝对路径"的模块引用，
    //   > 与一个"换台机器就加载不到"的补丁层，是同一个东西——
    //   > 只不过前者在作者自己的机器上跑得通。
    //
    // 所以这里用相对路径，补丁层连同 `plugins/` 一起搬走仍然有效。
    module: './plugins/hard-floor.mjs',
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}pre-execute`,
    plane: 'host',
    kind: 'listener',
    purpose: '动态 allow / deny / ask，team-hub 不可达或策略异常时 deny（fail closed）',
    mount: Object.freeze({ anchor: 'insert', after: 'tools' }),
    registrations: Object.freeze(["ctx.on('tools/pre-execute')"]),
    // ⚠️ 还没有这个模块。见上面 `module` 的说明。
    module: null,
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}approval-answerer`,
    plane: 'host',
    kind: 'answerer',
    purpose: '把审批请求写入审批箱；只有 allowed-once 执行；双段超时 fail closed',
    mount: Object.freeze({ anchor: 'insert', after: 'approval' }),
    registrations: Object.freeze(["ctx.on('approval/request')"]),
    // ⚠️ 还没有这个模块。见上面 `module` 的说明。
    module: null,
  }),
  Object.freeze({
    id: `${LEGION_ROW_PREFIX}permission-presets`,
    plane: 'host',
    kind: 'config-override',
    purpose: '用 Legion 自有 preset 表**替换** DSH 默认表（不合并）',
    mount: Object.freeze({ anchor: 'patch-over', target: 'permission' }),
    registrations: Object.freeze(['config.presets']),
    // patch-over **不需要**模块：它按 id 覆盖既有行的 config（`permission` 行本来就在）。
    module: null,
  }),
])

/** 员工 agent preset（agent 平面，按 session 挂载）。只承载岗位能力，不提供任何服务。 */
export const EMPLOYEE_PRESET_CONTRACT = Object.freeze({
  plane: 'agent',
  mayProvideServices: false,
  mayCarryEnforcement: false,
  carries: Object.freeze(['岗位工具集', 'persona', '提示段', 'skill 引用']),
})

/**
 * 一次组合树扫描结果与补丁层声明的对账。
 *
 * ## 为什么「行在不在」不足以判定生效
 *
 * 行挂上去了但**没激活**（等待某个服务）在组合树里看起来和成功挂载一模一样：
 * 都是「行存在」。DSH 的挂载审计会报 `N row(s) did not activate`，
 * 因此本函数要求调用方提供 `activated` 而不是只看 `present`。
 *
 * 同理，`permission` 行如果被 `patch-over` 覆盖成了 Legion 表，那是覆盖成功；
 * 如果它**根本没被覆盖**（还是 DSH 默认表），行也照样存在，
 * 但 `legion-unattended` 这个 preset 名会解析失败 —— 这才是判据。
 *
 * @param {{rows?: Array<{id: string, activated?: boolean}>, permissionPresets?: string[]}} observation
 *   组合树观察结果（由宿主侧注入，本模块不读文件、不 import DSH）
 */
export function reconcilePatchLayer(observation = {}) {
  const rows = Array.isArray(observation.rows) ? observation.rows : []
  const byId = new Map(rows.map((r) => [String(r?.id ?? ''), r]))

  const findings = []
  for (const spec of PATCH_LAYER_ROWS) {
    const hit = byId.get(spec.id)
    if (hit === undefined) {
      findings.push({
        row: spec.id,
        code: 'ROW_MISSING',
        effective: false,
        detail: `补丁层行未出现在组合树中（预期锚点：${spec.mount.anchor}）`,
      })
      continue
    }
    // 行存在但未激活 = 没生效。这一条是 DSH 挂载审计里最容易漏掉的一类：
    // 「等待某服务」的行在树里是**存在**的，但什么也没做。
    if (hit.activated === false) {
      findings.push({
        row: spec.id,
        code: 'ROW_NOT_ACTIVATED',
        effective: false,
        detail: '行已挂载但未激活（等待依赖服务），不产生任何强制效果',
      })
      continue
    }
    findings.push({ row: spec.id, code: 'OK', effective: true, detail: '行已挂载并激活' })
  }

  // preset 表是否真的被替换：判据是**Legion 的 preset 名能否解析**，
  // 而不是「permission 行存不存在」。后者在覆盖失败时同样成立。
  const names = Array.isArray(observation.permissionPresets) ? observation.permissionPresets.map(String) : null
  let presetsFinding
  if (names === null) {
    presetsFinding = {
      row: `${LEGION_ROW_PREFIX}permission-presets`,
      code: 'PRESETS_UNOBSERVED',
      effective: false,
      detail: '未能读到生效的 preset 表；「没观察到」不等于「已替换」，按未生效处理',
    }
  } else {
    const missing = Object.keys(LEGION_PERMISSION_PRESETS).filter((n) => !names.includes(n))
    if (missing.length > 0) {
      presetsFinding = {
        row: `${LEGION_ROW_PREFIX}permission-presets`,
        code: 'PRESETS_NOT_OVERRIDDEN',
        effective: false,
        detail: `生效的 preset 表里缺少 Legion 自有项 [${missing.join(', ')}]：patch-over 未生效，仍在用 DSH 默认表`,
      }
    } else {
      presetsFinding = {
        row: `${LEGION_ROW_PREFIX}permission-presets`,
        code: 'OK',
        effective: true,
        detail: `Legion preset 表已生效：${names.join(', ')}`,
      }
    }
  }

  const all = [...findings, presetsFinding]
  return {
    patchVersion: DSH_COMPOSITION_PATCH_VERSION,
    effective: all.every((f) => f.effective),
    findings: all,
    reasons: all.filter((f) => !f.effective).map((f) => `${f.row}: ${f.detail}`),
  }
}

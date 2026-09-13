// runtime/dsh-composition/render.mjs
// ============================================================================
// 由补丁层声明渲染出 `cordis.patch.yml` 的**内容**（PRT-214）。
//
// ## 为什么渲染而不是手写 YAML
//
// 补丁层的**声明**（`patch-layer.mjs`）与它的**落盘形式**（YAML）是同一个事实的
// 两种表达。手写两份必然漂移：改了一处忘了另一处，于是自检按新声明判定、
// 实际挂载按旧 YAML 执行 —— 这种不一致最难发现，因为两边各自都"对"。
//
// 因此 YAML 是**生成物**，由一条新鲜度用例守住：声明改了而 YAML 没重新生成，
// CI 直接变红。
//
// ## PRT-214 补记：这里此前生成的是一份 DSH 读不懂的文件
//
// 旧版生成的是：
//
//     patch:                       # 顶层映射
//       - id: legion-enforcement-hard-floor
//         insert: after:tools      # 字符串，不是数组
//         plane: host              # 不是 PatchOptions 的字段
//     permission: { presets: … }   # 第二个顶层键，补丁文件里没有这个位置
//
// DSH 的 `parsePatchList` 只接受**顶层 YAML 数组**，否则直接抛：
//
//     `${binName}: config ${file} must be a top-level YAML array of entries`
//
// 即便顶层换成数组，`applyEntryPatches` 会对 `patch.insert` 调 `.forEach`，
// 一个字符串当场 TypeError。
//
// 而仓库里的用例一直绿着，因为它断言的是「磁盘上的 YAML == 本函数输出」——
// 也就是**生成物与自己的声明一致**，从来没有让任何解析器去读它。
//
//   > 一个"与自己的声明完全一致"的补丁层，
//   > 与一个"能被 DSH 加载"的补丁层，在用例上是同一个东西——
//   > 只不过前者的用例是绿的，而它从未被任何解析器读过。
//
// 现在本模块只负责"把声明翻成文档、再印成文本"。**"能被 DSH 加载"这件事由
// `patch-format.mjs` 判定**——那边的字段表与形状检查逐字取自 DSH 的
// `PatchOptions` 定义（`cordis-plugin-include/lib/types/index.d.ts`）与
// `parsePatchList` 的实际断言。
//
// ## 为什么这个文件里没有 apply/write
//
// profile 层是 `patchReload: 'live'`，写入会立刻改变**正在运行**的强制面。
// 落盘动作必须是一次显式决策，不能藏在一个"顺手"的函数里。
// 本文件的 CLI 只在被显式传 `--write` 时写；写不写、写到哪，由调用方决定并留痕。
// ============================================================================

import {
  PATCH_DOCUMENT_CODES, renderPatchYamlText, toPatchDocument,
} from './patch-format.mjs'
import { DSH_COMPOSITION_PATCH_VERSION, LEGION_PERMISSION_PRESETS, PATCH_LAYER_ROWS } from './patch-layer.mjs'

export { PATCH_DOCUMENT_CODES }

/** 生成物的仓库内相对路径。 */
export const PATCH_YAML_PATH = 'runtime/dsh-composition/legion-host.patch.yml'

/** 文档的标题注释。它是散文，不是配置——所以只放在 `#` 后面。 */
const HEADER = Object.freeze([
  '# 由 runtime/dsh-composition/render.mjs 生成 —— 请勿手工编辑。',
  `# 对应运行时声明：runtime/dsh-composition/patch-layer.mjs（dshCompositionPatchVersion: ${DSH_COMPOSITION_PATCH_VERSION}）`,
  '# 重新生成：node runtime/dsh-composition/render.mjs --write',
  '#',
  '# ★ 格式：**顶层 YAML 数组**，每项是 @deepseek-ai/cordis-plugin-include 的 PatchOptions。',
  '#   这不是风格问题：DSH 的 parsePatchList 对非数组顶层直接抛，',
  '#   applyEntryPatches 对非数组的 insert 直接 TypeError。',
  '#   本文件的可加载性由 runtime/dsh-composition/patch-format.mjs 判定（形状检查，非解析器）。',
  '#',
  '# 本文件是 Legion 的 host 组合补丁层。它**不**替代 DSH 随部署分发的 preset 安装，',
  '# 只通过产品自己的 profile 层注入。DSH 升级会改变 bundle 结构与 patch 锚点，',
  '# 因此这一层必须与 dshVersion 成对验证（补丁层静默失效比 API 变化更隐蔽）。',
  '#',
  '# Legion 自有 permission preset 表：**不复用** DSH 默认表。',
  '# 默认表把 workspace-write↔ask 与 danger-full-access↔never 绑定；',
  '# 按默认表实现「无人值守 = never」会同时把沙箱降级为 danger-full-access。',
  '#',
  '# ★ 本文件目前**只包含造得出来的行**。下面这几行不进文档，原因逐行写在括号里：',
  ...PATCH_LAYER_ROWS.filter((r) => r.module === null && r.mount?.anchor !== 'patch-over')
    .map((r) => {
      const state = typeof r.runtimeModule === 'string' && r.runtimeModule.trim() !== ''
        ? `模块存在（${r.runtimeModule}），但需要一个进程内装配好的组合根才挂得上`
        : '模块还不存在'
      return `#     · ${r.id} —— ${state}（${r.purpose ?? r.kind ?? ''}）`.trimEnd()
    }),
  '#   它们**刻意不在这里**：一个 insert 项没有可加载的 name 时，DSH 对它是 warn-and-skip，',
  '#   于是那一行会「看起来装好了、而什么都没做」。缺行比假行好。',
  '#',
  '#   > 一个"能被 DSH 接受、然后被 warn-and-skip 掉"的补丁行，',
  '#   > 与一个"从未被写进补丁层"的补丁行，在组合树里长得一模一样——',
  '#   > 只不过前者的文件看起来是装好的。',
  '#',
  '#   标着「模块存在」的那两行由 runtime/dsh-composition/root.mjs 在进程内挂载：',
  '#   它们要的是桥与端口（函数），而静态 patch 文件带的是数据。',
  '#   缺的那几行由 reconcilePatchLayer() 报成 ROW_MISSING，于是启动自检仍然拒绝注册',
  '#   （fail closed）。**PRT-214 因此仍是未完成状态**，而不是"装好了但没生效"。',
  '#',
  '#   ★ 上面这份清单是**从 `PATCH_LAYER_ROWS` 推出来的**，不是手写的散文。',
  '#     手写清单会腐烂：填上一个模块之后，注释里仍然写着"它不存在"，',
  '#     于是文件同时说了两句互相矛盾的话，而读到哪一句取决于读的人。',
])

/**
 * 声明 → 补丁文档（**纯值**，数组）。
 *
 * @param {{moduleUrlOf?: ((m: string|null) => string|null)|null}} [cfg]
 *   `moduleUrlOf` 把声明的 `module` 转成可加载的模块名。**默认不给兜底**：
 *   一个"模块名编也能编出来"的默认值会让 `unbuildable` 永远是空的，
 *   而那正是本模块要防的那种"看起来装好了"。
 */
export function patchDocument({ moduleUrlOf = null } = {}) {
  return toPatchDocument({
    rows: PATCH_LAYER_ROWS,
    presets: LEGION_PERMISSION_PRESETS,
    ...(moduleUrlOf === null ? {} : { moduleUrlOf }),
  })
}

/**
 * 渲染成 YAML 文本。
 *
 * @returns {string} 一份**顶层是数组**的 YAML 文本。
 * @throws 当文档不能被 DSH 加载时（形状检查在 `patch-format.mjs`）。
 */
export function renderPatchYaml({ moduleUrlOf = null } = {}) {
  const built = patchDocument({ moduleUrlOf })
  return renderPatchYamlText(built.document, { header: HEADER })
}

/**
 * 渲染的**完整结论**：文本 + 文档里实际有的行 + 造不出来的行。
 *
 * 只给 `renderPatchYaml()` 的话，"这一层并不完整"这件事就只存在于注释里，
 * 而注释不会被任何判据读。所以把它做成一个返回值，让调用方必须面对它。
 */
export function renderPatchReport({ moduleUrlOf = null } = {}) {
  const built = patchDocument({ moduleUrlOf })
  return Object.freeze({
    text: renderPatchYamlText(built.document, { header: HEADER }),
    /**
     * **声明里**哪些行的 id 真的进了文档。由构造器给出（`built.rendered`）。
     *
     * ★ 此前这里是 `built.document.map((d) => d.id)` —— 读顶层项的 id。
     *   那是错的：新增行嵌在 `insert: [...]` 里，顶层项的 `id` 是 `undefined`；
     *   而 patch-over 项的顶层 `id` 是**被覆盖的目标**（`permission`），不是 Legion 行 id。
     *   于是清单里躺着 `undefined` 与 `'permission'`，而**两行数的计数恰好是 2**，
     *   与"真有两行"对得上——读数因此在行数相等时看起来是证据。
     *
     *   > 一个"把顶层项的 id 当成行 id"的读数，
     *   > 与一个"从来不报告哪些行进去了"的读数，在计数恰好相等时是同一个东西——
     *   > 只不过前者会在行数对得上时假装自己是证据。
     */
    renderedRowIds: built.rendered,
    /** 声明里全部行的 id。 */
    declaredRowIds: Object.freeze(PATCH_LAYER_ROWS.map((r) => r.id)),
    /** 造不出来、因此**不在文档里**的行。 */
    unbuildable: built.unbuildable,
    /**
     * ★ 造不出来、但**模块确实存在**、只是需要一个进程内装配好的组合根的行。
     *
     * 单列这一份是为了让"模块还没写"与"装配路径还没接上"在读数上不同形：
     * 前者要去写一个文件，后者要去把组合根接上（`root.mjs`）。
     * 合成一句"缺 2 行模块"会把后者的真因藏起来。
     */
    runtimeOnly: Object.freeze(
      built.unbuildable
        .filter((u) => u.moduleState === 'runtime-only')
        .map((u) => Object.freeze({ id: u.id, runtimeModule: u.runtimeModule })),
    ),
    /** 这一层是不是完整（声明里每一行都以某种形式进了文档）。 */
    complete: built.unbuildable.length === 0,
  })
}

// ------------------------------------------------------------------ CLI

// 只在被当作脚本直接执行时跑，import 时不产生副作用（测试要 import 上面的函数）。
//
// 判定用 `pathToFileURL` 而不是手拼 `file://${argv[1]}`：在 Windows 上后者得到
// `file://D:/...`（两斜线），而 `import.meta.url` 是 `file:///D:/...`（三斜线），
// 字面比较恒为假 —— CLI 会**静默什么都不做**，看起来像命令成功了。
{
  const { pathToFileURL } = await import('node:url')
  const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url

  if (invokedDirectly) {
    const { writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')

    const here = dirname(fileURLToPath(import.meta.url))
    const target = join(here, 'legion-host.patch.yml')
    const report = renderPatchReport()

    if (process.argv.includes('--write')) {
      writeFileSync(target, report.text, 'utf8')
      console.log(`已写入 ${PATCH_YAML_PATH}（${report.renderedRowIds.length} 行）`)
    } else if (process.argv.includes('--check')) {
      if (!existsSync(target)) {
        console.error(`⛔ ${PATCH_YAML_PATH} 不存在，运行 node runtime/dsh-composition/render.mjs --write`)
        process.exit(1)
      }
      const onDisk = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      if (onDisk !== report.text) {
        console.error(`⛔ ${PATCH_YAML_PATH} 与声明不一致（声明改了但 YAML 未重新生成）`)
        process.exit(1)
      }
      console.log(`✅ ${PATCH_YAML_PATH} 与 patch-layer.mjs 声明一致`)
    } else {
      process.stdout.write(report.text)
    }

    // ★ 缺失的行**必须**报出来。此前这一层"不完整"只写在注释里，
    //   而注释不会被任何判据读——于是"补丁层已就绪"可以一直是绿的。
    if (!report.complete) {
      console.error(`\n⚠️ 补丁层**不完整**：声明 ${report.declaredRowIds.length} 行，文档只有 ${report.renderedRowIds.length} 行。`)
      for (const u of report.unbuildable) console.error(`   · [${u.code}] ${u.detail}`)
      console.error('   缺行不是"暂时没装"：这三个 enforcement 行是强制面的本体，缺了它们启动自检会拒绝注册。')
      process.exitCode = 3
    }
  }
}

// runtime/dsh-composition/render.mjs
// ============================================================================
// 把补丁层声明渲染成一份可落盘的 `cordis.patch.yml` 片段（PRT-214）。
//
// ## 为什么渲染而不是手写 YAML
//
// 补丁层的**声明**（`patch-layer.mjs`）与它的**落盘形式**（YAML）是同一个事实的
// 两种表达。手写两份必然漂移：改了一处忘了另一处，于是自检按新声明判定、
// 实际挂载按旧 YAML 执行 —— 这种不一致最难发现，因为两边各自都"对"。
//
// 因此 YAML 是**生成物**，由一条新鲜度用例守住（`render.test.mjs`）：
// 声明改了而 YAML 没重新生成，CI 直接变红。
//
// ## 为什么这个文件里没有 apply/write
//
// profile 层是 `patchReload: 'live'`，写入会立刻改变**正在运行**的强制面。
// 落盘动作必须是一次显式决策，不能藏在一个"顺手"的函数里。
// 本文件只渲染字符串；写不写、写到哪，由调用方自己决定并留痕。
// ============================================================================

import { DSH_COMPOSITION_PATCH_VERSION, LEGION_PERMISSION_PRESETS, PATCH_LAYER_ROWS } from './patch-layer.mjs'

/** 生成物的仓库内相对路径。 */
export const PATCH_YAML_PATH = 'runtime/dsh-composition/legion-host.patch.yml'

/** 由补丁层声明渲染出 `cordis.patch.yml` 行片段。 */
export function renderPatchYaml() {
  const lines = [
    '# 由 runtime/dsh-composition/render.mjs 生成 —— 请勿手工编辑。',
    `# 对应运行时声明：runtime/dsh-composition/patch-layer.mjs（dshCompositionPatchVersion: ${DSH_COMPOSITION_PATCH_VERSION}）`,
    '# 重新生成：node runtime/dsh-composition/render.mjs --write',
    '#',
    '# 本文件是 Legion 的 host 组合补丁层。它**不**替代 DSH 随部署分发的 preset 安装，',
    '# 只通过产品自己的 profile 层注入。DSH 升级会改变 bundle 结构与 patch 锚点，',
    '# 因此这一层必须与 dshVersion 成对验证（补丁层静默失效比 API 变化更隐蔽）。',
    'patch:',
  ]

  for (const row of PATCH_LAYER_ROWS) {
    lines.push(`  # ${row.purpose}`)
    lines.push(`  - id: ${row.id}`)
    if (row.mount.anchor === 'patch-over') {
      lines.push(`    # patch-over：按 id 覆盖第 ${row.mount.target} 行。DSH 的语义是**替换整个 config**，不是合并。`)
      lines.push(`    target: ${row.mount.target}`)
    } else {
      lines.push(`    insert: after:${row.mount.after}`)
    }
    lines.push(`    plane: ${row.plane}`)
  }

  lines.push('')
  lines.push('# Legion 自有 permission preset 表：**不复用** DSH 默认表。')
  lines.push('# 默认表把 workspace-write↔ask 与 danger-full-access↔never 绑定；')
  lines.push('# 按默认表实现「无人值守 = never」会同时把沙箱降级为 danger-full-access。')
  lines.push('permission:')
  lines.push('  presets:')
  for (const [name, spec] of Object.entries(LEGION_PERMISSION_PRESETS)) {
    lines.push(`    ${name}:`)
    lines.push(`      sandbox: ${spec.sandbox}`)
    lines.push(`      approval: ${spec.approval}`)
    lines.push(`      name: ${spec.name}`)
    lines.push(`      description: ${spec.description}`)
  }
  lines.push('')

  return lines.join('\n')
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
    const text = renderPatchYaml()

    if (process.argv.includes('--write')) {
      writeFileSync(target, text, 'utf8')
      console.log(`已写入 ${PATCH_YAML_PATH}`)
    } else if (process.argv.includes('--check')) {
      if (!existsSync(target)) {
        console.error(`⛔ ${PATCH_YAML_PATH} 不存在，运行 node runtime/dsh-composition/render.mjs --write`)
        process.exit(1)
      }
      const onDisk = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      if (onDisk !== text) {
        console.error(`⛔ ${PATCH_YAML_PATH} 与声明不一致（声明改了但 YAML 未重新生成）`)
        process.exit(1)
      }
      console.log(`✅ ${PATCH_YAML_PATH} 与 patch-layer.mjs 声明一致`)
    } else {
      process.stdout.write(text)
    }
  }
}

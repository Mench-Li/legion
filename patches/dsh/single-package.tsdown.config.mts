// 只为**单个包**打包的 tsdown 配置（由 Legion 持有，不写进 DSH 仓库）。
//
// ## 为什么不用根 `tsdown.config.ts` + `-F`
//
// 那份配置的 `workspace` 是**整仓**的（`vendor/*` + `packages/*/*`），而 `-F` 的匹配口径
// （cwd 或 name）与本仓目录名对不上：实测三种写法都只得到
// `ERROR No valid configuration found`。整仓打包会把 200+ 个包一起重建，
// 对"我只改了 provider 里 20 行"这件事代价过大、也更容易撞上无关失败。
//
// ## 三个必须显式写的参数（都是实测踩出来的）
//
// 1. `process.cwd()`：tsdown 解析相对 `entry` 时以**配置文件所在目录**为基准
//    （配置放在 Legion 仓库里、entry 写相对路径 ⇒ `UNRESOLVED_ENTRY`）。
//    调用方约定在**目标包目录**里运行本配置。
//
// 2. `outExtensions`：`format: ['esm']` 默认产出 `index.mjs`，
//    而包 `main` 写的是 `lib/index.js` —— 名字一错，宿主就加载不到。
//
// 3. `external`：不带 workspace 上下文时，tsdown 会把能解析到的依赖**全部内联**
//    （实测 20.6KB → 2.26MB）。上游产物是**依赖外置**的（bundle 里保留
//    `import … from '@deepseek-ai/…'`），所以这里显式外置所有裸包名，
//    只打包相对导入 —— 形态与 `pnpm run build:lib:host` 的产出保持一致。
//
// 其余参数与根配置逐项相同；唯一缺的是 `typertPlugin`（服务 Client 侧契约声明，
// host-only 的 provider 不需要）。
import { resolve } from 'node:path'

const root = process.cwd()

export default {
  entry: resolve(root, 'lib/types/index.js'),
  outDir: resolve(root, 'lib'),
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  dts: false,
  clean: false,
  // 裸包名一律外置（`node:` 内置模块由 platform: node 自动外置）。
  //
  // ★ 这里是一个**函数**，而不是正则 `/^[^./]/`：tsdown 判定时可能拿到**绝对路径**
  //   （`D:\…\lib\types\run.js`），首字符不是 `.` 也不是 `/`，正则会把相对模块
  //   也判成"外部包" —— 实测产物缩到 3.2KB、只剩 `import './run.js'`，
  //   即源码根本没被合并进去（这种产物**看起来构建成功**，但补丁不在里面）。
  //   函数版逐条排除相对、绝对与盘符路径，于是只有裸包名被外置（实测 20.8KB，与上游一致）。
  //
  // `external` 在 tsdown 0.22 已标记废弃（会打一条 WARN），但它是当前唯一接受
  // **函数**形态的写法；`deps.neverBundle` 只吃正则/字符串，用正则就掉回上面那个坑。
  // 新旧都试过：WARN 无害，判据（产物字节数 + 依赖清单 + 补丁标记）才是准的。
  external: (id) => !id.startsWith('.') && !id.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(id),
}

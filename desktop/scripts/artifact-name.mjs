// desktop/scripts/artifact-name.mjs
// ============================================================================
// 安装包的**文件名**——单一真源。
//
// ## 为什么要有这个文件
//
// 这个名字被**两侧**各自用着，而它们一度不一致：
//
//   · **产出侧**（`build.mjs`）写的是
//       artifactName: 'Legion-${version}-internal-${arch}-setup.${ext}'
//     于是产物叫 `Legion-0.1.2-internal-x64-setup.exe`；
//   · **消费侧**（`team-hub/routes/releases.mjs` 的 `latestInstaller()`、
//     `team-hub/server.mjs` 的门口页、设计文档 §4、
//     `download-lines.mjs` 的样例）要的都是 `Legion-Setup-win-x64.exe`。
//
//   `latestInstaller()` 是**按文件名找**的：它扫 `releases/<id>/` 下有没有
//   `Legion-Setup-win-x64.exe`。名字对不上 ⇒ 它**找不到任何一份**，门口页于是
//   显示"尚未发布"，而发布目录里明明躺着安装包。
//
//   > 一个"产物名叫 A、而找它的人按 B 找"的发布流程，
//   > 与一个跑通的发布流程，在构建日志里都是 `installer: ...exe`——
//   > 只不过前者的门口页会一直说"尚未发布"，而没人会去怀疑文件名。
//
// ## 为什么不是 `-internal-`
//
// `-internal-` 是**通道**的名字，却被硬编码进了每一个产物：一个发到 `stable`
// 的正式安装包也叫 `…-internal-…`。而通道是**发布时**才决定的
// （`publish.mjs --channel`），构建期并不知道，也不该猜。
//
//   设计文档 §4 定的形状本来就没有通道段：
//     /legion/releases/<releaseId>/Legion-Setup-win-x64.exe
//
//   产物放进 `releases/<releaseId>/` 之后，**通道与版本都在路径里**了，
//   文件名再带一遍只会多一处会漂的地方。
//
// ## 为什么不用 `${version}`
//
// 同上：版本在路径段 `<releaseId>` 里。而且 `${version}` 会让**同一个 releaseId
// 的安装包名随版本变**，跨版本对比脚本更难写（要找的永远是同一个名字）。
//
//   > 一个"文件名里带版本号"的产物，
//   > 与一个"名字固定、位置带版本"的产物，在下载页上长得一样——
//   > 只不过前者的链接每次发布都要重新拼一遍，而拼错了就是一个 404。
// ============================================================================

/** 安装包的**基名**（不含扩展名）。两条构建路径与消费侧共用。 */
export const INSTALLER_BASENAME = 'Legion-Setup-win-x64'

/** 安装包的完整文件名。 */
export const INSTALLER_FILENAME = `${INSTALLER_BASENAME}.exe`

/**
 * electron-builder 的 `artifactName` 模板。
 *
 * 只保留 `${ext}`：electron-builder 需要它来填扩展名。刻意**不带**
 * `${version}` / `${arch}` / 通道名 —— 理由见文件头。
 */
export const ARTIFACT_NAME_TEMPLATE = `${INSTALLER_BASENAME}.\${ext}`

/** MIME（下载页与 Hub 托管两边都要用它发 `.exe`）。 */
export const INSTALLER_MIME = 'application/vnd.microsoft.portable-executable'

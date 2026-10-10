import { copyFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { build, Platform, Arch } from 'electron-builder'
import { prepareNsisResources } from './prepare-nsis.mjs'
// ★ 安装包文件名来自**单一真源**。这里原本写着
//   `'Legion-${version}-internal-${arch}-setup.${ext}'`（下面第 32 行还有一份
//   手拼的同名路径），而消费侧（`latestInstaller()`、门口页、设计文档 §4）
//   找的是 `Legion-Setup-win-x64.exe` —— 名字对不上就**找不到任何一份**，
//   门口页于是显示"尚未发布"，而发布目录里明明有安装包。
//   完整来龙去脉见 `artifact-name.mjs` 的文件头。
import { ARTIFACT_NAME_TEMPLATE, INSTALLER_FILENAME } from './artifact-name.mjs'
const root = fileURLToPath(new URL('../../', import.meta.url))
const { shell, resources } = JSON.parse(await readFile(join(root, '.desktop-build', 'current-stage.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'))
if (!process.argv.includes('--dir')) process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = await prepareNsisResources()
const buildStartedAt = performance.now()
const outputDir = join(root, 'desktop', 'dist')
await build({ projectDir: join(root, 'desktop'),
  targets: Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? 'dir' : 'nsis', Arch.x64),
  config: {
    appId: 'labs.legion.desktop', productName: 'Legion', electronVersion: pkg.devDependencies.electron,
    electronDist: join(root, 'desktop', 'node_modules', 'electron', 'dist'),
    directories: { app: shell, output: outputDir },
    asar: true, npmRebuild: false, files: ['**/*'],
    extraResources: [{ from: resources, to: '.', filter: ['**/*'] }],
    mac: { icon: join(root, 'desktop', 'assets', 'icon.icns') },
    linux: { icon: join(root, 'desktop', 'assets', 'icon.png') },
    win: { icon: join(root, 'desktop', 'assets', 'icon.ico'), artifactName: ARTIFACT_NAME_TEMPLATE, signAndEditExecutable: true },
    nsis: { installerIcon: join(root, 'desktop', 'assets', 'icon.ico'), uninstallerIcon: join(root, 'desktop', 'assets', 'icon.ico'), installerHeaderIcon: join(root, 'desktop', 'assets', 'icon.ico'), oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false, runAfterFinish: false },
  },
})
// Keep an easy-to-copy authoring example beside the installer. The installed
// copy remains the verified source used for first-run bootstrap.
const workflowPackSource = join(resources, 'legion', 'workflow-packs', 'software-collaboration.legionpack')
await copyFile(workflowPackSource, join(root, 'desktop', 'dist', 'software-collaboration.legionpack'))
// ★ 与 `artifactName` **同源**（都来自 `artifact-name.mjs`）：这一行原本是手拼的
//   `Legion-${pkg.version}-internal-x64-setup.exe`，与上面的模板各写一份。
//   两处都是错的，但"两处一致地错"让它看起来像是有意的。
const installerPath = join(outputDir, INSTALLER_FILENAME)
let installer = null
if (!process.argv.includes('--dir')) {
  installer = { path: installerPath, bytes: (await stat(installerPath)).size }
}
console.log(JSON.stringify({ buildElapsedMs: Math.round(performance.now() - buildStartedAt), installer }))

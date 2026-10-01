import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { build, Platform, Arch } from 'electron-builder'
import { prepareNsisResources } from './prepare-nsis.mjs'
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
    win: { artifactName: 'Legion-${version}-internal-${arch}-setup.${ext}', signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false, runAfterFinish: false },
  },
})
const installerPath = join(outputDir, `Legion-${pkg.version}-internal-x64-setup.exe`)
let installer = null
if (!process.argv.includes('--dir')) {
  installer = { path: installerPath, bytes: (await stat(installerPath)).size }
}
console.log(JSON.stringify({ buildElapsedMs: Math.round(performance.now() - buildStartedAt), installer }))

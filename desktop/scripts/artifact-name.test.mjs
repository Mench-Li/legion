// desktop/scripts/artifact-name.test.mjs
// ============================================================================
// 判据：安装包的文件名，**产出侧**与**消费侧**必须是同一个。
//
// 守的是 2026-10-10 实测发现的分歧：
//
//   · 产出侧（`build.mjs`）写的是
//       'Legion-${version}-internal-${arch}-setup.${ext}'
//     产物叫 `Legion-0.1.2-internal-x64-setup.exe`；
//   · 消费侧（`latestInstaller()`、门口页、设计文档 §4）找的是
//       `Legion-Setup-win-x64.exe`。
//
//   `latestInstaller()` 是**按文件名找**的 ⇒ 名字对不上，它找不到任何一份，
//   门口页显示"尚未发布"，而发布目录里明明躺着安装包。
//
//   > 一个"产物名叫 A、而找它的人按 B 找"的发布流程，
//   > 与一个跑通的发布流程，在构建日志里都是 `installer: ...exe`——
//   > 只不过前者的门口页会一直说"尚未发布"，而没人会去怀疑文件名。
//
// ## 为什么不只比对两个字符串常量
//
// 比对常量只能证明"两处字面量相同"。这里**真的调** `latestInstaller()`
// 去一个按产出侧名字布置的目录里找 —— 那才是消费侧的实际行为，
// 而它的入参默认值将来换了一种写法（例如从配置读）也照样受这条判据约束。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INSTALLER_BASENAME, INSTALLER_FILENAME, ARTIFACT_NAME_TEMPLATE } from './artifact-name.mjs'
import { latestInstaller } from '../../team-hub/routes/releases.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

describe('安装包文件名（产出侧 == 消费侧）', () => {
  test('① 产出侧的名字就是全仓约定的 Legion-Setup-win-x64.exe', () => {
    assert.equal(INSTALLER_FILENAME, 'Legion-Setup-win-x64.exe')
    assert.equal(INSTALLER_BASENAME, 'Legion-Setup-win-x64')
    // electron-builder 的模板必须能拼出同一个文件名（只留 `${ext}`）。
    assert.equal(ARTIFACT_NAME_TEMPLATE.replace('${ext}', 'exe'), INSTALLER_FILENAME)
    // 名字里**不许**再出现通道段：通道是发布时才知道的，构建期不该猜。
    assert.doesNotMatch(INSTALLER_FILENAME, /internal|stable|canary/,
      '安装包名里不该有通道段 —— 通道在 `releases/<releaseId>/` 的路径里')
    // 也不带版本号：版本同样在路径段里，带一遍就多一处会漂的地方。
    assert.doesNotMatch(INSTALLER_FILENAME, /\d+\.\d+\.\d+/, '安装包名里不该有版本号')
  })

  test('② 消费侧真的能按这个名字找到它（latestInstaller 实调）', () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-artifact-name-'))
    try {
      mkdirSync(join(root, 'releases', 'rel-0.1.3'), { recursive: true })
      // 按**产出侧**的名字放一份"安装包"。
      writeFileSync(join(root, 'releases', 'rel-0.1.3', INSTALLER_FILENAME), Buffer.alloc(64, 7))

      const found = latestInstaller(root)
      assert.ok(found !== null,
        `latestInstaller() 在 releases/rel-0.1.3/ 下找不到 ${INSTALLER_FILENAME}`
        + ' —— 产出侧与消费侧的文件名漂开了，门口页会一直显示"尚未发布"')
      assert.equal(found.releaseId, 'rel-0.1.3')
      assert.ok(found.file.endsWith(INSTALLER_FILENAME))
      assert.equal(found.sizeBytes, 64)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('③ 反例守卫：换一个名字就找不到（证明 ② 不是恒真）', () => {
    const root = mkdtempSync(join(tmpdir(), 'legion-artifact-name-neg-'))
    try {
      mkdirSync(join(root, 'releases', 'rel-0.1.3'), { recursive: true })
      // 旧的、带通道段的名字 —— 消费侧**不该**认得它。
      writeFileSync(join(root, 'releases', 'rel-0.1.3', 'Legion-0.1.3-internal-x64-setup.exe'),
        Buffer.alloc(64, 7))
      assert.equal(latestInstaller(root), null,
        'latestInstaller() 认出了带通道段的旧名字 —— 那 ② 的断言就失去意义了'
        + '（它成了一个"什么都能找到"的判据）')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('④ build.mjs 里不再自己写这个名字（防止将来又各写一份）', () => {
    const source = readFileSync(join(HERE, 'build.mjs'), 'utf8')
    // 只扫**代码行**，不扫注释 —— 注释里引用了旧名字来解释历史，
    // 那是文档，不是回归（这条教训在 `payload-filter.test.mjs` 上吃过一次）。
    const code = source.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    assert.match(code, /from '\.\/artifact-name\.mjs'/,
      'build.mjs 没有从 artifact-name.mjs 取文件名')
    assert.doesNotMatch(code, /internal-x64-setup|internal-\$\{arch\}/,
      'build.mjs 的**代码**里又出现了手写的安装包名 —— 那正是漂开的那个写法')
    assert.doesNotMatch(code, /artifactName:\s*'/,
      'build.mjs 的 artifactName 又写成了字面量，应当用 ARTIFACT_NAME_TEMPLATE')
  })

  test('⑤ 门口页/设计文档那侧的样本 URL 用的是同一个名字', async () => {
    // `download-lines.mjs` 的样例线路表是"下载页 URL 长什么样"的文档化答案。
    const { sampleLinesConfig } = await import('../../team-hub/download-lines.mjs')
    for (const line of sampleLinesConfig().lines) {
      assert.ok(line.url.endsWith(`/${INSTALLER_FILENAME}`),
        `样例线路 ${line.id} 的 URL 结尾不是 ${INSTALLER_FILENAME}：${line.url}`)
    }
  })

  test('⑥ 仓库根存在（防止 ROOT 写错后上面几条在错误的目录上通过）', () => {
    // 这条是"判据本身别写错"的守卫：ROOT 指到别处时，devDependencies 会读不到。
    const pkg = JSON.parse(readFileSync(join(ROOT, 'desktop', 'package.json'), 'utf8'))
    assert.ok(pkg.devDependencies?.electron, 'ROOT 没指到仓库根')
  })
})

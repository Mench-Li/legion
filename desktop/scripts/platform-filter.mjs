import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The Windows x64 NSIS target intentionally filters these node-pty ARM64
// binaries. Remove them before inventory generation so the signed release
// manifest describes exactly what the x64 installer can deliver.
export const WINDOWS_X64_EXCLUDED_PAYLOADS = Object.freeze([
  'node_modules/node-pty/prebuilds/win32-arm64',
  'node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64',
])

export async function pruneWindowsX64Payload(dshRoot, { remove = rm } = {}) {
  for (const relative of WINDOWS_X64_EXCLUDED_PAYLOADS) {
    await remove(join(dshRoot, ...relative.split('/')), { recursive: true, force: true })
  }
  // Source maps and TypeScript declaration files are development/debug metadata;
  // Node never executes them. Excluding them saves installer file operations
  // while leaving executable code, runtime TypeScript sources and licenses intact.
  async function removeDevelopmentMetadata(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await removeDevelopmentMetadata(path)
      else if (entry.isFile() && (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts'))) await remove(path, { force: true })
      else if (entry.isSymbolicLink()) throw Object.assign(new Error('Payload link rejected'), { code: 'BUNDLE_LINK_REJECTED' })
    }
  }
  await removeDevelopmentMetadata(dshRoot)
}

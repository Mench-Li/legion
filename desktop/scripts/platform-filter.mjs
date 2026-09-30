import { rm } from 'node:fs/promises'
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
}

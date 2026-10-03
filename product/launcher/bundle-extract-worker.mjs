import { createRequire } from 'node:module'

const [, , archivePath, destination, vendorRoot] = process.argv
if (![archivePath, destination, vendorRoot].every(value => typeof value === 'string' && value.length > 0)) process.exit(2)
try {
  const asar = createRequire(`${vendorRoot}/package.json`)('@electron/asar')
  asar.extractAll(archivePath, destination)
} catch {
  process.exitCode = 1
}

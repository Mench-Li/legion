import { normalize, join, sep } from 'node:path'

/**
 * Shared lexical artifact-path policy for scrum/serve.mjs and board-plugin.
 * Realpath checks remain at each file-serving boundary because roots are runtime-configured.
 */
export function normalizeArtifactPath(raw, roots) {
  const p = String(raw ?? '').trim()
  if (!p) return null
  const rootList = roots.map(root => normalize(root))
  const winAbs = /^[A-Za-z]:[\\/]/.test(p)
  const posixAbs = p.startsWith('/') || p.startsWith('\\\\')
  if (winAbs || posixAbs) {
    const n = normalize(p)
    return rootList.some(root => n === root || n.startsWith(root + sep)) ? { path: n, absolute: true, segments: null } : null
  }
  let rel = p.replace(/\\/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  rel = rel.replace(/^\/+/, '')
  const segments = rel.split('/').filter(Boolean)
  if (segments.length === 0 || segments.includes('..') || segments.some(x => x.toLowerCase() === '.git')) return null
  return { path: join(rootList[0], ...segments), absolute: false, segments }
}


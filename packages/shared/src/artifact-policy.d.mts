export type ArtifactPath = { path: string; absolute: boolean; segments: string[] | null }
export function normalizeArtifactPath(raw: unknown, roots: string[]): ArtifactPath | null

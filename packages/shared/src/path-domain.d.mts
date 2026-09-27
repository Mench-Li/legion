export interface PathOpts { caseInsensitive?: boolean }
export type PathRejectionCode = 'empty-path' | 'absolute-path' | 'path-traversal' | 'git-internal' | 'invalid-entry-type' | 'invalid-entry-shape'
export interface PathRejection { ok: false, code: PathRejectionCode, reason: string }
export interface NormalizedPath { ok: true, path: string, segments: readonly string[], caseInsensitive: boolean }
export type PathEntryType = 'file' | 'dir'
export interface PathEntryInput { path: string, type: PathEntryType }
export interface NormalizedEntry { ok: true, path: string, type: PathEntryType }
export declare const PATH_REJECTION_CODES: Readonly<Record<string, string>>
export function normalizeRepoPath(raw: unknown, opts?: PathOpts): NormalizedPath | PathRejection
export function classifyEntry(entry: string | PathEntryInput, opts?: PathOpts): NormalizedEntry | PathRejection
export function toEntryList(value: unknown, opts?: PathOpts): { entries: readonly NormalizedEntry[], rejected: readonly PathRejection[] }
export function normalizedEntriesOverlap(a: NormalizedEntry, b: NormalizedEntry): boolean
export function pathsIntersect(a: unknown, b: unknown, opts?: PathOpts): boolean
export function intersectingPaths(a: unknown, b: unknown, opts?: PathOpts): readonly { a: string, b: string, aType: PathEntryType, bType: PathEntryType }[]
export function expandRename(rename: { from?: string, to?: string }, opts?: PathOpts): readonly NormalizedEntry[]
export function normalizePathSet(paths: unknown, opts?: PathOpts): { ok: boolean, entries: readonly NormalizedEntry[], rejected: readonly { raw: string, code: string, reason: string }[] }

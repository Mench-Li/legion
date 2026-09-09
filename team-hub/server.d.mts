/**
 * Ambient 类型声明：`src/index.ts` 以相对路径复用 v2 权威实现 `team-hub/server.mjs`
 * （P1-1 合并：宿主 /team-hub 与独立 8787 服务共享同一业务实现/数据池）。
 * 仅供 tsc 类型解析；运行时由 NodeNext 直接加载 team-hub/server.mjs。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const DEFAULT_DB_FILE: string
export const db: unknown
export const server: unknown
export function handle(req: IncomingMessage, res: ServerResponse, stripPrefix?: string): Promise<void>
export function disposeHub(): void
export function registerSkill(input: unknown): unknown
export function reviewSkill(id: unknown, action: unknown): unknown
export function listSkills(input: unknown): unknown
export function grantSkill(id: unknown, grants: unknown): unknown
export function revokeSkill(id: unknown, targets: unknown): unknown
export function getSkill(id: unknown): unknown
export function getSkillSource(scope?: string): unknown
export function setSkillSource(input: unknown): unknown
export function publishGoalRecord(input: unknown): unknown
export function setGoalState(id: unknown, to: unknown, by?: string, forceGeneral?: boolean): unknown
export function setGoalContext(id: unknown, text: unknown, by?: string, forceGeneral?: boolean): unknown
export function listGoals(scope?: string): unknown
export function goalView(row: unknown): unknown
export function settleGoalsOfScope(scope: string, by?: string): unknown
export function createGoalChain(input: unknown): unknown
export function goalDocDirOf(goalId: string): string
export function goalDocPathOf(goalId: string, filename: string): string
export function expandGoalSlices(input: unknown): unknown
export function createTask(input: unknown): unknown

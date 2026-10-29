// Type surface for the runtime-side DSH event mapper used by the Worker.
// The implementation lives in `events.mjs`; this file exists so the Worker's
// TypeScript build can consume it without `any` at the call site.

/** One DSH event mapped onto the Legion RunEvent vocabulary. */
export interface DshMappedEvent {
  /** Contract event type; `run.progress` when the raw type is unrecognized. */
  type: string
  /** True when the raw DSH type was not in the mapping table. */
  unmapped: boolean
  /** Redacted payload fields carried alongside the type. */
  payload: Record<string, unknown>
  /** Payload keys that were redacted, when any. */
  redactedPaths?: string[]
}

/** Map one raw DSH run event to a Legion RunEvent load. */
export function mapDshEvent(raw: unknown): DshMappedEvent

/** DSH event name → contract RunEvent type. */
export const DSH_EVENT_MAP: Readonly<Record<string, string>>

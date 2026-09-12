/**
 * Edge-plane projection of bridge/contract/turn.schema.json.
 *
 * The JSON Schema is canonical. `contract.parity.test.ts` fails the build if
 * this file drifts from it, so "single source of truth" is enforced rather
 * than merely asserted in a comment.
 */

export const CONTRACT_VERSION = "turn.v1" as const;

export interface TraceContext {
  /** 16-byte hex, W3C traceparent trace-id. One trace spans BOTH planes. */
  trace_id: string;
  /** 8-byte hex; the edge-side span that originated the turn. */
  span_id: string;
  sampled?: boolean;
}

export type TargetKind = "agent" | "team" | "workflow";

export interface Target {
  kind: TargetKind;
  id: string;
}

export interface Attachment {
  kind: "image" | "audio" | "video" | "file";
  uri: string;
  mime_type?: string;
  size_bytes?: number;
}

export interface Principal {
  user_id: string;
  display_name?: string;
  channel: string;
  channel_user?: string;
  /** The brain plane ENFORCES these, not merely logs them. */
  scopes?: string[];
}

export interface TurnRequest {
  /** Idempotency key. Redelivery must not execute twice. */
  turn_id: string;
  session_id: string;
  target: Target;
  input: { text: string; attachments?: Attachment[] };
  principal: Principal;
  trace: TraceContext;
  options?: { stream?: boolean; timeout_ms?: number };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: number;
  duration_ms?: number;
}

export type TurnEvent =
  | { type: "run.started"; turn_id: string; run_id?: string; ts: string }
  | { type: "output.delta"; turn_id: string; text: string; ts: string }
  | { type: "reasoning.delta"; turn_id: string; text: string; ts: string }
  | { type: "tool.started"; turn_id: string; tool: string; args_preview?: string; ts: string }
  | { type: "tool.completed"; turn_id: string; tool: string; ok: boolean; error?: string; ts: string }
  | { type: "approval.required"; turn_id: string; approval_id: string; prompt: string; tool?: string; ts: string }
  | { type: "run.completed"; turn_id: string; run_id?: string; output: string; usage?: Usage; ts: string }
  | { type: "run.failed"; turn_id: string; error: string; retryable?: boolean; ts: string };

export type TurnEventType = TurnEvent["type"];

export const TERMINAL_EVENT_TYPES = ["run.completed", "run.failed"] as const;

export function isTerminal(ev: TurnEvent): ev is Extract<TurnEvent, { type: "run.completed" | "run.failed" }> {
  return ev.type === "run.completed" || ev.type === "run.failed";
}

export interface ApprovalDecision {
  approval_id: string;
  decision: "approve" | "deny";
  principal: Principal;
  reason?: string;
}

/** Generates a W3C-shaped trace context for a turn originating at the edge. */
export function newTraceContext(): TraceContext {
  const hex = (bytes: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return { trace_id: hex(16), span_id: hex(8), sampled: true };
}

/**
 * Runtime-visible list of every TurnEvent discriminator.
 *
 * TypeScript types are erased at runtime, so the union above cannot be compared
 * against the canonical JSON Schema by a test. This array is the runtime mirror,
 * and the two assertions below make it impossible to drift from the union
 * WITHOUT tsc failing:
 *
 *   - `_AllUnionMembersListed` fails if a union member is missing from the array.
 *   - `_NoExtraMembersListed`  fails if the array names something not in the union.
 *
 * `contract.parity.test.ts` then checks this array against turn.schema.json, so
 * schema -> array -> union is closed end to end.
 */
export const TURN_EVENT_TYPES = [
  "run.started",
  "output.delta",
  "reasoning.delta",
  "tool.started",
  "tool.completed",
  "approval.required",
  "run.completed",
  "run.failed",
] as const;

type _AllUnionMembersListed =
  Exclude<TurnEventType, (typeof TURN_EVENT_TYPES)[number]> extends never ? true : never;
type _NoExtraMembersListed =
  Exclude<(typeof TURN_EVENT_TYPES)[number], TurnEventType> extends never ? true : never;

const _unionCoverage: _AllUnionMembersListed = true;
const _arrayCoverage: _NoExtraMembersListed = true;
void _unionCoverage;
void _arrayCoverage;

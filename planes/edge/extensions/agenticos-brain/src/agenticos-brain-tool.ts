// AgenticOS Brain plugin module implements the brain-plane turn tool.
import { createHash } from "node:crypto";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { BrainClient } from "../vendor/client.ts";
import {
  newTraceContext,
  type Target,
  type TargetKind,
  type TurnEvent,
  type TurnRequest,
  type Usage,
} from "../vendor/contract.ts";

export const DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:8899";
export const DEFAULT_TURN_TIMEOUT_MS = 120_000;
export const DEFAULT_TURN_SCOPES = ["turns:create"] as const;
export const BRIDGE_TOKEN_ENV = "AGENTICOS_BRIDGE_TOKEN";
export const PLUGIN_ID = "agenticos-brain";

const TARGET_KINDS: readonly TargetKind[] = ["agent", "team", "workflow"];
/** Mirrors Target.id maxLength in bridge/contract/turn.schema.json; fail closed before dispatch. */
const TARGET_ID_MAX_LENGTH = 128;

export type PluginCfg = {
  baseUrl?: unknown;
  authToken?: unknown;
  timeoutMs?: unknown;
  defaultTarget?: unknown;
};

type BrainTurnParams = {
  text?: unknown;
  target_kind?: unknown;
  target_id?: unknown;
  session_id?: unknown;
  scopes?: unknown;
};

export type BrainTurnToolRecord = {
  tool: string;
  started_at: string;
  args_preview?: string;
  completed_at?: string;
  ok?: boolean;
  error?: string;
};

export type BrainTurnCompletedDetails = {
  turn_id: string;
  run_id?: string;
  usage?: Usage;
  tools: BrainTurnToolRecord[];
  reasoning_chars: number;
  trace_id: string;
};

export type BrainTurnPendingDetails = {
  approval_id: string;
  turn_id: string;
  pending: true;
  tool?: string;
  expires_at?: string;
  trace_id: string;
};

export type BrainTurnToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: BrainTurnCompletedDetails | BrainTurnPendingDetails;
};

export const agenticosBrainToolDefinition = {
  name: "agenticos_brain_turn",
  label: "AgenticOS Brain Turn",
  description:
    "Dispatch one turn to the AgenticOS brain plane (Agno agent, team, or workflow) over the bridge and return the brain's final output. Streams tool and reasoning activity into details.",
  parameters: Type.Object({
    text: Type.String({ description: "User-facing input text for the brain-plane turn." }),
    target_kind: Type.Optional(
      Type.Union([Type.Literal("agent"), Type.Literal("team"), Type.Literal("workflow")], {
        description: "Brain-plane executor kind. Defaults to the plugin's defaultTarget.kind.",
      }),
    ),
    target_id: Type.Optional(
      Type.String({
        description: "Brain-plane executor id. Defaults to the plugin's defaultTarget.id.",
      }),
    ),
    session_id: Type.Optional(
      Type.String({
        description:
          "Conversation of record on the brain plane. Defaults to a stable id derived from the current OpenClaw session.",
      }),
    ),
    scopes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Principal scopes the brain plane enforces. Defaults to ["turns:create"].',
      }),
    ),
  }),
};

export type CreateAgenticosBrainToolOptions = {
  api: OpenClawPluginApi;
  toolContext?: OpenClawPluginToolContext;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
};

function isTargetKind(value: unknown): value is TargetKind {
  return typeof value === "string" && (TARGET_KINDS as readonly string[]).includes(value);
}

function assertTargetId(id: string, source: string): string {
  if (id.length > TARGET_ID_MAX_LENGTH) {
    throw new Error(`${source} must be at most ${TARGET_ID_MAX_LENGTH} characters`);
  }
  return id;
}

function readConfiguredTarget(raw: unknown): Target | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as { kind?: unknown; id?: unknown };
  const id = normalizeOptionalString(record.id);
  if (!isTargetKind(record.kind) || !id) {
    throw new Error(
      `plugins.entries.${PLUGIN_ID}.config.defaultTarget must be { kind: "agent"|"team"|"workflow", id: string }`,
    );
  }
  return {
    kind: record.kind,
    id: assertTargetId(id, `plugins.entries.${PLUGIN_ID}.config.defaultTarget.id`),
  };
}

function resolveTarget(params: BrainTurnParams, pluginCfg: PluginCfg): Target {
  const requestedKind = params.target_kind;
  const requestedId = normalizeOptionalString(params.target_id);
  if (requestedKind !== undefined && requestedKind !== null && !isTargetKind(requestedKind)) {
    throw new Error(`target_kind must be one of ${TARGET_KINDS.join(", ")}`);
  }
  if (isTargetKind(requestedKind) && requestedId) {
    return { kind: requestedKind, id: assertTargetId(requestedId, "target_id") };
  }
  if (isTargetKind(requestedKind) !== Boolean(requestedId)) {
    throw new Error("target_kind and target_id must be provided together");
  }
  const configured = readConfiguredTarget(pluginCfg.defaultTarget);
  if (configured) {
    return configured;
  }
  throw new Error(
    `no brain-plane target: pass target_kind + target_id, or set plugins.entries.${PLUGIN_ID}.config.defaultTarget`,
  );
}

function resolveScopes(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [...DEFAULT_TURN_SCOPES];
  }
  if (!Array.isArray(raw)) {
    throw new Error("scopes must be an array of non-empty strings");
  }
  const scopes = raw.map((entry) => normalizeOptionalString(entry));
  if (scopes.some((scope) => !scope)) {
    throw new Error("scopes must be an array of non-empty strings");
  }
  return scopes as string[];
}

/** Deterministic UUID-shaped id derived from an OpenClaw session key, so one edge session maps to one brain session. */
export function stableSessionIdFromKey(sessionKey: string): string {
  const hex = createHash("sha256").update(`openclaw-session:${sessionKey}`).digest("hex");
  // Format as an RFC 4122 v4-shaped UUID (version/variant nibbles fixed) purely for shape consistency.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function resolveSessionId(
  params: BrainTurnParams,
  toolContext?: OpenClawPluginToolContext,
): string {
  const requested = normalizeOptionalString(params.session_id);
  if (requested) {
    return requested;
  }
  const contextSessionId = normalizeOptionalString(toolContext?.sessionId);
  if (contextSessionId) {
    return contextSessionId;
  }
  const sessionKey = normalizeOptionalString(toolContext?.sessionKey);
  if (sessionKey) {
    return stableSessionIdFromKey(sessionKey);
  }
  return crypto.randomUUID();
}

export function resolveAuthToken(pluginCfg: PluginCfg, env: Record<string, string | undefined>) {
  return (
    normalizeOptionalString(pluginCfg.authToken) ?? normalizeOptionalString(env[BRIDGE_TOKEN_ENV])
  );
}

export function resolveBaseUrl(pluginCfg: PluginCfg): string {
  const raw = normalizeOptionalString(pluginCfg.baseUrl) ?? DEFAULT_BRIDGE_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`plugins.entries.${PLUGIN_ID}.config.baseUrl is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`plugins.entries.${PLUGIN_ID}.config.baseUrl must use http or https`);
  }
  return raw;
}

function formatFailure(ev: Extract<TurnEvent, { type: "run.failed" }>): string {
  const retryable = ev.retryable === true;
  const parts = [`brain turn ${ev.turn_id} failed: ${ev.error}`, `retryable=${retryable}`];
  if (ev.reason) {
    parts.push(`reason=${ev.reason}`);
  }
  if (/\b409\b/.test(ev.error)) {
    parts.push("HTTP 409: idempotency replay, this turn_id was already executed by the brain");
  }
  return parts.join(" | ");
}

export function createAgenticosBrainTool(options: CreateAgenticosBrainToolOptions) {
  const { api, toolContext } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;

  return {
    ...agenticosBrainToolDefinition,

    async execute(
      _id: string,
      params: BrainTurnParams,
      signal?: AbortSignal,
    ): Promise<BrainTurnToolResult> {
      const text = typeof params.text === "string" ? params.text : "";
      if (!text.trim()) {
        throw new Error("text required");
      }
      if (signal?.aborted) {
        throw new Error("brain turn aborted before dispatch");
      }

      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
      const baseUrl = resolveBaseUrl(pluginCfg);
      const timeoutMs = asPositiveSafeInteger(pluginCfg.timeoutMs) ?? DEFAULT_TURN_TIMEOUT_MS;
      const authToken = resolveAuthToken(pluginCfg, env);
      const target = resolveTarget(params, pluginCfg);
      const scopes = resolveScopes(params.scopes);
      const sessionId = resolveSessionId(params, toolContext);
      const trace = newTraceContext();

      const turn: TurnRequest = {
        // Fresh per invocation: idempotency is per tool call, never per session.
        turn_id: crypto.randomUUID(),
        session_id: sessionId,
        target,
        input: { text },
        principal: {
          user_id: normalizeOptionalString(toolContext?.requesterSenderId) ?? "edge",
          channel: "openclaw",
          scopes,
        },
        trace,
        options: { stream: true, timeout_ms: timeoutMs },
      };

      const client = new BrainClient({ baseUrl, authToken, timeoutMs, fetchImpl });
      api.logger.debug?.(
        `[${PLUGIN_ID}] dispatch turn=${turn.turn_id} target=${target.kind}/${target.id} trace=${trace.trace_id}`,
      );

      let output = "";
      let runId: string | undefined;
      let reasoningChars = 0;
      const tools: BrainTurnToolRecord[] = [];

      for await (const ev of client.dispatch(turn, signal)) {
        switch (ev.type) {
          case "run.started":
            runId = ev.run_id ?? runId;
            break;
          case "output.delta":
            output += ev.text;
            break;
          case "reasoning.delta":
            reasoningChars += ev.text.length;
            break;
          case "tool.started":
            tools.push({
              tool: ev.tool,
              started_at: ev.ts,
              ...(ev.args_preview !== undefined ? { args_preview: ev.args_preview } : {}),
            });
            break;
          case "tool.completed": {
            const open = tools
              .toReversed()
              .find((entry) => entry.tool === ev.tool && entry.completed_at === undefined);
            const record: BrainTurnToolRecord = open ?? { tool: ev.tool, started_at: ev.ts };
            if (!open) {
              tools.push(record);
            }
            record.completed_at = ev.ts;
            record.ok = ev.ok;
            if (ev.error !== undefined) {
              record.error = ev.error;
            }
            break;
          }
          case "approval.required":
            // v1: never auto-approve. Surface the pause to the caller and stop consuming.
            return {
              content: [{ type: "text", text: `Approval required: ${ev.prompt}` }],
              details: {
                approval_id: ev.approval_id,
                turn_id: ev.turn_id,
                pending: true,
                ...(ev.tool !== undefined ? { tool: ev.tool } : {}),
                ...(ev.expires_at !== undefined ? { expires_at: ev.expires_at } : {}),
                trace_id: trace.trace_id,
              },
            };
          case "run.completed": {
            // The terminal event's `output` is the brain's canonical final text; the
            // concatenated deltas are the fallback for executors that never streamed.
            const finalText = ev.output.length > 0 ? ev.output : output;
            return {
              content: [{ type: "text", text: finalText }],
              details: {
                turn_id: ev.turn_id,
                ...((ev.run_id ?? runId) ? { run_id: ev.run_id ?? runId } : {}),
                ...(ev.usage ? { usage: ev.usage } : {}),
                tools,
                reasoning_chars: reasoningChars,
                trace_id: trace.trace_id,
              },
            };
          }
          case "run.failed":
            throw new Error(formatFailure(ev));
          default: {
            const unhandled: never = ev;
            api.logger.warn?.(
              `[${PLUGIN_ID}] ignoring unknown bridge event ${String((unhandled as { type?: unknown }).type)}`,
            );
          }
        }
      }

      // BrainClient guarantees a terminal event; this is a fail-closed guard against contract drift.
      throw new Error(`brain turn ${turn.turn_id} ended without a terminal event | retryable=true`);
    },
  };
}

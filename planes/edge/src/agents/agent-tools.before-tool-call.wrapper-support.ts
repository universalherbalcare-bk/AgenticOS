/**
 * Support for the before_tool_call execution wrapper: tool-owned param preparation and
 * finalization, the blocked/failure error types, adjusted-param replay bookkeeping and the
 * standard blocked tool result. Split out of agent-tools.before-tool-call.wrapper.ts so the
 * wrapper itself holds only the execution boundary.
 */
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveToolErrorDiagnostic } from "./agent-tools.before-tool-call.diagnostics.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  preExecutionBlockedToolCallIds,
  recordStructuredReplaySafeToolCall,
  structuredReplaySafeToolCallIds,
} from "./agent-tools.before-tool-call.state.js";
import type {
  BeforeToolCallFailureDisposition,
  HookBlockedReason,
  HookContext,
} from "./agent-tools.before-tool-call.types.js";
import { getChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { reconcileCodeModeExecBeforeHookParams } from "./code-mode-control-tools.js";
import {
  formatToolExecutionErrorMessage,
  isTrustedToolExecutionPreflightError,
  registerTrustedToolNoStartError,
} from "./tool-result-error.js";
import type { AnyAgentTool } from "./tools/common.js";

export const MAX_TRACKED_ADJUSTED_PARAMS = 1024;

/** Run tool-owned preparation while retaining the exact prepared object. */
export async function prepareBeforeToolCallExecutionParams(params: {
  tool: AnyAgentTool;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<unknown> {
  const prepare = params.tool.prepareBeforeToolCallParams;
  return prepare
    ? await prepare(params.params, {
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(params.ctx ? { hookContext: params.ctx } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      })
    : params.params;
}

/** Reconcile hook rewrites and restore tool-owned state before execution. */
export function finalizeBeforeToolCallExecutionParams(params: {
  tool: AnyAgentTool;
  preparedParams: unknown;
  hookParams: unknown;
  adjustedParams: unknown;
  finalizerMode: "adapter" | "wrapped";
}): unknown {
  const reconciledParams = reconcileCodeModeExecBeforeHookParams({
    owner: { tool: params.tool },
    originalParams: params.preparedParams,
    hookParams: params.hookParams,
    adjustedParams: params.adjustedParams,
  });
  // Tool preparation may key private state in a WeakMap by this exact object.
  // Keep the original identity until finalization transfers valid state to rewrites.
  const finalize = params.tool.finalizeBeforeToolCallParams;
  if (!finalize) {
    return reconciledParams;
  }
  if (params.finalizerMode === "adapter") {
    return finalize(reconciledParams, params.preparedParams);
  }
  return finalize.call(params.tool, reconciledParams, params.preparedParams) ?? reconciledParams;
}

export class BeforeToolCallBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BeforeToolCallBlockedError";
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.beforeToolCallBlockedErrorTestApi")
  ] = {
    create(message: string): Error {
      return new BeforeToolCallBlockedError(message);
    },
  };
}

export class BeforeToolCallFailureError extends Error {
  constructor(
    message: string,
    readonly disposition: BeforeToolCallFailureDisposition,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BeforeToolCallFailureError";
  }
}

export function tagBeforeToolCallFailure(
  error: unknown,
  signal?: AbortSignal,
  stage?: "tool_preparation" | "before_tool_call",
): BeforeToolCallFailureError {
  try {
    if (error instanceof BeforeToolCallFailureError) {
      return error;
    }
  } catch {
    // Continue through the guarded formatter and classifier for hostile values.
  }
  const message = formatToolExecutionErrorMessage(error, "before_tool_call failed");
  const disposition = resolveToolErrorDiagnostic(error, signal).terminalReason;
  const tagged = new BeforeToolCallFailureError(message, disposition, error);
  if (stage === "tool_preparation" && isTrustedToolExecutionPreflightError(error)) {
    registerTrustedToolNoStartError(tagged);
  }
  return tagged;
}

/** Return the closed terminal disposition carried by a before-tool failure. */
export function getBeforeToolCallFailureDisposition(
  error: unknown,
): BeforeToolCallFailureDisposition | undefined {
  try {
    return error instanceof BeforeToolCallFailureError ? error.disposition : undefined;
  } catch {
    return undefined;
  }
}

/** Remember hook-adjusted params for later adapter-side execution. */
export function recordAdjustedParamsForToolCall(
  toolCallId: string | undefined,
  params: unknown,
  runId?: string,
): void {
  if (!toolCallId) {
    return;
  }
  const cloneResult = cloneParamsForAdjustedReplay(params);
  if (!cloneResult.ok) {
    return;
  }
  adjustedParamsByToolCallId.set(buildAdjustedParamsKey({ runId, toolCallId }), cloneResult.value);
  pruneMapToMaxSize(adjustedParamsByToolCallId, MAX_TRACKED_ADJUSTED_PARAMS);
}

function cloneParamsForAdjustedReplay(
  params: unknown,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: structuredClone(params) };
  } catch {
    return { ok: false };
  }
}

/** Record that one concrete core-owned tool call may use structured replay classification. */
export function recordStructuredReplayTrustForToolCall(
  toolCallId: string | undefined,
  tool: AnyAgentTool,
  runId?: string,
): void {
  if (!toolCallId || getPluginToolMeta(tool) || getChannelAgentToolMeta(tool as never)) {
    return;
  }
  recordStructuredReplaySafeToolCall(toolCallId, runId);
  while (structuredReplaySafeToolCallIds.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = structuredReplaySafeToolCallIds.values().next().value;
    if (!oldest) {
      break;
    }
    structuredReplaySafeToolCallIds.delete(oldest);
  }
}

/**
 * Returns true when an error represents an intentional before_tool_call veto.
 */
export function isBeforeToolCallBlockedError(err: unknown): err is BeforeToolCallBlockedError {
  return err instanceof BeforeToolCallBlockedError;
}

const preExecutionBlockedToolResults = new WeakSet<object>();

export function isPreExecutionBlockedToolResult(result: unknown): boolean {
  return (
    result !== null && typeof result === "object" && preExecutionBlockedToolResults.has(result)
  );
}

/** Build the standard terminal result for vetoed tool calls. */
export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
  toolCallId?: string;
  runId?: string;
}) {
  recordPreExecutionBlockedToolCall(params.toolCallId, params.runId);
  const result = {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
  preExecutionBlockedToolResults.add(result);
  return result;
}

export function recordPreExecutionBlockedToolCall(toolCallId?: string, runId?: string): void {
  if (!toolCallId) {
    return;
  }
  preExecutionBlockedToolCallIds.add(buildAdjustedParamsKey({ runId, toolCallId }));
  while (preExecutionBlockedToolCallIds.size > MAX_TRACKED_ADJUSTED_PARAMS) {
    const oldest = preExecutionBlockedToolCallIds.values().next().value;
    if (!oldest) {
      break;
    }
    preExecutionBlockedToolCallIds.delete(oldest);
  }
}

/**
 * Adapts runtime AgentTool objects into session ToolDefinition entries.
 * Owns hook execution, client-tool delegation, result coercion, and safe
 * logging for failed tool calls.
 */
import { logDebug, logError } from "../logger.js";
import { isPlainObject } from "../utils.js";
import {
  describeToolExecutionError,
  describeToolFailureInputs,
} from "./agent-tool-definition-adapter.logging.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  buildBlockedToolResult,
  isToolWrappedWithBeforeToolCallHook,
  isBeforeToolCallBlockedError,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
  runBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { consumeFinalClientVoiceToolConfirmation } from "./agent-tools.before-tool-call.policy.js";
import {
  finalizeBeforeToolCallExecutionParams,
  prepareBeforeToolCallExecutionParams,
} from "./agent-tools.before-tool-call.wrapper.js";
import {
  createInternalExecutionPreparer,
  readInternalExecutionControl,
} from "./agent-tools.execution-preparer.js";
import {
  runAgentToolKernelAuthorityGate,
  runToolUnderKernelAuthority,
} from "./agent-tools.kernel-authority-gate.js";
import {
  copyCodeModeControlToolIdentity,
  getCodeModeExecBeforeHookMetadata,
  normalizeCodeModeExecBeforeHookParams,
} from "./code-mode-control-tools.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import type { ToolDefinition } from "./sessions/index.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { jsonResult, payloadTextResult, ToolInputError } from "./tools/common.js";

type AnyAgentTool = AgentTool;

type ToolExecuteArgsCurrent = [
  string,
  unknown,
  AbortSignal | undefined,
  AgentToolUpdateCallback | undefined,
  unknown,
];
type ToolExecuteArgsLegacy = [
  string,
  unknown,
  AgentToolUpdateCallback | undefined,
  unknown,
  AbortSignal | undefined,
];
type ToolExecuteArgs = ToolDefinition["execute"] extends (...args: infer P) => unknown
  ? P
  : ToolExecuteArgsCurrent;
type ToolExecuteArgsAny = ToolExecuteArgs | ToolExecuteArgsLegacy | ToolExecuteArgsCurrent;

type ClientToolCallRecorder =
  | ((toolName: string, params: Record<string, unknown>) => void)
  | {
      reserve?: (toolCallId: string, toolName: string) => void;
      complete: (toolCallId: string, toolName: string, params: Record<string, unknown>) => void;
      discard?: (toolCallId: string, toolName: string) => void;
    };

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && "aborted" in value;
}

function isLegacyToolExecuteArgs(args: ToolExecuteArgsAny): args is ToolExecuteArgsLegacy {
  const third = args[2];
  const fifth = args[4];
  if (typeof third === "function") {
    return true;
  }
  return isAbortSignal(fifth);
}

function normalizeToolExecutionResult(params: {
  toolName: string;
  result: unknown;
}): AgentToolResult<unknown> {
  const { toolName, result } = params;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return result as AgentToolResult<unknown>;
    }
    logDebug(`tools: ${toolName} returned non-standard result (missing content[]); coercing`);
    const details = "details" in record ? record.details : record;
    const safeDetails = details ?? { status: "ok", tool: toolName };
    return payloadTextResult(safeDetails);
  }
  const safeDetails = result ?? { status: "ok", tool: toolName };
  return payloadTextResult(safeDetails);
}

function buildToolExecutionErrorResult(params: {
  toolName: string;
  message: string;
}): AgentToolResult<unknown> {
  return jsonResult({
    status: "error",
    tool: params.toolName,
    error: params.message,
  });
}

async function executeAdaptedToolOperation(params: {
  toolCallId: string;
  normalizedToolName: string;
  rawParams: unknown;
  getEffectiveParams: () => unknown;
  signal: AbortSignal | undefined;
  run: () => Promise<unknown>;
  hookContext: HookContext | undefined;
}): Promise<AgentToolResult<unknown>> {
  try {
    return normalizeToolExecutionResult({
      toolName: params.normalizedToolName,
      result: await params.run(),
    });
  } catch (err) {
    if (params.signal?.aborted) {
      throw err;
    }
    if (isBeforeToolCallBlockedError(err)) {
      logDebug(`tools: ${params.normalizedToolName} blocked by before_tool_call: ${err.reason}`);
      return buildBlockedToolResult({
        reason: err.reason,
        toolCallId: params.toolCallId,
        runId: params.hookContext?.runId,
      });
    }
    const described = describeToolExecutionError(err);
    if (described.stack && described.stack !== described.message) {
      logDebug(`tools: ${params.normalizedToolName} failed stack:\n${described.stack}`);
    }
    const inputPreview = describeToolFailureInputs({
      toolName: params.normalizedToolName,
      rawParams: params.rawParams,
      effectiveParams: params.getEffectiveParams(),
    });
    logError(`[tools] ${params.normalizedToolName} failed: ${described.message} ${inputPreview}`);
    return buildToolExecutionErrorResult({
      toolName: params.normalizedToolName,
      message: described.message,
    });
  }
}

function splitToolExecuteArgs(args: ToolExecuteArgsAny): {
  toolCallId: string;
  params: unknown;
  onUpdate: AgentToolUpdateCallback | undefined;
  signal: AbortSignal | undefined;
} {
  if (isLegacyToolExecuteArgs(args)) {
    const [toolCallId, params, onUpdate, _ctx, signal] = args;
    return {
      toolCallId,
      params,
      onUpdate,
      signal,
    };
  }
  const [toolCallId, params, signal, onUpdate] = args;
  return {
    toolCallId,
    params,
    onUpdate,
    signal,
  };
}

function attachAdapterExecutionPreparer<T extends ToolDefinition>(definition: T): T {
  return attachInternalToolExecutionPreparer(
    definition,
    createInternalExecutionPreparer((params, control) =>
      definition.execute(
        params.toolCallId,
        params.args,
        params.signal,
        params.onUpdate,
        control as never,
      ),
    ),
  );
}

const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

/** Find client-hosted tool names that collide with runtime or sibling tools. */
export function findClientToolNameConflicts(params: {
  tools: ClientToolDefinition[];
  existingToolNames?: Iterable<string>;
}): string[] {
  const existingNormalized = new Set<string>();
  for (const name of params.existingToolNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      existingNormalized.add(normalizeToolPolicyName(trimmed));
    }
  }

  const conflicts = new Set<string>();
  const seenClientNames = new Map<string, string>();
  for (const tool of params.tools) {
    const rawName = (tool.function?.name ?? "").trim();
    if (!rawName) {
      continue;
    }
    const normalizedName = normalizeToolPolicyName(rawName);
    if (existingNormalized.has(normalizedName)) {
      conflicts.add(rawName);
    }
    const priorClientName = seenClientNames.get(normalizedName);
    if (priorClientName) {
      conflicts.add(priorClientName);
      conflicts.add(rawName);
      continue;
    }
    seenClientNames.set(normalizedName, rawName);
  }
  return Array.from(conflicts);
}

/** Build a recognizable error for rejecting conflicting client tool names. */
export function createClientToolNameConflictError(conflicts: string[]): Error {
  return new Error(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} ${conflicts.join(", ")}`);
}

/** Detect client tool conflict errors without depending on object identity. */
export function isClientToolNameConflictError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(CLIENT_TOOL_NAME_CONFLICT_PREFIX);
}

/** Convert executable agent tools into session definitions with hook handling. */
export function toToolDefinitions(
  tools: AnyAgentTool[],
  hookContext?: HookContext,
  abortSignal?: AbortSignal,
): ToolDefinition[] {
  // Adaptation installs policy hooks outside source tools. Bind their lifetime
  // here too, so revoked generations cannot leave approvals waiting upstream.
  const resolveAbortSignal = (signal?: AbortSignal) =>
    signal && abortSignal ? AbortSignal.any([signal, abortSignal]) : (signal ?? abortSignal);
  return tools.map((tool) => {
    const name = tool.name || "tool";
    const normalizedName = normalizeToolPolicyName(name);
    const beforeHookWrapped = isToolWrappedWithBeforeToolCallHook(tool);
    const sourcePreparer = getInternalToolExecutionPreparer(tool);
    const definition = {
      name,
      label: tool.label ?? name,
      ...(tool.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
      ...(tool.resultContentSource ? { resultContentSource: tool.resultContentSource } : {}),
      description: tool.description ?? "",
      parameters: tool.parameters,
      prepareArguments: tool.prepareArguments,
      executionMode: tool.executionMode,
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, onUpdate, signal: callSignal } = splitToolExecuteArgs(args);
        const signal = resolveAbortSignal(callSignal);
        signal?.throwIfAborted();
        const control = readInternalExecutionControl(args[4]);
        recordStructuredReplayTrustForToolCall(toolCallId, tool, hookContext?.runId);
        let executeParams = params;
        return await executeAdaptedToolOperation({
          toolCallId,
          normalizedToolName: normalizedName,
          rawParams: params,
          getEffectiveParams: () => executeParams,
          signal,
          hookContext,
          run: async () => {
            if (!beforeHookWrapped) {
              const preparedParams = await prepareBeforeToolCallExecutionParams({
                tool,
                params,
                ...(toolCallId ? { toolCallId } : {}),
                ...(hookContext ? { ctx: hookContext } : {}),
                ...(signal ? { signal } : {}),
              });
              const hookParams = normalizeCodeModeExecBeforeHookParams({
                tool,
                params: preparedParams,
              });
              const hookMetadata = getCodeModeExecBeforeHookMetadata({
                tool,
                params: preparedParams,
              });
              const hookOutcome = await runBeforeToolCallHook({
                toolName: name,
                params: hookParams,
                ...hookMetadata,
                toolCallId,
                ctx: hookContext,
                signal,
              });
              if (hookOutcome.blocked) {
                if (hookOutcome.kind === "veto") {
                  return buildBlockedToolResult({
                    reason: hookOutcome.reason,
                    deniedReason: hookOutcome.deniedReason,
                    toolCallId,
                    runId: hookContext?.runId,
                  });
                }
                throw new Error(hookOutcome.reason);
              }
              executeParams = finalizeBeforeToolCallExecutionParams({
                tool,
                preparedParams,
                hookParams,
                adjustedParams: hookOutcome.params,
                finalizerMode: "adapter",
              });
              const decision = control ? await control.pause(executeParams) : undefined;
              if (decision && !decision.launch) {
                return { content: [], details: { status: "skipped" } };
              }
              // A voice grant binds the post-finalizer execution shape. Consuming it
              // earlier would let later alias or tool-owned rewrites escape the grant.
              const voiceConfirmation = consumeFinalClientVoiceToolConfirmation({
                toolName: name,
                params: executeParams,
                ctx: hookContext,
              });
              if (!voiceConfirmation.allowed) {
                return buildBlockedToolResult({
                  reason: voiceConfirmation.reason,
                  deniedReason: "client-voice-confirmation",
                  toolCallId,
                  runId: hookContext?.runId,
                });
              }
              decision?.start?.();
              recordAdjustedParamsForToolCall(toolCallId, executeParams, hookContext?.runId);
              // Unwrapped tools still meet the APEX kernel authority here, bound to the
              // final params; wrapped tools were gated inside their wrapper.
              const governed = await runToolUnderKernelAuthority({
                tool,
                toolName: name,
                params: executeParams,
                toolCallId,
                ctx: hookContext,
                signal,
                invoke: () => tool.execute(toolCallId, executeParams, signal, onUpdate),
              });
              if (governed.kind === "blocked") {
                return buildBlockedToolResult({
                  reason: governed.outcome.reason,
                  deniedReason: "kernel-authority",
                  toolCallId,
                  runId: hookContext?.runId,
                });
              }
              return governed.result;
            }
            return await tool.execute(toolCallId, executeParams, signal, onUpdate);
          },
        });
      },
    } satisfies ToolDefinition;
    copyCodeModeControlToolIdentity(tool, definition);
    if (!sourcePreparer) {
      return beforeHookWrapped ? definition : attachAdapterExecutionPreparer(definition);
    }
    return attachInternalToolExecutionPreparer(definition, async (params) => {
      const signal = resolveAbortSignal(params.signal);
      signal?.throwIfAborted();
      recordStructuredReplayTrustForToolCall(params.toolCallId, tool, hookContext?.runId);
      const settle = (run: () => Promise<unknown>) =>
        executeAdaptedToolOperation({
          toolCallId: params.toolCallId,
          normalizedToolName: normalizedName,
          rawParams: params.args,
          getEffectiveParams: () => params.args,
          signal,
          hookContext,
          run,
        });
      type ImmediateOutcome = Extract<
        Awaited<ReturnType<typeof sourcePreparer>>,
        { kind: "immediate" }
      >["outcome"];
      const settleImmediate = async (outcome: ImmediateOutcome, dispose: () => void) => {
        try {
          const result = await settle(async () => {
            if (outcome.kind === "error") {
              throw outcome.error;
            }
            return outcome.result;
          });
          return {
            kind: "immediate" as const,
            outcome: {
              kind: "result" as const,
              result,
              isError: outcome.kind === "result" && outcome.isError,
            },
            dispose,
          };
        } catch (error) {
          return {
            kind: "immediate" as const,
            outcome: { kind: "error" as const, error },
            dispose,
          };
        }
      };
      let prepared: Awaited<ReturnType<typeof sourcePreparer>>;
      try {
        prepared = await sourcePreparer({
          toolCallId: params.toolCallId,
          args: params.args,
          ...(signal ? { signal } : {}),
          ...(params.onUpdate ? { onUpdate: params.onUpdate } : {}),
        });
      } catch (error) {
        return await settleImmediate({ kind: "error", error }, () => {});
      }
      if (prepared.kind === "immediate") {
        return await settleImmediate(prepared.outcome, prepared.dispose);
      }
      const ready = prepared;
      return {
        kind: "ready",
        args: ready.args,
        execute: (onImplementationStart) => {
          signal?.throwIfAborted();
          return settle(() => ready.execute(onImplementationStart));
        },
        dispose: ready.dispose,
      };
    });
  });
}

function coerceParamsRecord(
  value: unknown,
  schema: ClientToolDefinition["function"]["parameters"],
): Record<string, unknown> {
  let record: Record<string, unknown>;
  if (isPlainObject(value)) {
    record = value;
  } else if (value === undefined || value === null) {
    record = {};
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      record = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new ToolInputError("Invalid client tool arguments: expected a JSON object");
      }
      if (parsed === null) {
        record = {};
      } else if (isPlainObject(parsed)) {
        record = parsed;
      } else {
        throw new ToolInputError("Invalid client tool arguments: expected a JSON object");
      }
    }
  } else {
    throw new ToolInputError("Invalid client tool arguments: expected a JSON object");
  }

  const required = Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  const missing = required.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) {
    throw new ToolInputError(
      `Invalid client tool arguments: missing required ${missing.join(", ")}`,
    );
  }
  return record;
}

/** Convert client-hosted tools into pending session definitions. */
export function toClientToolDefinitions(
  tools: ClientToolDefinition[],
  onClientToolCall?: ClientToolCallRecorder,
  hookContext?: HookContext,
): ToolDefinition[] {
  return tools.map((tool) => {
    const func = tool.function;
    const definition = {
      name: func.name,
      label: func.name,
      description: func.description ?? "",
      parameters: func.parameters as ToolDefinition["parameters"],
      execute: async (...args: ToolExecuteArgs): Promise<AgentToolResult<unknown>> => {
        const { toolCallId, params, signal } = splitToolExecuteArgs(args);
        const control = readInternalExecutionControl(args[4]);
        if (onClientToolCall && typeof onClientToolCall !== "function") {
          onClientToolCall.reserve?.(toolCallId, func.name);
        }
        try {
          const initialParamsRecord = coerceParamsRecord(params, func.parameters);
          const outcome = await runBeforeToolCallHook({
            toolName: func.name,
            params: initialParamsRecord,
            toolCallId,
            ctx: hookContext,
            signal,
          });
          if (outcome.blocked) {
            if (onClientToolCall && typeof onClientToolCall !== "function") {
              onClientToolCall.discard?.(toolCallId, func.name);
            }
            if (outcome.kind === "veto") {
              return buildBlockedToolResult({
                reason: outcome.reason,
                deniedReason: outcome.deniedReason,
                toolCallId,
                runId: hookContext?.runId,
              });
            }
            throw new Error(outcome.reason);
          }
          const adjustedParams = outcome.params;
          const paramsRecord = coerceParamsRecord(adjustedParams, func.parameters);
          // Client-hosted tools have no tool-owned finalizer, so hook reconciliation
          // produces the canonical execution shape consumed here.
          const decision = control ? await control.pause(paramsRecord) : undefined;
          if (decision && !decision.launch) {
            if (onClientToolCall && typeof onClientToolCall !== "function") {
              onClientToolCall.discard?.(toolCallId, func.name);
            }
            return { content: [], details: { status: "skipped" } };
          }
          const voiceConfirmation = consumeFinalClientVoiceToolConfirmation({
            toolName: func.name,
            params: paramsRecord,
            ctx: hookContext,
          });
          if (!voiceConfirmation.allowed) {
            if (onClientToolCall && typeof onClientToolCall !== "function") {
              onClientToolCall.discard?.(toolCallId, func.name);
            }
            return buildBlockedToolResult({
              reason: voiceConfirmation.reason,
              deniedReason: "client-voice-confirmation",
              toolCallId,
              runId: hookContext?.runId,
            });
          }
          // Client-hosted tools execute outside this plane: the kernel still decides
          // whether the delegation may leave, bound to the final params. The outcome is
          // never observed here, so the receipt says so.
          const kernelGate = await runAgentToolKernelAuthorityGate({
            toolName: func.name,
            params: paramsRecord,
            toolCallId,
            ctx: hookContext,
            signal,
          });
          if (kernelGate.kind === "blocked") {
            if (onClientToolCall && typeof onClientToolCall !== "function") {
              onClientToolCall.discard?.(toolCallId, func.name);
            }
            return buildBlockedToolResult({
              reason: kernelGate.outcome.reason,
              deniedReason: "kernel-authority",
              toolCallId,
              runId: hookContext?.runId,
            });
          }
          signal?.throwIfAborted();
          decision?.start?.();
          await kernelGate.finish("unknown");
          // Notify handler that a client tool was called.
          if (onClientToolCall) {
            if (typeof onClientToolCall === "function") {
              onClientToolCall(func.name, paramsRecord);
            } else {
              onClientToolCall.complete(toolCallId, func.name, paramsRecord);
            }
          }
        } catch (err) {
          if (onClientToolCall && typeof onClientToolCall !== "function") {
            onClientToolCall.discard?.(toolCallId, func.name);
          }
          if (err instanceof ToolInputError) {
            return buildToolExecutionErrorResult({
              toolName: func.name,
              message: err.message,
            });
          }
          throw err;
        }
        // Return a terminal pending result; the client will execute the tool.
        return {
          ...jsonResult({
            status: "pending",
            tool: func.name,
            message: "Tool execution delegated to client",
          }),
          terminate: true,
        };
      },
    } satisfies ToolDefinition;
    return attachAdapterExecutionPreparer(definition);
  });
}

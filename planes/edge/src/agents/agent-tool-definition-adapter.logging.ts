/**
 * Safe logging for failed adapted tool calls: describes the error and previews the raw and
 * effective params with exec commands/env values redacted (they may carry credentials).
 * Split out of agent-tool-definition-adapter.ts so the adapter holds only the execution
 * boundary.
 */
import { createHash } from "node:crypto";
import { redactToolDetail } from "../logging/redact.js";
import { isPlainObject } from "../utils.js";
import { sanitizeForConsole } from "./console-sanitize.js";

const TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS = 600;
const TOOL_ERROR_EXEC_COMMAND_HASH_CHARS = 16;
const SENSITIVE_EXEC_ENV_VALUE = "[omitted exec env value]";
const EXEC_COMMAND_PARAM_KEYS = new Set(["command", "cmd"]);

export function describeToolExecutionError(err: unknown): {
  message: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const message = err.message?.trim() ? err.message : String(err);
    return { message, stack: err.stack };
  }
  return { message: String(err) };
}

function serializeToolParams(value: unknown): string {
  if (value === undefined) {
    return "<undefined>";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // Fall through to String(value).
  }
  if (typeof value === "function") {
    return value.name ? `[Function ${value.name}]` : "[Function anonymous]";
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  return Object.prototype.toString.call(value);
}

function formatToolParamPreview(label: string, value: unknown): string {
  const serialized = serializeToolParams(value);
  const redacted = redactToolDetail(serialized);
  const preview = sanitizeForConsole(redacted, TOOL_ERROR_PARAM_PREVIEW_MAX_CHARS) ?? "<empty>";
  return `${label}=${preview}`;
}

function kindForLog(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function summarizeSensitiveValueForLog(params: {
  value: unknown;
  reason: string;
}): Record<string, unknown> {
  const serialized = serializeToolParams(params.value);
  return {
    omitted: true,
    reason: params.reason,
    type: kindForLog(params.value),
    chars: serialized.length,
    sha256: createHash("sha256")
      .update(serialized)
      .digest("hex")
      .slice(0, TOOL_ERROR_EXEC_COMMAND_HASH_CHARS),
  };
}

function summarizeExecCommandForLog(command: unknown): Record<string, unknown> {
  return summarizeSensitiveValueForLog({
    value: command,
    reason: "exec command may contain credentials",
  });
}

function sanitizeExecEnvForLog(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value === undefined ? undefined : "[omitted exec env]";
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, SENSITIVE_EXEC_ENV_VALUE]),
  );
}

function sanitizeExecFailureParamsForLog(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isPlainObject(parsed)) {
        return sanitizeExecFailureParamsForLog(parsed);
      }
    } catch {
      // Non-JSON exec params can still be a raw model-supplied command payload.
    }
  }
  if (!isPlainObject(value)) {
    return summarizeSensitiveValueForLog({
      value,
      reason: "exec params may contain command credentials",
    });
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (EXEC_COMMAND_PARAM_KEYS.has(key)) {
      sanitized[key] = summarizeExecCommandForLog(field);
      continue;
    }
    if (key === "env") {
      sanitized[key] = sanitizeExecEnvForLog(field);
      continue;
    }
    sanitized[key] = field;
  }
  return sanitized;
}

function sanitizeToolFailureParamsForLog(toolName: string, value: unknown): unknown {
  return toolName === "exec" ? sanitizeExecFailureParamsForLog(value) : value;
}

export function describeToolFailureInputs(params: {
  toolName: string;
  rawParams: unknown;
  effectiveParams: unknown;
}): string {
  const rawParams = sanitizeToolFailureParamsForLog(params.toolName, params.rawParams);
  const effectiveParams = sanitizeToolFailureParamsForLog(params.toolName, params.effectiveParams);
  const parts = [formatToolParamPreview("raw_params", rawParams)];
  const rawSerialized = serializeToolParams(rawParams);
  const effectiveSerialized = serializeToolParams(effectiveParams);
  if (effectiveSerialized !== rawSerialized) {
    parts.push(formatToolParamPreview("effective_params", effectiveParams));
  }
  return parts.join(" ");
}

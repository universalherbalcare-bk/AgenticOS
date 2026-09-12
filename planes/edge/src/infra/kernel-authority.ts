/**
 * Stdlib-only client for the APEX kernel authority protocol (apex.authority v1).
 *
 * A plane adapter spawns the configured authority command with no shell,
 * writes one JSON request object to its stdin, and reads one JSON response
 * object from its stdout. See APEX-OS/kernel/docs/AUTHORITY-PROTOCOL.md and
 * APEX-OS/kernel/schemas/{AuthorityRequest,AuthorityResponse}.schema.json for
 * the wire contract this module implements.
 *
 * Fails closed: a spawn error, non-zero exit, timeout, unparseable response,
 * `ok: false`, or an unexpected `decision` value always resolves to
 * `{ decision: "deny", reason: "kernel_unreachable", detail }`. This module
 * never returns "allow" unless the kernel explicitly said so. It never
 * throws: every failure mode is represented in the returned decision.
 *
 * Never logs command text or argument values. Nothing in this module writes
 * to stdout/stderr/logs; callers that log a decision must log only
 * kernel-provided identifiers/digests (`approval_id`, `payload_sha256`), not
 * the request's own `args`.
 */
import { execFile } from "node:child_process";

/** Planes recognized by the kernel authority protocol. */
export type AuthorityPlane = "kernel" | "jarvis" | "business" | "edge" | "brain";

/** Risk tiers recognized by the kernel authority protocol. */
export type AuthorityRisk = "R0" | "R1" | "R2" | "R3" | "R4";

/** Outcome reported to `finish` after the effect ran. */
export type AuthorityOutcome = "succeeded" | "failed" | "unknown";

/** Identical to turn.v1 Principal: who asked, as resolved by the plane. */
export type AuthorityPrincipal = {
  user_id: string;
  display_name?: string;
  channel: string;
  channel_user?: string;
  scopes?: string[];
};

/** Request body for the `decide` operation (before the `op` discriminant is added). */
export type AuthorityDecideRequest = {
  plane: AuthorityPlane;
  tool: string;
  risk: AuthorityRisk;
  principal: AuthorityPrincipal;
  args: Record<string, unknown>;
  approval_id?: string;
  /** Authority workspace directory; defaults to APEX_AUTHORITY_DIR when omitted. */
  directory?: string;
};

/** Request body for the `resolve` operation. */
export type AuthorityResolveRequest = {
  approval_id: string;
  approve: boolean;
  plane: AuthorityPlane;
  tool: string;
  risk: AuthorityRisk;
  principal: AuthorityPrincipal;
  args: Record<string, unknown>;
  directory?: string;
};

/** Request body for the `finish` operation. */
export type AuthorityFinishRequest = {
  approval_id: string;
  outcome: AuthorityOutcome;
  directory?: string;
};

/** Normalized decision returned by every operation in this client. */
export type AuthorityDecision = {
  decision: "allow" | "deny" | "approval_required";
  reason: string;
  detail?: string;
  operation?: string;
  resource?: string;
  risk?: AuthorityRisk;
  approval_id: string | null;
  payload_sha256?: string | null;
  expires_at?: number;
  consumed_at?: number;
};

/** APEX_AUTHORITY_MODE values recognized by adapters built on this client. */
export type KernelAuthorityMode = "required" | "native";

/** Resolved adapter configuration, read from environment at call time. */
export type KernelAuthorityConfig = {
  cmd: string | undefined;
  directory: string | undefined;
  mode: KernelAuthorityMode;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 256 * 1024;

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Positive integer milliseconds, or undefined for anything else (including absent/blank). */
function parsePositiveTimeoutMs(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads APEX_AUTHORITY_CMD / APEX_AUTHORITY_DIR / APEX_AUTHORITY_MODE from
 * `env`. APEX_AUTHORITY_TIMEOUT_MS is an undocumented test/ops escape hatch
 * for the 5000ms default; the protocol only specifies the default value.
 */
export function resolveKernelAuthorityConfig(
  env: NodeJS.ProcessEnv = process.env,
): KernelAuthorityConfig {
  const cmd = normalizeNonEmpty(env.APEX_AUTHORITY_CMD);
  const directory = normalizeNonEmpty(env.APEX_AUTHORITY_DIR);
  const mode: KernelAuthorityMode =
    normalizeNonEmpty(env.APEX_AUTHORITY_MODE) === "required" ? "required" : "native";
  const timeoutMs = parsePositiveTimeoutMs(env.APEX_AUTHORITY_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  return { cmd, directory, mode, timeoutMs };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type NodeExecFileError = Error & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  code?: number | string | null;
};

function isNodeExecFileError(error: unknown): error is NodeExecFileError {
  return error instanceof Error;
}

/** Describes a spawn/exit/timeout failure without ever naming the gated command. */
function describeSpawnError(error: unknown): string {
  if (isNodeExecFileError(error)) {
    if (error.killed || error.signal) {
      return `kernel authority process timed out or was killed (signal=${error.signal ?? "unknown"})`;
    }
    if (typeof error.code === "number") {
      return `kernel authority process exited with code ${error.code}`;
    }
    if (typeof error.code === "string") {
      return `kernel authority process failed to start (${error.code})`;
    }
  }
  return `kernel authority process failed: ${describeError(error)}`;
}

function denyUnreachable(detail: string, approvalId: string | null = null): AuthorityDecision {
  return {
    decision: "deny",
    reason: "kernel_unreachable",
    detail,
    approval_id: approvalId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDecisionValue(value: unknown): value is "allow" | "deny" | "approval_required" {
  return value === "allow" || value === "deny" || value === "approval_required";
}

function isValidRiskValue(value: unknown): value is AuthorityRisk {
  return value === "R0" || value === "R1" || value === "R2" || value === "R3" || value === "R4";
}

type AuthorityProcessResult = {
  stdout: string;
  error?: NodeExecFileError;
};

/** Spawns `cmd` with no shell and no arguments, writes `requestJson` to stdin, collects stdout. */
function runAuthorityProcess(
  cmd: string,
  requestJson: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<AuthorityProcessResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: AuthorityProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise(result);
    };

    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        cmd,
        [],
        {
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: MAX_STDOUT_BYTES,
          windowsHide: true,
          env,
        },
        (error, stdout) => {
          settle({
            stdout: typeof stdout === "string" ? stdout : "",
            error: error ? (error as NodeExecFileError) : undefined,
          });
        },
      );
    } catch (spawnError) {
      settle({ stdout: "", error: spawnError as NodeExecFileError });
      return;
    }

    child.on("error", (error) => {
      settle({ stdout: "", error: error as NodeExecFileError });
    });

    const stdin = child.stdin;
    if (!stdin) {
      settle({ stdout: "", error: new Error("kernel authority process has no stdin") });
      return;
    }
    // A child that exits before consuming stdin raises EPIPE here; the exit
    // callback above already reports the failure, so this only prevents an
    // unhandled 'error' event from crashing the process.
    stdin.on("error", () => {});
    stdin.write(requestJson, (writeError) => {
      if (!writeError) {
        stdin.end();
      }
    });
  });
}

async function callAuthority(
  payload: { op: "decide" | "resolve" | "finish"; directory?: string; [key: string]: unknown },
  env: NodeJS.ProcessEnv,
): Promise<AuthorityDecision> {
  const config = resolveKernelAuthorityConfig(env);
  const cmd = config.cmd;
  if (!cmd) {
    return denyUnreachable("kernel authority not configured");
  }
  const directory = payload.directory ?? config.directory;
  const requestBody: Record<string, unknown> = { ...payload };
  if (directory) {
    requestBody.directory = directory;
  } else {
    delete requestBody.directory;
  }

  let requestJson: string;
  try {
    requestJson = JSON.stringify(requestBody);
  } catch (error) {
    return denyUnreachable(
      `kernel authority request could not be serialized: ${describeError(error)}`,
    );
  }

  // The gated command's own environment is irrelevant here: this spawns the
  // *authority* process, not the gated command. Merge onto process.env so the
  // authority binary (and any shell it is itself implemented as) still finds
  // a normal PATH/HOME, while letting a caller-supplied `env` add or override
  // specific keys (APEX_AUTHORITY_*, and any fixture-only variables a test
  // wants the authority process to see) without mutating global state.
  const childEnv: NodeJS.ProcessEnv =
    env === process.env ? process.env : { ...process.env, ...env };
  const { stdout, error } = await runAuthorityProcess(cmd, requestJson, config.timeoutMs, childEnv);

  let parsed: unknown;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    return denyUnreachable(
      error ? describeSpawnError(error) : "kernel authority returned an unparseable response",
    );
  }
  if (!parsed.ok) {
    const errorText =
      typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error
        : "kernel authority denied the request";
    return denyUnreachable(errorText);
  }
  // ok === true but the process still reported a failure (should not happen per
  // protocol, but never trust a decision that arrived alongside a process error).
  if (error) {
    return denyUnreachable(describeSpawnError(error));
  }

  const result = parsed.result;
  if (!isRecord(result) || !isValidDecisionValue(result.decision)) {
    return denyUnreachable("kernel authority returned an unexpected decision value");
  }

  return {
    decision: result.decision,
    reason: typeof result.reason === "string" ? result.reason : "unknown",
    ...(typeof result.detail === "string" ? { detail: result.detail } : {}),
    ...(typeof result.operation === "string" ? { operation: result.operation } : {}),
    ...(typeof result.resource === "string" ? { resource: result.resource } : {}),
    ...(isValidRiskValue(result.risk) ? { risk: result.risk } : {}),
    approval_id: typeof result.approval_id === "string" ? result.approval_id : null,
    payload_sha256: typeof result.payload_sha256 === "string" ? result.payload_sha256 : null,
    ...(typeof result.expires_at === "number" ? { expires_at: result.expires_at } : {}),
    ...(typeof result.consumed_at === "number" ? { consumed_at: result.consumed_at } : {}),
  };
}

/**
 * Asks the kernel to decide a tool call. Never throws and never returns
 * "allow" unless the kernel process explicitly returned `ok: true` with
 * `result.decision === "allow"`.
 */
export async function decide(
  req: AuthorityDecideRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorityDecision> {
  return callAuthority({ op: "decide", ...req }, env);
}

/** Relays a human's answer for a pending approval. Never throws. */
export async function resolve(
  req: AuthorityResolveRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorityDecision> {
  return callAuthority({ op: "resolve", ...req }, env);
}

/** Records the outcome of an executed effect against its consumed approval. Never throws. */
export async function finish(
  req: AuthorityFinishRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorityDecision> {
  return callAuthority({ op: "finish", ...req }, env);
}

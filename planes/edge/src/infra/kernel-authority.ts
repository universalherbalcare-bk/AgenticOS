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
  /** On approval_rejected only: the record's own status; adapters keep waiting only on "pending". */
  record_status?: "pending" | "approved" | "consumed" | "revoked" | "expired" | null;
  payload_sha256?: string | null;
  expires_at?: number;
  consumed_at?: number;
};

/** APEX_AUTHORITY_MODE values recognized by adapters built on this client. */
/**
 * What `resolve` and `finish` return on success: the kernel's approval RECORD (status, reason,
 * timestamps), never a decision. Only the fields adapters read are named.
 */
export type AuthorityRecord = {
  id: string;
  status: "pending" | "approved" | "consumed" | "revoked" | "expired";
  reason: string;
  outcome?: string;
  [key: string]: unknown;
};

export type AuthorityRecordResult =
  | { ok: true; record: AuthorityRecord }
  | { ok: false; reason: "kernel_unreachable"; detail: string };

export type KernelAuthorityMode = "required" | "native";

/** Resolved adapter configuration, read from environment at call time. */
export type KernelAuthorityConfig = {
  cmd: string | undefined;
  directory: string | undefined;
  mode: KernelAuthorityMode;
  timeoutMs: number;
  /** Ceiling on concurrently running authority processes (APEX_AUTHORITY_MAX_CONCURRENCY). */
  maxConcurrency: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 256 * 1024;
export const DEFAULT_AUTHORITY_MAX_CONCURRENCY = 8;
/** Hard upper bound for APEX_AUTHORITY_MAX_CONCURRENCY; larger values fall back to the default. */
export const AUTHORITY_MAX_CONCURRENCY_CEILING = 256;

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
 * Positive integer in [1, AUTHORITY_MAX_CONCURRENCY_CEILING], or undefined for anything else
 * (absent, blank, non-integer, zero, negative, or above the ceiling). Invalid values never
 * widen the ceiling: they fall back to the default.
 */
function parseMaxConcurrency(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= AUTHORITY_MAX_CONCURRENCY_CEILING
    ? parsed
    : undefined;
}

/**
 * Reads APEX_AUTHORITY_CMD / APEX_AUTHORITY_DIR / APEX_AUTHORITY_MODE from
 * `env`. APEX_AUTHORITY_TIMEOUT_MS is an undocumented test/ops escape hatch
 * for the 5000ms default; the protocol only specifies the default value.
 * APEX_AUTHORITY_MAX_CONCURRENCY bounds how many authority processes this
 * plane runs at once (default 8); callers beyond it wait, and the timeout
 * covers wait + run so a saturated kernel fails closed instead of hanging.
 */
export function resolveKernelAuthorityConfig(
  env: NodeJS.ProcessEnv = process.env,
): KernelAuthorityConfig {
  const cmd = normalizeNonEmpty(env.APEX_AUTHORITY_CMD);
  const directory = normalizeNonEmpty(env.APEX_AUTHORITY_DIR);
  const mode: KernelAuthorityMode =
    normalizeNonEmpty(env.APEX_AUTHORITY_MODE) === "required" ? "required" : "native";
  const timeoutMs = parsePositiveTimeoutMs(env.APEX_AUTHORITY_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrency =
    parseMaxConcurrency(env.APEX_AUTHORITY_MAX_CONCURRENCY) ?? DEFAULT_AUTHORITY_MAX_CONCURRENCY;
  return { cmd, directory, mode, timeoutMs, maxConcurrency };
}

/** One startup-log line describing the resolved kernel authority mode. Pure; never logs itself. */
export type KernelAuthorityModeDescription = {
  mode: KernelAuthorityMode;
  /** "warn" whenever the kernel is NOT (or cannot be) governing exec on this plane. */
  level: "info" | "warn";
  message: string;
};

/**
 * Describes the resolved kernel authority mode for the gateway boot log, so a
 * silent default to "native" (kernel not governing exec) is never invisible.
 * Names only the authority command path and directory, never a gated command.
 */
export function describeKernelAuthorityMode(
  env: NodeJS.ProcessEnv = process.env,
): KernelAuthorityModeDescription {
  const config = resolveKernelAuthorityConfig(env);
  const settings = `dir=${config.directory ?? "(default)"} timeoutMs=${config.timeoutMs} maxConcurrency=${config.maxConcurrency}`;
  if (config.mode === "required") {
    if (!config.cmd) {
      return {
        mode: "required",
        level: "warn",
        message: `kernel authority: mode=required but APEX_AUTHORITY_CMD is unset; every exec spawn will be DENIED (kernel_unreachable) until it is set. ${settings}`,
      };
    }
    return {
      mode: "required",
      level: "info",
      message: `kernel authority: mode=required cmd=${config.cmd} ${settings}; the APEX kernel governs every exec spawn (gateway, sandbox, node hosts)`,
    };
  }
  const rawMode = normalizeNonEmpty(env.APEX_AUTHORITY_MODE);
  const why =
    rawMode === undefined
      ? "APEX_AUTHORITY_MODE is unset"
      : rawMode === "native"
        ? "APEX_AUTHORITY_MODE=native"
        : `APEX_AUTHORITY_MODE=${JSON.stringify(rawMode)} is not "required"`;
  return {
    mode: "native",
    level: "warn",
    message: `WARNING kernel authority: mode=native (${why}); the APEX kernel is NOT governing exec on this plane, only plane-local approval policy applies. Set APEX_AUTHORITY_MODE=required and APEX_AUTHORITY_CMD to enable it.${config.cmd ? ` (APEX_AUTHORITY_CMD=${config.cmd} is set but ignored in native mode)` : ""}`,
  };
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

function isRecordStatus(
  value: unknown,
): value is "pending" | "approved" | "consumed" | "revoked" | "expired" {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "consumed" ||
    value === "revoked" ||
    value === "expired"
  );
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

// ---------------------------------------------------------------------------
// Bounded concurrency. Every decide/resolve/finish spawns one authority process; without a
// ceiling a burst of exec calls (or a deliberate flood) forks an unbounded number of kernel
// processes. Callers beyond the ceiling queue here. The queue is FIFO, the ceiling is read per
// call from the config (so ops can tune it without a restart of this module's tests), and a
// waiter that cannot get a slot before the caller's own timeout fails closed rather than hangs.
// ---------------------------------------------------------------------------

type AuthoritySlotWaiter = { grant: () => void };

let authorityInFlight = 0;
const authoritySlotWaiters: AuthoritySlotWaiter[] = [];

/** Resolves true once a slot is held (the caller MUST release it), false if `waitMs` elapsed first. */
function acquireAuthoritySlot(limit: number, waitMs: number): Promise<boolean> {
  if (authorityInFlight < limit) {
    authorityInFlight += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const waiter: AuthoritySlotWaiter = {
      grant: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        authorityInFlight += 1;
        resolvePromise(true);
      },
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const index = authoritySlotWaiters.indexOf(waiter);
      if (index >= 0) {
        authoritySlotWaiters.splice(index, 1);
      }
      resolvePromise(false);
    }, waitMs);
    timer.unref?.();
    authoritySlotWaiters.push(waiter);
  });
}

function releaseAuthoritySlot(): void {
  authorityInFlight = Math.max(0, authorityInFlight - 1);
  const next = authoritySlotWaiters.shift();
  next?.grant();
}

/** Test hook: how many authority processes this module believes are running right now. */
export function getKernelAuthorityInFlightCountForTests(): number {
  return authorityInFlight;
}

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

type InvokeResult = { ok: true; result: unknown } | { ok: false; detail: string };

function unreachable(detail: string): InvokeResult {
  return { ok: false, detail };
}

/** One protocol round trip: spawn, write, read, parse, ok-check. Validation of `result` is the caller's. */
async function invokeAuthority(
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<InvokeResult> {
  const config = resolveKernelAuthorityConfig(env);
  const cmd = config.cmd;
  if (!cmd) {
    return unreachable("kernel authority not configured");
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
    return unreachable(`kernel authority request could not be serialized: ${describeError(error)}`);
  }

  // The gated command's own environment is irrelevant here: this spawns the
  // *authority* process, not the gated command. Merge onto process.env so the
  // authority binary (and any shell it is itself implemented as) still finds
  // a normal PATH/HOME, while letting a caller-supplied `env` add or override
  // specific keys (APEX_AUTHORITY_*, and any fixture-only variables a test
  // wants the authority process to see) without mutating global state.
  const childEnv: NodeJS.ProcessEnv =
    env === process.env ? process.env : { ...process.env, ...env };
  // The configured timeout bounds wait + run together: time spent queued for a slot is
  // subtracted from the process timeout, so a saturated kernel cannot stall a caller past it.
  const startedAt = Date.now();
  const granted = await acquireAuthoritySlot(config.maxConcurrency, config.timeoutMs);
  if (!granted) {
    return unreachable(
      `kernel authority concurrency ceiling (${config.maxConcurrency}) stayed saturated for ${config.timeoutMs}ms`,
    );
  }
  let stdout: string;
  let error: NodeExecFileError | undefined;
  try {
    const remainingMs = Math.max(1, config.timeoutMs - (Date.now() - startedAt));
    ({ stdout, error } = await runAuthorityProcess(cmd, requestJson, remainingMs, childEnv));
  } finally {
    releaseAuthoritySlot();
  }

  let parsed: unknown;
  try {
    parsed = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
    return unreachable(
      error ? describeSpawnError(error) : "kernel authority returned an unparseable response",
    );
  }
  if (!parsed.ok) {
    const errorText =
      typeof parsed.error === "string" && parsed.error.trim()
        ? parsed.error
        : "kernel authority denied the request";
    return unreachable(errorText);
  }
  // ok === true but the process still reported a failure (should not happen per
  // protocol, but never trust a decision that arrived alongside a process error).
  if (error) {
    return unreachable(describeSpawnError(error));
  }

  return { ok: true, result: parsed.result };
}

async function callAuthority(
  payload: { op: "decide" | "resolve" | "finish"; directory?: string; [key: string]: unknown },
  env: NodeJS.ProcessEnv,
): Promise<AuthorityDecision> {
  const invoked = await invokeAuthority(payload, env);
  if (!invoked.ok) {
    return denyUnreachable(invoked.detail);
  }
  const result = invoked.result;
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
    ...(isRecordStatus(result.record_status) ? { record_status: result.record_status } : {}),
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
const RECORD_STATUSES = new Set(["pending", "approved", "consumed", "revoked", "expired"]);

function isValidRecord(value: unknown): value is AuthorityRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string" &&
    RECORD_STATUSES.has(value.status) &&
    typeof value.reason === "string"
  );
}

async function callAuthorityRecord(
  request: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<AuthorityRecordResult> {
  const invoked = await invokeAuthority(request, env);
  if (!invoked.ok) {
    return { ok: false, reason: "kernel_unreachable", detail: invoked.detail };
  }
  if (!isValidRecord(invoked.result)) {
    return {
      ok: false,
      reason: "kernel_unreachable",
      detail: "kernel authority returned an unexpected record shape",
    };
  }
  return { ok: true, record: invoked.result };
}

/**
 * Relays the human's answer for a pending approval. The kernel replies with the approval
 * RECORD (status approved or revoked), never a decision; a decision-shaped reply is refused.
 * Never throws.
 */
export async function resolve(
  req: AuthorityResolveRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorityRecordResult> {
  return callAuthorityRecord({ op: "resolve", ...req }, env);
}

/** Records the outcome of an executed effect against its consumed approval. Never throws. */
export async function finish(
  req: AuthorityFinishRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AuthorityRecordResult> {
  return callAuthorityRecord({ op: "finish", ...req }, env);
}

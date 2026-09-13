/**
 * Wires the APEX kernel authority protocol (src/infra/kernel-authority.ts)
 * into the exec tool's local process-spawn boundary.
 *
 * The gate built here is passed as `runExecProcess`'s `beforeSpawn` callback
 * (see bash-tools.exec-runtime.ts): the one point, common to every local exec
 * host (gateway and sandbox), where a command has already cleared the
 * plane's own allow/deny/ask policy and is immediately about to be spawned
 * as a real OS process. The node host (bash-tools.exec-host-node.ts) calls
 * the same gate immediately before each `system.run` dispatch.
 *
 * The gate authorizes the command that is ACTUALLY spawned: `beforeSpawn`
 * receives the final spawn parameters (the gateway host may rewrite the
 * requested command, e.g. safe-bin path normalization) and the kernel
 * request's `args.command` is bound to that string, never to the request
 * as the model typed it (red-team finding C2).
 *
 * Mode "native" (the default, and any mode when APEX_AUTHORITY_CMD is
 * unset) leaves existing plane approval behaviour completely unchanged:
 * `createExecKernelAuthorityGate` returns `undefined` and the kernel is
 * never consulted. Mode "required" spawns the command only when the kernel
 * returns decision "allow"; "approval_required" and "deny" (and any kernel
 * failure, which itself always resolves to "deny") both prevent the spawn.
 */
import os from "node:os";
import { type ExecHost, resolveExecApprovalAllowedDecisions } from "../infra/exec-approvals.js";
import {
  decide as decideKernelAuthority,
  finish as finishKernelAuthority,
  resolveKernelAuthorityConfig,
  type AuthorityDecideRequest,
  type AuthorityDecision,
  type AuthorityOutcome,
  type AuthorityPrincipal,
  type AuthorityRisk,
} from "../infra/kernel-authority.js";
import { logWarn } from "../logger.js";
import {
  createKernelAuthorityPendingMemory,
  type KernelAuthorityPendingMemory,
} from "./bash-tools.exec-kernel-authority-pending.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

// ---------------------------------------------------------------------------
// Pending approval memory: see bash-tools.exec-kernel-authority-pending.ts. Partitioned by
// principal (+ session), TTL-bounded, with an overall cap that evicts the flooding partition
// first. A lost entry costs one extra approval round, never an unapproved spawn.
// ---------------------------------------------------------------------------

const pendingApprovals: KernelAuthorityPendingMemory = createKernelAuthorityPendingMemory();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function kernelAuthorityRequestKey(request: AuthorityDecideRequest): string {
  const { plane, tool, risk, principal, args } = request;
  return canonicalJson({ plane, tool, risk, principal, args });
}

/**
 * Pending-memory partition: the resolved kernel principal plus the agent session when known.
 * Exported so tests can assert two callers land in different partitions.
 */
export function kernelAuthorityPendingPartition(
  principal: AuthorityPrincipal,
  sessionKey: string | undefined,
): string {
  return canonicalJson({ principal, session: sessionKey?.trim() || null });
}

/** Test hook: forget every remembered approval id. */
export function resetKernelAuthorityPendingForTests(): void {
  pendingApprovals.clear();
}

/** Test hook: live remembered-id count (all partitions, or one). */
export function getKernelAuthorityPendingSizeForTests(partition?: string): number {
  return partition === undefined
    ? pendingApprovals.size()
    : pendingApprovals.partitionSize(partition);
}

export type InterpretedKernelDecision =
  | { kind: "allow" }
  | { kind: "pending"; approvalId: string; decision: AuthorityDecision }
  | { kind: "deny"; decision: AuthorityDecision };

/**
 * allow -> spawn; approval_required with an id -> wait under that id; deny with the kernel's
 * still-pending wording for an id we presented -> keep waiting under the same id; any other
 * deny -> stop. Exported so the interpretation is testable on its own.
 */
export function interpretKernelDecision(
  decision: AuthorityDecision,
  presented: string | undefined,
): InterpretedKernelDecision {
  if (decision.decision === "allow") {
    return { kind: "allow" };
  }
  if (
    decision.decision === "approval_required" &&
    typeof decision.approval_id === "string" &&
    decision.approval_id.length > 0
  ) {
    return { kind: "pending", approvalId: decision.approval_id, decision };
  }
  // The store's rejection wording is identical for a still-pending, a revoked and a spent
  // record; the kernel returns the record's own status and that field alone decides whether
  // to keep waiting. Anything but "pending" (including a missing field) is a hard denial.
  if (
    decision.decision === "deny" &&
    presented !== undefined &&
    decision.reason === "approval_rejected" &&
    decision.record_status === "pending"
  ) {
    return {
      kind: "pending",
      approvalId: presented,
      decision: { ...decision, approval_id: presented },
    };
  }
  return { kind: "deny", decision };
}

/** What the caller knows about the requesting user/session, before fallback. */
export type ExecKernelAuthorityPrincipalSource = {
  userId?: string;
  displayName?: string;
  channel?: string;
  channelUser?: string;
  scopes?: string[];
};

/**
 * Maps what the plane knows about the requester onto the protocol principal. Shared with the
 * generic tool gate (agent-tools.kernel-authority-gate.ts) so exec and every other governed
 * tool present the same principal for the same requester.
 */
export function resolveKernelAuthorityPrincipal(
  source: ExecKernelAuthorityPrincipalSource | undefined,
): AuthorityPrincipal {
  const userId = source?.userId?.trim();
  const channel = source?.channel?.trim();
  if (userId && channel) {
    const displayName = source?.displayName?.trim();
    const channelUser = source?.channelUser?.trim();
    const scopes = source?.scopes;
    return {
      user_id: userId,
      channel,
      ...(displayName ? { display_name: displayName } : {}),
      ...(channelUser ? { channel_user: channelUser } : {}),
      ...(scopes && scopes.length > 0 ? { scopes } : {}),
    };
  }
  // No turn/agent-owner identity was resolvable; fall back to the OS
  // principal running the edge plane process itself.
  return { user_id: os.userInfo().username, channel: "edge" };
}

/** Marks tool results produced by this gate so hosts can tell them from their own outcomes. */
export const KERNEL_AUTHORITY_RESULT_KIND = {
  denied: "kernel-denied",
  pending: "kernel-approval-pending",
} as const;

export type KernelAuthorityResultKind =
  (typeof KERNEL_AUTHORITY_RESULT_KIND)[keyof typeof KERNEL_AUTHORITY_RESULT_KIND];

function buildKernelDeniedResult(params: {
  command: string;
  cwd?: string;
  decision: AuthorityDecision;
}): AgentToolResult<ExecToolDetails> {
  const reasonText = params.decision.detail?.trim() || params.decision.reason;
  const idSuffix = params.decision.approval_id ? ` id=${params.decision.approval_id}` : "";
  const text = `Exec denied (kernel${idSuffix}, ${reasonText}): ${params.command}`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "failed",
      exitCode: null,
      durationMs: 0,
      aggregated: text,
      timedOut: false,
      reason: "policy-denied",
      ...(params.cwd ? { cwd: params.cwd } : {}),
    },
  };
}

/** Which gate outcome a result carries, by the shape this module alone produces. */
export function classifyKernelAuthorityResult(
  result: AgentToolResult<ExecToolDetails> | undefined,
): KernelAuthorityResultKind | undefined {
  if (!result) {
    return undefined;
  }
  if (result.details.status === "approval-pending") {
    return typeof result.details.approvalSlug === "string" &&
      result.details.approvalSlug.startsWith("kernel:")
      ? KERNEL_AUTHORITY_RESULT_KIND.pending
      : undefined;
  }
  if (result.details.status === "failed" && result.details.reason === "policy-denied") {
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    return text.startsWith("Exec denied (kernel") ? KERNEL_AUTHORITY_RESULT_KIND.denied : undefined;
  }
  return undefined;
}

function buildKernelApprovalPendingResult(params: {
  command: string;
  cwd?: string;
  host: ExecHost;
  decision: AuthorityDecision;
}): AgentToolResult<ExecToolDetails> {
  const approvalId = params.decision.approval_id ?? "unknown";
  // The kernel's own TTL is authoritative when present; fall back to a
  // conservative default notice window otherwise.
  const expiresAtMs =
    typeof params.decision.expires_at === "number"
      ? params.decision.expires_at
      : Date.now() + 300_000;
  const text = [
    `Exec requires kernel approval (id=${approvalId}): ${params.command}`,
    "This run will not execute until the APEX kernel authority records an allow decision for this exact command.",
  ].join("\n");
  return {
    content: [{ type: "text", text }],
    details: {
      status: "approval-pending",
      approvalId,
      approvalSlug: `kernel:${approvalId}`,
      expiresAtMs,
      allowedDecisions: resolveExecApprovalAllowedDecisions(),
      host: params.host,
      command: params.command,
      ...(params.cwd ? { cwd: params.cwd } : {}),
    },
  };
}

/** Raw shape of the exec tool's own runtime defaults, as far as principal identity goes. */
export type ExecKernelAuthorityIdentitySource = {
  channelContext?: { sender?: { id?: string }; chat?: { id?: string } };
  accountId?: string;
  messageProvider?: string;
  currentChannelId?: string;
  /** Agent session; partitions pending-approval memory, never sent to the kernel. */
  sessionKey?: string;
};

function principalSourceFromIdentity(
  identity: ExecKernelAuthorityIdentitySource | undefined,
): ExecKernelAuthorityPrincipalSource {
  return {
    userId: identity?.channelContext?.sender?.id ?? identity?.accountId,
    channel: identity?.messageProvider,
    channelUser: identity?.channelContext?.chat?.id ?? identity?.currentChannelId,
  };
}

export type CreateExecKernelAuthorityGateParams = {
  /** The command as requested. Overridden per call by the spawn input when the host rewrites it. */
  command: string;
  cwd?: string;
  host: ExecHost;
  /** The plane's own classification of this call as elevated/dangerous, when known. */
  elevated: boolean;
  principal?: ExecKernelAuthorityPrincipalSource;
  /** Convenience alternative to `principal`: the exec tool's own runtime defaults bag. */
  identity?: ExecKernelAuthorityIdentitySource;
  /** Agent session for pending-memory partitioning when `principal` is given directly. */
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * What is actually about to be spawned. `runExecProcess` passes the final
 * `execCommand` (after any host rewrite) and workdir; the node host passes the
 * prepared transport command plus the exact argv the node will run.
 */
export type ExecSpawnAuthorizationInput = {
  command: string;
  cwd?: string;
  argv?: readonly string[];
};

export type ExecBeforeSpawnGate = (
  spawn?: ExecSpawnAuthorizationInput,
) => Promise<AgentToolResult<ExecToolDetails> | undefined>;

/**
 * The gate the exec tool builds: the `beforeSpawn` function plus the receipt side. After a
 * kernel `allow` that CONSUMED an approval record (R2+ with an approval id; a low-risk allow
 * carries no record), `finish` reports how the effect ended so the consumed record does not
 * stay at outcome "unknown". Exactly one receipt is sent per consumed record: later calls are
 * no-ops, and a receipt failure is logged (id only) but never alters the tool result, because
 * the effect has already run.
 */
export type ExecKernelAuthorityGate = ExecBeforeSpawnGate & {
  finish: (outcome: AuthorityOutcome) => Promise<void>;
  /** Test/diagnostic hook: the consumed approval id awaiting a receipt, if any. */
  consumedApprovalId: () => string | undefined;
};

/**
 * Sends the receipt through `gate` when it is a full `ExecKernelAuthorityGate`; hosts also
 * accept a bare `beforeSpawn` function (test doubles, composed gates), for which this is a
 * no-op. Never throws.
 */
export async function finishExecKernelAuthorityGate(
  gate: ExecBeforeSpawnGate | undefined,
  outcome: AuthorityOutcome,
): Promise<void> {
  const finish = (gate as Partial<ExecKernelAuthorityGate> | undefined)?.finish;
  if (typeof finish !== "function") {
    return;
  }
  try {
    await finish(outcome);
  } catch {
    // finish() never throws by contract; this guards composed/foreign gates.
  }
}

/** Maps a finished exec process to the protocol outcome. */
export function authorityOutcomeFromExecProcess(outcome: {
  status: "completed" | "failed";
  exitCode: number | null;
  timedOut?: boolean;
}): AuthorityOutcome {
  if (outcome.status === "completed" && outcome.exitCode === 0 && !outcome.timedOut) {
    return "succeeded";
  }
  return "failed";
}

/** Maps a host's terminal exec tool result to the protocol outcome. */
export function authorityOutcomeFromExecToolResult(
  result: AgentToolResult<ExecToolDetails>,
): AuthorityOutcome {
  const details = result.details;
  if (details.status === "completed") {
    return details.exitCode === 0 && !details.timedOut ? "succeeded" : "failed";
  }
  if (details.status === "failed") {
    return details.reason === "outcome-unknown" ? "unknown" : "failed";
  }
  return "unknown";
}

/**
 * Builds a `runExecProcess`-compatible `beforeSpawn` gate for one exec call,
 * or returns `undefined` when the kernel authority integration is inactive
 * (mode "native"). Reads configuration from the environment at call time
 * (each invocation re-resolves it), so tests can flip modes between runs.
 *
 * When invoked with a spawn input, the kernel is asked about THAT command
 * (and argv, when given), and the returned result names it too; the
 * `command` given at construction time is only the fallback for callers that
 * spawn exactly what was requested.
 */
export function createExecKernelAuthorityGate(
  params: CreateExecKernelAuthorityGateParams,
): ExecKernelAuthorityGate | undefined {
  const env = params.env ?? process.env;
  const config = resolveKernelAuthorityConfig(env);
  if (config.mode !== "required") {
    return undefined;
  }
  // The approval record the last allow consumed, until its receipt is sent. A second allow
  // before the first receipt (PTY retry) replaces it: the earlier spawn never happened.
  let consumed: string | undefined;
  const gate = (async (spawn) => {
    const command = spawn?.command ?? params.command;
    const cwd = spawn?.cwd ?? params.cwd;
    const risk: AuthorityRisk = params.elevated ? "R4" : "R3";
    const principal = resolveKernelAuthorityPrincipal(
      params.principal ?? principalSourceFromIdentity(params.identity),
    );
    const request: AuthorityDecideRequest = {
      plane: "edge",
      tool: "exec",
      risk,
      principal,
      args: {
        command,
        cwd: cwd ?? "",
        host: params.host,
        ...(spawn?.argv ? { argv: [...spawn.argv] } : {}),
      },
    };
    const partition = kernelAuthorityPendingPartition(
      principal,
      params.sessionKey ?? params.identity?.sessionKey,
    );
    const key = kernelAuthorityRequestKey(request);
    const remembered = pendingApprovals.recall(partition, key);
    const decision = await decideKernelAuthority(
      remembered === undefined ? request : { ...request, approval_id: remembered },
      env,
    );
    const interpreted = interpretKernelDecision(decision, remembered);
    if (interpreted.kind === "allow") {
      pendingApprovals.forget(partition, key);
      consumed =
        typeof decision.approval_id === "string" && decision.approval_id.length > 0
          ? decision.approval_id
          : undefined;
      return undefined;
    }
    if (interpreted.kind === "pending") {
      pendingApprovals.remember(
        partition,
        key,
        interpreted.approvalId,
        interpreted.decision.expires_at,
      );
      return buildKernelApprovalPendingResult({
        command,
        ...(cwd ? { cwd } : {}),
        host: params.host,
        decision: interpreted.decision,
      });
    }
    pendingApprovals.forget(partition, key);
    return buildKernelDeniedResult({
      command,
      ...(cwd ? { cwd } : {}),
      decision: interpreted.decision,
    });
  }) as ExecKernelAuthorityGate;
  gate.consumedApprovalId = () => consumed;
  gate.finish = async (outcome) => {
    const approvalId = consumed;
    if (!approvalId) {
      return;
    }
    consumed = undefined;
    const receipt = await finishKernelAuthority({ approval_id: approvalId, outcome }, env);
    if (!receipt.ok) {
      logWarn(
        `exec: kernel authority receipt failed (id=${approvalId} outcome=${outcome}): ${receipt.detail}`,
      );
    }
  };
  return gate;
}

/**
 * Runs `first`, then `second` only if `first` allowed the spawn (returned
 * `undefined`). Either side may be absent; returns `undefined` when both are.
 * The spawn input is handed to both sides unchanged.
 */
export function composeExecBeforeSpawn(
  first: ExecBeforeSpawnGate | undefined,
  second: ExecBeforeSpawnGate | undefined,
): ExecBeforeSpawnGate | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return async (spawn) => {
    const firstResult = await first(spawn);
    if (firstResult) {
      return firstResult;
    }
    return second(spawn);
  };
}

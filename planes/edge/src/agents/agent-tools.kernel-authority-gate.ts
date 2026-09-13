/**
 * Generic APEX kernel authority gate for every edge tool except exec (Phase 4 finding C10).
 *
 * Runs inside the before_tool_call execution boundary (agent-tools.before-tool-call.wrapper.ts
 * and the adapter fallback in agent-tool-definition-adapter.ts) AFTER the plane's own policy
 * chain, hook approvals, voice confirmation, validation and steering have produced the final
 * execution params, and immediately before the tool's own `execute` runs. The kernel request
 * binds those final params (red-team finding C2 for exec applies to every tool: the kernel
 * rates what the tool will actually receive, not what the model typed).
 *
 * Semantics are identical to the exec gate:
 *  - mode "native" (default): the kernel is never consulted, nothing changes;
 *  - mode "required": the tool runs only on a kernel `allow`;
 *  - `approval_required`: the plane's existing plugin-approval flow asks the operator under the
 *    kernel's approval id; on allow the answer is relayed with `resolve`, the approval is
 *    consumed by a second `decide` presenting the id, and only then does the tool run. The id
 *    is remembered per principal (+session) so an answer that arrives after a timeout is
 *    consumed on the retry instead of proposing a new record;
 *  - `deny`, an unreachable kernel, a malformed reply: the call is refused before any side
 *    effect, as a vetoed tool result the model can read.
 * After a kernel-allowed call completes, `finish` reports succeeded|failed|unknown against the
 * consumed record (low-risk allows carry no record and need no receipt).
 *
 * Exec is recognised from the FIXED risk table and skipped here: its dedicated gate at the
 * spawn boundary is the one that governs it, so exec is never double-gated.
 */
import {
  decide as decideKernelAuthority,
  finish as finishKernelAuthority,
  resolve as resolveKernelAuthority,
  resolveKernelAuthorityConfig,
  type AuthorityDecideRequest,
  type AuthorityDecision,
  type AuthorityOutcome,
  type AuthorityRisk,
} from "../infra/kernel-authority.js";
import { logWarn } from "../logger.js";
import { isPlainObject } from "../utils.js";
import { resolveBeforeToolCallApprovalOutcome } from "./agent-tools.before-tool-call.approval.js";
import type { HookContext, HookOutcome } from "./agent-tools.before-tool-call.types.js";
import {
  resolveEdgeToolKernelRisk,
  type EdgeToolKernelClass,
} from "./agent-tools.kernel-authority-risk.js";
import {
  interpretKernelDecision,
  kernelAuthorityPendingPartition,
  kernelAuthorityRequestKey,
  resolveKernelAuthorityPrincipal,
} from "./bash-tools.exec-kernel-authority-gate.js";
import {
  createKernelAuthorityPendingMemory,
  type KernelAuthorityPendingMemory,
} from "./bash-tools.exec-kernel-authority-pending.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Plugin id under which kernel approvals are presented through the plane's approval flow. */
export const KERNEL_AUTHORITY_APPROVAL_PLUGIN_ID = "apex-kernel-authority";

/** Remembered pending ids, partitioned per principal (+session); see the exec pending module. */
const pendingApprovals: KernelAuthorityPendingMemory = createKernelAuthorityPendingMemory();

/** Test hook: forget every remembered approval id held by the generic gate. */
export function resetAgentToolKernelAuthorityPendingForTests(): void {
  pendingApprovals.clear();
}

/** Test hook: live remembered-id count (all partitions, or one). */
export function getAgentToolKernelAuthorityPendingSizeForTests(partition?: string): number {
  return partition === undefined
    ? pendingApprovals.size()
    : pendingApprovals.partitionSize(partition);
}

/** Receipt side of an allowed call. `finish` sends at most one receipt; later calls are no-ops. */
export type AgentToolKernelAuthorityAllow = {
  kind: "allow";
  /** False when the kernel was not consulted (native mode, or exec's dedicated gate). */
  governed: boolean;
  class?: EdgeToolKernelClass;
  risk?: AuthorityRisk;
  /** The consumed approval id awaiting a receipt, when the allow consumed a record. */
  consumedApprovalId?: string;
  finish: (outcome: AuthorityOutcome) => Promise<void>;
};

/** The vetoed outcome shape this gate produces; callers read `outcome.reason` directly. */
export type KernelAuthorityBlockedOutcome = Extract<HookOutcome, { blocked: true; kind: "veto" }>;

export type AgentToolKernelAuthorityGateResult =
  | AgentToolKernelAuthorityAllow
  | { kind: "blocked"; outcome: KernelAuthorityBlockedOutcome };

export type AgentToolKernelAuthorityGateParams = {
  tool?: AnyAgentTool;
  toolName: string;
  /** FINAL execution params (post-normalisation): exactly what `execute` will receive. */
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  /** The wrapper's approval mode; "defer" is treated as "request" (this IS the execution boundary). */
  approvalMode?: "request" | "report" | "deny" | "defer";
  env?: NodeJS.ProcessEnv;
};

const NOOP_ALLOW: AgentToolKernelAuthorityAllow = {
  kind: "allow",
  governed: false,
  finish: async () => {},
};

/** Tool result statuses that mean the effect did not happen or failed. */
const FAILED_RESULT_STATUSES = new Set([
  "failed",
  "error",
  "forbidden",
  "cancelled",
  "canceled",
  "timeout",
  "timed_out",
  "rejected",
  "denied",
  "blocked",
  "unavailable",
  "aborted",
]);

/** Tool result statuses that mean the effect is still in flight or never started. */
const INDETERMINATE_RESULT_STATUSES = new Set([
  "running",
  "pending",
  "approval-pending",
  "approval-unavailable",
  "suppressed",
  "skipped",
  "deferred",
  "in_progress",
]);

/** Maps a returned tool result to the protocol outcome; a thrown execution is "failed". */
export function authorityOutcomeFromToolResult(result: unknown): AuthorityOutcome {
  if (!isPlainObject(result)) {
    return "succeeded";
  }
  const details = result.details;
  const status =
    isPlainObject(details) && typeof details.status === "string" ? details.status : undefined;
  if (status === undefined) {
    return isPlainObject(details) && details.error !== undefined && details.error !== null
      ? "failed"
      : "succeeded";
  }
  if (FAILED_RESULT_STATUSES.has(status)) {
    return "failed";
  }
  if (INDETERMINATE_RESULT_STATUSES.has(status)) {
    return "unknown";
  }
  return "succeeded";
}

/**
 * The args the kernel digests: the final params as a JSON object. Non-object params are
 * wrapped; anything JSON cannot carry (cycles, BigInt) fails closed with an explicit reason.
 */
function bindToolArgs(
  params: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; detail: string } {
  try {
    const json = JSON.stringify(params === undefined ? null : params);
    const parsed: unknown = JSON.parse(json);
    return { ok: true, args: isPlainObject(parsed) ? parsed : { value: parsed } };
  } catch (error) {
    return {
      ok: false,
      detail: `tool arguments could not be bound for the kernel: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function principalSourceFromHookContext(ctx: HookContext | undefined) {
  return {
    userId: ctx?.requester?.senderId ?? ctx?.turnSourceAccountId,
    channel: ctx?.requester?.channel ?? ctx?.turnSourceChannel,
    channelUser: ctx?.turnSourceTo,
  };
}

function blocked(
  reason: string,
  params: unknown,
): { kind: "blocked"; outcome: KernelAuthorityBlockedOutcome } {
  return {
    kind: "blocked",
    outcome: {
      blocked: true,
      kind: "veto",
      deniedReason: "kernel-authority",
      reason,
      params,
    },
  };
}

function describeDecision(decision: AuthorityDecision): string {
  const detail = decision.detail?.trim();
  const idSuffix = decision.approval_id ? ` id=${decision.approval_id}` : "";
  return `${decision.reason}${detail ? `: ${detail}` : ""}${idSuffix}`;
}

function buildDeniedReason(toolName: string, decision: AuthorityDecision): string {
  return `Tool call denied by the APEX kernel authority (${describeDecision(decision)}): ${toolName}. The tool did not run.`;
}

function createFinish(
  consumedApprovalId: string | undefined,
  env: NodeJS.ProcessEnv,
  toolName: string,
): AgentToolKernelAuthorityAllow["finish"] {
  let pendingReceipt = consumedApprovalId;
  return async (outcome) => {
    const approvalId = pendingReceipt;
    if (!approvalId) {
      return;
    }
    pendingReceipt = undefined;
    const receipt = await finishKernelAuthority({ approval_id: approvalId, outcome }, env);
    if (!receipt.ok) {
      logWarn(
        `kernel authority: receipt failed for ${toolName} (id=${approvalId} outcome=${outcome}): ${receipt.detail}`,
      );
    }
  };
}

function allowFrom(params: {
  decision: AuthorityDecision;
  governedClass: EdgeToolKernelClass;
  risk: AuthorityRisk;
  env: NodeJS.ProcessEnv;
  toolName: string;
}): AgentToolKernelAuthorityAllow {
  const consumedApprovalId =
    typeof params.decision.approval_id === "string" && params.decision.approval_id.length > 0
      ? params.decision.approval_id
      : undefined;
  return {
    kind: "allow",
    governed: true,
    class: params.governedClass,
    risk: params.risk,
    ...(consumedApprovalId ? { consumedApprovalId } : {}),
    finish: createFinish(consumedApprovalId, params.env, params.toolName),
  };
}

/**
 * Runs the plane's own approval flow under the kernel's approval id, relays the answer with
 * `resolve`, and consumes the approval with a second `decide`. Returns the final gate result.
 */
async function requestOperatorApproval(params: {
  request: AuthorityDecideRequest;
  approvalId: string;
  pending: AuthorityDecision;
  partition: string;
  key: string;
  gate: AgentToolKernelAuthorityGateParams;
  governedClass: EdgeToolKernelClass;
  env: NodeJS.ProcessEnv;
}): Promise<AgentToolKernelAuthorityGateResult> {
  const { request, approvalId, gate, env } = params;
  const toolName = request.tool;
  const approvalMode = gate.approvalMode === "defer" ? "request" : gate.approvalMode;
  const expiresAt =
    typeof params.pending.expires_at === "number" ? params.pending.expires_at : undefined;
  const timeoutMs = expiresAt !== undefined ? Math.max(1_000, expiresAt - Date.now()) : undefined;
  const approval = {
    pluginId: KERNEL_AUTHORITY_APPROVAL_PLUGIN_ID,
    title: `Kernel approval required: ${toolName}`,
    description: [
      `The APEX kernel authority requires an operator decision before ${toolName} runs (risk ${request.risk}, id=${approvalId}).`,
      "Allow once to let the kernel consume this approval for exactly this call; deny to revoke it.",
    ].join(" "),
    severity:
      request.risk === "R3" || request.risk === "R4" ? ("critical" as const) : ("warning" as const),
    allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "allow-always" | "deny">,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  const answer = await resolveBeforeToolCallApprovalOutcome({
    result: { requireApproval: approval },
    approvalMode,
    toolName,
    ...(gate.toolCallId ? { toolCallId: gate.toolCallId } : {}),
    ...(gate.ctx ? { ctx: gate.ctx } : {}),
    signal: gate.signal,
    baseParams: gate.params,
  });
  if (!answer || answer.blocked) {
    const humanDenied = answer?.blocked === true && answer.reason.startsWith("Denied by user");
    if (humanDenied) {
      // Relay the denial so the kernel revokes the record; a lost relay only leaves it to expire.
      pendingApprovals.forget(params.partition, params.key);
      const revoked = await resolveKernelAuthority(
        { ...request, approval_id: approvalId, approve: false },
        env,
      );
      if (!revoked.ok) {
        logWarn(
          `kernel authority: could not relay denial for ${toolName} (id=${approvalId}): ${revoked.detail}`,
        );
      }
      return blocked(
        `Tool call denied by the operator through the APEX kernel authority (id=${approvalId}): ${toolName}. The tool did not run.`,
        gate.params,
      );
    }
    // Timeout, unavailable surface, report/deny mode: the id stays remembered so a later
    // operator allow is consumed on the retry instead of proposing a new record.
    const reason = answer?.blocked ? answer.reason : "Kernel approval could not be requested";
    return blocked(
      `${reason}\nThe APEX kernel authority holds approval id=${approvalId} for ${toolName} (risk ${request.risk}); once it is approved, run the tool call again.`,
      gate.params,
    );
  }
  const resolved = await resolveKernelAuthority(
    { ...request, approval_id: approvalId, approve: true },
    env,
  );
  if (!resolved.ok) {
    return blocked(
      `Tool call not run: the operator allowed it but the APEX kernel authority could not record the approval (id=${approvalId}, ${resolved.detail}). Run the tool call again once the kernel is reachable.`,
      gate.params,
    );
  }
  const consumed = await decideKernelAuthority({ ...request, approval_id: approvalId }, env);
  const interpreted = interpretKernelDecision(consumed, approvalId);
  if (interpreted.kind === "allow") {
    pendingApprovals.forget(params.partition, params.key);
    return allowFrom({
      decision: consumed,
      governedClass: params.governedClass,
      risk: request.risk,
      env,
      toolName,
    });
  }
  if (interpreted.kind !== "pending") {
    pendingApprovals.forget(params.partition, params.key);
  }
  return blocked(buildDeniedReason(toolName, interpreted.decision), gate.params);
}

/**
 * Asks the kernel about one tool call. Never throws: every failure mode is a blocked outcome
 * (fail closed), and a native-mode or exec call is a governed:false allow.
 */
export async function runAgentToolKernelAuthorityGate(
  gate: AgentToolKernelAuthorityGateParams,
): Promise<AgentToolKernelAuthorityGateResult> {
  const env = gate.env ?? process.env;
  const config = resolveKernelAuthorityConfig(env);
  if (config.mode !== "required") {
    return NOOP_ALLOW;
  }
  const toolName = normalizeToolPolicyName(gate.toolName || "tool");
  const resolution = resolveEdgeToolKernelRisk({ toolName, params: gate.params, tool: gate.tool });
  if (!resolution.governed) {
    return NOOP_ALLOW;
  }
  const bound = bindToolArgs(gate.params);
  if (!bound.ok) {
    return blocked(
      `Tool call denied by the APEX kernel authority (kernel_unreachable: ${bound.detail}): ${toolName}. The tool did not run.`,
      gate.params,
    );
  }
  const principal = resolveKernelAuthorityPrincipal(principalSourceFromHookContext(gate.ctx));
  const request: AuthorityDecideRequest = {
    plane: "edge",
    tool: toolName,
    risk: resolution.risk,
    principal,
    args: bound.args,
  };
  const partition = kernelAuthorityPendingPartition(principal, gate.ctx?.sessionKey);
  const key = kernelAuthorityRequestKey(request);
  const remembered = pendingApprovals.recall(partition, key);
  const decision = await decideKernelAuthority(
    remembered === undefined ? request : { ...request, approval_id: remembered },
    env,
  );
  const interpreted = interpretKernelDecision(decision, remembered);
  if (interpreted.kind === "allow") {
    pendingApprovals.forget(partition, key);
    return allowFrom({
      decision,
      governedClass: resolution.class,
      risk: resolution.risk,
      env,
      toolName,
    });
  }
  if (interpreted.kind === "pending") {
    pendingApprovals.remember(
      partition,
      key,
      interpreted.approvalId,
      interpreted.decision.expires_at,
    );
    return requestOperatorApproval({
      request,
      approvalId: interpreted.approvalId,
      pending: interpreted.decision,
      partition,
      key,
      gate,
      governedClass: resolution.class,
      env,
    });
  }
  pendingApprovals.forget(partition, key);
  return blocked(buildDeniedReason(toolName, interpreted.decision), gate.params);
}

/**
 * Convenience for execution boundaries: gate, then run `invoke` only on allow, then send the
 * receipt. A thrown execution is reported as "failed" and re-thrown unchanged.
 */
export async function runToolUnderKernelAuthority<T>(
  params: AgentToolKernelAuthorityGateParams & { invoke: () => Promise<T> },
): Promise<
  { kind: "blocked"; outcome: KernelAuthorityBlockedOutcome } | { kind: "result"; result: T }
> {
  const { invoke, ...gateParams } = params;
  const gate = await runAgentToolKernelAuthorityGate(gateParams);
  if (gate.kind === "blocked") {
    return gate;
  }
  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    await gate.finish("failed");
    throw error;
  }
  await gate.finish(authorityOutcomeFromToolResult(result));
  return { kind: "result", result };
}

import type { invokeNodeSystemRun } from "./bash-tools.exec-host-node-failure.js";
/**
 * Kernel authority gate wiring for the node host (red-team finding C1).
 *
 * `host: "node"` used to return from the exec tool BEFORE the kernel gate was
 * built, so with APEX_AUTHORITY_MODE=required a deny-everything kernel still
 * saw the remote `system.run` fire. The node host now consults the same gate
 * as the gateway/sandbox hosts immediately before EACH `system.run` dispatch:
 *
 *  - the inline dispatch (policy satisfied, or an approval resolved within the
 *    tool call): a kernel deny / approval_required is returned to the caller
 *    as the very same tool result the local hosts produce;
 *  - the deferred continuation (a human approves the plane's own request after
 *    the tool call already returned approval-pending): the run is NOT
 *    dispatched and the operator gets a follow-up message naming the kernel
 *    outcome instead. There is no second tool result to return at that point,
 *    so a kernel `approval_required` there costs one more exec attempt: the id
 *    is remembered, the retry presents it, and the command runs once the
 *    kernel has recorded the human's allow. That is the documented, fail-safe
 *    cost; an unauthorized dispatch is never possible.
 *
 * The gate authorizes what the node will actually run: the prepared transport
 * command text and the exact argv from `system.run.prepare`.
 */
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import {
  authorityOutcomeFromExecToolResult,
  classifyKernelAuthorityResult,
  createExecKernelAuthorityGate,
  finishExecKernelAuthorityGate,
  type ExecBeforeSpawnGate,
  type ExecSpawnAuthorizationInput,
} from "./bash-tools.exec-kernel-authority-gate.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

/**
 * The gate the exec tool built for this call, or (for direct callers of
 * `executeNodeHostCommand`) one resolved here from the environment and the
 * turn's own identity fields. Never `undefined` in mode "required".
 */
export function resolveNodeHostKernelAuthorityGate(
  params: ExecuteNodeHostCommandParams,
): ExecBeforeSpawnGate | undefined {
  if (params.kernelAuthorityGate) {
    return params.kernelAuthorityGate;
  }
  return createExecKernelAuthorityGate({
    command: params.command,
    ...(params.workdir ? { cwd: params.workdir } : {}),
    host: "node",
    elevated: params.bashElevated?.enabled === true,
    identity: {
      ...(params.turnSourceAccountId ? { accountId: params.turnSourceAccountId } : {}),
      ...(params.turnSourceChannel ? { messageProvider: params.turnSourceChannel } : {}),
      ...(params.turnSourceTo ? { currentChannelId: params.turnSourceTo } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    },
  });
}

/** What the node will actually run, as the kernel must see it. */
export function buildNodeHostSpawnAuthorization(prepared: {
  argv: readonly string[];
  transportRawCommand: string;
  cwd: string | undefined;
}): ExecSpawnAuthorizationInput {
  return {
    command: prepared.transportRawCommand,
    ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
    argv: [...prepared.argv],
  };
}

/**
 * Consults the gate for the exact prepared run. `undefined` means the kernel
 * allowed it (or the integration is inactive); anything else must be returned
 * or relayed to the operator and the run must not be dispatched.
 */
export async function consultNodeHostKernelAuthority(
  gate: ExecBeforeSpawnGate | undefined,
  prepared: { argv: readonly string[]; transportRawCommand: string; cwd: string | undefined },
): Promise<AgentToolResult<ExecToolDetails> | undefined> {
  if (!gate) {
    return undefined;
  }
  return gate(buildNodeHostSpawnAuthorization(prepared));
}

/** Follow-up text for the deferred continuation when the kernel did not allow the dispatch. */
export function formatNodeHostKernelAuthorityFollowup(params: {
  result: AgentToolResult<ExecToolDetails>;
  nodeId: string;
  approvalId: string;
}): string {
  const kind = classifyKernelAuthorityResult(params.result);
  const text = params.result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
  const prefix =
    kind === "kernel-approval-pending"
      ? `Exec not dispatched (node=${params.nodeId} id=${params.approvalId}, kernel-approval-required)`
      : `Exec denied (node=${params.nodeId} id=${params.approvalId}, kernel-denied)`;
  const hint =
    kind === "kernel-approval-pending"
      ? "\nThe plane's approval was recorded, but the APEX kernel still requires its own allow decision for this exact command. Once it is recorded, run the exec again: the retry presents the remembered kernel approval id."
      : "";
  return `${prefix}\n${text}${hint}`;
}

type NodeInvokeResult = Awaited<ReturnType<typeof invokeNodeSystemRun>>;

/** How a node `system.run` dispatch ended, as far as the receipt is concerned. */
export type NodeHostKernelAuthorityCompletion =
  | { kind: "result"; result: AgentToolResult<ExecToolDetails> }
  | { kind: "invocation"; invocation: NodeInvokeResult }
  | { kind: "unknown" };

/** Protocol outcome for a node dispatch: exit 0 without timeout succeeded, anything else failed. */
export function authorityOutcomeFromNodeInvocation(
  invocation: NodeInvokeResult,
): "succeeded" | "failed" {
  if (!invocation.ok) {
    return "failed";
  }
  const raw = invocation.raw as { payload?: unknown } | undefined;
  const payload =
    raw?.payload && typeof raw.payload === "object"
      ? (raw.payload as { exitCode?: unknown; timedOut?: unknown; error?: unknown })
      : {};
  return payload.exitCode === 0 && payload.timedOut !== true && !payload.error
    ? "succeeded"
    : "failed";
}

/**
 * Sends the receipt for the approval the kernel consumed before this dispatch. A no-op when the
 * gate is absent (native mode) or consumed nothing (low-risk allow). Never throws.
 */
export async function finishNodeHostKernelAuthority(
  gate: ExecBeforeSpawnGate | undefined,
  completion: NodeHostKernelAuthorityCompletion,
): Promise<void> {
  if (!gate) {
    return;
  }
  const outcome =
    completion.kind === "result"
      ? authorityOutcomeFromExecToolResult(completion.result)
      : completion.kind === "invocation"
        ? authorityOutcomeFromNodeInvocation(completion.invocation)
        : "unknown";
  await finishExecKernelAuthorityGate(gate, outcome);
}

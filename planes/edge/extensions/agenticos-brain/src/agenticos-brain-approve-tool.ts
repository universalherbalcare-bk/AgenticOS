// Resolves a pending brain-plane approval from the edge plane.
//
// The bridge pauses a run and streams `approval.required`; `agenticos_brain_turn`
// then returns early with `{ pending: true, approval_id, turn_id }` and refuses to
// auto-approve. This tool is the other half of that loop: an operator (or an
// agent acting under the gateway's own approval policy) resolves the approval
// via POST /v1/turns/{turn_id}/approvals/{approval_id}, and the paused run either
// resumes or ends as run.failed("approval denied by operator").
//
// Nothing here bypasses governance: the bridge still enforces its bearer token
// and, in `required` mode, the APEX kernel's binding of the approval.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { BrainClient, BridgeError } from "../vendor/client.ts";
import type { ApprovalDecision } from "../vendor/contract.ts";
import {
  DEFAULT_TURN_SCOPES,
  type PluginCfg,
  resolveAuthToken,
  resolveBaseUrl,
} from "./agenticos-brain-tool.js";

export const agenticosBrainApproveToolDefinition = {
  name: "agenticos_brain_approve",
  label: "AgenticOS Brain: resolve approval",
  description:
    "Approve or deny a pending AgenticOS brain-plane approval (returned by agenticos_brain_turn as pending). " +
    "approve resumes the paused run; deny ends it as failed. The brain enforces its own auth and kernel policy.",
  parameters: Type.Object(
    {
      turn_id: Type.String({
        description: "turn_id from the pending agenticos_brain_turn result.",
      }),
      approval_id: Type.String({
        description: "approval_id from the pending agenticos_brain_turn result.",
      }),
      decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
      reason: Type.Optional(
        Type.String({ description: "Optional operator reason (max 1024 chars)." }),
      ),
    },
    { additionalProperties: false },
  ),
};

type ApproveParams = {
  turn_id?: unknown;
  approval_id?: unknown;
  decision?: unknown;
  reason?: unknown;
};

export type CreateApproveToolOptions = {
  api: { pluginConfig?: unknown };
  toolContext?: { requesterSenderId?: string | null } | undefined;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
};

export function createAgenticosBrainApproveTool(options: CreateApproveToolOptions) {
  const { api, toolContext } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;

  return {
    ...agenticosBrainApproveToolDefinition,

    async execute(_id: string, params: ApproveParams) {
      const turnId = normalizeOptionalString(params.turn_id);
      const approvalId = normalizeOptionalString(params.approval_id);
      const decision = params.decision;
      if (!turnId) {
        throw new Error("turn_id required");
      }
      if (!approvalId) {
        throw new Error("approval_id required");
      }
      if (decision !== "approve" && decision !== "deny") {
        throw new Error('decision must be "approve" or "deny"');
      }
      const reason = normalizeOptionalString(params.reason);
      if (reason && reason.length > 1024) {
        throw new Error("reason exceeds 1024 characters");
      }

      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;
      const client = new BrainClient({
        baseUrl: resolveBaseUrl(pluginCfg),
        authToken: resolveAuthToken(pluginCfg, env),
        fetchImpl,
      });
      const body: ApprovalDecision = {
        approval_id: approvalId,
        decision,
        principal: {
          user_id: normalizeOptionalString(toolContext?.requesterSenderId) ?? "edge",
          channel: "openclaw",
          scopes: [...DEFAULT_TURN_SCOPES],
        },
        ...(reason ? { reason } : {}),
      };

      try {
        await client.resolveApproval(turnId, body);
      } catch (err) {
        if (err instanceof BridgeError && err.status === 404) {
          throw new Error(
            `no pending approval ${approvalId} for turn ${turnId} (already resolved, timed out, or unknown)`,
            { cause: err },
          );
        }
        throw err;
      }

      return {
        content: [
          { type: "text", text: `Approval ${approvalId} ${decision}d for turn ${turnId}.` },
        ],
        details: { turn_id: turnId, approval_id: approvalId, decision, resolved: true },
      };
    },
  };
}

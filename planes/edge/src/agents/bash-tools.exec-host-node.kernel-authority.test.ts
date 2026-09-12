/**
 * Regression tests for red-team finding C1: the node host (`host: "node"`) must
 * be governed by the APEX kernel authority exactly like the local hosts.
 *
 * Fixture: the same real node-host stack as bash-tools.exec-host-node.integration.test.ts
 * (real `handleInvoke` node program, real approvals snapshot, gateway RPC mocked), with a
 * `/bin/sh` shim standing in for APEX_AUTHORITY_CMD. `invokeCount` counts real
 * `system.run` dispatches, i.e. whether the remote command boundary was reached.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readExecApprovalsSnapshot, saveExecApprovals } from "../infra/exec-approvals.js";
import { handleInvoke } from "../node-host/invoke.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import type { Deferred } from "../shared/deferred.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { resetKernelAuthorityPendingForTests } from "./bash-tools.exec-kernel-authority-gate.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

const rpc = vi.hoisted(() => vi.fn());
const followupSpy = vi.hoisted(() => vi.fn(async (_target: unknown, _text: string) => undefined));
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: rpc }));
vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: async () => [
    {
      nodeId: "node-1",
      connected: true,
      platform: "darwin",
      commands: ["system.run", "system.run.prepare"],
    },
  ],
  resolveNodeIdFromList: () => "node-1",
}));
vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>()),
  sendExecApprovalFollowupResult: followupSpy,
}));

const ENV_KEYS = [
  "APEX_AUTHORITY_CMD",
  "APEX_AUTHORITY_DIR",
  "APEX_AUTHORITY_MODE",
  "APEX_AUTHORITY_TIMEOUT_MS",
  "FAKE_AUTHORITY_MODE",
  "FAKE_AUTHORITY_REQUEST_FILE",
];

const APPROVAL_ID = "d".repeat(64);

const SHIM_SCRIPT = `#!/bin/sh
set -eu
request="$(cat)"
if [ -n "\${FAKE_AUTHORITY_REQUEST_FILE:-}" ]; then
  printf '%s' "$request" > "$FAKE_AUTHORITY_REQUEST_FILE"
fi
case "\${FAKE_AUTHORITY_MODE:-deny}" in
  allow)
    printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"low_risk","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}'
    ;;
  approval_required)
    printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":"${APPROVAL_ID}","expires_at":4102444800000}}'
    ;;
  *)
    printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"tool_disabled","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}'
    ;;
esac
exit 0
`;

type ShimFixture = { dir: string; shim: string; requestFile: string };

function createShimFixture(): ShimFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-kernel-authority-shim-"));
  const shim = path.join(dir, "apex-authority");
  fs.writeFileSync(shim, SHIM_SCRIPT, { mode: 0o755 });
  return { dir, shim, requestFile: path.join(dir, "request.json") };
}

function readSentRequest(fixture: ShimFixture): Record<string, unknown> & {
  args: Record<string, unknown>;
} {
  return JSON.parse(fs.readFileSync(fixture.requestFile, "utf8"));
}

let state: OpenClawTestState;
let invokeCount: number;
let lastSystemRunParams: Record<string, unknown> | undefined;
let request: ExecuteNodeHostCommandParams & { workdir: string };
let resolveDecision: (result: { decision: string }) => void;
let decisionEntered: Deferred;
let envSnapshot: ReturnType<typeof captureEnv>;
let fixture: ShimFixture;

describeUnix("node host kernel authority gate (C1)", () => {
  beforeEach(async ({ onTestFinished }) => {
    envSnapshot = captureEnv(ENV_KEYS);
    for (const key of ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    resetKernelAuthorityPendingForTests();
    followupSpy.mockReset();
    followupSpy.mockImplementation(async () => undefined);
    fixture = createShimFixture();
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const previousRegistry = captureActivePluginRegistrySnapshot();
    onTestFinished(() => rollbackStagedPluginRegistry(previousRegistry));
    stageActivePluginRegistry(
      createTestRegistry([
        { pluginId: "a2a", source: "test", plugin: createChannelTestPluginBase({ id: "a2a" }) },
      ]),
      null,
      "default",
    );
    state = await createOpenClawTestState({ label: "node-exec-kernel-authority" });
    await state.writeConfig({});
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
    invokeCount = 0;
    lastSystemRunParams = undefined;
    request = {
      command: "/usr/bin/printf node-kernel-proof",
      workdir: await fsp.realpath(state.root),
      env: {},
      sessionKey: "agent:main:node-kernel",
      agentId: "main",
      security: "full",
      ask: "off",
      defaultTimeoutSec: 5,
      approvalRunningNoticeMs: 1000,
      warnings: [],
      turnSourceChannel: "webchat",
    };
    const decision = new Promise<{ decision: string }>((resolve) => {
      resolveDecision = resolve;
    });
    decisionEntered = createDeferred();
    rpc.mockReset().mockImplementation(async (method, _options, params) => {
      if (method === "exec.approvals.node.get") {
        return readExecApprovalsSnapshot();
      }
      if (method === "exec.approval.request") {
        return { id: params.id, expiresAtMs: Date.now() + 60000 };
      }
      if (method === "exec.approval.waitDecision") {
        decisionEntered.resolve();
        return await decision;
      }
      if (method !== "node.invoke") {
        throw new Error(`Unexpected RPC: ${method}`);
      }
      if (params.command === "system.run") {
        invokeCount += 1;
        lastSystemRunParams = params.params as Record<string, unknown>;
      }
      let response:
        | { ok: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
        | undefined;
      await handleInvoke(
        {
          id: "invoke-1",
          nodeId: "node-1",
          command: params.command,
          paramsJSON: JSON.stringify(params.params),
        },
        {
          async request<T>(name: string, value?: unknown): Promise<T> {
            if (name === "node.invoke.result") {
              response = value as typeof response;
            }
            return {} as T;
          },
        },
        { current: async () => [] },
      );
      if (!response?.ok) {
        throw Object.assign(new Error(response?.error?.message ?? "Node rejected invocation"), {
          details: { nodeError: response?.error },
        });
      }
      return { payload: JSON.parse(response.payloadJSON ?? "{}") };
    });
  });

  afterEach(async () => {
    envSnapshot.restore();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    await state.cleanup();
  });

  it("required + kernel deny: system.run is never dispatched and the caller gets the kernel denial", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");

    const result = await executeNodeHostCommand({ ...request });

    expect(invokeCount).toBe(0);
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("Exec denied (kernel");
    expect(text).toContain("tool_disabled");
    expect(text).toContain("node-kernel-proof");
    expect(text).not.toMatch(/may have executed|request approval/);
    const sent = readSentRequest(fixture);
    expect(sent.args.host).toBe("node");
  });

  it("native mode (default): the shim is never consulted and the command runs as before", async () => {
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");

    const result = await executeNodeHostCommand({ ...request });

    expect(invokeCount).toBe(1);
    expect(result.details).toMatchObject({ status: "completed", aggregated: "node-kernel-proof" });
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
  });

  it("required + allow: dispatched once, and the kernel saw exactly what the node runs (transport command + argv)", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");

    const result = await executeNodeHostCommand({
      ...request,
      turnSourceChannel: "slack",
      turnSourceAccountId: "acct-9",
      turnSourceTo: "chan-7",
    });

    expect(invokeCount).toBe(1);
    expect(result.details).toMatchObject({ status: "completed", aggregated: "node-kernel-proof" });
    const sent = readSentRequest(fixture);
    expect(sent.op).toBe("decide");
    expect(sent.plane).toBe("edge");
    expect(sent.tool).toBe("exec");
    expect(sent.args.host).toBe("node");
    // The dispatched system.run carries the prepared argv and rawCommand; the kernel request
    // must name those, not merely the command as the model typed it.
    expect(lastSystemRunParams).toBeDefined();
    expect(sent.args.argv).toEqual(lastSystemRunParams?.command);
    expect(sent.args.command).toBe(lastSystemRunParams?.rawCommand);
    expect(sent.args.cwd).toBe(lastSystemRunParams?.cwd);
    expect(sent.principal).toEqual({ user_id: "acct-9", channel: "slack", channel_user: "chan-7" });
  });

  it("required + approval_required: not dispatched, the kernel approval id is surfaced under the kernel slug", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");

    const result = await executeNodeHostCommand({ ...request });

    expect(invokeCount).toBe(0);
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: APPROVAL_ID,
      approvalSlug: `kernel:${APPROVAL_ID}`,
      host: "node",
    });
  });

  it("required + an explicitly supplied gate is the one consulted (the exec tool's gate wins over env resolution)", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
    const suppliedGate = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Exec denied (kernel, supplied-gate): x" }],
      details: {
        status: "failed" as const,
        exitCode: null,
        durationMs: 0,
        aggregated: "Exec denied (kernel, supplied-gate): x",
        timedOut: false,
        reason: "policy-denied" as const,
      },
    }));

    const result = await executeNodeHostCommand({ ...request, kernelAuthorityGate: suppliedGate });

    expect(invokeCount).toBe(0);
    expect(suppliedGate).toHaveBeenCalledTimes(1);
    expect(suppliedGate.mock.calls[0]?.[0]).toMatchObject({
      argv: expect.any(Array),
      command: expect.any(String),
    });
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
  });

  it("required + deferred human approval: the plane's grant does not bypass the kernel; a deny is relayed as a follow-up and nothing is dispatched", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");

    const result = await executeNodeHostCommand({
      ...request,
      ask: "always",
      approvalFollowupMode: "agent",
    });
    // The plane's own approval is what the tool reports first; the kernel is not consulted
    // until the human's answer would otherwise dispatch the run.
    expect(result.details).toMatchObject({ status: "approval-pending" });
    expect(fs.existsSync(fixture.requestFile)).toBe(false);

    await decisionEntered.promise;
    resolveDecision({ decision: "allow-once" });

    await vi.waitFor(() => {
      expect(followupSpy).toHaveBeenCalled();
    });
    const followup = followupSpy.mock.calls[0]?.[1] ?? "";
    expect(followup).toContain("kernel-denied");
    expect(followup).toContain("tool_disabled");
    expect(followup).toContain("node=node-1");
    expect(invokeCount).toBe(0);
    expect(readSentRequest(fixture).args.host).toBe("node");
  });

  it("required + deferred human approval + kernel approval_required: relayed with the retry hint, nothing dispatched", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");

    const result = await executeNodeHostCommand({
      ...request,
      ask: "always",
      approvalFollowupMode: "agent",
    });
    expect(result.details).toMatchObject({ status: "approval-pending" });

    await decisionEntered.promise;
    resolveDecision({ decision: "allow-once" });

    await vi.waitFor(() => {
      expect(followupSpy).toHaveBeenCalled();
    });
    const followup = followupSpy.mock.calls[0]?.[1] ?? "";
    expect(followup).toContain("kernel-approval-required");
    expect(followup).toContain(APPROVAL_ID);
    expect(followup).toContain("run the exec again");
    expect(invokeCount).toBe(0);
  });
});

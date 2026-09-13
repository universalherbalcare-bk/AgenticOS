/**
 * Receipts (`finish`) for exec spawns the kernel allowed by consuming an approval record.
 *
 * Same fixture as bash-tools.exec.kernel-authority.test.ts (real `createExecTool().execute()`
 * pipeline, supervisor spawn stubbed at the OS-process boundary), with the stateful shim from
 * agent-tools.kernel-authority-gate.test-support.ts so the exact protocol sequence, including
 * the receipt and its outcome, can be asserted. The local hosts (gateway inline and sandbox)
 * share the `runExecProcess` settlement path exercised here; the node host has its own test
 * in bash-tools.exec-host-node.kernel-authority.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createKernelAuthorityShimFixture,
  SHIM_APPROVAL_ID,
  SHIM_ENV_KEYS,
  type KernelAuthorityShimFixture,
} from "./agent-tools.kernel-authority-gate.test-support.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import {
  authorityOutcomeFromExecProcess,
  authorityOutcomeFromExecToolResult,
  createExecKernelAuthorityGate,
  finishExecKernelAuthorityGate,
  resetKernelAuthorityPendingForTests,
} from "./bash-tools.exec-kernel-authority-gate.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

const spawnSpy = vi.hoisted(() => vi.fn());

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: spawnSpy,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";

function managedRun(exitCode: number) {
  return {
    runId: "run-receipt",
    startedAtMs: Date.now(),
    pid: 4242,
    stdin: undefined,
    wait: async () => ({
      reason: "exit" as const,
      exitCode,
      exitSignal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }),
    cancel: vi.fn(),
  };
}

describeUnix("exec kernel authority receipts (finish)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let fixture: KernelAuthorityShimFixture;

  beforeEach(() => {
    envSnapshot = captureEnv(SHIM_ENV_KEYS);
    for (const key of SHIM_ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    fixture = createKernelAuthorityShimFixture("exec-kernel-receipt-shim-");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_STATE_DIR", fixture.stateDir);
    setTestEnvValue("APEX_AUTHORITY_TIMEOUT_MS", "10000");
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    spawnSpy.mockReset();
    resetProcessRegistryForTests();
    resetKernelAuthorityPendingForTests();
  });

  afterEach(() => {
    envSnapshot.restore();
    fixture.cleanup();
  });

  const createExecTool = () =>
    createExecToolImpl({ host: "gateway", security: "full", ask: "off", agentId: "main" });

  it("consumed approval + exit 0: the receipt names the approval id with outcome succeeded", async () => {
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
    spawnSpy.mockImplementation(async () => managedRun(0));
    const result = await createExecTool().execute("x-ok", { command: "echo ok" });
    expect(result.details.status).toBe("completed");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fixture.ops("finish")).toHaveLength(1);
    });
    expect(fixture.requests().map((r) => r.op)).toEqual(["decide", "finish"]);
    expect(fixture.ops("finish")[0]).toMatchObject({
      approval_id: SHIM_APPROVAL_ID,
      outcome: "succeeded",
    });
  });

  it("consumed approval + non-zero exit: outcome failed", async () => {
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
    spawnSpy.mockImplementation(async () => managedRun(3));
    const result = await createExecTool().execute("x-fail", { command: "false" });
    // The exec tool reports a non-zero exit as "completed" with the exit code; the receipt
    // must still say the effect failed.
    expect(result.details).toMatchObject({ status: "completed", exitCode: 3 });
    await vi.waitFor(() => {
      expect(fixture.ops("finish")).toHaveLength(1);
    });
    expect(fixture.ops("finish")[0]).toMatchObject({
      approval_id: SHIM_APPROVAL_ID,
      outcome: "failed",
    });
  });

  it("consumed approval + spawn failure: the effect never ran, the receipt says failed", async () => {
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
    spawnSpy.mockImplementation(async () => {
      throw new Error("spawn EACCES");
    });
    await expect(createExecTool().execute("x-spawn", { command: "echo never" })).rejects.toThrow(
      "spawn EACCES",
    );
    await vi.waitFor(() => {
      expect(fixture.ops("finish")).toHaveLength(1);
    });
    expect(fixture.ops("finish")[0]).toMatchObject({
      approval_id: SHIM_APPROVAL_ID,
      outcome: "failed",
    });
  });

  it("low-risk allow (no record): no receipt is sent", async () => {
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
    spawnSpy.mockImplementation(async () => managedRun(0));
    await createExecTool().execute("x-low", { command: "echo ok" });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(fixture.requests().map((r) => r.op)).toEqual(["decide"]);
  });

  it("deny: nothing spawned, nothing to receipt", async () => {
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
    spawnSpy.mockImplementation(async () => managedRun(0));
    const result = await createExecTool().execute("x-deny", { command: "echo no" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
    expect(fixture.requests().map((r) => r.op)).toEqual(["decide"]);
  });

  describe("gate object", () => {
    it("finish is idempotent per consumed approval and a no-op before any allow", async () => {
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
      const gate = createExecKernelAuthorityGate({
        command: "echo x",
        host: "gateway",
        elevated: false,
        principal: { userId: "u", channel: "cli" },
      });
      expect(gate).toBeDefined();
      await gate!.finish("succeeded");
      expect(fixture.requests()).toEqual([]);
      expect(await gate!({ command: "echo x", cwd: "/tmp" })).toBeUndefined();
      expect(gate!.consumedApprovalId()).toBe(SHIM_APPROVAL_ID);
      await gate!.finish("succeeded");
      await gate!.finish("failed");
      expect(gate!.consumedApprovalId()).toBeUndefined();
      expect(fixture.ops("finish")).toHaveLength(1);
      expect(fixture.ops("finish")[0]).toMatchObject({ outcome: "succeeded" });
    });

    it("finishExecKernelAuthorityGate tolerates bare beforeSpawn functions", async () => {
      await expect(
        finishExecKernelAuthorityGate(async () => undefined, "succeeded"),
      ).resolves.toBeUndefined();
      await expect(finishExecKernelAuthorityGate(undefined, "failed")).resolves.toBeUndefined();
    });

    it("outcome mapping: exit 0 without timeout succeeded, else failed; unknown stays unknown", () => {
      expect(
        authorityOutcomeFromExecProcess({ status: "completed", exitCode: 0, timedOut: false }),
      ).toBe("succeeded");
      expect(
        authorityOutcomeFromExecProcess({ status: "completed", exitCode: 1, timedOut: false }),
      ).toBe("failed");
      expect(
        authorityOutcomeFromExecProcess({ status: "failed", exitCode: null, timedOut: true }),
      ).toBe("failed");
      expect(
        authorityOutcomeFromExecToolResult({
          content: [],
          details: { status: "completed", exitCode: 0, durationMs: 1, aggregated: "" },
        }),
      ).toBe("succeeded");
      expect(
        authorityOutcomeFromExecToolResult({
          content: [],
          details: {
            status: "failed",
            exitCode: null,
            durationMs: 1,
            aggregated: "",
            reason: "outcome-unknown",
          },
        }),
      ).toBe("unknown");
      expect(
        authorityOutcomeFromExecToolResult({
          content: [],
          details: {
            status: "approval-pending",
            approvalId: "a",
            approvalSlug: "kernel:a",
            expiresAtMs: 1,
            host: "gateway",
            command: "x",
          },
        }),
      ).toBe("unknown");
    });
  });
});

/**
 * Phase 2 done-criterion, edge plane, against the REAL kernel.
 *
 * bash-tools.exec.kernel-authority.test.ts proves the wiring with a /bin/sh shim. This file
 * repeats the decisive cases with APEX_AUTHORITY_CMD pointed at the real launcher
 * (kernel/bin/apex-authority in the merged product) over a fresh authority workspace, so every
 * decision below was made by apex_os.authority_service over a real SQLite store. It runs only
 * when APEX_AUTHORITY_REAL_LAUNCHER names that launcher; the merged product's integration job
 * sets it, a standalone edge checkout skips with a visible reason rather than a silent pass.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { resetKernelAuthorityPendingForTests } from "./bash-tools.exec-kernel-authority-gate.js";

const LAUNCHER = process.env.APEX_AUTHORITY_REAL_LAUNCHER;
const describeReal =
  process.platform !== "win32" && LAUNCHER && fs.existsSync(LAUNCHER) ? describe : describe.skip;

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

const ENV_KEYS = [
  "APEX_AUTHORITY_CMD",
  "APEX_AUTHORITY_DIR",
  "APEX_AUTHORITY_MODE",
  "APEX_AUTHORITY_TIMEOUT_MS",
];

function managedRun() {
  return {
    runId: "run-real",
    startedAtMs: Date.now(),
    pid: 4243,
    stdin: undefined,
    wait: async () => ({
      reason: "exit" as const,
      exitCode: 0,
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

/** Talks to the real kernel directly, as the human's approval channel would. */
function kernel(request: Record<string, unknown>): Record<string, unknown> {
  try {
    const out = execFileSync(LAUNCHER as string, [], {
      input: JSON.stringify(request),
      env: process.env,
      timeout: 30_000,
    });
    return JSON.parse(out.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    // Exit 2 is the kernel's "undecidable / refused" answer and still carries a JSON body.
    const stdout = (error as { stdout?: Buffer | string }).stdout;
    const text = typeof stdout === "string" ? stdout : stdout?.toString("utf8");
    if (text) {
      return JSON.parse(text) as Record<string, unknown>;
    }
    throw error;
  }
}

describeReal("exec tool kernel authority gate against the real kernel", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let workspace: string;

  beforeEach(() => {
    envSnapshot = captureEnv(ENV_KEYS);
    for (const key of ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-authority-edge-"));
    fs.chmodSync(workspace, 0o700);
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", LAUNCHER as string);
    setTestEnvValue("APEX_AUTHORITY_DIR", workspace);
    setTestEnvValue("APEX_AUTHORITY_TIMEOUT_MS", "20000");
    spawnSpy.mockReset();
    spawnSpy.mockImplementation(async () => managedRun());
    resetProcessRegistryForTests();
    resetKernelAuthorityPendingForTests();
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("REAL KERNEL: no approval, not spawned; the human approves the exact command, spawned once; replay not spawned", async () => {
    const tool = createExecToolImpl({
      host: "gateway",
      security: "full",
      ask: "off",
      agentId: "main",
      messageProvider: "cli",
      accountId: "brijesh",
    });
    const first = await tool.execute("real-1", { command: "echo real" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(first.details.status).toBe("approval-pending");
    const approvalId = (first.details as { approvalId?: string }).approvalId ?? "";
    expect(approvalId).toMatch(/^[a-f0-9]{64}$/);

    const request = {
      plane: "edge",
      tool: "exec",
      risk: "R3",
      principal: { user_id: "brijesh", channel: "cli" },
      args: {
        command: "echo real",
        cwd: (first.details as { cwd?: string }).cwd ?? "",
        host: "gateway",
      },
    };
    // Approving a different command against this record is refused by the kernel.
    const wrong = kernel({
      op: "resolve",
      directory: workspace,
      approval_id: approvalId,
      approve: true,
      ...request,
      args: { ...request.args, command: "rm -rf /" },
    });
    expect(wrong.ok).toBe(false);

    const resolved = kernel({
      op: "resolve",
      directory: workspace,
      approval_id: approvalId,
      approve: true,
      ...request,
    });
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);

    const second = await tool.execute("real-2", { command: "echo real" });
    expect(second.details.status).toBe("completed");
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const replay = await tool.execute("real-3", { command: "echo real" });
    expect(replay.details.status).toBe("approval-pending");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("REAL KERNEL: the kill switch 'edge:exec' denies without offering an approval", async () => {
    fs.writeFileSync(
      path.join(workspace, "authority-policy.json"),
      JSON.stringify({ schema: "apex.authority-policy.v1", disabled: ["edge:exec"] }),
      { mode: 0o600 },
    );
    const tool = createExecToolImpl({
      host: "gateway",
      security: "full",
      ask: "off",
      agentId: "main",
    });
    const result = await tool.execute("real-kill", { command: "echo blocked" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("tool_disabled");
  });
});

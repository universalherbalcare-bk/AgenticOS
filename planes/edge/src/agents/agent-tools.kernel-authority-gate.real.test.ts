/**
 * Generic tool gate + receipts against the REAL kernel (apex_os.authority_service over a real
 * SQLite store), the way bash-tools.exec.kernel-authority.real.test.ts proves the exec gate.
 * Runs only when APEX_AUTHORITY_REAL_LAUNCHER names kernel/bin/apex-authority; otherwise it
 * skips with a visible reason rather than a silent pass.
 *
 * Proves, over a file write, an MCP-shaped tool and an exec spawn:
 *  - R2 without approval: no side effect, a pending record with the plane's tool id;
 *  - the operator's allow (relayed through the plane's approval flow) is resolved and consumed
 *    by the kernel, the effect runs exactly once, and the consumed record's `outcome` field
 *    carries the receipt ("succeeded"/"failed") instead of staying "unknown".
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import { resetAgentToolKernelAuthorityPendingForTests } from "./agent-tools.kernel-authority-gate.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { resetKernelAuthorityPendingForTests } from "./bash-tools.exec-kernel-authority-gate.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

const LAUNCHER = process.env.APEX_AUTHORITY_REAL_LAUNCHER;
const describeReal =
  process.platform !== "win32" && LAUNCHER && fs.existsSync(LAUNCHER) ? describe : describe.skip;

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

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
import { createWriteTool } from "./sessions/index.js";

const mockCallGateway = vi.mocked(callGatewayTool);

const ENV_KEYS = [
  "APEX_AUTHORITY_CMD",
  "APEX_AUTHORITY_DIR",
  "APEX_AUTHORITY_MODE",
  "APEX_AUTHORITY_TIMEOUT_MS",
];

const ctx: HookContext = {
  agentId: "main",
  sessionKey: "agent:main:kernel-real",
  turnSourceChannel: "cli",
  turnSourceAccountId: "brijesh",
};

/** The kernel's own record for an approval id, read straight from its SQLite store. */
function readRecord(workspace: string, approvalId: string): Record<string, unknown> | undefined {
  const db = new DatabaseSync(path.join(workspace, "authority.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT data FROM approvals WHERE id = ?").get(approvalId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined;
  } finally {
    db.close();
  }
}

function pendingIds(workspace: string): string[] {
  const db = new DatabaseSync(path.join(workspace, "authority.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, data FROM approvals").all() as Array<{
      id: string;
      data: string;
    }>;
    return rows
      .filter((row) => (JSON.parse(row.data) as { status?: string }).status === "pending")
      .map((row) => row.id);
  } finally {
    db.close();
  }
}

function managedRun(exitCode: number) {
  return {
    runId: "run-real-receipt",
    startedAtMs: Date.now(),
    pid: 4244,
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

/** Talks to the real kernel directly, as the human's approval channel would (exec case). */
function kernel(request: Record<string, unknown>): Record<string, unknown> {
  try {
    const out = execFileSync(LAUNCHER as string, [], {
      input: JSON.stringify(request),
      env: process.env,
      timeout: 30_000,
    });
    return JSON.parse(out.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    const stdout = (error as { stdout?: Buffer | string }).stdout;
    const text = typeof stdout === "string" ? stdout : stdout?.toString("utf8");
    if (text) {
      return JSON.parse(text) as Record<string, unknown>;
    }
    throw error;
  }
}

describeReal("generic kernel authority gate against the real kernel", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let workspace: string;
  let workdir: string;

  beforeEach(() => {
    envSnapshot = captureEnv(ENV_KEYS);
    for (const key of ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "apex-authority-edge-tools-"));
    fs.chmodSync(workspace, 0o700);
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-authority-edge-workdir-"));
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", LAUNCHER as string);
    setTestEnvValue("APEX_AUTHORITY_DIR", workspace);
    setTestEnvValue("APEX_AUTHORITY_TIMEOUT_MS", "20000");
    mockCallGateway.mockReset();
    spawnSpy.mockReset();
    resetProcessRegistryForTests();
    resetAgentToolKernelAuthorityPendingForTests();
    resetKernelAuthorityPendingForTests();
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("REAL KERNEL: file write needs approval; the operator's allow is consumed once and the record's outcome is succeeded", async () => {
    const target = path.join(workdir, "real.txt");
    const tool = wrapToolWithBeforeToolCallHook(createWriteTool(workdir), ctx, {
      emitDiagnostics: false,
    });

    // Round 1: the operator does not answer in time. Nothing is written, one pending record.
    mockCallGateway
      .mockResolvedValueOnce({ id: "srv-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "srv-1", decision: "timeout" });
    const first = await tool.execute("real-w1", { path: target, content: "real" });
    expect(fs.existsSync(target)).toBe(false);
    expect(first.details).toMatchObject({ status: "blocked", deniedReason: "kernel-authority" });
    const pending = pendingIds(workspace);
    expect(pending).toHaveLength(1);
    const approvalId = pending[0]!;
    expect(readRecord(workspace, approvalId)).toMatchObject({
      status: "pending",
      outcome: "not_started",
    });

    // Round 2: the operator allows through the plane's approval card; the gate relays the
    // allow, the kernel consumes the SAME record, the write happens once.
    mockCallGateway.mockResolvedValueOnce({ id: "srv-2", decision: "allow-once" });
    const second = await tool.execute("real-w2", { path: target, content: "real" });
    expect(fs.readFileSync(target, "utf8")).toBe("real");
    expect(second.details).not.toMatchObject({ status: "blocked" });
    expect(readRecord(workspace, approvalId)).toMatchObject({
      status: "consumed",
      outcome: "succeeded",
    });
    expect(pendingIds(workspace)).toHaveLength(0);
  });

  it("REAL KERNEL: an MCP-shaped tool (undeclared -> R2) is governed the same way, and a failing call is receipted as failed", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "upstream broke" }],
      details: { status: "error", error: "upstream 500" },
    }));
    const raw = {
      name: "srv__do_thing",
      description: "mcp",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute,
    } as unknown as AnyAgentTool;
    setPluginToolMeta(raw, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: { serverName: "srv", safeServerName: "srv", toolName: "do_thing", operation: "tool" },
    });
    const tool = wrapToolWithBeforeToolCallHook(raw, ctx, { emitDiagnostics: false });

    mockCallGateway.mockResolvedValueOnce({ id: "srv-3", decision: "allow-once" });
    const result = await tool.execute("real-mcp", { q: "x" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ status: "error" });
    const records = pendingIds(workspace);
    expect(records).toHaveLength(0);
    const db = new DatabaseSync(path.join(workspace, "authority.db"), { readOnly: true });
    const all = (db.prepare("SELECT data FROM approvals").all() as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as Record<string, unknown>,
    );
    db.close();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "consumed", outcome: "failed" });
    // Replay: the record is spent, a fresh approval is proposed and (here) times out.
    mockCallGateway
      .mockResolvedValueOnce({ id: "srv-4", status: "accepted" })
      .mockResolvedValueOnce({ id: "srv-4", decision: "timeout" });
    await tool.execute("real-mcp-2", { q: "x" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("REAL KERNEL: an exec spawn allowed through a consumed approval gets its receipt on the record", async () => {
    spawnSpy.mockImplementation(async () => managedRun(0));
    const tool = createExecToolImpl({
      host: "gateway",
      security: "full",
      ask: "off",
      agentId: "main",
      messageProvider: "cli",
      accountId: "brijesh",
    });
    const first = await tool.execute("real-x1", { command: "echo receipt" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(first.details.status).toBe("approval-pending");
    const approvalId = (first.details as { approvalId?: string }).approvalId ?? "";
    expect(approvalId).toMatch(/^[a-f0-9]{64}$/);
    const resolved = kernel({
      op: "resolve",
      directory: workspace,
      approval_id: approvalId,
      approve: true,
      plane: "edge",
      tool: "exec",
      risk: "R3",
      principal: { user_id: "brijesh", channel: "cli" },
      args: {
        command: "echo receipt",
        cwd: (first.details as { cwd?: string }).cwd ?? "",
        host: "gateway",
      },
    });
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true);

    const second = await tool.execute("real-x2", { command: "echo receipt" });
    expect(second.details.status).toBe("completed");
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // The exec receipt is sent from the settlement callback; wait for the kernel to record it.
    await vi.waitFor(
      () => {
        expect(readRecord(workspace, approvalId)).toMatchObject({
          status: "consumed",
          outcome: "succeeded",
        });
      },
      { timeout: 20_000, interval: 200 },
    );
  });
});

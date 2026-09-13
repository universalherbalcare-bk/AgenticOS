/**
 * Generic kernel authority gate (agent-tools.kernel-authority-gate.ts) exercised through the
 * REAL before_tool_call wrapper with a `/bin/sh` shim standing in for APEX_AUTHORITY_CMD.
 *
 * Every assertion observes whether the tool's own `execute` ran (a real file write, or a spy
 * on a browser/message/MCP-shaped tool), and what protocol operations the shim received in
 * which order, including the `finish` receipt and its outcome.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import {
  authorityOutcomeFromToolResult,
  getAgentToolKernelAuthorityPendingSizeForTests,
  resetAgentToolKernelAuthorityPendingForTests,
} from "./agent-tools.kernel-authority-gate.js";
import {
  createKernelAuthorityShimFixture,
  SHIM_APPROVAL_ID,
  SHIM_ENV_KEYS,
  type KernelAuthorityShimFixture,
} from "./agent-tools.kernel-authority-gate.test-support.js";
import { createWriteTool } from "./sessions/index.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const describeUnix = process.platform === "win32" ? describe.skip : describe;
const mockCallGateway = vi.mocked(callGatewayTool);

const ctx: HookContext = {
  agentId: "main",
  sessionKey: "agent:main:kernel-gate",
  turnSourceChannel: "slack",
  turnSourceAccountId: "acct-1",
  turnSourceTo: "chan-1",
};

function spyTool(name: string, result: unknown = { content: [], details: { status: "ok" } }) {
  const execute = vi.fn(async () => result);
  const tool = {
    name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute,
  } as unknown as AnyAgentTool;
  return { tool, execute };
}

function mcpTool(name: string, readOnlyHint?: boolean, declared?: "R0" | "R1" | "R2" | "R3") {
  const spy = spyTool(name);
  setPluginToolMeta(spy.tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "srv",
      safeServerName: "srv",
      toolName: name,
      operation: "tool",
      ...(readOnlyHint !== undefined ? { codexApproval: { annotations: { readOnlyHint } } } : {}),
      ...(declared ? { kernelAuthorityRisk: declared } : {}),
    },
  });
  return spy;
}

function wrapped(tool: AnyAgentTool, approvalMode?: "request" | "report" | "deny") {
  return wrapToolWithBeforeToolCallHook(tool, ctx, {
    emitDiagnostics: false,
    ...(approvalMode ? { approvalMode } : {}),
  });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => ("text" in c && c.text ? c.text : "")).join("\n");
}

describeUnix("generic kernel authority gate (before_tool_call boundary)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let fixture: KernelAuthorityShimFixture;
  let workdir: string;

  beforeEach(() => {
    envSnapshot = captureEnv(SHIM_ENV_KEYS);
    for (const key of SHIM_ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    fixture = createKernelAuthorityShimFixture();
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-gate-workdir-"));
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_STATE_DIR", fixture.stateDir);
    setTestEnvValue("APEX_AUTHORITY_TIMEOUT_MS", "10000");
    resetAgentToolKernelAuthorityPendingForTests();
    mockCallGateway.mockReset();
  });

  afterEach(() => {
    envSnapshot.restore();
    fixture.cleanup();
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  describe("file write (R2)", () => {
    const target = () => path.join(workdir, "out.txt");

    it("native mode (default): the shim is never consulted and the file is written", async () => {
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const tool = wrapped(createWriteTool(workdir));
      await tool.execute("w-native", { path: target(), content: "hello" });
      expect(fs.readFileSync(target(), "utf8")).toBe("hello");
      expect(fixture.requests()).toEqual([]);
    });

    it("required + deny: the write never happens and the model sees a kernel-attributed block", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const tool = wrapped(createWriteTool(workdir));
      const result = await tool.execute("w-deny", { path: target(), content: "nope" });
      expect(fs.existsSync(target())).toBe(false);
      expect(result.details).toMatchObject({ status: "blocked", deniedReason: "kernel-authority" });
      expect(textOf(result)).toContain("tool_disabled");
      const decide = fixture.ops("decide")[0] as { args: Record<string, unknown> };
      expect(decide).toMatchObject({
        op: "decide",
        plane: "edge",
        tool: "write",
        risk: "R2",
        principal: { user_id: "acct-1", channel: "slack", channel_user: "chan-1" },
      });
      // The kernel saw the FINAL params the tool would receive.
      expect(decide.args.path).toBe(target());
      expect(decide.args.content).toBe("nope");
      expect(fixture.ops("finish")).toEqual([]);
    });

    it("required + allow (consumed approval): the file is written and a receipt with outcome succeeded follows", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
      const tool = wrapped(createWriteTool(workdir));
      const result = await tool.execute("w-allow", { path: target(), content: "yes" });
      expect(fs.readFileSync(target(), "utf8")).toBe("yes");
      expect(result.details).not.toMatchObject({ status: "blocked" });
      expect(fixture.requests().map((r) => r.op)).toEqual(["decide", "finish"]);
      expect(fixture.ops("finish")[0]).toMatchObject({
        approval_id: SHIM_APPROVAL_ID,
        outcome: "succeeded",
      });
    });

    it("required + allow, tool throws: the receipt says failed and the error propagates", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
      const { tool } = spyTool("write");
      (tool as { execute: unknown }).execute = vi.fn(async () => {
        throw new Error("disk on fire");
      });
      const result = await wrapped(tool)
        .execute("w-throw", { path: "x", content: "y" })
        .then(
          () => "resolved",
          (error: unknown) => error,
        );
      expect(result).toBeInstanceOf(Error);
      expect(fixture.ops("finish")[0]).toMatchObject({
        approval_id: SHIM_APPROVAL_ID,
        outcome: "failed",
      });
    });

    it.each(["garbage", "exit2"] as const)(
      "required + %s reply: refused before any side effect (kernel_unreachable)",
      async (mode) => {
        setTestEnvValue("APEX_AUTHORITY_MODE", "required");
        setTestEnvValue("FAKE_AUTHORITY_MODE", mode);
        const tool = wrapped(createWriteTool(workdir));
        const result = await tool.execute("w-bad", { path: target(), content: "x" });
        expect(fs.existsSync(target())).toBe(false);
        expect(result.details).toMatchObject({
          status: "blocked",
          deniedReason: "kernel-authority",
        });
        expect(textOf(result)).toContain("kernel_unreachable");
      },
    );

    it("required without APEX_AUTHORITY_CMD: refused, nothing spawned", async () => {
      deleteTestEnvValue("APEX_AUTHORITY_CMD");
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      const tool = wrapped(createWriteTool(workdir));
      const result = await tool.execute("w-nocmd", { path: target(), content: "x" });
      expect(fs.existsSync(target())).toBe(false);
      expect(textOf(result)).toContain("kernel authority not configured");
    });
  });

  describe("approval_required (the plane's approval flow under the kernel id)", () => {
    it("operator allows: resolve, then decide+id consumes, the tool runs once, the receipt lands", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_flow");
      mockCallGateway
        .mockResolvedValueOnce({ id: "srv-1", status: "accepted" })
        .mockResolvedValueOnce({ id: "srv-1", decision: "allow-once" });
      const target = path.join(workdir, "approved.txt");
      const tool = wrapped(createWriteTool(workdir));
      const result = await tool.execute("w-appr", { path: target, content: "approved" });
      expect(fs.readFileSync(target, "utf8")).toBe("approved");
      expect(result.details).not.toMatchObject({ status: "blocked" });
      expect(fixture.requests().map((r) => r.op)).toEqual([
        "decide",
        "resolve",
        "decide",
        "finish",
      ]);
      const [first, second] = fixture.ops("decide");
      expect(first?.approval_id).toBeUndefined();
      expect(second?.approval_id).toBe(SHIM_APPROVAL_ID);
      const resolve = fixture.ops("resolve")[0];
      expect(resolve).toMatchObject({
        approval_id: SHIM_APPROVAL_ID,
        approve: true,
        tool: "write",
        risk: "R2",
      });
      // resolve names the identical action the kernel proposed.
      expect(resolve?.args).toEqual(first?.args);
      expect(fixture.ops("finish")[0]).toMatchObject({
        approval_id: SHIM_APPROVAL_ID,
        outcome: "succeeded",
      });
      const approvalRequest = mockCallGateway.mock.calls[0] as unknown as [
        string,
        unknown,
        { description?: string },
      ];
      expect(approvalRequest[0]).toBe("plugin.approval.request");
      expect(approvalRequest[2]).toMatchObject({
        toolName: "write",
        allowedDecisions: ["allow-once", "deny"],
      });
      expect(String(approvalRequest[2].description)).toContain(SHIM_APPROVAL_ID);
      expect(getAgentToolKernelAuthorityPendingSizeForTests()).toBe(0);
    });

    it("operator denies: the denial is relayed (revoke), nothing runs", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_flow");
      mockCallGateway
        .mockResolvedValueOnce({ id: "srv-2", status: "accepted" })
        .mockResolvedValueOnce({ id: "srv-2", decision: "deny" });
      const target = path.join(workdir, "denied.txt");
      const result = await wrapped(createWriteTool(workdir)).execute("w-den", {
        path: target,
        content: "x",
      });
      expect(fs.existsSync(target)).toBe(false);
      expect(result.details).toMatchObject({ status: "blocked", deniedReason: "kernel-authority" });
      expect(fixture.requests().map((r) => r.op)).toEqual(["decide", "resolve"]);
      expect(fixture.ops("resolve")[0]).toMatchObject({
        approve: false,
        approval_id: SHIM_APPROVAL_ID,
      });
      expect(getAgentToolKernelAuthorityPendingSizeForTests()).toBe(0);
    });

    it("timeout, then an out-of-band approval: the retry presents the remembered id and consumes it exactly once", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_flow");
      mockCallGateway
        .mockResolvedValueOnce({ id: "srv-3", status: "accepted" })
        .mockResolvedValueOnce({ id: "srv-3", decision: "timeout" });
      const target = path.join(workdir, "later.txt");
      const params = { path: target, content: "later" };
      const tool = wrapped(createWriteTool(workdir));

      const first = await tool.execute("w-t1", params);
      expect(fs.existsSync(target)).toBe(false);
      expect(first.details).toMatchObject({ status: "blocked" });
      expect(textOf(first)).toContain(SHIM_APPROVAL_ID);
      expect(getAgentToolKernelAuthorityPendingSizeForTests()).toBe(1);

      // The retry before anyone approved: the kernel says still pending (under the SAME id),
      // the operator is asked again and again does not answer; still no write.
      mockCallGateway
        .mockResolvedValueOnce({ id: "srv-3b", status: "accepted" })
        .mockResolvedValueOnce({ id: "srv-3b", decision: "timeout" });
      const stillPending = await tool.execute("w-t2", params);
      expect(fs.existsSync(target)).toBe(false);
      expect(stillPending.details).toMatchObject({ status: "blocked" });
      expect(fixture.ops("decide").at(-1)?.approval_id).toBe(SHIM_APPROVAL_ID);
      expect(getAgentToolKernelAuthorityPendingSizeForTests()).toBe(1);

      fixture.approveOutOfBand();
      const consumed = await tool.execute("w-t3", params);
      expect(fs.readFileSync(target, "utf8")).toBe("later");
      expect(consumed.details).not.toMatchObject({ status: "blocked" });
      expect(fixture.ops("finish")).toHaveLength(1);
      expect(getAgentToolKernelAuthorityPendingSizeForTests()).toBe(0);

      // Replay: the record is spent; a fresh approval_required starts (and here is denied).
      fs.rmSync(target);
      mockCallGateway
        .mockResolvedValueOnce({ id: "srv-4", status: "accepted" })
        .mockResolvedValueOnce({ id: "srv-4", decision: "deny" });
      const replay = await tool.execute("w-t4", params);
      expect(fs.existsSync(target)).toBe(false);
      expect(replay.details).toMatchObject({ status: "blocked" });
      expect(fixture.ops("finish")).toHaveLength(1);
      // The operator was asked three times (timeout, timeout, deny); the consumption round
      // (out-of-band approval already recorded) needed no approval card at all.
      expect(
        mockCallGateway.mock.calls.filter((c) => c[0] === "plugin.approval.request"),
      ).toHaveLength(3);
    });

    it("approvalMode report: approval_required blocks without asking the gateway; the id is kept for a retry", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_flow");
      const target = path.join(workdir, "report.txt");
      const result = await wrapped(createWriteTool(workdir), "report").execute("w-rep", {
        path: target,
        content: "x",
      });
      expect(fs.existsSync(target)).toBe(false);
      expect(result.details).toMatchObject({ status: "blocked" });
      expect(mockCallGateway).not.toHaveBeenCalled();
      expect(getAgentToolKernelAuthorityPendingSizeForTests()).toBe(1);
    });
  });

  describe("browser (per action)", () => {
    it("navigate is R1 (allowed without a record), a click is R2 and can be denied before it fires", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
      const nav = spyTool("browser");
      await wrapped(nav.tool).execute("b-nav", { action: "navigate", url: "https://example.test" });
      expect(nav.execute).toHaveBeenCalledTimes(1);
      expect(fixture.ops("decide")[0]).toMatchObject({ tool: "browser", risk: "R1" });
      expect(fixture.ops("finish")).toEqual([]);

      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const click = spyTool("browser");
      const result = await wrapped(click.tool).execute("b-click", {
        action: "act",
        kind: "click",
        ref: "e1",
      });
      expect(click.execute).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({ status: "blocked", deniedReason: "kernel-authority" });
      expect(fixture.ops("decide")[1]).toMatchObject({ tool: "browser", risk: "R2" });
    });
  });

  describe("message (per action and channel)", () => {
    it("send on slack is R2, send on whatsapp is R3, read is R1; a denied send never fires", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const slack = spyTool("message");
      const denied = await wrapped(slack.tool).execute("m-1", {
        action: "send",
        channel: "slack",
        text: "hi",
      });
      expect(slack.execute).not.toHaveBeenCalled();
      expect(denied.details).toMatchObject({ status: "blocked" });
      const wa = spyTool("message");
      await wrapped(wa.tool).execute("m-2", { action: "send", channel: "whatsapp", text: "hi" });
      expect(wa.execute).not.toHaveBeenCalled();
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
      const read = spyTool("message");
      await wrapped(read.tool).execute("m-3", { action: "read", channel: "slack" });
      expect(read.execute).toHaveBeenCalledTimes(1);
      expect(fixture.ops("decide").map((r) => r.risk)).toEqual(["R2", "R3", "R1"]);
    });
  });

  describe("MCP tools (bundle metadata)", () => {
    it("undeclared MCP tool is R2 and deniable; read-only annotated is R1; declared risk wins", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const plain = mcpTool("srv__do_thing");
      const result = await wrapped(plain.tool).execute("mcp-1", { q: "x" });
      expect(plain.execute).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({ status: "blocked", deniedReason: "kernel-authority" });
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
      const readOnly = mcpTool("srv__lookup", true);
      await wrapped(readOnly.tool).execute("mcp-2", { q: "x" });
      expect(readOnly.execute).toHaveBeenCalledTimes(1);
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const declared = mcpTool("srv__wipe", true, "R3");
      await wrapped(declared.tool).execute("mcp-3", {});
      expect(declared.execute).not.toHaveBeenCalled();
      expect(fixture.ops("decide").map((r) => [r.tool, r.risk])).toEqual([
        ["srv__do_thing", "R2"],
        ["srv__lookup", "R1"],
        ["srv__wipe", "R3"],
      ]);
    });

    it("an MCP call allowed through a consumed approval carries its outcome in the receipt", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow_consumed");
      const failing = mcpTool("srv__flaky");
      (failing.tool as { execute: unknown }).execute = vi.fn(async () => ({
        content: [{ type: "text", text: "nope" }],
        details: { status: "error", error: "upstream 500" },
      }));
      await wrapped(failing.tool).execute("mcp-4", {});
      expect(fixture.ops("finish")[0]).toMatchObject({
        approval_id: SHIM_APPROVAL_ID,
        outcome: "failed",
      });
    });
  });

  describe("exec is not double-gated; unknown tools are R2", () => {
    it("a tool named exec passes the generic gate untouched (its own gate governs the spawn)", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const exec = spyTool("exec");
      await wrapped(exec.tool).execute("x-1", { command: "echo hi" });
      expect(exec.execute).toHaveBeenCalledTimes(1);
      expect(fixture.requests()).toEqual([]);
    });

    it("a tool the table does not know is presented as R2", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const novel = spyTool("some_plugin_tool");
      await wrapped(novel.tool).execute("u-1", { anything: 1 });
      expect(novel.execute).not.toHaveBeenCalled();
      expect(fixture.ops("decide")[0]).toMatchObject({ tool: "some_plugin_tool", risk: "R2" });
    });
  });

  describe("adapter fallback (unwrapped tool definitions)", () => {
    it("an unwrapped tool adapted straight into a definition still meets the kernel", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const spy = spyTool("write");
      const [definition] = toToolDefinitions([spy.tool], ctx);
      const result = await definition!.execute(
        "a-1",
        { path: "x", content: "y" },
        undefined,
        undefined,
      );
      expect(spy.execute).not.toHaveBeenCalled();
      expect(result.details).toMatchObject({ status: "blocked", deniedReason: "kernel-authority" });
      expect(fixture.ops("decide")[0]).toMatchObject({ tool: "write", risk: "R2" });
    });
  });

  describe("authorityOutcomeFromToolResult", () => {
    it("maps statuses conservatively", () => {
      expect(authorityOutcomeFromToolResult({ content: [], details: { status: "ok" } })).toBe(
        "succeeded",
      );
      expect(
        authorityOutcomeFromToolResult({ content: [], details: { status: "completed" } }),
      ).toBe("succeeded");
      expect(authorityOutcomeFromToolResult({ content: [], details: { status: "failed" } })).toBe(
        "failed",
      );
      expect(authorityOutcomeFromToolResult({ content: [], details: { status: "error" } })).toBe(
        "failed",
      );
      expect(authorityOutcomeFromToolResult({ content: [], details: { status: "running" } })).toBe(
        "unknown",
      );
      expect(authorityOutcomeFromToolResult({ content: [], details: { error: "x" } })).toBe(
        "failed",
      );
      expect(authorityOutcomeFromToolResult({ content: [], details: {} })).toBe("succeeded");
      expect(authorityOutcomeFromToolResult(undefined)).toBe("succeeded");
    });
  });
});

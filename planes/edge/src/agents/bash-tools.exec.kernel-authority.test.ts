/**
 * Integration tests for the APEX kernel authority gate wired into the exec
 * tool's real local spawn boundary (bash-tools.exec-kernel-authority-gate.ts,
 * composed into bash-tools.exec-runtime.ts's `beforeSpawn` from
 * bash-tools.exec-run.ts).
 *
 * These exercise the real `createExecTool().execute()` pipeline (approval
 * policy, workdir resolution, env prep) with `host: "gateway", security:
 * "full", ask: "off"` so the plane's own approval machinery never engages;
 * only the kernel authority gate can deny. The one thing stubbed is the
 * process supervisor's `spawn`, i.e. the actual OS process launch boundary
 * (see bash-tools.exec-runtime.ts `spawn = (input) => ... supervisor.spawn(input)`),
 * so every assertion below observes whether that real spawn boundary was
 * reached, not a proxy for it.
 *
 * A `/bin/sh` shim plays the kernel authority process for `APEX_AUTHORITY_CMD`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import {
  composeExecBeforeSpawn,
  createExecKernelAuthorityGate,
  getKernelAuthorityPendingSizeForTests,
  kernelAuthorityPendingPartition,
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

const createExecTool = (
  defaults?: Parameters<typeof createExecToolImpl>[0],
): ReturnType<typeof createExecToolImpl> =>
  createExecToolImpl({
    host: "gateway",
    security: "full",
    ask: "off",
    agentId: "main",
    ...defaults,
  });

const ENV_KEYS = [
  "APEX_AUTHORITY_CMD",
  "APEX_AUTHORITY_DIR",
  "APEX_AUTHORITY_MODE",
  "APEX_AUTHORITY_TIMEOUT_MS",
  "FAKE_AUTHORITY_MODE",
  "FAKE_AUTHORITY_REQUEST_FILE",
];

const APPROVAL_ID = "c".repeat(64);

const SHIM_SCRIPT = `#!/bin/sh
set -eu
request="$(cat)"
if [ -n "\${FAKE_AUTHORITY_REQUEST_FILE:-}" ]; then
  printf '%s' "$request" > "$FAKE_AUTHORITY_REQUEST_FILE"
fi
case "\${FAKE_AUTHORITY_MODE:-allow}" in
  allow)
    printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"low_risk","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}'
    exit 0
    ;;
  deny)
    printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"tool_disabled","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}'
    exit 0
    ;;
  approval_required)
    printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":"${APPROVAL_ID}","expires_at":4102444800000}}'
    exit 0
    ;;
  pending_then_consume)
    case "$request" in
      *approval_id*) printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"approval_consumed","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":"${APPROVAL_ID}"}}' ;;
      *) printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":"${APPROVAL_ID}","expires_at":4102444800000}}' ;;
    esac
    exit 0
    ;;
  still_pending)
    case "$request" in
      *approval_id*) printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"approval_rejected","detail":"A live, unused approved request is required.","record_status":"pending","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}' ;;
      *) printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":"${APPROVAL_ID}","expires_at":4102444800000}}' ;;
    esac
    exit 0
    ;;
  revoked)
    case "$request" in
      *approval_id*) printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"approval_rejected","detail":"A live, unused approved request is required.","record_status":"revoked","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}' ;;
      *) printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":"${APPROVAL_ID}","expires_at":4102444800000}}' ;;
    esac
    exit 0
    ;;
  garbage)
    printf '%s\\n' 'this is not json'
    exit 0
    ;;
  exit2)
    printf '%s\\n' '{"ok":false,"error":"Authority request fields: missing field."}'
    exit 2
    ;;
  hang)
    sleep 30
    exit 0
    ;;
  *)
    exit 2
    ;;
esac
`;

type ShimFixture = { dir: string; shim: string; requestFile: string };

function createShimFixture(): ShimFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-kernel-authority-shim-"));
  const shim = path.join(dir, "apex-authority");
  fs.writeFileSync(shim, SHIM_SCRIPT, { mode: 0o755 });
  return { dir, shim, requestFile: path.join(dir, "request.json") };
}

function makeManagedRun() {
  return {
    runId: "run-1",
    startedAtMs: Date.now(),
    pid: 4242,
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

describeUnix("exec tool kernel authority gate", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let fixtureDirs: string[];

  beforeEach(() => {
    envSnapshot = captureEnv(ENV_KEYS);
    for (const key of ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    fixtureDirs = [];
    spawnSpy.mockReset();
    spawnSpy.mockImplementation(async () => makeManagedRun());
    resetProcessRegistryForTests();
    resetKernelAuthorityPendingForTests();
  });

  afterEach(() => {
    envSnapshot.restore();
    for (const dir of fixtureDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function withShim(): ShimFixture {
    const fixture = createShimFixture();
    fixtureDirs.push(fixture.dir);
    return fixture;
  }

  it("required + kernel deny: the command is not spawned and the result names the kernel reason", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");

    const tool = createExecTool();
    const result = await tool.execute("call-deny", { command: "echo hi" });

    expect(spawnSpy).not.toHaveBeenCalled();
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("kernel");
    expect(text).toContain("tool_disabled");
    expect(text).toContain("echo hi");
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
  });

  it("required + approval_required: the command is not spawned and the approval_id is surfaced", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");

    const tool = createExecTool();
    const result = await tool.execute("call-pending", { command: "echo hi" });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "approval-pending",
      approvalId: APPROVAL_ID,
    });
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain(APPROVAL_ID);
  });

  it("required + allow: spawned exactly once with the exact plane/tool/principal/args/directory", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("APEX_AUTHORITY_DIR", "/var/lib/apex-authority");
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool({
      messageProvider: "slack",
      accountId: "acct-9",
      channelContext: { sender: { id: "user-42" }, chat: { id: "chan-7" } },
    });
    const result = await tool.execute("call-allow", { command: "echo hi" });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("completed");

    const sent = JSON.parse(fs.readFileSync(fixture.requestFile, "utf8"));
    expect(sent.op).toBe("decide");
    expect(sent.plane).toBe("edge");
    expect(sent.tool).toBe("exec");
    expect(sent.risk).toBe("R3");
    expect(sent.principal).toEqual({
      user_id: "user-42",
      channel: "slack",
      channel_user: "chan-7",
    });
    expect(sent.args.command).toBe("echo hi");
    expect(sent.args.host).toBe("gateway");
    expect(sent.directory).toBe("/var/lib/apex-authority");
  });

  it("required + pending then approved: the retry presents the remembered approval id, the kernel consumes it, and the command is spawned exactly once", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "pending_then_consume");
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool();
    const first = await tool.execute("call-pending-1", { command: "echo consume" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(first.details).toMatchObject({ status: "approval-pending", approvalId: APPROVAL_ID });
    expect(JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id).toBeUndefined();

    const second = await tool.execute("call-pending-2", { command: "echo consume" });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(second.details.status).toBe("completed");
    expect(JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id).toBe(APPROVAL_ID);

    // A different command is a different action: no remembered id, a fresh proposal, no spawn.
    const other = await tool.execute("call-pending-3", { command: "echo something-else" });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(other.details.status).toBe("approval-pending");
    expect(JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id).toBeUndefined();
  });

  it("required + still pending: the retry presents the same id, stays approval-pending under it, and proposes nothing new", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "still_pending");
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool();
    await tool.execute("call-wait-1", { command: "echo wait" });
    const again = await tool.execute("call-wait-2", { command: "echo wait" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(again.details).toMatchObject({ status: "approval-pending", approvalId: APPROVAL_ID });
    expect(JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id).toBe(APPROVAL_ID);
  });

  it("required + revoked: the same rejection wording as pending, but record_status makes it a hard denial, not a wait", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "revoked");

    const tool = createExecTool();
    await tool.execute("call-revoked-1", { command: "echo no" });
    const denied = await tool.execute("call-revoked-2", { command: "echo no" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(denied.details).toMatchObject({ status: "failed", reason: "policy-denied" });
  });

  it("required + hard deny forgets the remembered id, so the next attempt starts a fresh proposal", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool();
    setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");
    await tool.execute("call-forget-1", { command: "echo forget" });
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
    const denied = await tool.execute("call-forget-2", { command: "echo forget" });
    expect(denied.details).toMatchObject({ status: "failed", reason: "policy-denied" });
    expect(JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id).toBe(APPROVAL_ID);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");
    await tool.execute("call-forget-3", { command: "echo forget" });
    expect(JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id).toBeUndefined();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("required + allow falls back to the OS principal when no turn/agent identity is known", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool();
    await tool.execute("call-allow-fallback", { command: "echo hi" });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fs.readFileSync(fixture.requestFile, "utf8"));
    expect(sent.principal).toEqual({ user_id: os.userInfo().username, channel: "edge" });
  });

  it.each([
    ["garbage kernel output", "garbage"],
    ["kernel exit 2 (undecidable)", "exit2"],
  ])("required + %s: the command is not spawned", async (_label, mode) => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", mode);

    const tool = createExecTool();
    const result = await tool.execute("call-fail-closed", { command: "echo hi" });

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
  });

  it("required + kernel timeout: the command is not spawned", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "hang");
    setTestEnvValue("APEX_AUTHORITY_TIMEOUT_MS", "200");

    const tool = createExecTool();
    const startedAt = Date.now();
    const result = await tool.execute("call-timeout", { command: "echo hi" });
    const elapsedMs = Date.now() - startedAt;

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
    expect(elapsedMs).toBeLessThan(5000);
  }, 10_000);

  it("required + APEX_AUTHORITY_CMD unset: the command is not spawned and the reason names 'not configured'", async () => {
    setTestEnvValue("APEX_AUTHORITY_MODE", "required");

    const tool = createExecTool();
    const result = await tool.execute("call-unconfigured", { command: "echo hi" });

    expect(spawnSpy).not.toHaveBeenCalled();
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("not configured");
    expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
  });

  it("native mode (default): existing behaviour is unchanged and the kernel shim is never invoked", async () => {
    const fixture = withShim();
    // APEX_AUTHORITY_MODE intentionally left unset (defaults to "native").
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool();
    const result = await tool.execute("call-native", { command: "echo hi" });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("completed");
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
  });

  it("native mode with APEX_AUTHORITY_MODE explicitly 'native': shim never invoked", async () => {
    const fixture = withShim();
    setTestEnvValue("APEX_AUTHORITY_MODE", "native");
    setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
    setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

    const tool = createExecTool();
    const result = await tool.execute("call-native-explicit", { command: "echo hi" });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(result.details.status).toBe("completed");
    expect(fs.existsSync(fixture.requestFile)).toBe(false);
  });

  describe("C4: pending memory is partitioned by principal and session, TTL-bounded", () => {
    const victimIdentity = {
      messageProvider: "slack",
      accountId: "acct-v",
      channelContext: { sender: { id: "victim" }, chat: { id: "chan-v" } },
      sessionKey: "agent:main:victim",
    };
    const attackerIdentity = {
      messageProvider: "slack",
      accountId: "acct-a",
      channelContext: { sender: { id: "attacker" }, chat: { id: "chan-a" } },
      sessionKey: "agent:main:attacker",
    };

    function sentApprovalId(fixture: ShimFixture): unknown {
      return JSON.parse(fs.readFileSync(fixture.requestFile, "utf8")).approval_id;
    }

    it("the literal PoC: 256 distinct fillers from the SAME principal no longer evict the victim's remembered id", async () => {
      const fixture = withShim();
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");
      setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

      const tool = createExecTool(victimIdentity);
      const victim = await tool.execute("victim-call", { command: "echo VICTIM-COMMAND-1" });
      expect(victim.details).toMatchObject({ status: "approval-pending", approvalId: APPROVAL_ID });
      expect(sentApprovalId(fixture)).toBeUndefined();

      for (let i = 0; i < 256; i += 1) {
        const filler = await tool.execute(`filler-${i}`, { command: `echo FILLER-${i}` });
        expect(filler.details.status).toBe("approval-pending");
      }

      const retry = await tool.execute("victim-retry", { command: "echo VICTIM-COMMAND-1" });
      expect(retry.details).toMatchObject({ status: "approval-pending", approvalId: APPROVAL_ID });
      expect(sentApprovalId(fixture)).toBe(APPROVAL_ID);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("a different principal flooding 300 distinct requests cannot evict the victim's remembered id", async () => {
      const fixture = withShim();
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");
      setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

      const victimTool = createExecTool(victimIdentity);
      const attackerTool = createExecTool(attackerIdentity);
      await victimTool.execute("victim-call", { command: "echo VICTIM-COMMAND-2" });
      expect(sentApprovalId(fixture)).toBeUndefined();

      for (let i = 0; i < 300; i += 1) {
        await attackerTool.execute(`attacker-${i}`, { command: `echo ATTACK-${i}` });
      }

      await victimTool.execute("victim-retry", { command: "echo VICTIM-COMMAND-2" });
      expect(sentApprovalId(fixture)).toBe(APPROVAL_ID);
      // The attacker's partition is bounded on its own; the victim's single entry is untouched.
      const victimPartition = kernelAuthorityPendingPartition(
        { user_id: "victim", channel: "slack", channel_user: "chan-v" },
        "agent:main:victim",
      );
      expect(getKernelAuthorityPendingSizeForTests(victimPartition)).toBe(1);
      expect(getKernelAuthorityPendingSizeForTests()).toBe(301);
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("the same principal in a different session is a different partition: a cross-session retry proposes afresh (documented fail-safe cost)", async () => {
      const fixture = withShim();
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
      setTestEnvValue("FAKE_AUTHORITY_MODE", "approval_required");
      setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

      const sessionA = createExecTool(victimIdentity);
      const sessionB = createExecTool({ ...victimIdentity, sessionKey: "agent:main:other" });
      await sessionA.execute("a-1", { command: "echo SESSION-BOUND" });
      await sessionB.execute("b-1", { command: "echo SESSION-BOUND" });
      expect(sentApprovalId(fixture)).toBeUndefined();
      await sessionA.execute("a-2", { command: "echo SESSION-BOUND" });
      expect(sentApprovalId(fixture)).toBe(APPROVAL_ID);
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  });

  describe("C2: the gate binds the kernel request to the spawn input it is invoked with", () => {
    it("args.command/cwd/argv and the result text follow the spawn input, not the construction-time command", async () => {
      const fixture = withShim();
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

      const gate = createExecKernelAuthorityGate({
        command: "echo typed",
        cwd: "/typed",
        host: "gateway",
        elevated: false,
      });
      expect(gate).toBeDefined();
      const denied = await gate?.({
        command: "/bin/echo rewritten",
        cwd: "/spawn",
        argv: ["/bin/echo", "rewritten"],
      });
      const sent = JSON.parse(fs.readFileSync(fixture.requestFile, "utf8"));
      expect(sent.args).toEqual({
        command: "/bin/echo rewritten",
        cwd: "/spawn",
        host: "gateway",
        argv: ["/bin/echo", "rewritten"],
      });
      const text = denied?.content.map((c) => ("text" in c ? c.text : "")).join("\n") ?? "";
      expect(text).toContain("/bin/echo rewritten");
      expect(text).not.toContain("echo typed");
      expect(denied?.details).toMatchObject({
        status: "failed",
        reason: "policy-denied",
        cwd: "/spawn",
      });
    });

    it("composeExecBeforeSpawn hands the same spawn input to both sides", async () => {
      const seen: unknown[] = [];
      const composed = composeExecBeforeSpawn(
        async (spawn) => {
          seen.push(spawn);
          return undefined;
        },
        async (spawn) => {
          seen.push(spawn);
          return undefined;
        },
      );
      await composed?.({ command: "x", cwd: "/w" });
      expect(seen).toEqual([
        { command: "x", cwd: "/w" },
        { command: "x", cwd: "/w" },
      ]);
    });

    it("gate invoked without a spawn input falls back to the construction-time command", async () => {
      const fixture = withShim();
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("APEX_AUTHORITY_CMD", fixture.shim);
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
      setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", fixture.requestFile);

      const gate = createExecKernelAuthorityGate({
        command: "echo typed",
        cwd: "/typed",
        host: "sandbox",
        elevated: true,
      });
      expect(await gate?.()).toBeUndefined();
      const sent = JSON.parse(fs.readFileSync(fixture.requestFile, "utf8"));
      expect(sent.args).toEqual({ command: "echo typed", cwd: "/typed", host: "sandbox" });
      expect(sent.risk).toBe("R4");
    });
  });
});

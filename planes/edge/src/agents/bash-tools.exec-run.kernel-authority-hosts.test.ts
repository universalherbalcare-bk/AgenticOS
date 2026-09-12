/**
 * Regression tests at the exec tool's host-dispatch layer (bash-tools.exec-run.ts):
 *
 *  - C1: the kernel authority gate is built BEFORE host dispatch and handed to the node host,
 *    so `host: "node"` is governed by the same gate as the local hosts;
 *  - C2: when the gateway host rewrites the command (safe-bin / allowlist normalization), the
 *    kernel authorizes the string that is actually spawned, not the command as typed.
 *
 * The node host and the gateway allowlist stage are mocked at their module boundary so the
 * test can observe exactly what exec-run hands them; the supervisor spawn (the real OS process
 * boundary) is stubbed and its input recorded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import { resetKernelAuthorityPendingForTests } from "./bash-tools.exec-kernel-authority-gate.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

const mocks = vi.hoisted(() => ({
  spawnInputs: [] as unknown[],
  nodeHostParams: [] as ExecuteNodeHostCommandParams[],
  gatewayOverride: undefined as string | undefined,
}));

vi.mock("./bash-tools.exec-host-node.js", () => ({
  executeNodeHostCommand: vi.fn(async (params: ExecuteNodeHostCommandParams) => {
    mocks.nodeHostParams.push(params);
    return {
      content: [{ type: "text", text: "node ok" }],
      details: { status: "completed", exitCode: 0, durationMs: 0, aggregated: "node ok" },
    };
  }),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () =>
    mocks.gatewayOverride === undefined ? {} : { execCommandOverride: mocks.gatewayOverride },
  ),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: unknown) => {
      mocks.spawnInputs.push(input);
      return {
        runId: "mock-run",
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
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

import { createExecTool } from "./bash-tools.exec-run.js";

const ENV_KEYS = [
  "APEX_AUTHORITY_CMD",
  "APEX_AUTHORITY_DIR",
  "APEX_AUTHORITY_MODE",
  "APEX_AUTHORITY_TIMEOUT_MS",
  "FAKE_AUTHORITY_MODE",
  "FAKE_AUTHORITY_REQUEST_FILE",
];

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
  *)
    printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"tool_disabled","operation":"tool.execute","resource":"exec","risk":"R3","approval_id":null}}'
    ;;
esac
exit 0
`;

let envSnapshot: ReturnType<typeof captureEnv>;
let shimDir: string;
let shim: string;
let requestFile: string;

describeUnix("exec tool host dispatch under the kernel authority gate", () => {
  beforeEach(() => {
    envSnapshot = captureEnv(ENV_KEYS);
    for (const key of ENV_KEYS) {
      deleteTestEnvValue(key);
    }
    mocks.spawnInputs.length = 0;
    mocks.nodeHostParams.length = 0;
    mocks.gatewayOverride = undefined;
    resetProcessRegistryForTests();
    resetKernelAuthorityPendingForTests();
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-run-kernel-authority-"));
    shim = path.join(shimDir, "apex-authority");
    fs.writeFileSync(shim, SHIM_SCRIPT, { mode: 0o755 });
    requestFile = path.join(shimDir, "request.json");
    setTestEnvValue("APEX_AUTHORITY_CMD", shim);
    setTestEnvValue("FAKE_AUTHORITY_REQUEST_FILE", requestFile);
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(shimDir, { recursive: true, force: true });
  });

  describe("C1: host=node receives the gate built before dispatch", () => {
    it("required mode: the node host is handed a live gate that returns the kernel's denial", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const tool = createExecTool({
        host: "node",
        security: "full",
        ask: "off",
        cwd: process.cwd(),
        sessionKey: "agent:main:s1",
      });

      await tool.execute("node-call", { command: "echo hi" });

      expect(mocks.nodeHostParams).toHaveLength(1);
      const gate = mocks.nodeHostParams[0]?.kernelAuthorityGate;
      expect(typeof gate).toBe("function");
      const outcome = await gate?.({
        command: "/bin/sh -c 'echo hi'",
        argv: ["/bin/sh", "-c", "echo hi"],
      });
      expect(outcome?.details).toMatchObject({ status: "failed", reason: "policy-denied" });
      const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
      expect(sent.args).toMatchObject({
        host: "node",
        command: "/bin/sh -c 'echo hi'",
        argv: ["/bin/sh", "-c", "echo hi"],
      });
      expect(mocks.spawnInputs).toHaveLength(0);
    });

    it("native mode: no gate is handed to the node host and the shim is never consulted", async () => {
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      const tool = createExecTool({
        host: "node",
        security: "full",
        ask: "off",
        cwd: process.cwd(),
      });

      const result = await tool.execute("node-call-native", { command: "echo hi" });

      expect(result.details.status).toBe("completed");
      expect(mocks.nodeHostParams).toHaveLength(1);
      expect(mocks.nodeHostParams[0]?.kernelAuthorityGate).toBeUndefined();
      expect(fs.existsSync(requestFile)).toBe(false);
    });
  });

  describe("C2: the kernel authorizes the command that is actually spawned", () => {
    it("when the gateway rewrites the command, args.command equals the spawned string, not the typed one", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
      mocks.gatewayOverride = "/usr/bin/true rewritten-by-gateway";
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: process.cwd(),
      });

      const result = await tool.execute("gateway-rewrite", { command: "true typed-by-model" });

      expect(result.details.status).toBe("completed");
      const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
      expect(sent.args.command).toBe("/usr/bin/true rewritten-by-gateway");
      expect(sent.args.host).toBe("gateway");
      expect(mocks.spawnInputs).toHaveLength(1);
      const spawned = JSON.stringify(mocks.spawnInputs[0]);
      expect(spawned).toContain("/usr/bin/true rewritten-by-gateway");
      expect(spawned).not.toContain("typed-by-model");
    });

    it("when the gateway rewrites the command and the kernel denies it, nothing is spawned and the denial names the spawned string", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "deny");
      mocks.gatewayOverride = "/usr/bin/true rewritten-by-gateway";
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: process.cwd(),
      });

      const result = await tool.execute("gateway-rewrite-deny", { command: "true typed-by-model" });

      expect(result.details).toMatchObject({ status: "failed", reason: "policy-denied" });
      const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
      expect(text).toContain("/usr/bin/true rewritten-by-gateway");
      expect(mocks.spawnInputs).toHaveLength(0);
    });

    it("without a rewrite, args.command is the typed command and it is what gets spawned", async () => {
      setTestEnvValue("APEX_AUTHORITY_MODE", "required");
      setTestEnvValue("FAKE_AUTHORITY_MODE", "allow");
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: process.cwd(),
      });

      await tool.execute("gateway-plain", { command: "true plain-command" });

      const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
      expect(sent.args.command).toBe("true plain-command");
      expect(JSON.stringify(mocks.spawnInputs[0])).toContain("true plain-command");
    });
  });
});

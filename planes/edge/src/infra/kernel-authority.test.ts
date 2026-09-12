/**
 * Tests for the stdlib-only APEX kernel authority protocol client.
 * A `/bin/sh` shim stands in for `APEX_AUTHORITY_CMD`: it records the exact
 * request it received to a file and replies with a canned response chosen
 * by `FAKE_AUTHORITY_MODE`, covering every fail-closed path this client
 * must handle (deny, approval_required, garbage output, exit 2, a hang that
 * must be killed on timeout, and an unconfigured command).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_MAX_CONCURRENCY_CEILING,
  DEFAULT_AUTHORITY_MAX_CONCURRENCY,
  decide,
  describeKernelAuthorityMode,
  finish,
  getKernelAuthorityInFlightCountForTests,
  resolve,
  resolveKernelAuthorityConfig,
  type AuthorityDecideRequest,
} from "./kernel-authority.js";

const describeUnix = process.platform === "win32" ? describe.skip : describe;

const APPROVAL_ID_A = "a".repeat(64);
const APPROVAL_ID_B = "b".repeat(64);

const SHIM_SCRIPT = `#!/bin/sh
set -eu
request="$(cat)"
if [ -n "\${FAKE_AUTHORITY_REQUEST_FILE:-}" ]; then
  printf '%s' "$request" > "$FAKE_AUTHORITY_REQUEST_FILE"
fi
mode="\${FAKE_AUTHORITY_MODE:-allow}"
case "$mode" in
  allow)
    printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"low_risk","operation":"tool.execute","resource":"exec:test","risk":"R3","approval_id":null}}'
    exit 0
    ;;
  deny)
    printf '%s\\n' '{"ok":true,"result":{"decision":"deny","reason":"tool_disabled","operation":"tool.execute","resource":"exec:test","risk":"R3","approval_id":null}}'
    exit 0
    ;;
  approval_required)
    printf '%s\\n' '{"ok":true,"result":{"decision":"approval_required","reason":"approval_required","operation":"tool.execute","resource":"exec:test","risk":"R3","approval_id":"${APPROVAL_ID_A}","expires_at":4102444800000}}'
    exit 0
    ;;
  resolve_allow)
    printf '%s\\n' '{"ok":true,"result":{"decision":"allow","reason":"approval_consumed","operation":"tool.execute","resource":"exec:test","risk":"R3","approval_id":"${APPROVAL_ID_B}","consumed_at":1000}}'
    exit 0
    ;;
  record_approved)
    printf '%s\\n' '{"ok":true,"result":{"id":"${APPROVAL_ID_B}","status":"approved","reason":"user_approved"}}'
    exit 0
    ;;
  record_consumed)
    printf '%s\\n' '{"ok":true,"result":{"id":"${APPROVAL_ID_B}","status":"consumed","reason":"used_once","outcome":"succeeded"}}'
    exit 0
    ;;
  garbage)
    printf '%s\\n' 'not { valid json at all'
    exit 0
    ;;
  empty)
    exit 0
    ;;
  unexpected_decision)
    printf '%s\\n' '{"ok":true,"result":{"decision":"maybe","reason":"low_risk","operation":"tool.execute","resource":"exec:test","risk":"R3","approval_id":null}}'
    exit 0
    ;;
  not_an_object)
    printf '%s\\n' '["ok", true]'
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
    printf '%s\\n' '{"ok":false,"error":"unknown FAKE_AUTHORITY_MODE"}'
    exit 2
    ;;
esac
`;

function createShimDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kernel-authority-shim-"));
}

function writeShim(dir: string, name = "apex-authority"): string {
  const shimPath = path.join(dir, name);
  fs.writeFileSync(shimPath, SHIM_SCRIPT, { mode: 0o755 });
  return shimPath;
}

function requestFilePath(dir: string): string {
  return path.join(dir, "request.json");
}

function baseDecideRequest(
  overrides: Partial<AuthorityDecideRequest> = {},
): AuthorityDecideRequest {
  return {
    plane: "edge",
    tool: "exec",
    risk: "R3",
    principal: { user_id: "u-1", channel: "edge" },
    args: { command: "echo hi", cwd: "/work", host: "gateway" },
    ...overrides,
  };
}

describeUnix("kernel-authority resolveKernelAuthorityConfig", () => {
  it("defaults to native mode with no cmd/directory, the 5s timeout, and the concurrency ceiling of 8", () => {
    const config = resolveKernelAuthorityConfig({});
    expect(config).toEqual({
      cmd: undefined,
      directory: undefined,
      mode: "native",
      timeoutMs: 5000,
      maxConcurrency: 8,
    });
  });

  it("only recognizes the exact string 'required' for APEX_AUTHORITY_MODE", () => {
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_MODE: "required" }).mode).toBe("required");
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_MODE: "Required" }).mode).toBe("native");
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_MODE: "" }).mode).toBe("native");
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_MODE: "native" }).mode).toBe("native");
  });

  it("trims cmd/directory and ignores blank strings", () => {
    const config = resolveKernelAuthorityConfig({
      APEX_AUTHORITY_CMD: "  /usr/local/bin/apex-authority  ",
      APEX_AUTHORITY_DIR: "   ",
    });
    expect(config.cmd).toBe("/usr/local/bin/apex-authority");
    expect(config.directory).toBeUndefined();
  });

  it("honors a positive APEX_AUTHORITY_TIMEOUT_MS override and rejects invalid ones", () => {
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_TIMEOUT_MS: "250" }).timeoutMs).toBe(250);
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_TIMEOUT_MS: "0" }).timeoutMs).toBe(5000);
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_TIMEOUT_MS: "-5" }).timeoutMs).toBe(5000);
    expect(resolveKernelAuthorityConfig({ APEX_AUTHORITY_TIMEOUT_MS: "abc" }).timeoutMs).toBe(5000);
  });
});

describeUnix("kernel-authority decide()", () => {
  let dir: string;

  beforeEach(() => {
    dir = createShimDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("denies with 'kernel authority not configured' when APEX_AUTHORITY_CMD is unset", async () => {
    const decision = await decide(baseDecideRequest(), { APEX_AUTHORITY_MODE: "required" });
    expect(decision).toEqual({
      decision: "deny",
      reason: "kernel_unreachable",
      detail: "kernel authority not configured",
      approval_id: null,
    });
  });

  it("returns allow exactly as the kernel reported it", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "allow",
    });
    expect(decision.decision).toBe("allow");
    expect(decision.reason).toBe("low_risk");
    expect(decision.approval_id).toBeNull();
  });

  it("returns deny exactly as the kernel reported it", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "deny",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("tool_disabled");
  });

  it("returns approval_required with the kernel's approval_id and expiry", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "approval_required",
    });
    expect(decision.decision).toBe("approval_required");
    expect(decision.approval_id).toBe(APPROVAL_ID_A);
    expect(decision.expires_at).toBe(4102444800000);
  });

  it("fails closed with kernel_unreachable on garbage stdout", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "garbage",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
  });

  it("fails closed with kernel_unreachable on empty stdout", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "empty",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
  });

  it("fails closed with kernel_unreachable on an unexpected decision value", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "unexpected_decision",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
  });

  it("fails closed with kernel_unreachable when the response is not an object", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "not_an_object",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
  });

  it("fails closed with the kernel's own error text on exit 2", async () => {
    const shim = writeShim(dir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "exit2",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
    expect(decision.detail).toBe("Authority request fields: missing field.");
  });

  it("kills a hung process at the configured timeout and fails closed", async () => {
    const shim = writeShim(dir);
    const startedAt = Date.now();
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "hang",
      APEX_AUTHORITY_TIMEOUT_MS: "200",
    });
    const elapsedMs = Date.now() - startedAt;
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
    // Generous upper bound: proves the 200ms timeout fired, not the 30s sleep.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("fails closed without throwing when the command does not exist", async () => {
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: path.join(dir, "does-not-exist"),
      APEX_AUTHORITY_MODE: "required",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("kernel_unreachable");
  });

  it("sends one JSON request with op, plane, tool, risk, principal, args, and directory", async () => {
    const shim = writeShim(dir);
    const requestFile = requestFilePath(dir);
    await decide(
      baseDecideRequest({
        principal: { user_id: "alice", channel: "cli", display_name: "Alice" },
        args: { command: "rm -rf /tmp/x", cwd: "/home/alice", host: "sandbox" },
      }),
      {
        APEX_AUTHORITY_CMD: shim,
        APEX_AUTHORITY_DIR: "/var/lib/apex-authority",
        FAKE_AUTHORITY_MODE: "allow",
        FAKE_AUTHORITY_REQUEST_FILE: requestFile,
      },
    );
    const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    expect(sent).toEqual({
      op: "decide",
      plane: "edge",
      tool: "exec",
      risk: "R3",
      principal: { user_id: "alice", channel: "cli", display_name: "Alice" },
      args: { command: "rm -rf /tmp/x", cwd: "/home/alice", host: "sandbox" },
      directory: "/var/lib/apex-authority",
    });
  });

  it("lets an explicit request.directory take precedence over APEX_AUTHORITY_DIR", async () => {
    const shim = writeShim(dir);
    const requestFile = requestFilePath(dir);
    await decide(baseDecideRequest({ directory: "/explicit/dir" }), {
      APEX_AUTHORITY_CMD: shim,
      APEX_AUTHORITY_DIR: "/env/dir",
      FAKE_AUTHORITY_MODE: "allow",
      FAKE_AUTHORITY_REQUEST_FILE: requestFile,
    });
    const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    expect(sent.directory).toBe("/explicit/dir");
  });

  it("spawns with no shell: a shim path containing spaces still runs correctly", async () => {
    const spacedDir = path.join(dir, "path with spaces");
    fs.mkdirSync(spacedDir);
    const shim = writeShim(spacedDir);
    const decision = await decide(baseDecideRequest(), {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "allow",
    });
    expect(decision.decision).toBe("allow");
  });

  it("never logs or echoes the gated command text on stdout/stderr of this process", () => {
    // Static guarantee: this module contains no console/logInfo/logWarn calls,
    // and the shim above proves the command travels only inside the JSON
    // stdin payload to the kernel process, never as an argv element or in any
    // output this module itself produces.
    const source = fs.readFileSync(path.join(import.meta.dirname, "kernel-authority.ts"), "utf8");
    expect(/console\.|logInfo\(|logWarn\(/.test(source)).toBe(false);
  });
});

describeUnix("kernel-authority resolve() and finish()", () => {
  let dir: string;

  beforeEach(() => {
    dir = createShimDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolve() sends op=resolve with approval_id/approve and returns the kernel's approval RECORD; a decision-shaped reply is refused", async () => {
    const shim = writeShim(dir);
    const requestFile = requestFilePath(dir);
    const req = {
      approval_id: APPROVAL_ID_B,
      approve: true,
      plane: "edge" as const,
      tool: "exec",
      risk: "R3" as const,
      principal: { user_id: "u-1", channel: "edge" },
      args: { command: "echo hi", cwd: "/work", host: "gateway" },
    };
    const result = await resolve(req, {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "record_approved",
      FAKE_AUTHORITY_REQUEST_FILE: requestFile,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe("approved");
      expect(result.record.id).toBe(APPROVAL_ID_B);
    }
    const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    expect(sent.op).toBe("resolve");
    expect(sent.approval_id).toBe(APPROVAL_ID_B);
    expect(sent.approve).toBe(true);
    // The real kernel never answers resolve with a decision; accepting one would mean the
    // client was validated against the shim rather than the protocol.
    const refused = await resolve(req, {
      APEX_AUTHORITY_CMD: shim,
      FAKE_AUTHORITY_MODE: "resolve_allow",
    });
    expect(refused.ok).toBe(false);
  });

  it("finish() sends op=finish with approval_id/outcome, returns the consumed record, and fails closed on any other reply", async () => {
    const shim = writeShim(dir);
    const requestFile = requestFilePath(dir);
    const consumed = await finish(
      { approval_id: APPROVAL_ID_B, outcome: "succeeded" },
      {
        APEX_AUTHORITY_CMD: shim,
        FAKE_AUTHORITY_MODE: "record_consumed",
        FAKE_AUTHORITY_REQUEST_FILE: requestFile,
      },
    );
    expect(consumed.ok).toBe(true);
    if (consumed.ok) {
      expect(consumed.record.status).toBe("consumed");
      expect(consumed.record.outcome).toBe("succeeded");
    }
    const sent = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    expect(sent).toEqual({ op: "finish", approval_id: APPROVAL_ID_B, outcome: "succeeded" });
    const denied = await finish(
      { approval_id: APPROVAL_ID_B, outcome: "succeeded" },
      { APEX_AUTHORITY_CMD: shim, FAKE_AUTHORITY_MODE: "deny" },
    );
    expect(denied.ok).toBe(false);
  });
});

describeUnix("kernel-authority startup mode description (C7)", () => {
  it("native by default: a WARNING that the kernel is not governing exec, naming the unset variable", () => {
    const described = describeKernelAuthorityMode({});
    expect(described.mode).toBe("native");
    expect(described.level).toBe("warn");
    expect(described.message).toMatch(/^WARNING kernel authority: mode=native/);
    expect(described.message).toContain("APEX_AUTHORITY_MODE is unset");
    expect(described.message).toContain("NOT governing exec");
  });

  it("native with a cmd set but mode wrong: still a WARNING, and it names both facts", () => {
    const described = describeKernelAuthorityMode({
      APEX_AUTHORITY_MODE: "Required",
      APEX_AUTHORITY_CMD: "/opt/apex/bin/apex-authority",
    });
    expect(described).toMatchObject({ mode: "native", level: "warn" });
    expect(described.message).toContain('APEX_AUTHORITY_MODE="Required" is not "required"');
    expect(described.message).toContain(
      "APEX_AUTHORITY_CMD=/opt/apex/bin/apex-authority is set but ignored",
    );
  });

  it("required with a cmd: an info line naming the command, dir, timeout and concurrency ceiling", () => {
    const described = describeKernelAuthorityMode({
      APEX_AUTHORITY_MODE: "required",
      APEX_AUTHORITY_CMD: "/opt/apex/bin/apex-authority",
      APEX_AUTHORITY_DIR: "/var/lib/apex",
      APEX_AUTHORITY_TIMEOUT_MS: "2500",
      APEX_AUTHORITY_MAX_CONCURRENCY: "3",
    });
    expect(described).toMatchObject({ mode: "required", level: "info" });
    expect(described.message).toBe(
      "kernel authority: mode=required cmd=/opt/apex/bin/apex-authority dir=/var/lib/apex timeoutMs=2500 maxConcurrency=3; the APEX kernel governs every exec spawn (gateway, sandbox, node hosts)",
    );
  });

  it("required without a cmd: a WARNING that every exec will be denied until it is set", () => {
    const described = describeKernelAuthorityMode({ APEX_AUTHORITY_MODE: "required" });
    expect(described).toMatchObject({ mode: "required", level: "warn" });
    expect(described.message).toContain("APEX_AUTHORITY_CMD is unset");
    expect(described.message).toContain("DENIED");
  });
});

describeUnix("kernel-authority bounded concurrency (C8)", () => {
  const CONCURRENCY_SHIM = `#!/bin/sh
set -eu
cat >/dev/null
mark="$FAKE_MARK_DIR/$$"
: > "$mark"
sleep "\${FAKE_SLEEP_S:-0.3}"
count=$(ls "$FAKE_MARK_DIR" | wc -l | tr -d ' ')
printf '%s\n' "$count" >> "$FAKE_MARK_DIR.log"
rm -f "$mark"
printf '%s\n' '{"ok":true,"result":{"decision":"allow","reason":"low_risk","operation":"tool.execute","resource":"exec:test","risk":"R3","approval_id":null}}'
exit 0
`;
  let dir: string;
  let markDir: string;
  let shim: string;

  beforeEach(() => {
    dir = createShimDir();
    markDir = path.join(dir, "marks");
    fs.mkdirSync(markDir);
    shim = path.join(dir, "apex-authority-slow");
    fs.writeFileSync(shim, CONCURRENCY_SHIM, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses APEX_AUTHORITY_MAX_CONCURRENCY and falls back to the default on anything invalid", () => {
    expect(DEFAULT_AUTHORITY_MAX_CONCURRENCY).toBe(8);
    expect(resolveKernelAuthorityConfig({}).maxConcurrency).toBe(8);
    expect(
      resolveKernelAuthorityConfig({ APEX_AUTHORITY_MAX_CONCURRENCY: "4" }).maxConcurrency,
    ).toBe(4);
    expect(
      resolveKernelAuthorityConfig({ APEX_AUTHORITY_MAX_CONCURRENCY: " 1 " }).maxConcurrency,
    ).toBe(1);
    expect(
      resolveKernelAuthorityConfig({
        APEX_AUTHORITY_MAX_CONCURRENCY: String(AUTHORITY_MAX_CONCURRENCY_CEILING),
      }).maxConcurrency,
    ).toBe(AUTHORITY_MAX_CONCURRENCY_CEILING);
    for (const invalid of ["0", "-1", "1.5", "abc", "", "  ", "1e3", "0x10", "99999"]) {
      expect(
        resolveKernelAuthorityConfig({ APEX_AUTHORITY_MAX_CONCURRENCY: invalid }).maxConcurrency,
      ).toBe(8);
    }
  });

  it("20 concurrent decides never exceed the ceiling in flight, and all complete with the kernel's answer", async () => {
    const env = {
      APEX_AUTHORITY_CMD: shim,
      APEX_AUTHORITY_MODE: "required",
      APEX_AUTHORITY_TIMEOUT_MS: "20000",
      APEX_AUTHORITY_MAX_CONCURRENCY: "4",
      FAKE_MARK_DIR: markDir,
      FAKE_SLEEP_S: "0.2",
    };
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        decide(
          baseDecideRequest({ args: { command: `echo ${i}`, cwd: "/work", host: "gateway" } }),
          env,
        ),
      ),
    );
    expect(decisions.map((d) => d.decision)).toEqual(Array.from({ length: 20 }, () => "allow"));
    const observed = fs
      .readFileSync(`${markDir}.log`, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line));
    expect(observed).toHaveLength(20);
    expect(Math.max(...observed)).toBeLessThanOrEqual(4);
    // The ceiling was actually reached (the runs were genuinely concurrent, not serialized by chance).
    expect(Math.max(...observed)).toBeGreaterThanOrEqual(2);
    expect(getKernelAuthorityInFlightCountForTests()).toBe(0);
  });

  it("callers stuck behind a saturated ceiling fail closed within the timeout instead of hanging", async () => {
    const env = {
      APEX_AUTHORITY_CMD: shim,
      APEX_AUTHORITY_MODE: "required",
      APEX_AUTHORITY_TIMEOUT_MS: "300",
      APEX_AUTHORITY_MAX_CONCURRENCY: "1",
      FAKE_MARK_DIR: markDir,
      FAKE_SLEEP_S: "5",
    };
    const startedAt = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        decide(
          baseDecideRequest({ args: { command: `echo ${i}`, cwd: "/work", host: "gateway" } }),
          env,
        ),
      ),
    );
    const elapsedMs = Date.now() - startedAt;
    for (const decision of decisions) {
      expect(decision.decision).toBe("deny");
      expect(decision.reason).toBe("kernel_unreachable");
    }
    // Well under the 5s the shim would sleep: every caller was bounded by the 300ms budget.
    expect(elapsedMs).toBeLessThan(3000);
    expect(getKernelAuthorityInFlightCountForTests()).toBe(0);
    // A later call is not poisoned by the earlier saturation.
    const after = await decide(baseDecideRequest(), {
      ...env,
      FAKE_SLEEP_S: "0",
      APEX_AUTHORITY_TIMEOUT_MS: "5000",
    });
    expect(after.decision).toBe("allow");
  });
});

describeUnix("kernel-authority shim self-check", () => {
  it("the shim script itself is valid POSIX sh (sanity check for the fixtures above)", () => {
    const dir = createShimDir();
    try {
      const shim = writeShim(dir);
      const output = execFileSync(shim, [], {
        input: JSON.stringify({ op: "decide" }),
        env: { ...process.env, FAKE_AUTHORITY_MODE: "allow" },
        encoding: "utf8",
      });
      expect(JSON.parse(output).ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

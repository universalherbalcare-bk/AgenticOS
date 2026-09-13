/**
 * The FIXED tool -> kernel risk table (agent-tools.kernel-authority-risk.ts) is data an
 * auditor reads; these tests pin the properties that data must keep: every core tool is
 * classified, exec is excluded (dedicated gate), read-only tools stay at R0/R1, file writes
 * are R2, browser and message risks follow the action, MCP risk comes from declared metadata
 * with a fail-closed default, and unknown tools are consequential.
 */
import { describe, expect, it } from "vitest";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  EDGE_TOOL_KERNEL_RISK,
  KERNEL_GOVERNED_TOOL_CLASSES,
  MCP_READ_ONLY_TOOL_RISK,
  MCP_TOOL_DEFAULT_RISK,
  MESSAGE_CHANNEL_RISK_ELEVATION,
  resolveEdgeToolKernelRisk,
  UNKNOWN_TOOL_RISK,
} from "./agent-tools.kernel-authority-risk.js";
import { listCoreToolFactoryDescriptors } from "./core-tool-factory-descriptors.js";
import type { AnyAgentTool } from "./tools/common.js";

function governed(name: string, params: unknown, tool?: AnyAgentTool) {
  const resolved = resolveEdgeToolKernelRisk({ toolName: name, params, tool });
  if (!resolved.governed) {
    throw new Error(`${name} is not governed by the generic gate`);
  }
  return resolved;
}

function mcpTool(params: {
  name: string;
  operation?: "tool" | "resources_list" | "resources_read" | "prompts_list" | "prompts_get";
  readOnlyHint?: boolean;
  kernelAuthorityRisk?: "R0" | "R1" | "R2" | "R3" | "R4";
}): AnyAgentTool {
  const tool = {
    name: params.name,
    description: "mcp",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  } as unknown as AnyAgentTool;
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "srv",
      safeServerName: "srv",
      toolName: params.name,
      operation: params.operation ?? "tool",
      ...(params.readOnlyHint !== undefined
        ? { codexApproval: { annotations: { readOnlyHint: params.readOnlyHint } } }
        : {}),
      ...(params.kernelAuthorityRisk ? { kernelAuthorityRisk: params.kernelAuthorityRisk } : {}),
    },
  });
  return tool;
}

describe("EDGE_TOOL_KERNEL_RISK (fixed table)", () => {
  it("classifies every core tool factory descriptor; nothing consequential is left to the unknown default", () => {
    const missing = listCoreToolFactoryDescriptors()
      .map((d) => d.name)
      .filter((name) => !Object.hasOwn(EDGE_TOOL_KERNEL_RISK, name));
    expect(missing).toEqual([]);
  });

  it("exec is the only tool with a dedicated gate, and the generic gate skips it", () => {
    const dedicated = Object.entries(EDGE_TOOL_KERNEL_RISK)
      .filter(([, rule]) => "dedicatedGate" in rule)
      .map(([name]) => name);
    expect(dedicated).toEqual(["exec"]);
    expect(
      resolveEdgeToolKernelRisk({ toolName: "exec", params: { command: "rm -rf /" } }),
    ).toEqual({
      governed: false,
      class: "exec",
      reason: "dedicated-gate",
    });
    expect(resolveEdgeToolKernelRisk({ toolName: "EXEC", params: {} }).governed).toBe(false);
  });

  it("read-only tools are R0/R1 and file write/edit/patch are R2", () => {
    for (const name of [
      "ls",
      "read",
      "memory_get",
      "memory_search",
      "sessions_list",
      "agents_list",
    ]) {
      expect(governed(name, {}).risk, name).toBe("R0");
    }
    for (const name of ["web_search", "web_fetch", "x_search"]) {
      expect(governed(name, {}).risk, name).toBe("R1");
    }
    for (const name of ["write", "edit", "apply_patch", "skill_workshop"]) {
      const resolved = governed(name, { path: "a.txt" });
      expect(resolved.risk, name).toBe("R2");
      expect(resolved.class, name).toBe("file-write");
    }
  });

  it("browser: navigation/observation R1, actions that click/type/submit R2, read-only status R0", () => {
    expect(governed("browser", { action: "status" }).risk).toBe("R0");
    expect(governed("browser", { action: "snapshot" }).risk).toBe("R1");
    expect(governed("browser", { action: "navigate", url: "https://x" }).risk).toBe("R1");
    expect(governed("browser", { action: "open" }).risk).toBe("R1");
    expect(governed("browser", { action: "act", kind: "hover" }).risk).toBe("R1");
    expect(governed("browser", { action: "act", kind: "click", ref: "e1" }).risk).toBe("R2");
    expect(governed("browser", { action: "act", kind: "type", text: "x" }).risk).toBe("R2");
    expect(governed("browser", { action: "act", request: { kind: "fill" } }).risk).toBe("R2");
    expect(governed("browser", { action: "act" }).risk).toBe("R2");
    expect(governed("browser", { action: "upload" }).risk).toBe("R2");
    expect(governed("browser", { action: "importprofile" }).risk).toBe("R2");
    // An action nobody listed is consequential.
    expect(governed("browser", { action: "something-new" }).risk).toBe("R2");
    expect(governed("browser", {}).risk).toBe("R2");
  });

  it("message: reads R1, outbound R2, public/phone channels and broadcast/delete R3", () => {
    expect(governed("message", { action: "read", channel: "slack" }).risk).toBe("R1");
    expect(governed("message", { action: "search" }).risk).toBe("R1");
    expect(governed("message", { action: "send", channel: "slack" }).risk).toBe("R2");
    expect(governed("message", { action: "reply", channel: "Discord" }).risk).toBe("R2");
    expect(governed("message", { action: "send", channel: "whatsapp" }).risk).toBe("R3");
    expect(governed("message", { action: "send", channel: "EMAIL" }).risk).toBe("R3");
    expect(governed("message", { action: "broadcast", channel: "slack" }).risk).toBe("R3");
    expect(governed("message", { action: "delete", channel: "slack" }).risk).toBe("R3");
    expect(governed("message", { action: "unsend" }).risk).toBe("R3");
    // Elevation never lowers: an R3 action on an R3 channel stays R3, a read on one stays R1.
    expect(governed("message", { action: "broadcast", channel: "sms" }).risk).toBe("R3");
    expect(governed("message", { action: "read", channel: "sms" }).risk).toBe("R1");
    expect(Object.values(MESSAGE_CHANNEL_RISK_ELEVATION).every((r) => r === "R3")).toBe(true);
    expect(governed("conversations_send", {}).risk).toBe("R2");
  });

  it("process: list/poll/log R1, anything that writes into or kills a process R2", () => {
    expect(governed("process", { action: "list" }).risk).toBe("R1");
    expect(governed("process", { action: "poll" }).risk).toBe("R1");
    expect(governed("process", { action: "write", data: "x" }).risk).toBe("R2");
    expect(governed("process", { action: "send-keys" }).risk).toBe("R2");
    expect(governed("process", { action: "kill" }).risk).toBe("R2");
  });

  it("MCP: declared risk wins, server read-only annotation yields R1, everything else R2", () => {
    expect(governed("srv__x", {}, mcpTool({ name: "srv__x" })).risk).toBe(MCP_TOOL_DEFAULT_RISK);
    expect(governed("srv__x", {}, mcpTool({ name: "srv__x" })).source).toBe("mcp-default");
    expect(governed("srv__x", {}, mcpTool({ name: "srv__x", readOnlyHint: true })).risk).toBe(
      MCP_READ_ONLY_TOOL_RISK,
    );
    expect(governed("srv__x", {}, mcpTool({ name: "srv__x", readOnlyHint: false })).risk).toBe(
      "R2",
    );
    expect(
      governed(
        "srv__x",
        {},
        mcpTool({ name: "srv__x", readOnlyHint: true, kernelAuthorityRisk: "R3" }),
      ),
    ).toMatchObject({ risk: "R3", source: "mcp-declared", class: "mcp" });
    expect(
      governed("srv__x", {}, mcpTool({ name: "srv__x", kernelAuthorityRisk: "R0" })).risk,
    ).toBe("R0");
    expect(
      governed(
        "srv__resources_list",
        {},
        mcpTool({ name: "srv__resources_list", operation: "resources_list" }),
      ).risk,
    ).toBe("R1");
    // The MCP metadata decides even when the safe name collides with a core tool id.
    expect(governed("read", {}, mcpTool({ name: "read" })).risk).toBe("R2");
  });

  it("unknown tools are R2 (consequential until classified)", () => {
    const resolved = governed("some_plugin_tool", { anything: true });
    expect(resolved).toMatchObject({
      risk: UNKNOWN_TOOL_RISK,
      class: "unknown",
      source: "unknown",
    });
  });

  it("the boot-log class list names exec's dedicated gate and the R2 default for unknown tools", () => {
    const joined = KERNEL_GOVERNED_TOOL_CLASSES.join("; ");
    expect(joined).toContain("exec (dedicated spawn-boundary gate)");
    expect(joined).toContain("file-write");
    expect(joined).toContain("browser");
    expect(joined).toContain("message");
    expect(joined).toContain("mcp");
    expect(joined).toContain("unknown tools at R2");
  });
});

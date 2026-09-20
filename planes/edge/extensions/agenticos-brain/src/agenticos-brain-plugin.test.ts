// Verifies the plugin entry's derived metadata matches the manifest and registers the tool.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { agenticosBrainToolDefinition, DEFAULT_BRIDGE_BASE_URL } from "./agenticos-brain-tool.js";

type PluginApi = Parameters<typeof plugin.register>[0];

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(here, "..", "openclaw.plugin.json"), "utf8"),
) as {
  id: string;
  configSchema: {
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  contracts: { tools: string[] };
  toolMetadata: Record<string, { optional?: boolean }>;
};

describe("agenticos-brain plugin entry", () => {
  const metadata = getToolPluginMetadata(plugin);

  const EXPECTED_TOOLS = ["agenticos_brain_turn", "agenticos_brain_approve"];

  it("declares exactly the turn + approve tools, both optional", () => {
    expect(metadata?.id).toBe("agenticos-brain");
    expect(metadata?.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(metadata?.tools.every((tool) => tool.optional === true)).toBe(true);
    expect(metadata?.tools[0]?.name).toBe(agenticosBrainToolDefinition.name);
  });

  it("keeps the manifest in step with the entry", () => {
    expect(manifest.id).toBe(metadata?.id);
    expect(manifest.contracts.tools).toEqual(EXPECTED_TOOLS);
    for (const name of EXPECTED_TOOLS) {
      expect(
        manifest.toolMetadata[name]?.optional,
        `${name} must be optional in the manifest`,
      ).toBe(true);
    }
    expect(Object.keys(manifest.configSchema.properties).toSorted()).toEqual(
      Object.keys(metadata?.configSchema.properties ?? {}).toSorted(),
    );
    expect(manifest.configSchema.required).toEqual(["baseUrl"]);
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });

  it("requires baseUrl with the documented default and forbids unknown keys", () => {
    const schema = metadata?.configSchema as {
      required?: string[];
      additionalProperties?: boolean;
      properties: { baseUrl?: { default?: string } };
    };
    expect(schema.required).toEqual(["baseUrl"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.baseUrl?.default).toBe(DEFAULT_BRIDGE_BASE_URL);
    expect(DEFAULT_BRIDGE_BASE_URL).toBe("http://127.0.0.1:8899");
  });

  it("applies the baseUrl default and rejects unknown config keys at parse time", () => {
    const safeParse = plugin.configSchema?.safeParse;
    if (!safeParse) {
      throw new Error("plugin entry must expose configSchema.safeParse");
    }
    const parsed = safeParse({});
    expect(parsed.success).toBe(true);
    expect((parsed as { data?: { baseUrl?: string } }).data?.baseUrl).toBe(DEFAULT_BRIDGE_BASE_URL);
    expect(safeParse({ bogus: 1 }).success).toBe(false);
    expect(safeParse({ defaultTarget: { kind: "robot", id: "x" } }).success).toBe(false);
    expect(
      safeParse({
        baseUrl: "http://127.0.0.1:8899",
        authToken: "t",
        timeoutMs: 5000,
        defaultTarget: { kind: "team", id: "ops" },
      }).success,
    ).toBe(true);
  });

  it("registers the tool through a factory on plugin startup", () => {
    const registerTool = vi.fn();
    const api = {
      id: "agenticos-brain",
      pluginConfig: { baseUrl: DEFAULT_BRIDGE_BASE_URL },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      registerTool,
    } as unknown as PluginApi;

    plugin.register(api);

    expect(registerTool).toHaveBeenCalledTimes(EXPECTED_TOOLS.length);
    const registered = registerTool.mock.calls as Array<
      [
        (ctx: Record<string, unknown>) => { name: string; execute: unknown },
        { name: string; optional?: boolean },
      ]
    >;
    expect(registered.map(([, opts]) => opts)).toEqual(
      EXPECTED_TOOLS.map((name) => ({ name, optional: true })),
    );
    for (const [factory, opts] of registered) {
      const built = factory({ sessionId: "s-1" });
      expect(built.name).toBe(opts.name);
      expect(typeof built.execute).toBe("function");
    }
  });
});

/**
 * Declared kernel authority risk for bundle MCP tools.
 *
 * `mcp.servers.<name>.kernelAuthority` is the bundle-metadata declaration; it is normalized
 * once per catalog build and copied onto each catalog tool so the generic tool gate
 * (agent-tools.kernel-authority-gate.ts) can read a per-tool risk from the plugin tool meta
 * without touching config at call time. Anything malformed is dropped, never widened:
 * a bad entry costs the declaration, and the tool falls back to the R2 default.
 */
import type { McpServerKernelAuthorityCatalog } from "./agent-bundle-mcp-types.js";

type Risk = "R0" | "R1" | "R2" | "R3" | "R4";

function isRisk(value: unknown): value is Risk {
  return value === "R0" || value === "R1" || value === "R2" || value === "R3" || value === "R4";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalizes the raw config block; undefined when nothing usable was declared. */
export function normalizeMcpServerKernelAuthority(
  raw: unknown,
): McpServerKernelAuthorityCatalog | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const readOnlyTools = Array.isArray(raw.readOnlyTools)
    ? raw.readOnlyTools
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const risk: Record<string, Risk> = {};
  if (isRecord(raw.risk)) {
    for (const [toolName, value] of Object.entries(raw.risk)) {
      const trimmed = toolName.trim();
      if (trimmed && isRisk(value)) {
        risk[trimmed] = value;
      }
    }
  }
  const hasReadOnly = readOnlyTools.length > 0;
  const hasRisk = Object.keys(risk).length > 0;
  if (!hasReadOnly && !hasRisk) {
    return undefined;
  }
  return {
    ...(hasReadOnly ? { readOnlyTools: [...new Set(readOnlyTools)].toSorted() } : {}),
    ...(hasRisk ? { risk } : {}),
  };
}

/** The declared risk for one tool: an explicit tier wins, then readOnlyTools (R1), else nothing. */
export function resolveDeclaredMcpToolKernelRisk(
  declaration: McpServerKernelAuthorityCatalog | undefined,
  toolName: string,
): Risk | undefined {
  if (!declaration) {
    return undefined;
  }
  const explicit = declaration.risk?.[toolName];
  if (isRisk(explicit)) {
    return explicit;
  }
  return declaration.readOnlyTools?.includes(toolName) ? "R1" : undefined;
}

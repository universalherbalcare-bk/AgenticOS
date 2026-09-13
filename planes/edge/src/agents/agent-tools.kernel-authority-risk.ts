/**
 * FIXED tool -> kernel risk table for the edge plane (Phase 4 finding C10).
 *
 * Every consequential edge tool call is presented to the APEX kernel authority with a risk
 * tier drawn from this table, never from the model, the tool's own description, or a plugin.
 * The table is declarative data so an audit can read it top to bottom:
 *
 *  - read-only tools (listing, reading, searching, status) are R0/R1: the kernel allows them
 *    without a record (`low_risk`);
 *  - file write/edit/patch is R2;
 *  - browser navigation/observation is R1; browser actions that click, type, press, fill,
 *    select, drag, upload, evaluate, answer dialogs or import profiles are R2;
 *  - outbound messages are R2, or R3 on channels that reach the public internet or phone
 *    networks (see MESSAGE_CHANNEL_RISK_ELEVATION) and for broadcast/delete/unsend;
 *  - MCP tools take the risk DECLARED in the bundle metadata (`mcp.servers.<name>.kernelAuthority`
 *    -> catalog -> plugin tool meta); undeclared MCP tools default to R2 unless the server
 *    itself annotated them read-only (readOnlyHint), which yields R1; MCP resource/prompt
 *    listing and reading is R1;
 *  - exec keeps its dedicated spawn-boundary gate (bash-tools.exec-kernel-authority-gate.ts)
 *    and is NOT governed here, so it is never double-gated;
 *  - any tool absent from the table (a plugin tool, a client-hosted tool, a new core tool
 *    nobody classified) is R2: unknown is consequential until someone says otherwise.
 *
 * Risk resolution reads the FINAL execution params (post-normalisation), so the action the
 * kernel rates is the action the tool will perform.
 */
import type { AuthorityRisk } from "../infra/kernel-authority.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { isPlainObject } from "../utils.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Tool classes named in the boot log and in every gate decision. */
export type EdgeToolKernelClass =
  | "read-only"
  | "file-write"
  | "process"
  | "runtime"
  | "secrets"
  | "web"
  | "sessions"
  | "browser"
  | "ui"
  | "message"
  | "automation"
  | "nodes"
  | "agents"
  | "media"
  | "mcp"
  | "exec"
  | "unknown";

/** A risk that depends on one string parameter of the call (e.g. `action`). */
export type ActionRiskRule = {
  /** Parameter whose value selects the risk. */
  param: string;
  risks: Readonly<Record<string, AuthorityRisk>>;
  /** Risk for a value not in `risks` (including a missing/non-string value). */
  default: AuthorityRisk;
  /** A second-level selector applied when `param` equals `nested.when`. */
  nested?: {
    when: string;
    param: string;
    risks: Readonly<Record<string, AuthorityRisk>>;
    default: AuthorityRisk;
  };
};

export type EdgeToolKernelRiskRule =
  | { class: EdgeToolKernelClass; risk: AuthorityRisk }
  | { class: EdgeToolKernelClass; byAction: ActionRiskRule }
  /** exec: governed by its own gate at the spawn boundary. */
  | { class: "exec"; dedicatedGate: true };

/** Risk for MCP tools that declared nothing and are not annotated read-only. */
export const MCP_TOOL_DEFAULT_RISK: AuthorityRisk = "R2";
/** Risk for MCP tools the server annotated `readOnlyHint: true` (and for resource/prompt reads). */
export const MCP_READ_ONLY_TOOL_RISK: AuthorityRisk = "R1";
/** Risk for tools this table does not know. Consequential until classified. */
export const UNKNOWN_TOOL_RISK: AuthorityRisk = "R2";

/** Message actions that leave the plane (anything not in here is a read). */
const MESSAGE_OUTBOUND_ACTIONS: Readonly<Record<string, AuthorityRisk>> = {
  send: "R2",
  reply: "R2",
  "thread-reply": "R2",
  "thread-create": "R2",
  react: "R2",
  pin: "R2",
  unpin: "R2",
  "poll-vote": "R2",
  sticker: "R2",
  edit: "R2",
  poll: "R3",
  broadcast: "R3",
  delete: "R3",
  unsend: "R3",
};

/**
 * Channels whose outbound messages reach the public internet or phone networks: an R2 send
 * becomes R3 there. Keys are compared case-insensitively against the call's `channel` arg.
 */
export const MESSAGE_CHANNEL_RISK_ELEVATION: Readonly<Record<string, "R3">> = {
  x: "R3",
  twitter: "R3",
  bluesky: "R3",
  mastodon: "R3",
  email: "R3",
  gmail: "R3",
  smtp: "R3",
  sms: "R3",
  twilio: "R3",
  whatsapp: "R3",
  signal: "R3",
  imessage: "R3",
};

const BROWSER_RULE: ActionRiskRule = {
  param: "action",
  risks: {
    doctor: "R0",
    status: "R0",
    profiles: "R0",
    tabs: "R0",
    snapshot: "R1",
    screenshot: "R1",
    text: "R1",
    console: "R1",
    requests: "R1",
    errors: "R1",
    pdf: "R1",
    start: "R1",
    stop: "R1",
    open: "R1",
    focus: "R1",
    close: "R1",
    navigate: "R1",
    emulate: "R1",
    waitfordownload: "R1",
    download: "R2",
    upload: "R2",
    dialog: "R2",
    importprofile: "R2",
    act: "R2",
  },
  default: "R2",
  nested: {
    when: "act",
    param: "kind",
    risks: {
      wait: "R1",
      hover: "R1",
      scrollIntoView: "R1",
      resize: "R1",
      close: "R1",
      click: "R2",
      clickCoords: "R2",
      type: "R2",
      press: "R2",
      drag: "R2",
      select: "R2",
      fill: "R2",
      evaluate: "R2",
      batch: "R2",
    },
    default: "R2",
  },
};

/**
 * THE table. Keys are tool ids as the policy layer normalises them (lower-case). Read it as
 * the authoritative statement of what the kernel is asked about and how seriously.
 */
export const EDGE_TOOL_KERNEL_RISK: Readonly<Record<string, EdgeToolKernelRiskRule>> = {
  // --- files
  ls: { class: "read-only", risk: "R0" },
  read: { class: "read-only", risk: "R0" },
  write: { class: "file-write", risk: "R2" },
  edit: { class: "file-write", risk: "R2" },
  apply_patch: { class: "file-write", risk: "R2" },
  // --- runtime
  exec: { class: "exec", dedicatedGate: true },
  process: {
    class: "process",
    byAction: {
      param: "action",
      risks: {
        list: "R1",
        poll: "R1",
        log: "R1",
        write: "R2",
        "send-keys": "R2",
        submit: "R2",
        paste: "R2",
        kill: "R2",
        clear: "R2",
        remove: "R2",
      },
      default: "R2",
    },
  },
  code_execution: { class: "runtime", risk: "R2" },
  secrets: {
    class: "secrets",
    byAction: {
      param: "action",
      risks: { list: "R1", request: "R2", delete: "R3" },
      default: "R2",
    },
  },
  // --- web (read-only network)
  web_search: { class: "web", risk: "R1" },
  web_fetch: { class: "web", risk: "R1" },
  x_search: { class: "web", risk: "R1" },
  // --- memory
  memory_search: { class: "read-only", risk: "R0" },
  memory_get: { class: "read-only", risk: "R0" },
  // --- sessions
  sessions: { class: "sessions", risk: "R1" },
  sessions_list: { class: "read-only", risk: "R0" },
  sessions_history: { class: "read-only", risk: "R0" },
  sessions_search: { class: "read-only", risk: "R0" },
  session_status: { class: "read-only", risk: "R0" },
  sessions_send: { class: "sessions", risk: "R1" },
  sessions_spawn: { class: "sessions", risk: "R1" },
  sessions_yield: { class: "read-only", risk: "R0" },
  subagents: { class: "sessions", risk: "R1" },
  conversations_list: { class: "read-only", risk: "R0" },
  conversations_send: { class: "message", risk: "R2" },
  conversations_turn: { class: "message", risk: "R2" },
  github_identity_status: { class: "read-only", risk: "R0" },
  github_publish: { class: "sessions", risk: "R3" },
  agents_list: { class: "read-only", risk: "R0" },
  agents_wait: { class: "read-only", risk: "R0" },
  suggest_task: { class: "sessions", risk: "R1" },
  dismiss_task: { class: "sessions", risk: "R1" },
  // --- ui
  browser: { class: "browser", byAction: BROWSER_RULE },
  screen: { class: "ui", risk: "R2" },
  dashboard: { class: "ui", risk: "R1" },
  terminal: {
    class: "ui",
    byAction: {
      param: "action",
      risks: { read: "R1", list: "R1", resize: "R2", close: "R2", input: "R2" },
      default: "R2",
    },
  },
  portal: { class: "ui", risk: "R2" },
  canvas: { class: "ui", risk: "R1" },
  show_widget: { class: "ui", risk: "R1" },
  progress_card: { class: "ui", risk: "R1" },
  mobile_ui: { class: "nodes", risk: "R2" },
  // --- messaging
  message: {
    class: "message",
    byAction: { param: "action", risks: MESSAGE_OUTBOUND_ACTIONS, default: "R1" },
  },
  heartbeat_respond: { class: "read-only", risk: "R0" },
  // --- automation
  automations: { class: "automation", risk: "R2" },
  cron: { class: "automation", risk: "R2" },
  gateway: {
    class: "automation",
    byAction: {
      param: "action",
      risks: { "config.get": "R1", "config.schema.lookup": "R1", "update.run": "R3" },
      default: "R2",
    },
  },
  openclaw: { class: "automation", risk: "R2" },
  // --- nodes / devices
  nodes: {
    class: "nodes",
    byAction: {
      param: "action",
      risks: {
        status: "R1",
        describe: "R1",
        pending: "R1",
        device_status: "R1",
        device_info: "R1",
        device_health: "R1",
        device_permissions: "R1",
        location_get: "R1",
        camera_list: "R1",
        notifications_list: "R1",
        photos_latest: "R1",
        screen_snapshot: "R1",
      },
      default: "R2",
    },
  },
  computer: { class: "nodes", risk: "R2" },
  // --- agents / goals / structured
  ask_user: { class: "read-only", risk: "R0" },
  get_goal: { class: "read-only", risk: "R0" },
  create_goal: { class: "agents", risk: "R1" },
  update_goal: { class: "agents", risk: "R1" },
  structured_output: { class: "read-only", risk: "R0" },
  skill_workshop: { class: "file-write", risk: "R2" },
  transcripts: { class: "media", risk: "R2" },
  // --- media (generation costs but has no external effect)
  view_image: { class: "read-only", risk: "R0" },
  pdf: { class: "read-only", risk: "R0" },
  image_generate: { class: "media", risk: "R1" },
  music_generate: { class: "media", risk: "R1" },
  video_generate: { class: "media", risk: "R1" },
  tts: { class: "media", risk: "R1" },
};

/** Tool classes the generic gate governs, for the boot log. Exec is named with its own gate. */
export const KERNEL_GOVERNED_TOOL_CLASSES: readonly string[] = [
  "exec (dedicated spawn-boundary gate)",
  "file-write (write/edit/apply_patch/skill_workshop)",
  "process",
  "browser",
  "message (+conversations_send/turn)",
  "mcp (bundle-declared risk, default R2)",
  "nodes/computer/mobile_ui",
  "automation (automations/cron/gateway/openclaw)",
  "secrets",
  "sessions (github_publish R3)",
  "ui (screen/terminal/portal)",
  "media/transcripts",
  "read-only tools at R0/R1 (allowed without a record)",
  "unknown tools at R2",
];

export type EdgeToolKernelRiskResolution =
  | { governed: false; class: "exec"; reason: "dedicated-gate" }
  | {
      governed: true;
      class: EdgeToolKernelClass;
      risk: AuthorityRisk;
      source: "table" | "mcp-declared" | "mcp-read-only" | "mcp-default" | "unknown";
    };

function readStringParam(params: unknown, key: string): string | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function resolveByAction(rule: ActionRiskRule, params: unknown): AuthorityRisk {
  const value = readStringParam(params, rule.param);
  if (value === undefined) {
    return rule.default;
  }
  if (rule.nested && value === rule.nested.when) {
    const nestedValue =
      readStringParam(params, rule.nested.param) ??
      readStringParam(isPlainObject(params) ? params.request : undefined, rule.nested.param);
    return nestedValue === undefined
      ? rule.nested.default
      : (rule.nested.risks[nestedValue] ?? rule.nested.default);
  }
  return rule.risks[value] ?? rule.default;
}

const RISK_ORDER: readonly AuthorityRisk[] = ["R0", "R1", "R2", "R3", "R4"];

function elevate(risk: AuthorityRisk, floor: AuthorityRisk): AuthorityRisk {
  return RISK_ORDER.indexOf(risk) < RISK_ORDER.indexOf(floor) ? floor : risk;
}

function resolveMessageRisk(rule: ActionRiskRule, params: unknown): AuthorityRisk {
  const risk = resolveByAction(rule, params);
  const action = readStringParam(params, rule.param);
  if (action === undefined || !Object.hasOwn(MESSAGE_OUTBOUND_ACTIONS, action)) {
    return risk;
  }
  const channel = readStringParam(params, "channel")?.trim().toLowerCase();
  const elevated = channel ? MESSAGE_CHANNEL_RISK_ELEVATION[channel] : undefined;
  return elevated ? elevate(risk, elevated) : risk;
}

function isValidRisk(value: unknown): value is AuthorityRisk {
  return value === "R0" || value === "R1" || value === "R2" || value === "R3" || value === "R4";
}

function resolveMcpRisk(tool: AnyAgentTool | undefined): EdgeToolKernelRiskResolution | undefined {
  const mcp = tool ? getPluginToolMeta(tool)?.mcp : undefined;
  if (!mcp) {
    return undefined;
  }
  if (isValidRisk(mcp.kernelAuthorityRisk)) {
    return { governed: true, class: "mcp", risk: mcp.kernelAuthorityRisk, source: "mcp-declared" };
  }
  if (mcp.operation !== "tool") {
    // resources_list / resources_read / prompts_list / prompts_get never mutate.
    return { governed: true, class: "mcp", risk: MCP_READ_ONLY_TOOL_RISK, source: "mcp-read-only" };
  }
  if (mcp.codexApproval?.annotations?.readOnlyHint === true) {
    return { governed: true, class: "mcp", risk: MCP_READ_ONLY_TOOL_RISK, source: "mcp-read-only" };
  }
  return { governed: true, class: "mcp", risk: MCP_TOOL_DEFAULT_RISK, source: "mcp-default" };
}

/**
 * Resolves the kernel risk for one tool call from the FIXED table above, reading the final
 * execution params. `tool` (when available) lets MCP-bridged tools be recognised by their
 * plugin metadata regardless of the provider-safe name they were registered under.
 */
export function resolveEdgeToolKernelRisk(params: {
  toolName: string;
  params: unknown;
  tool?: AnyAgentTool;
}): EdgeToolKernelRiskResolution {
  const mcp = resolveMcpRisk(params.tool);
  if (mcp) {
    return mcp;
  }
  const name = params.toolName.trim().toLowerCase();
  const rule = Object.hasOwn(EDGE_TOOL_KERNEL_RISK, name) ? EDGE_TOOL_KERNEL_RISK[name] : undefined;
  if (!rule) {
    return { governed: true, class: "unknown", risk: UNKNOWN_TOOL_RISK, source: "unknown" };
  }
  if ("dedicatedGate" in rule) {
    return { governed: false, class: "exec", reason: "dedicated-gate" };
  }
  if ("byAction" in rule) {
    const risk =
      rule.class === "message"
        ? resolveMessageRisk(rule.byAction, params.params)
        : resolveByAction(rule.byAction, params.params);
    return { governed: true, class: rule.class, risk, source: "table" };
  }
  return { governed: true, class: rule.class, risk: rule.risk, source: "table" };
}

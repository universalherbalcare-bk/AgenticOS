// AgenticOS Brain plugin entrypoint registers the brain-plane turn tool with OpenClaw.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import type { AnyAgentTool } from "./api.js";
import {
  agenticosBrainApproveToolDefinition,
  createAgenticosBrainApproveTool,
} from "./src/agenticos-brain-approve-tool.js";
import {
  agenticosBrainToolDefinition,
  createAgenticosBrainTool,
  DEFAULT_BRIDGE_BASE_URL,
} from "./src/agenticos-brain-tool.js";

export default defineToolPlugin({
  id: "agenticos-brain",
  name: "AgenticOS Brain",
  description:
    "Dispatches a turn to the AgenticOS brain plane over the HTTP+SSE bridge and returns the brain's final output.",
  configSchema: Type.Object(
    {
      baseUrl: Type.String({ default: DEFAULT_BRIDGE_BASE_URL }),
      authToken: Type.Optional(Type.String()),
      timeoutMs: optionalPositiveIntegerSchema(),
      defaultTarget: Type.Optional(
        Type.Object(
          {
            kind: Type.Union([
              Type.Literal("agent"),
              Type.Literal("team"),
              Type.Literal("workflow"),
            ]),
            id: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  tools: (tool) => [
    tool({
      ...agenticosBrainToolDefinition,
      optional: true,
      factory: ({ api, toolContext }) =>
        createAgenticosBrainTool({ api, toolContext }) as unknown as AnyAgentTool,
    }),
    tool({
      ...agenticosBrainApproveToolDefinition,
      optional: true,
      factory: ({ api, toolContext }) =>
        createAgenticosBrainApproveTool({ api, toolContext }) as unknown as AnyAgentTool,
    }),
  ],
});

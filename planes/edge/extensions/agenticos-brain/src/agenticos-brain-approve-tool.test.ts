import { describe, expect, it, vi } from "vitest";
import { createAgenticosBrainApproveTool } from "./agenticos-brain-approve-tool.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown = { resolved: true }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const api = { pluginConfig: { baseUrl: "http://brain.test:8899", authToken: "cfg-token" } };

describe("agenticos_brain_approve", () => {
  it("POSTs the contract ApprovalDecision to the bridge with the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    const tool = createAgenticosBrainApproveTool({
      api,
      toolContext: { requesterSenderId: "ops-1" },
      fetchImpl,
      env: {},
    });
    const res = await tool.execute("id", {
      turn_id: "turn-1",
      approval_id: "turn-1:run-9",
      decision: "approve",
      reason: "looks fine",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://brain.test:8899/v1/turns/turn-1/approvals/turn-1%3Arun-9");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer cfg-token");
    const rawBody = calls[0]!.init.body;
    if (typeof rawBody !== "string") {
      throw new Error("expected a JSON string body");
    }
    const body = JSON.parse(rawBody);
    expect(body).toEqual({
      approval_id: "turn-1:run-9",
      decision: "approve",
      principal: { user_id: "ops-1", channel: "openclaw", scopes: ["turns:create"] },
      reason: "looks fine",
    });
    expect(res.details).toEqual({
      turn_id: "turn-1",
      approval_id: "turn-1:run-9",
      decision: "approve",
      resolved: true,
    });
  });

  it("falls back to AGENTICOS_BRIDGE_TOKEN from env when config has no token", async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    const tool = createAgenticosBrainApproveTool({
      api: { pluginConfig: { baseUrl: "http://brain.test:8899" } },
      fetchImpl,
      env: { AGENTICOS_BRIDGE_TOKEN: "env-token" },
    });
    await tool.execute("id", { turn_id: "t", approval_id: "a", decision: "deny" });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer env-token",
    );
  });

  it("surfaces 404 as 'no pending approval' rather than a raw status", async () => {
    const { fetchImpl } = fakeFetch(404, { detail: "no such pending approval" });
    const tool = createAgenticosBrainApproveTool({ api, fetchImpl, env: {} });
    await expect(
      tool.execute("id", { turn_id: "t", approval_id: "gone", decision: "approve" }),
    ).rejects.toThrow(/no pending approval gone for turn t/);
  });

  it("rejects an invalid decision before touching the network", async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    const tool = createAgenticosBrainApproveTool({ api, fetchImpl, env: {} });
    await expect(
      tool.execute("id", { turn_id: "t", approval_id: "a", decision: "maybe" }),
    ).rejects.toThrow(/approve.*deny/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an over-long reason (contract max 1024)", async () => {
    const { fetchImpl, calls } = fakeFetch(200);
    const tool = createAgenticosBrainApproveTool({ api, fetchImpl, env: {} });
    await expect(
      tool.execute("id", {
        turn_id: "t",
        approval_id: "a",
        decision: "approve",
        reason: "x".repeat(1025),
      }),
    ).rejects.toThrow(/1024/);
    expect(calls).toHaveLength(0);
  });

  it("propagates 5xx as a retryable BridgeError", async () => {
    const { fetchImpl } = fakeFetch(503);
    const tool = createAgenticosBrainApproveTool({ api, fetchImpl, env: {} });
    await expect(
      tool.execute("id", { turn_id: "t", approval_id: "a", decision: "approve" }),
    ).rejects.toMatchObject({ name: "BridgeError", status: 503, retryable: true });
  });
});

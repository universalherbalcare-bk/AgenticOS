// AgenticOS Brain tests cover the brain-plane turn tool against a mocked bridge.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_TOKEN_ENV,
  createAgenticosBrainTool,
  stableSessionIdFromKey,
} from "./agenticos-brain-tool.js";

type BrainApi = Parameters<typeof createAgenticosBrainTool>[0]["api"];
type BrainToolContext = NonNullable<Parameters<typeof createAgenticosBrainTool>[0]["toolContext"]>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Frame = Record<string, unknown>;

function sseResponse(frames: Frame[], init: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const type = String(frame.type);
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Builds SSE frames that echo the request's turn_id, like the real bridge does. */
function framesFor(turnId: string, build: (turnId: string) => Frame[]): Frame[] {
  return build(turnId);
}

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

function mockFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const call = { url, init: init ?? {}, body };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeApi(overrides: Record<string, unknown> = {}): BrainApi {
  return {
    id: "agenticos-brain",
    name: "agenticos-brain",
    source: "test",
    config: {},
    pluginConfig: {
      baseUrl: "http://bridge.test:8899",
      defaultTarget: { kind: "agent", id: "assistant" },
    },
    runtime: { version: "test" },
    logger,
    registerTool() {},
    ...overrides,
  } as unknown as BrainApi;
}

function completedFrames(turnId: string): Frame[] {
  const ts = "2026-09-20T00:00:00.000Z";
  return [
    { type: "run.started", turn_id: turnId, run_id: "run-1", ts },
    { type: "reasoning.delta", turn_id: turnId, text: "thinking…", ts },
    { type: "tool.started", turn_id: turnId, tool: "web_search", args_preview: '{"q":"x"}', ts },
    { type: "tool.completed", turn_id: turnId, tool: "web_search", ok: true, ts },
    { type: "output.delta", turn_id: turnId, text: "Hello, ", ts },
    { type: "output.delta", turn_id: turnId, text: "world.", ts },
    {
      type: "run.completed",
      turn_id: turnId,
      run_id: "run-1",
      output: "Hello, world.",
      usage: { input_tokens: 12, output_tokens: 4, tool_calls: 1, duration_ms: 321 },
      ts,
    },
  ];
}

describe("agenticos_brain_turn tool", () => {
  beforeEach(() => {
    logger.debug.mockClear();
    logger.warn.mockClear();
  });

  it("concatenates deltas and returns run.completed output with details", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    const res = await tool.execute("call-1", { text: "hi" });

    expect(res.content).toEqual([{ type: "text", text: "Hello, world." }]);
    expect(res.details).toEqual({
      turn_id: expect.stringMatching(UUID_RE),
      run_id: "run-1",
      usage: { input_tokens: 12, output_tokens: 4, tool_calls: 1, duration_ms: 321 },
      tools: [
        {
          tool: "web_search",
          started_at: "2026-09-20T00:00:00.000Z",
          args_preview: '{"q":"x"}',
          completed_at: "2026-09-20T00:00:00.000Z",
          ok: true,
        },
      ],
      reasoning_chars: "thinking…".length,
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://bridge.test:8899/v1/turns");
    expect(calls[0]?.init.method).toBe("POST");
    const body = calls[0]?.body ?? {};
    expect(body.turn_id).toBe((res.details as { turn_id: string }).turn_id);
    expect(body.target).toEqual({ kind: "agent", id: "assistant" });
    expect(body.input).toEqual({ text: "hi" });
    expect(body.principal).toEqual({
      user_id: "edge",
      channel: "openclaw",
      scopes: ["turns:create"],
    });
    expect(body.trace).toEqual({
      trace_id: (res.details as { trace_id: string }).trace_id,
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/u),
      sampled: true,
    });
    expect(body.options).toEqual({ stream: true, timeout_ms: 120_000 });
  });

  it("uses a fresh turn_id per invocation and falls back to concatenated deltas", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      const turnId = String(call.body.turn_id);
      const ts = "2026-09-20T00:00:00.000Z";
      return sseResponse([
        { type: "output.delta", turn_id: turnId, text: "a" },
        { type: "output.delta", turn_id: turnId, text: "b" },
        { type: "run.completed", turn_id: turnId, output: "", ts },
      ]);
    });
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    const first = await tool.execute("call-1", { text: "x" });
    const second = await tool.execute("call-2", { text: "x" });

    expect(first.content[0]?.text).toBe("ab");
    expect(calls[0]?.body.turn_id).not.toBe(calls[1]?.body.turn_id);
    expect((first.details as { turn_id: string }).turn_id).not.toBe(
      (second.details as { turn_id: string }).turn_id,
    );
  });

  it("throws on run.failed with the brain's error text and retryable flag", async () => {
    const { fetchImpl } = mockFetch((call) =>
      sseResponse([
        {
          type: "run.failed",
          turn_id: String(call.body.turn_id),
          error: "executor exploded",
          retryable: true,
          reason: "executor_error",
          ts: "2026-09-20T00:00:00.000Z",
        },
      ]),
    );
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    await expect(tool.execute("call-1", { text: "hi" })).rejects.toThrow(
      /executor exploded.*retryable=true.*reason=executor_error/u,
    );
  });

  it("returns pending details on approval.required without throwing or auto-approving", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      const turnId = String(call.body.turn_id);
      const ts = "2026-09-20T00:00:00.000Z";
      return sseResponse([
        { type: "run.started", turn_id: turnId, run_id: "run-2", ts },
        {
          type: "approval.required",
          turn_id: turnId,
          approval_id: "apr-1",
          prompt: "Allow sending the email?",
          tool: "send_email",
          expires_at: "2026-09-20T00:05:00.000Z",
          ts,
        },
        // Anything after the pause must be ignored by v1.
        { type: "output.delta", turn_id: turnId, text: "should not appear", ts },
        { type: "run.completed", turn_id: turnId, output: "should not appear", ts },
      ]);
    });
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    const res = await tool.execute("call-1", { text: "send it" });

    expect(res.content).toEqual([
      { type: "text", text: "Approval required: Allow sending the email?" },
    ]);
    expect(res.details).toEqual({
      approval_id: "apr-1",
      turn_id: calls[0]?.body.turn_id,
      pending: true,
      tool: "send_email",
      expires_at: "2026-09-20T00:05:00.000Z",
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/u),
    });
    // v1 never calls the approvals endpoint.
    expect(calls.every((call) => !call.url.includes("/approvals/"))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("throws naming defaultTarget when no target is given and none is configured", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const tool = createAgenticosBrainTool({
      api: fakeApi({ pluginConfig: { baseUrl: "http://bridge.test:8899" } }),
      fetchImpl,
      env: {},
    });

    await expect(tool.execute("call-1", { text: "hi" })).rejects.toThrow(/defaultTarget/u);
    expect(calls).toHaveLength(0);
  });

  it("uses explicit target_kind/target_id over the configured default", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    await tool.execute("call-1", { text: "hi", target_kind: "workflow", target_id: "nightly" });

    expect(calls[0]?.body.target).toEqual({ kind: "workflow", id: "nightly" });
  });

  it("rejects a half-specified target and an unknown target_kind before dispatch", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    await expect(tool.execute("call-1", { text: "hi", target_id: "x" })).rejects.toThrow(
      /provided together/u,
    );
    await expect(
      tool.execute("call-1", { text: "hi", target_kind: "robot", target_id: "x" }),
    ).rejects.toThrow(/target_kind must be one of/u);
    await expect(
      tool.execute("call-1", { text: "hi", target_kind: "agent", target_id: "x".repeat(129) }),
    ).rejects.toThrow(/at most 128 characters/u);
    expect(calls).toHaveLength(0);
  });

  it("sends the configured authToken as a Bearer authorization header", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const tool = createAgenticosBrainTool({
      api: fakeApi({
        pluginConfig: {
          baseUrl: "http://bridge.test:8899",
          authToken: "cfg-secret",
          defaultTarget: { kind: "agent", id: "assistant" },
        },
      }),
      fetchImpl,
      env: { [BRIDGE_TOKEN_ENV]: "env-secret" },
    });

    await tool.execute("call-1", { text: "hi" });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer cfg-secret");
    expect(headers.accept).toBe("text/event-stream");
    // The token must never reach the logger.
    for (const entry of [...logger.debug.mock.calls, ...logger.warn.mock.calls].flat()) {
      expect(String(entry)).not.toContain("cfg-secret");
    }
  });

  it("falls back to AGENTICOS_BRIDGE_TOKEN when authToken is not configured", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const tool = createAgenticosBrainTool({
      api: fakeApi(),
      fetchImpl,
      env: { [BRIDGE_TOKEN_ENV]: "env-secret" },
    });

    await tool.execute("call-1", { text: "hi" });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer env-secret");
  });

  it("sends no authorization header when neither config nor env supplies a token", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    await tool.execute("call-1", { text: "hi" });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("surfaces a 409 idempotency replay as a thrown error", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response("duplicate turn_id", { status: 409, statusText: "Conflict" }),
    );
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    await expect(tool.execute("call-1", { text: "hi" })).rejects.toThrow(
      /409.*retryable=false.*idempotency/su,
    );
  });

  it("derives a stable session_id from the tool context and honours an explicit one", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const withSessionId = createAgenticosBrainTool({
      api: fakeApi(),
      toolContext: { sessionId: "sess-uuid-1", sessionKey: "agent:main:main" } as BrainToolContext,
      fetchImpl,
      env: {},
    });
    await withSessionId.execute("call-1", { text: "hi" });
    expect(calls[0]?.body.session_id).toBe("sess-uuid-1");

    const withSessionKey = createAgenticosBrainTool({
      api: fakeApi(),
      toolContext: {
        sessionKey: "agent:main:main",
        requesterSenderId: "user-42",
      } as BrainToolContext,
      fetchImpl,
      env: {},
    });
    await withSessionKey.execute("call-2", { text: "hi" });
    await withSessionKey.execute("call-3", { text: "hi" });
    expect(calls[1]?.body.session_id).toBe(stableSessionIdFromKey("agent:main:main"));
    expect(calls[1]?.body.session_id).toBe(calls[2]?.body.session_id);
    expect(calls[1]?.body.session_id).toMatch(UUID_RE);
    expect(calls[1]?.body.principal).toMatchObject({ user_id: "user-42" });

    const noContext = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });
    await noContext.execute("call-4", { text: "hi" });
    await noContext.execute("call-5", { text: "hi" });
    expect(calls[3]?.body.session_id).toMatch(UUID_RE);
    expect(calls[3]?.body.session_id).not.toBe(calls[4]?.body.session_id);

    await noContext.execute("call-6", { text: "hi", session_id: "explicit-session" });
    expect(calls[5]?.body.session_id).toBe("explicit-session");
  });

  it("passes custom scopes through and rejects malformed ones", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      sseResponse(framesFor(String(call.body.turn_id), completedFrames)),
    );
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });

    await tool.execute("call-1", { text: "hi", scopes: ["turns:create", "tools:web"] });
    expect(calls[0]?.body.principal).toMatchObject({ scopes: ["turns:create", "tools:web"] });

    await expect(tool.execute("call-2", { text: "hi", scopes: ["ok", ""] })).rejects.toThrow(
      /scopes must be/u,
    );
    expect(calls).toHaveLength(1);
  });

  it("honours an already-aborted signal and an abort during streaming", async () => {
    const pre = new AbortController();
    pre.abort();
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });
    await expect(tool.execute("call-1", { text: "hi" }, pre.signal)).rejects.toThrow(/aborted/u);
    expect(calls).toHaveLength(0);

    const mid = new AbortController();
    const hanging = mockFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          mid.abort();
        }),
    );
    const hangingTool = createAgenticosBrainTool({
      api: fakeApi(),
      fetchImpl: hanging.fetchImpl,
      env: {},
    });
    await expect(hangingTool.execute("call-2", { text: "hi" }, mid.signal)).rejects.toThrow(
      /aborted or timed out.*retryable=true/u,
    );
  });

  it("rejects an invalid baseUrl before dispatch", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const tool = createAgenticosBrainTool({
      api: fakeApi({
        pluginConfig: { baseUrl: "ftp://nope", defaultTarget: { kind: "agent", id: "a" } },
      }),
      fetchImpl,
      env: {},
    });
    await expect(tool.execute("call-1", { text: "hi" })).rejects.toThrow(/http or https/u);
    expect(calls).toHaveLength(0);
  });

  it("requires non-empty text", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const tool = createAgenticosBrainTool({ api: fakeApi(), fetchImpl, env: {} });
    await expect(tool.execute("call-1", { text: "   " })).rejects.toThrow(/text required/u);
    expect(calls).toHaveLength(0);
  });
});

// VERBATIM COPY of bridge/ts/src/client.ts. DO NOT EDIT HERE.
// Canonical source: /bridge/ts/src (the AgenticOS bridge contract package).
// This copy exists only because bundled OpenClaw extensions may not import
// outside their own package root (tsc rootDir + lint:extensions:no-relative-outside-package).
// Keep in sync with: node extensions/agenticos-brain/vendor/sync.mts
// Drift is a build failure: see src/vendor-sync.test.ts.
// --- BEGIN VERBATIM COPY (do not edit below this line) ---
/**
 * Edge-plane client for the AgenticOS brain plane.
 *
 * This is the ONLY sanctioned way the TypeScript plane talks to the Python
 * plane. It is deliberately small: dispatch a turn, consume a typed event
 * stream, resolve approvals. Everything else stays inside its own plane.
 */

import {
  type ApprovalDecision,
  type TurnEvent,
  type TurnRequest,
  isTerminal,
} from "./contract.ts";

export class BridgeError extends Error {
  // NOTE: written as explicit assignments rather than TypeScript "parameter
  // properties". Node runs this file via type-stripping, which erases types but
  // cannot emit code, so `constructor(readonly x)` is a syntax error there.
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface BrainClientOptions {
  baseUrl: string;
  authToken?: string;
  /** Wall-clock ceiling for a whole turn. Defaults to the contract's 120s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class BrainClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BrainClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authToken = opts.authToken;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...extra };
    if (this.authToken) h.authorization = `Bearer ${this.authToken}`;
    return h;
  }

  async health(): Promise<{ status: string; contract: string; executors: Record<string, string[]> }> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/bridge/health`, { headers: this.headers() });
    if (!res.ok) throw new BridgeError(`bridge health failed: ${res.status}`, res.status);
    return res.json() as Promise<{ status: string; contract: string; executors: Record<string, string[]> }>;
  }

  /**
   * Dispatch one turn and yield typed events until a terminal event.
   *
   * Guarantees, so callers never need a defensive timeout of their own:
   *  - always ends with exactly one terminal event (a transport failure is
   *    synthesised into `run.failed` rather than throwing mid-iteration);
   *  - honours `signal` and the configured wall-clock ceiling.
   */
  async *dispatch(turn: TurnRequest, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), turn.options?.timeout_ms ?? this.timeoutMs);

    let sawTerminal = false;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/turns`, {
        method: "POST",
        headers: this.headers({ accept: "text/event-stream" }),
        body: JSON.stringify(turn),
        signal: ac.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // 409 is an idempotency replay: the turn already ran. Not retryable.
        throw new BridgeError(
          `bridge rejected turn ${turn.turn_id}: ${res.status} ${detail}`.trim(),
          res.status,
          res.status >= 500 || res.status === 429,
        );
      }
      if (!res.body) throw new BridgeError("bridge returned no body", res.status);

      for await (const ev of parseSse(res.body)) {
        if (isTerminal(ev)) sawTerminal = true;
        yield ev;
        if (sawTerminal) return;
      }

      if (!sawTerminal) {
        // Stream ended without a terminal event: the contract was violated
        // upstream. Fail closed so the caller always sees an ending.
        yield {
          type: "run.failed",
          turn_id: turn.turn_id,
          error: "bridge stream ended without a terminal event",
          retryable: true,
          ts: new Date().toISOString(),
        };
      }
    } catch (err) {
      if (sawTerminal) return;
      const aborted = ac.signal.aborted;
      yield {
        type: "run.failed",
        turn_id: turn.turn_id,
        error: aborted ? "turn aborted or timed out" : String((err as Error)?.message ?? err),
        retryable: aborted || (err instanceof BridgeError ? err.retryable : true),
        ts: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async resolveApproval(turnId: string, decision: ApprovalDecision): Promise<void> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/turns/${encodeURIComponent(turnId)}/approvals/${encodeURIComponent(decision.approval_id)}`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(decision) },
    );
    if (!res.ok) {
      throw new BridgeError(`approval resolve failed: ${res.status}`, res.status, res.status >= 500);
    }
  }
}

/** Minimal SSE frame parser: splits on blank lines, keeps `data:` payloads. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const payload = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (payload) yield JSON.parse(payload) as TurnEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Cross-plane end-to-end test.
 *
 * Proves the merged system is ONE system: a TypeScript edge-plane client
 * dispatches a turn over real HTTP to a real Python brain-plane server running
 * a real Agno agent, and receives a typed, ordered, terminating event stream.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BrainClient } from "../../bridge/ts/src/client.ts";
import { newTraceContext, isTerminal, type TurnEvent, type TurnRequest } from "../../bridge/ts/src/contract.ts";

const BASE = process.env.BRAIN_URL ?? "http://127.0.0.1:8899";
const client = new BrainClient({ baseUrl: BASE });

function turn(id: string, kind: "agent" | "team" = "agent", target = "support"): TurnRequest {
  return {
    turn_id: id,
    session_id: "cross-plane-session",
    target: { kind, id: target },
    input: { text: "hello from the edge plane" },
    principal: { user_id: "u-edge", channel: "slack", scopes: ["turns:create"] },
    trace: newTraceContext(),
  };
}

async function drain(t: TurnRequest): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const ev of client.dispatch(t)) out.push(ev);
  return out;
}

describe("cross-plane bridge", () => {
  before(async () => {
    // Fail fast and loudly if the brain plane is not up.
    const health = await client.health();
    assert.equal(health.contract, "turn.v1");
  });

  it("reports the brain plane's registered executors", async () => {
    const h = await client.health();
    assert.deepEqual(h.executors.agent, ["support"]);
    assert.deepEqual(h.executors.team, ["triage"]);
  });

  it("streams a turn from the TS edge to the Python brain and back", async () => {
    const events = await drain(turn("xp-1"));
    const types = events.map((e) => e.type);

    assert.equal(types[0], "run.started", `first event was ${types[0]}`);
    assert.ok(isTerminal(events.at(-1)!), `last event was ${types.at(-1)}`);
    assert.equal(events.filter(isTerminal).length, 1, "exactly one terminal event");

    const text = events
      .filter((e): e is Extract<TurnEvent, { type: "output.delta" }> => e.type === "output.delta")
      .map((e) => e.text)
      .join("");
    assert.equal(text, "Crossed the plane boundary.");

    const final = events.at(-1)!;
    assert.equal(final.type, "run.completed");
    if (final.type === "run.completed") {
      assert.equal(final.output, "Crossed the plane boundary.");
    }
  });

  it("routes a team target across the boundary", async () => {
    const events = await drain(turn("xp-team", "team", "triage"));
    const final = events.at(-1)!;
    assert.equal(final.type, "run.completed");
    if (final.type === "run.completed") assert.equal(final.output, "Team crossed too.");
  });

  it("rejects a replayed turn_id (idempotency holds over the wire)", async () => {
    await drain(turn("xp-dup"));
    const replay = await drain(turn("xp-dup"));
    const final = replay.at(-1)!;
    assert.equal(final.type, "run.failed", "replay must not execute twice");
    if (final.type === "run.failed") assert.match(final.error, /409/);
  });

  it("synthesises a terminal event when the brain plane is unreachable", async () => {
    const offline = new BrainClient({ baseUrl: "http://127.0.0.1:9", timeoutMs: 3000 });
    const out: TurnEvent[] = [];
    for await (const ev of offline.dispatch(turn("xp-offline"))) out.push(ev);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "run.failed", "client must fail closed, never hang");
  });

  it("surfaces an unknown target as a terminal failure, not a hang", async () => {
    const events = await drain(turn("xp-404", "agent", "does-not-exist"));
    const final = events.at(-1)!;
    assert.equal(final.type, "run.failed");
    if (final.type === "run.failed") assert.match(final.error, /404/);
  });
});

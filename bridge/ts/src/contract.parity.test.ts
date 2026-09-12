/**
 * The JSON Schema is canonical; the TypeScript contract is its projection.
 *
 * This test did not exist when the merge first claimed "both planes generate
 * their types from it and a parity test fails the build if they drift" — the
 * Python side had one, the TypeScript side did not. Adversarial review caught
 * the overclaim; this closes it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_VERSION,
  TERMINAL_EVENT_TYPES,
  TURN_EVENT_TYPES,
  isTerminal,
  newTraceContext,
  type TurnEvent,
} from "./contract.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(
  readFileSync(join(HERE, "..", "..", "contract", "turn.schema.json"), "utf8"),
);

describe("bridge contract parity (schema <-> TypeScript)", () => {
  it("is the version the client claims to speak", () => {
    assert.equal(SCHEMA.$id.endsWith("turn.v1.json"), true);
    assert.equal(CONTRACT_VERSION, "turn.v1");
  });

  it("covers exactly the schema's TurnEvent members", () => {
    const fromSchema = SCHEMA.$defs.TurnEvent.oneOf
      .map((m: { properties: { type: { const: string } } }) => m.properties.type.const)
      .sort();
    assert.deepEqual([...TURN_EVENT_TYPES].sort(), fromSchema);
  });

  it("treats exactly the terminal events as terminal", () => {
    assert.deepEqual([...TERMINAL_EVENT_TYPES].sort(), ["run.completed", "run.failed"]);
    for (const type of TURN_EVENT_TYPES) {
      const ev = { type, turn_id: "t", ts: "now" } as unknown as TurnEvent;
      assert.equal(
        isTerminal(ev),
        type === "run.completed" || type === "run.failed",
        `isTerminal disagrees for ${type} — a wrong answer here hangs the client`,
      );
    }
  });

  it("mirrors the schema's required fields for TurnRequest", () => {
    assert.deepEqual(
      [...SCHEMA.$defs.TurnRequest.required].sort(),
      ["input", "principal", "session_id", "target", "trace", "turn_id"],
    );
  });

  it("generates trace ids the schema's patterns accept", () => {
    const { trace_id, span_id } = newTraceContext();
    assert.match(trace_id, new RegExp(SCHEMA.$defs.TraceContext.properties.trace_id.pattern));
    assert.match(span_id, new RegExp(SCHEMA.$defs.TraceContext.properties.span_id.pattern));
  });
});

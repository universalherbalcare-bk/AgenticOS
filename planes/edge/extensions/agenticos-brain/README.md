# AgenticOS Brain (plugin)

Adds an **optional** agent tool `agenticos_brain_turn` that dispatches one turn
to the AgenticOS **brain plane** (Python / Agno) over the HTTP+SSE bridge and
returns the brain's final output. This is the first runtime path from the
OpenClaw edge plane to the brain plane.

The tool talks to the bridge exclusively through `BrainClient`
(`bridge/ts/src/client.ts`), the only sanctioned edge-to-brain path.

## Enable

1. Enable the plugin:

```json
{
  "plugins": {
    "entries": {
      "agenticos-brain": { "enabled": true }
    }
  }
}
```

2. Allowlist the tool (it is registered with `optional: true`):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["agenticos_brain_turn"] }
      }
    ]
  }
}
```

## Config

```json
{
  "plugins": {
    "entries": {
      "agenticos-brain": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8899",
          "authToken": "<bridge bearer token>",
          "timeoutMs": 120000,
          "defaultTarget": { "kind": "agent", "id": "assistant" }
        }
      }
    }
  }
}
```

| Key             | Type                                                | Default                 | Notes                                                                                  |
| --------------- | --------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `baseUrl`       | string (required)                                   | `http://127.0.0.1:8899` | Bridge base URL. Must be `http:` or `https:`.                                          |
| `authToken`     | string (optional, sensitive)                        | –                       | Sent as `authorization: Bearer <token>`. Never logged.                                 |
| `timeoutMs`     | positive integer (optional)                         | `120000`                | Wall-clock ceiling for one whole turn; also sent as `options.timeout_ms` to the brain. |
| `defaultTarget` | `{ kind: "agent"\|"team"\|"workflow", id: string }` | –                       | Used when a tool call omits `target_kind` / `target_id`.                               |

### `AGENTICOS_BRIDGE_TOKEN` environment fallback

If `authToken` is not set in config, the tool reads the token from the
`AGENTICOS_BRIDGE_TOKEN` environment variable. Config wins when both are
present. When neither is set, no `authorization` header is sent. The token is
never written to logs or included in tool results.

## Tool API

### Parameters

- `text` (string, required) – input text for the turn.
- `target_kind` (`agent` | `team` | `workflow`, optional)
- `target_id` (string, optional)
- `session_id` (string, optional) – brain-plane conversation of record.
- `scopes` (string[], optional) – principal scopes the brain enforces. Defaults to `["turns:create"]`.

`target_kind` and `target_id` must be given together. If neither is given the
plugin's `defaultTarget` is used; if that is also missing the call fails with an
error naming `plugins.entries.agenticos-brain.config.defaultTarget`.

### Request construction

- `turn_id` is a fresh `crypto.randomUUID()` on **every** invocation, so the
  brain's idempotency guard is per tool call. A `409` from the brain (replayed
  `turn_id`) surfaces as a thrown error mentioning `409` and idempotency.
- `session_id` resolution order: explicit `session_id` param → the OpenClaw
  tool context's `sessionId` → a stable UUID-shaped SHA-256 of the tool
  context's `sessionKey` → a fresh UUID.
- `principal` is `{ user_id: <requesterSenderId or "edge">, channel: "openclaw", scopes }`.
- `trace` is a fresh W3C-shaped trace context (`newTraceContext()`); its
  `trace_id` is echoed in `details.trace_id` so one trace spans both planes.

### Output

On `run.completed`:

```json
{
  "content": [{ "type": "text", "text": "<brain final output>" }],
  "details": {
    "turn_id": "…",
    "run_id": "…",
    "usage": { "input_tokens": 12, "output_tokens": 4, "tool_calls": 1, "duration_ms": 321 },
    "tools": [{ "tool": "web_search", "started_at": "…", "completed_at": "…", "ok": true }],
    "reasoning_chars": 9,
    "trace_id": "…"
  }
}
```

`text` is the terminal event's canonical `output`; if the brain streamed
`output.delta` frames but sent an empty final `output`, the concatenated deltas
are used instead. `reasoning.delta` text is **not** returned, only its length
(`reasoning_chars`).

On `run.failed` the tool **throws** an `Error` whose message contains the
brain's `error` string, `retryable=<bool>`, and the `reason` when present.

### Cancellation and timeouts

The tool honours the `AbortSignal` passed by the runtime and forwards it to
`BrainClient.dispatch`. The client guarantees exactly one terminal event, so an
abort or timeout becomes a thrown error (`turn aborted or timed out`,
`retryable=true`) rather than a hang.

## Vendored bridge files

`vendor/client.ts` and `vendor/contract.ts` are **verbatim copies** of
`bridge/ts/src/client.ts` and `bridge/ts/src/contract.ts` with a fixed header.
A relative import of the canonical files is rejected by two repo gates
(`tsc` TS6059 against the extension tsconfig's `rootDir`, and
`lint:extensions:no-relative-outside-package`), so the copy is the only
in-policy way to reach the bridge client from a bundled extension.

- `planes/edge/.gitignore` ignores every `vendor/` directory; this extension's own
  `.gitignore` re-includes it (`!vendor/`) so the copies are tracked. The repo's
  oxfmt/oxlint configs also skip `vendor/`, which keeps the copies verbatim.
- Resync after changing the bridge: `node extensions/agenticos-brain/vendor/sync.mts`
- `src/vendor-sync.test.ts` asserts byte-equality with the originals after the
  header, so drift fails the test run.

## Bundled extension note

This extension is intended to ship as a **bundled** OpenClaw extension and be
enabled via `plugins.entries` + tool allowlists. It is not designed to be copied
into `~/.openclaw/extensions` as a standalone plugin directory.

## Approvals (human-in-the-loop)

When the brain pauses a run for approval, `agenticos_brain_turn` returns early with
`details: { pending: true, approval_id, turn_id }` and never auto-approves.

`agenticos_brain_approve` resolves it:

```json
{ "turn_id": "<from the pending result>", "approval_id": "<from the pending result>",
  "decision": "approve" | "deny", "reason": "optional, max 1024 chars" }
```

`approve` resumes the paused run; `deny` ends it as `run.failed("approval denied by operator")`.
The bridge enforces its bearer token, and with the APEX kernel in `required` mode the
approval is bound to the exact pending action on the brain side.

## Kernel risk classification (edge plane)

Risk is assigned by the edge's fixed, audited table
(`src/agents/agent-tools.kernel-authority-risk.ts`), never by this plugin:

| Tool | Class | Risk | Why |
|---|---|---|---|
| `agenticos_brain_turn` | agents | **R1** | a delegation to another kernel-governed plane, like `sessions_spawn`; every tool the brain runs is presented to the same kernel by the bridge |
| `agenticos_brain_approve` | agents | **R2** | resumes a paused consequential tool; a model must never approve its own pause, so a human is required on the edge |

## Opt-in

Both tools are registered `optional`; OpenClaw requires an explicit allowlist entry:

```json
{ "tools": { "alsoAllow": ["agenticos_brain_turn", "agenticos_brain_approve"] } }
```

`bin/agenticos` renders this automatically into `data/edge/openclaw.json`.

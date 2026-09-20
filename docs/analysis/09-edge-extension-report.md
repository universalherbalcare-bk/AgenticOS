# 09 — Edge extension `agenticos-brain` (first edge→brain runtime path)

Date: 2026-09-20. Scope: one OpenClaw tool plugin at
`planes/edge/extensions/agenticos-brain/`. No other path was modified. No git
commit was made. All results below are EXECUTED in this session unless marked
otherwise.

## What was built

Plugin id `agenticos-brain`, one optional tool `agenticos_brain_turn`. It builds a
`TurnRequest`, streams `BrainClient.dispatch(turn, signal)`, and returns the brain's
final output. Shape mirrors `extensions/llm-task` exactly (`defineToolPlugin`,
`tool({...definition, optional, factory})`, `{ content:[{type:"text",text}], details }`).

### Files created (all under `/Users/brijesh/AgenticOS/planes/edge/extensions/agenticos-brain/`)

| File | Purpose |
| --- | --- |
| `index.ts` | `defineToolPlugin` entry; typebox `configSchema` (`additionalProperties:false`): `baseUrl` (string, required, default `http://127.0.0.1:8899`), `authToken` (optional), `timeoutMs` (optional positive int), `defaultTarget` (`{kind: agent\|team\|workflow, id}`). Registers the tool via `factory: ({ api, toolContext }) => createAgenticosBrainTool(...)`. |
| `src/agenticos-brain-tool.ts` | Tool definition + `createAgenticosBrainTool({ api, toolContext, fetchImpl?, env? })`. Params: `text` (required), `target_kind`, `target_id`, `session_id`, `scopes`. Fresh `crypto.randomUUID()` `turn_id` per call; `session_id` = param → `toolContext.sessionId` → SHA-256-derived UUID-shaped id from `toolContext.sessionKey` → fresh UUID; `principal = { user_id: requesterSenderId ?? "edge", channel: "openclaw", scopes ?? ["turns:create"] }`; `trace = newTraceContext()`. Concatenates `output.delta`, collects `tool.started/completed` into `details.tools`, counts `reasoning.delta` chars. `run.completed` → result with `{ turn_id, run_id, usage, tools, reasoning_chars, trace_id }`. `run.failed` → throws `Error` containing the brain error, `retryable=<bool>`, `reason`, and an idempotency hint when the error carries `409`. `approval.required` → returns early `"Approval required: <prompt>"` with `{ approval_id, turn_id, pending: true, tool?, expires_at?, trace_id }`; never auto-approves. Honours the `AbortSignal` (pre-aborted → throws before dispatch; mid-stream → client synthesises `run.failed`, tool throws). Token is never logged. Validates `baseUrl` (http/https), `target_kind` enum, `target_id` ≤ 128 chars (schema maxLength), scopes non-empty strings. |
| `src/agenticos-brain-tool.test.ts` | 16 vitest cases driving the tool with a fake `api` and a mocked `fetch` returning `Response(ReadableStream<SSE>)`. Covers required cases (a)–(f) plus fresh turn_id per call, delta fallback, half-specified target, session_id derivation, scopes, abort (pre and mid-stream), invalid baseUrl, empty text, token-not-logged. |
| `src/agenticos-brain-plugin.test.ts` | 5 cases: entry metadata (one optional tool named `agenticos_brain_turn`), manifest ↔ entry parity, `required:["baseUrl"]` + default + `additionalProperties:false`, real `configSchema.safeParse` applies the default and rejects unknown keys / bad `defaultTarget.kind`, `register(api)` calls `registerTool` once with a factory. |
| `src/vendor-sync.test.ts` | 4 cases asserting `vendor/client.ts` and `vendor/contract.ts` are byte-identical (Buffer.equals) to `bridge/ts/src/*` after a fixed header. Drift fails the run. |
| `vendor/client.ts`, `vendor/contract.ts` | Verbatim copies of `bridge/ts/src/client.ts` / `contract.ts` with a 7-line header ending in a sentinel line. |
| `vendor/sync.mts` | Regenerates the two vendored files; exports the header/strip helpers the test uses. Runs under Node 26 native type stripping: `node extensions/agenticos-brain/vendor/sync.mts`. |
| `.gitignore` | `!vendor/` — required because `planes/edge/.gitignore:63` ignores every `vendor/` directory. Without it the copies would never be committed and the extension would be broken on a clean checkout. Verified: `git check-ignore -v` on the three vendor files now returns exit 1 (not ignored) and `git status --untracked-files=all` lists them. |
| `api.ts` | Re-exports `definePluginEntry`, `AnyAgentTool`, `OpenClawPluginApi`, `OpenClawPluginToolContext` from `openclaw/plugin-sdk/plugin-entry` (llm-task convention). |
| `openclaw.plugin.json` | Manifest: `configSchema` (mirrors index.ts, `required:["baseUrl"]`), `uiHints.authToken.sensitive: true`, `contracts.tools: ["agenticos_brain_turn"]`, `toolMetadata.agenticos_brain_turn.optional: true`. |
| `package.json` | `@openclaw/agenticos-brain` (repo naming guard requires `@openclaw/<id>`), `"openclaw": {"extensions": ["./index.ts"]}`, `typebox 1.3.18`, `@openclaw/plugin-sdk workspace:*`. |
| `tsconfig.json` | `extends ../tsconfig.package-boundary.base.json` (same as llm-task). |
| `assets/icon.png` | 512×512 RGBA PNG (repo's `bundled-plugin-icons` test requires one per bundled plugin). |
| `README.md` | What it is, enable + config example, env fallback, v1 approval behaviour, vendored-files policy. |

## Import strategy: vendored copy (fallback), with proof the relative import fails

Attempt 1 used the relative import `../../../../../bridge/ts/src/client.ts` from
`src/agenticos-brain-tool.ts`. Vitest passed (16/16) but two independent repo gates
rejected it, so it is not usable in this repo:

1. `corepack pnpm exec tsc --noEmit -p extensions/agenticos-brain/tsconfig.json` → **exit 2**
   `error TS6059: File '/Users/brijesh/AgenticOS/bridge/ts/src/client.ts' is not under 'rootDir' '/Users/brijesh/AgenticOS/planes/edge/extensions/agenticos-brain'` (and the same for `contract.ts`). The base tsconfig pins `rootDir: "${configDir}"`.
2. `node --import ./scripts/tsx.mjs scripts/check-extension-plugin-sdk-boundary.mts --mode=relative-outside-package` (the repo's `lint:extensions:no-relative-outside-package` lane) → **exit 1**, 2 violations:
   `Rule: production bundled plugins must not use relative imports that escape their own package root` (resolved `../../bridge/ts/src/client.ts`, `../../bridge/ts/src/contract.ts`).

Attempt 2 (final): verbatim copies in `vendor/` + a byte-equality test, exactly as the
task's fallback prescribes. `vendor/` is already in `.oxfmtrc.jsonc` and `.oxlintrc.json`
ignore lists, so neither formatter nor linter can demand edits to the copies. One trap
found and closed: `planes/edge/.gitignore` also ignores `vendor/` (two differently-shaped
probes agreed: `git check-ignore -v` and `git status --ignored`), so the extension carries
its own `.gitignore` with `!vendor/`; re-checked with both probes after the fix. Resync command:
`node extensions/agenticos-brain/vendor/sync.mts` (verified idempotent: running it
twice produces identical SHA-1s).

## Commands run (final state) and real results

Working directory `/Users/brijesh/AgenticOS/planes/edge`, Node v26.8.1, pnpm 12.3.4, vitest 4.1.11.

| Command | Result |
| --- | --- |
| `corepack pnpm exec vitest run extensions/agenticos-brain --reporter=dot` | **exit 0** — 3 files, **25 passed** (16 tool + 5 plugin-entry + 4 vendor-sync), 0 failed. |
| `corepack pnpm exec tsc --noEmit -p extensions/agenticos-brain/tsconfig.json` | **exit 0** (this is how llm-task's tsconfig is shaped; production sources only, tests excluded by the base config). |
| `corepack pnpm tsgo:extensions` (repo's canonical extension typecheck, `tsconfig.extensions.json`, adds `noUnusedLocals/Parameters`) | **exit 0** (18.5 s incremental; first full run 46.8 s). |
| `corepack pnpm tsgo:extensions:test` (repo's canonical extension *test-file* typecheck, `test/tsconfig/tsconfig.extensions.test.json`) | **exit 0** (15.6 s). Two earlier reds were fixed: a `.mjs` sync script had no types (TS7016) → rewritten as `vendor/sync.mts`; a strict-null `?.safeParse(...)` call in the plugin test (TS2722/TS18048) → guarded. |
| `node scripts/run-oxlint.mjs --tsconfig extensions/tsconfig.json extensions/agenticos-brain` (repo `lint:extensions` lane, scoped) | **exit 0**. Two earlier findings fixed: `unicorn/no-array-reverse` → `toReversed()`; `no-unsafe-optional-chaining` in tests → `toMatchObject`. |
| `corepack pnpm exec oxfmt --check extensions/agenticos-brain` | **exit 0** — "All matched files use the correct format" (7 files). |
| `scripts/check-extension-plugin-sdk-boundary.mts --mode=relative-outside-package` / `src-outside-plugin-sdk` / `normalization-core-bypass` | **exit 0 / 0 / 0**. |
| `corepack pnpm exec vitest run src/plugins/bundled-plugin-naming.test.ts src/plugins/bundled-plugin-icons.test.ts src/plugins/bundled-manifest-contract-plugins.test.ts src/plugins/bundled-plugin-metadata.test.ts` | **exit 0** — 4 files, 43 passed. Caveat: these guards enumerate *git-tracked* manifests, and this extension is untracked, so their pass is weak evidence for this plugin specifically. The colocated `agenticos-brain-plugin.test.ts` covers the manifest/entry invariants directly; `assets/icon.png` was verified out-of-band as a 512×512 RGBA PNG. |
| `node extensions/agenticos-brain/vendor/sync.mts` | exit 0, idempotent (SHA-1 unchanged on second run). |
| Baseline sanity: `corepack pnpm exec vitest run extensions/llm-task/src --reporter=dot` | exit 0 — 28 passed (confirms the reference plugin's harness before mirroring it). |

## Assumptions (labeled)

- ASSUMPTION: `run.completed.output` is the brain's canonical final text; the tool returns it and falls back to the concatenated `output.delta` text only when the final `output` is empty. The success test sends deltas that concatenate to the same string as `output`, so both paths are exercised.
- ASSUMPTION: "stable id derived from the tool call context" = `toolContext.sessionId` when present, else a SHA-256-derived UUID-shaped id from `toolContext.sessionKey`. `OpenClawPluginToolContext` (src/plugins/tool-types.ts) documents `sessionId` as the ephemeral per-conversation UUID and `sessionKey` as the stable key.
- ASSUMPTION: `user_id` comes from `toolContext.requesterSenderId` (documented as the trusted runtime-provided sender id); `"edge"` otherwise.
- ASSUMPTION: the `sensitive` marking for `authToken` lives in `openclaw.plugin.json` `uiHints` because `defineToolPlugin` exposes no `uiHints` passthrough; the code itself never logs or returns the token (test asserts the logger never sees it).
- ASSUMPTION: `options: { stream: true, timeout_ms: <timeoutMs> }` is sent so the brain's own ceiling matches the client's.

## UNVERIFIED / not covered

- **UNVERIFIED: no live bridge was exercised.** Every bridge interaction is against a mocked `fetch` (SSE `ReadableStream` / 409 `Response`). No brain-plane server was started in this session, so end-to-end behaviour against the real Python bridge (auth acceptance, real SSE framing, real 409 semantics) is not proven here.
- **UNVERIFIED: plugin load inside a running OpenClaw gateway.** `plugin.register(api)` was exercised with a fake `api`; the plugin was not enabled in a live gateway config, so runtime discovery/allowlisting was not observed.
- Not covered: `resolveApproval` — deliberately out of v1 scope (documented in README). Pending approvals are surfaced, never resolved, by this tool.
- Not covered: the repo-wide `pnpm check` / full `vitest` matrix was not run (only the lanes that touch extensions plus the four bundled-plugin guard files). `pnpm install` was not run; the new extension has no per-package `node_modules` symlinks yet — tests resolve `typebox` and `openclaw/plugin-sdk/*` via the workspace root and vitest aliases, which is how they passed. A future `pnpm install` will add the symlinks like llm-task's.
- Residual gap (honesty note): the vendor byte-equality check is enforcement-by-test, not a mathematical guarantee — it only fires when the extension test lane runs.

## Verdict

Extension builds, typechecks under both the per-extension `tsc` and the repo's canonical `tsgo:extensions` / `tsgo:extensions:test` lanes, lints and formats clean, passes all three extension-boundary guards, and passes 25/25 colocated tests. Ready for review and commit; **not** live-verified against a running brain plane.

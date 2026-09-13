# Capability Decision Matrix

**This is the R2 deliverable**: for every capability both systems implement, which one survives
in AgenticOS, which one is deleted, and the evidence for the call.

Produced by six parallel master-level domain specialists reading both source trees, plus executed
measurements taken in the main thread. Every row was decided on read code or run code — not on
README claims. Where a specialist could not verify something, it is marked UNVERIFIED and no
deletion was authorised on it.

**Scoring rule:** the winner's implementation becomes the only one in the merged OS. Superior
sub-features of the loser are salvaged (ported) before its duplicate is deleted. A tie was treated
as an analysis failure and re-adjudicated.

**Headline:** counting the winner column of the tables below, the edge (OpenClaw) implementation wins
**23 rows** and the brain (Agno) implementation wins **14**. Neither system is a subset of the other,
which is the empirical justification for a two-plane architecture rather than a rewrite.

> *Correction (adversarial review):* an earlier version of this line claimed "OpenClaw wins 14, Agno
> wins 11". That tally was asserted rather than derived and reconciled with nothing in the tables. The
> figures above are counted directly from the winner column.

---

## 1. Model / provider layer — **EDGE (OpenClaw) wins**

| Capability | Agno | OpenClaw | Winner | Evidence |
|---|---|---|---|---|
| Provider count | 64 registry rows / ~52 vendors | 54 extensions / 73 provider ids | ~tie in count | `models/utils.py` vs `openclaw.plugin.json` |
| Provider *kind* | 1 Python class per vendor; ~30 are 40–45-line `OpenAILike` base-URL shims | 8 wire-protocol adapters + declarative priced manifests | **OpenClaw** | `tuning_engines.py` is 45 lines total |
| Cost / context catalog | **none** — grep for pricing/context_window across `agno/models/` returns zero | tiered pricing, 7 sources w/ authority flags, SSRF-guarded 6h refresh | **OpenClaw** | `model-catalog-pricing.ts` |
| Retry | blocking `sleep()`, no jitter, ignores `Retry-After`, `retries` defaults to **0** | honours + caps `Retry-After`, directional jitter | **OpenClaw** | `packages/retry/src/index.ts` |
| Circuit breaking | **none** (grep "circuit" → unrelated comments only) | cooldown + half-open probe slots, TTL/LRU | **OpenClaw** | — |
| Tool-call repair | none | 5,749-line package promoting leaked text/XML tool calls mid-stream | **OpenClaw** | `packages/tool-call-repair` |
| Error classification | 3 classes, 13 substrings | 16 frozen reason codes + 8,631-line classifier + regression corpus | **OpenClaw** | `src/agents/failover/` |
| Cancellation | none at model layer | `AbortSignal` throughout | **OpenClaw** | — |
| Local token counting | tiktoken/HF + image-tile math | provider-reported only; can report `contextUsage: unavailable` | **Agno — SALVAGE** | `utils/tokens.py` |
| Per-error-class fallback | `on_rate_limit` / `on_context_overflow` / `on_error` chains | 16 reasons funnel into ONE ordered list | **Agno — SALVAGE** | `models/fallback.py` |

## 2. Agent runtime — **SPLIT along a mechanism/semantics line**

| Capability | Agno | OpenClaw | Winner |
|---|---|---|---|
| Agent loop | **no agent loop** — tool cycle lives inside the *provider adapter*, triplicated at `models/base.py:700/924/1415`, no abort, no injection | 1,667-line two-level state machine: mid-run steering, 6 abort checkpoints, typed handoff-vs-interrupt, per-tool sequential/parallel | **OpenClaw** |
| Reasoning | full package: `ReasoningStep{title,action,result,reasoning,next_action,confidence}`, 11 provider-native modules, streamed events, think()/analyze() scratchpad | entire `reasoning.ts` is **39 lines** mapping a thinking level to a provider option | **Agno, decisively** |
| Teams | 4 typed coordination modes incl. autonomous `tasks` with dependency-carrying shared TaskList | swarm lanes, ~60-file subagent registry w/ restart recovery, ACP | **Agno** (semantics) + **OpenClaw** (execution) — complementary |
| Workflows | Step/Steps/Loop/Parallel/Condition/Router, CEL expressions, nesting, per-step retries, persisted pause/resume | `task-flow-registry` is a status ledger; `currentStep` is opaque free text | **Agno, no contest** |
| Session / context | 3-run window + summary | session DAG (11 entry types), token-budget compaction w/ cut-point + tool-result-pair repair, pluggable `ContextEngine` SPI | **OpenClaw, decisively** |
| HITL | durable `RunRequirement` pause/resume, `@approval`, `HumanReview` workflow nodes, **input-content guardrails** | 8-bucket risk classifier, permission relay, approval timeouts; **no input-content guardrails found** | **Agno** (state model) + **OpenClaw** (transport) |
| Run-level retry / max-steps | present | **absent** (no `maxSteps`/`maxTurns` in the loop) | **Agno — SALVAGE into AgentLoopConfig** |

## 3. Knowledge / memory / persistence — **SPLIT 3–2 to BRAIN**

| Capability | Agno | OpenClaw | Winner |
|---|---|---|---|
| Vector stores | **20 backends** behind one ABC (**18 in the merged tree** — `langchaindb` and `llamaindex` deleted) | 2 (builtin sqlite-vec + optional LanceDB plugin) | **Agno** |
| Ingestion | 23 readers, 8 chunkers, 18 embedders, 5 remote loaders (S3/GCS/Azure/SharePoint/GitHub) | markdown + transcripts + image/audio via one line-window chunker | **Agno** |
| Incremental / caching | — | per-source hash/mtime/size + embedding cache keyed (provider,model,key,hash) | **OpenClaw — SALVAGE** |
| Retrieval | whatever each backend's SQL does; **no cross-backend fusion stage** | weighted fusion → temporal decay → importance → project boost → exact-path tiers → MMR → threshold w/ lexical fallback, `path#L12-L40` citations | **OpenClaw** |
| Reranking | 4 cross-encoder rerankers + `FilterExpr` DSL | — | **Agno — SALVAGE** |
| Memory | **user memory has NO vector retrieval** — only `last_n`, `first_n`, and an `agentic` mode that loads *every* memory and asks an LLM to pick ids | recall telemetry → scored short/long-term promotion, 3-phase dreaming consolidation w/ fail-closed loss guard, standing intents, provenance/tombstones, circuit-broken auto-recall | **OpenClaw, decisively** |
| Persistence | 14 backends + versioned migration manager | SQLite only (well hardened: leases, WAL, integrity-before-mutation) | **Agno** (portability); salvage OpenClaw's SQLite hardening |

## 4. Edge layer — **EDGE wins 4 of 5**

| Capability | Agno | OpenClaw | Winner |
|---|---|---|---|
| Channels | **3 served + 1 detached script** (Discord bot never mounted; `os/interfaces/__init__.py` is 0 bytes). All webhook-only → iMessage/Signal structurally impossible | **27 bundled channels** (~430k LOC), webhook + Socket Mode + polling + local daemons | **OpenClaw, decisively** |
| Gateway | in-process dict WS singletons that silently break under `workers>1`; no backpressure | supervised daemon, WS-RPC gateway, node hosts, container-per-tenant fleet cells, real slow-consumer backpressure, backoff reconnect | **OpenClaw** |
| API surface | 110 paths / 149 decorators (README's "50+" is understated) but exactly **one** WS endpoint, workflow-only | 415 typed WS-RPC methods from one canonical policy table | **OpenClaw** on scale; **Agno** on REST idiom (kept as facade) |
| Clients | Python SDK only — no CLI, no TUI, no web UI | CLI + TUI + web control UI + 4 native apps (macOS/iOS/Android/Linux) | **OpenClaw** |
| Edge auth | **per-resource + wildcard RBAC** (`agents:<id>:run`, `agents:*:run`), JWT middleware, service-account PATs | closed set of 8 coarse operator scopes; "access groups" solve a *different* problem (channel-sender allowlists) | **Agno — its clearest win** |
| Cross-replica replay | `event_streams/redis.py` — writer-generation Lua fence, explicit monotonic-not-gapless contract | no replica-agnostic replay equivalent | **Agno — SALVAGE (best code on the losing side)** |

## 5. Tools / sandbox / security — **EDGE wins all but breadth**

| Capability | Agno | OpenClaw | Winner |
|---|---|---|---|
| Toolkit breadth | **152 `Toolkit` subclasses** (vendor catalog) | ~57 built-in tool ids + 151 extensions (only ~26 declare tools); breadth comes from MCP + skills | **Agno** |
| Execution sandbox | **none, by its own admission** — `tools/shell.py:20` calls itself "an RCE sink if the agent is prompt-injected"; `code_mode.py:9` "not a sandbox and does not pretend to be one" | `--read-only`, `--cap-drop`, `no-new-privileges`, seccomp/AppArmor, pids/mem/cpu caps; blocks `/etc /proc /sys /dev /var/run/docker.sock`, `~/.ssh ~/.aws ~/.gnupg`, `network: host`, `seccomp=unconfined` at 3 layers | **OpenClaw, decisively** |
| SSRF defence | **zero** (grep `169.254|ssrf` → one unrelated comment) | DNS-pinned guard + cloud-metadata denylist | **OpenClaw — sharpest security gap** |
| Browser | `browserbase.py`, 4 tools | own CDP stack, 24 actions, 14 `act` kinds, ARIA/AI snapshots, profiles, 3 targets incl. Chrome+noVNC container | **OpenClaw** |
| Skills | 5 files, a directory loader | 8 subsystems + 1,038-line scanner w/ 15 rules (dangerous-exec, crypto-mining, prompt-injection, secret-exfiltration), ClawHub install w/ sha256 + lockfile + trust | **OpenClaw** |
| Path safety | `fs/local.py:_safe_join` rejects any path normalization would *alter* (fullwidth dots, NFKC) | weaker equivalent | **Agno — SALVAGE** |
| PII guardrail | `guardrails/pii.py` | absent | **Agno — SALVAGE** |

## 6. Platform services — **SPLIT**

| Capability | Agno | OpenClaw | Winner |
|---|---|---|---|
| MCP **server** | FastMCP Streamable-HTTP at `/mcp` + full **OAuth 2.1 authorization server** (PKCE S256, DCR, hashed codes, refresh rotation w/ family reuse detection, consent page) | stdio + bearer-on-127.0.0.1 loopback | **Agno** |
| MCP **client** | absent | 3 transports w/ mTLS/toolFilter/timeout, OAuth client w/ per-requester identity, MCP Apps UI resources | **OpenClaw** |
| Scheduling | genuinely distributed: `UPDATE…RETURNING` over `SELECT…FOR UPDATE SKIP LOCKED` + stale-lock reclaim across 6 DB backends; durable queue w/ heartbeat, sweep recovery, idempotency keys | single-node (no lease/distributed primitives found) but better *semantics*: 5 schedule kinds, Croner DST, jitter, retry classifier | **Agno** (mechanism) + **OpenClaw** (semantics) |
| Observability | 571 lines writing spans to its own DB; 18-line `debug.py`; no audit store | OTLP traces+metrics+logs, W3C/B3/Jaeger propagators, correct `gen_ai.*` conventions, 1,148-line Prometheus exporter, ~120-file logging w/ redaction, pseudonymised audit ledger | **OpenClaw, decisively** |
| Eval / QA | programmable DB-persisted eval API (`eval/` + `scorer/`, ~3.3k lines) | `auto-qa`/`autoreview`/`claw-score` are **agent skills (markdown), not runtime libraries**; real asset is the executable YAML scenario pack + coverage taxonomy | **Agno, narrowly** (+ salvage the scenario pack) |
| Config | 54-line `BaseSettings`, **no file loader at all** | 253 modules, JSON5 + `$include` layering, fail-closed `${VAR}`, generated JSON Schema, secret refs, hot reload | **OpenClaw** |
| Build / CI | 7 workflows | 101 workflows, oxlint/oxfmt/tsdown/vitest/tsgo + ~20 architecture ratchets | **OpenClaw** for TS; keep Agno's for Python |
| Dependency hygiene | — | 7-day `minimumReleaseAge` cooldown, strict, w/ dated justified exclusions | **OpenClaw** |

---

## The two hard integration problems (named, not hidden) — decided 2026-09-13

Both were recorded here as "unimplemented by design" until 2026-09-13. Each now has a dated,
ADR-style decision below, enforced in `bridge/py` and proven by executed tests. The original
problem statements are kept verbatim so the reasoning can be audited.

1. **Double tool loop.** Plugging an Agno `Model` into OpenClaw's `agentLoop` yields two nested tool
   loops, one invisible. Agno's provider-level loop must be deleted and its adapters reduced to the
   edge `StreamFn` contract. *(Original framing. Superseded by ADR REQ-0041 below: the loop is not
   deleted, it is made the ONLY loop for a turn.v1 turn, and the bridge owns its pause/resume.)*
2. **Pause-the-run vs block-the-tool.** Agno unwinds and persists a paused run; OpenClaw blocks
   inside `beforeToolCall` with a timeout. Neither can express the other. Fix: `AgentToolResult`
   needs a third disposition — `suspend`, carrying a `RunRequirement` — so one tool contract can
   either await (interactive) or unwind and persist (durable). *(Original framing. Superseded by ADR
   REQ-0042 below, which defines both words across planes and implements them at the bridge.)*

### ADR REQ-0041 — One owner of tool execution across the bridge (2026-09-13)

**Status:** accepted, enforced in `bridge/py/agenticos_bridge/server.py`, proven by
`tests/e2e/test_tool_owner.py` (real `agno.agent.Agent`, real confirmation-gated tool, scripted
model; shim kernel and the real APEX kernel).

**Decision.** For every turn.v1 turn the **brain executor's own Agno loop is the single owner of
tool execution**. The bridge never executes a tool and the edge never executes one on the brain's
behalf. What the bridge owns is the *pause*: every confirmation-gated tool call surfaces as a
`RunPaused` frame, the kernel (mode `required`) or the bridge's operator gate (mode `native`)
decides, and on approval the bridge **resumes the same run** (`executor.acontinue_run(run_id,
requirements=[confirmed...])`) so the tool executes exactly once, inside the brain loop, after the
kernel's consume. A denial or timeout never resumes the run.

**Alternatives considered.**

| Option | Verdict | Why |
|---|---|---|
| A. Edge owns: the brain surfaces every tool call and never executes; the edge runs it and feeds the result back | rejected | turn.v1 has no tool-result inbound (`TurnRequest.input` is `{text, attachments}` with `additionalProperties:false`); every brain toolkit would have to be re-declared as an edge tool, and Agno's loop would need `external_execution` on every function plus a resume-with-results path. Two registries of the same tools is the duplication R2 exists to remove. |
| B. Both loops: the edge wraps the bridge as a model provider and runs its own tool loop over the brain's output | rejected | Exactly the double-loop hazard: two places can execute, one of them invisible to the kernel. |
| C. Brain owns, bridge resumes (chosen) | accepted | One loop, one governance point (the pause), no contract change for tools. The only new bridge responsibility is resumption, which the runtime already exposes. |

**Enforcement (each with a test).**
1. *Illegal state unrepresentable:* a request carrying `tools` or `input.tool_results` is rejected at
   the boundary (422) — the edge has no channel through which to make the brain run *its* tools.
2. *Refused at registration:* Agno resumes a paused run by re-loading it from the executor's `db`;
   without one `acontinue_run` raises `RunNotFoundError` (verified against the installed package).
   `BrainBridge` refuses to register an executor that has confirmation-gated tools and no `db`, so an
   approval can never silently become a no-op in production.
3. *Resume, not fall through:* after approval the bridge drains the paused stream (Agno persists the
   paused run's tool-call state AFTER yielding `RunPaused`), confirms every requirement of the frame,
   and continues the same run streaming. Kernel log order for one governed tool is exactly
   `decide → resolve(approve) → decide(consume) → finish(succeeded)`, and the side-effect list has
   one entry.
4. *No silent completion:* a resumable executor that pauses without confirmable requirements and then
   ends is reported as `run.failed` / `pause_not_resumable`, never as `run.completed` with empty output.

**What the runtime cannot enforce (stated, not hidden).** The bridge governs turns that cross the
bridge. Agno's own AgentOS routes (`/agents/{id}/runs`, `/runs/{id}/continue`) remain a second way to
execute a brain tool if they are reachable; that is a deployment boundary (the bridge is the ONE
endpoint the edge may call), not something `bridge/py` can close. A blocked run's row stays `paused`
in the brain's store; the kernel record for it is revoked, so an out-of-band continue would run the
tool without a kernel decision — the same residual, named once here.

### ADR REQ-0042 — Pause vs block across planes (2026-09-13)

**Status:** accepted, enforced in `bridge/py/agenticos_bridge/server.py` and the contract
(`bridge/contract/turn.schema.json` v1, additive fields), proven by
`tests/e2e/test_pause_vs_block.py` (shim kernel and the real APEX kernel).

**Definitions.**

| Word | Meaning across planes | On the wire |
|---|---|---|
| **PAUSE** | The run is waiting for a decision **with a TTL** and resumes on approve. The TTL is the turn's `options.timeout_ms`, capped by the kernel record's own `expires_at` (5-minute TTL) in `required` mode, so the bridge never waits for an answer the kernel could no longer resolve. | `approval.required` now carries `expires_at` (RFC 3339). An approve inside the TTL resumes the run exactly once (`resolve` is called once). |
| **BLOCK** | The tool call is refused and the run **ends**. A timeout is a block. | `run.failed` with `retryable=false` and a `reason` from the closed set `approval_timed_out`, `approval_denied`, `kernel_denied`, `kernel_unreachable`, `pause_not_resumable` (`BLOCK_REASONS`). Non-block failures use `executor_error`, `client_disconnected`, `cancelled`. |

**The Phase 4 P2 gap, closed.** A bridge-side timeout in `required` mode used to leave the kernel's
pending record to lapse by TTL ("a deliberate simplification"). Now, on timeout, the bridge calls the
kernel's `resolve` with `approve=false` for **every** record proposed for the frame — the exact
pending action (same plane, tool, risk, principal, args) — *before* emitting the terminal event, so
the kernel ledger records the operator's silence as `revoked` (`user_revoked`), not `expired`.
Against the real kernel, consuming the id afterwards is refused with `record_status: "revoked"`.

**Why "the run ends" rather than "the run continues with the tool refused".** Continuing would mean
resuming the run with the requirement rejected, which re-invokes the model (a paid request) to
narrate a refusal the operator already saw, and would present the model's afterword as the turn's
output. Ending the run with a machine-readable reason keeps the block visible in the channel and
leaves the choice to retry with the edge. The edge's `isBlocked(ev)` distinguishes a block from a
retryable failure. Client-synthesised `run.failed` events (transport errors in `client.ts`) carry no
`reason`; the field is optional and additive, and both parity tests assert the enum and property
sets match the schema.

## Cross-cutting hazards flagged by the team

- **Token counting must not be forked** between runtimes — divergent estimates silently corrupt compaction.
- **Identity mapping** between Agno's inward scoped principal and OpenClaw's outward `shared`/`per-requester`
  identity is a genuine privilege-crossing bug if left unmapped, not a cosmetic duplication.
- **Agno's multi-tenancy is fail-open**: its own docstring says omitting row-scoping "will silently
  bypass user isolation with no runtime error". The merged OS must not rely on it alone.
- Agno hard-defaults every agent to OpenAI at construction (`agent/_init.py:88`) — **fixed** in this
  session by `DeterministicModel`, a zero-dependency provider-neutral default.

## Corrections the team made to the brief (recorded for honesty)

- **QQ and WeChat exist in neither codebase.** They were named speculatively in my brief; no code found.
- `agno/environments/` is an **eval/rollout harness**, not a sandbox.
- OpenClaw's `src/tools/` is a single `types.ts`; the real tool surface is `src/agents/tools/` (298 files).
- My own runtime probe measured **72 paths / 113 operations** on a *minimal* AgentOS (one agent, no DB);
  static analysis of all routers counts **110 paths / 149 decorators**. Both are correct at their own
  measurement basis; conditional routers mount only when a DB is configured. Neither figure is retracted.

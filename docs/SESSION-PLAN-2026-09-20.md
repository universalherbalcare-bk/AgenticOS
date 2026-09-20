# Session plan — 2026-09-20 — Orchestrate & wire to real backends

## Raw intent → requirements
> "COMPILE AND ORCHESTRATE EVERYTHING YOU WERE BUILD IN THIS SESSION. WIRE EACH PARTICULAR
> FEATURE/FUNCTION/SYSTEM WITH ITS RELEVANT BACKEND DATA. DO NOT HALLUCINATE. AVOID BOTTLENECK."

| ID | Requirement | Evidence of the gap (DIRECT OBSERVATION, this session) |
|---|---|---|
| R1 | One orchestrated system, not parts | `bin/agenticos doctor` is **red 2/6** in the moved repo: it resolves `$HOME/.venv` (a foreign venv) instead of the repo `.venv`; `agenticos_bridge` not on its path |
| R2 | Every feature wired to its real backend data | `agenticos brain` boots `tests/e2e/brain_server.py` — hardcoded `DeterministicModel` executors, **no db**, bare `FastAPI` (not the 72-path AgentOS control plane). `agenticos.config.yaml` `brain.executors` is empty lists that **nothing reads**. **Zero** edge→brain dispatch exists inside `planes/edge` (`BrainClient` is used only by a test). No trace propagation into Agno runs |
| R3 | No hallucination | every claim below carries an evidence class; nothing asserted that was not run |
| R4 | No bottlenecks | `IdempotencyStore` is in-memory → correct only in one process; `agenticos` has no concurrent boot; bridge and control plane are two servers |

## Workstreams
| WS | Deliverable | Owner | Depends on |
|---|---|---|---|
| W1 | `planes/brain/agenticos_brain/` — real brain server: config loader (fail-closed `${VAR}`), executor factory from `brain.executors` with a **real SQLite db** per executor (REQ-0041), provider-neutral model resolver, **AgentOS app + bridge router on ONE app**, trace_id → run metadata | main | — |
| W2 | `bridge/py/agenticos_bridge/idempotency_sqlite.py` — durable, multi-process-safe store (WAL, atomic INSERT claim); selected by `bridge.idempotency` config | main | — |
| W3 | `planes/edge/extensions/agenticos-brain/` — OpenClaw tool plugin that dispatches a turn to the brain via `bridge/ts/src/client.ts`; the first runtime edge→brain path | subagent | — |
| W4 | `bin/agenticos` — repo-local venv only; `brain` boots W1; `up` boots both planes **concurrently** with parallel health-wait; `turn` CLI smoke; `verify` covers W1–W3 | main | W1 |
| W5 | Tests for W1–W4 (config fail-closed, factory+db, cross-process idempotency, one-app OpenAPI, trace propagation, extension unit, `up` smoke) | main + subagent | W1–W4 |
| W6 | CI job, docs, corrections ledger | main | all |

## Assumptions (labelled)
- ASSUMPTION: SQLite is the default durable store for a single host; Postgres remains a config switch via Agno's `db` backends. Stated in config.
- ASSUMPTION: the deterministic model remains the default executor model because no provider keys exist here; live inference stays **UNVERIFIED**.
- CONSTRAINT: `~/APEX-OS` is a separate project; it is consulted (kernel authority binary) but never edited.

## Done criteria
`agenticos doctor` green from a clean shell · `agenticos up` boots both planes concurrently and a `turn` crosses edge→brain→edge against **config-defined** executors with a **real db** · idempotency holds across two worker processes · all gates green · zero regressions vs baseline.

## Outcome (executed 2026-09-20)

| WS | Status | Evidence |
|---|---|---|
| W1 brain server | **VERIFIED COMPLETE** | `python -m agenticos_brain` boots 5 config-defined, db-backed executors on ONE app (75 paths/116 ops); `tests/brain` 30/30 |
| W2 durable idempotency | **VERIFIED COMPLETE** | two live workers: 20 identical turns → 1×200/19×409; 4 processes×25 claims → 1 winner |
| W3 edge→brain extension | **VERIFIED COMPLETE** | 25/25 unit tests; real gateway lists it, loads it (`2 plugins: agenticos-brain, …`), and `tools.invoke` reaches the brain |
| W4 CLI | **VERIFIED COMPLETE** | `doctor` green (12 checks), `up` boots both planes concurrently, `turn` crosses for agent/team/workflow, `verify` 8/8 |
| W5 tests | **VERIFIED COMPLETE** | 7 + 30 + 81 + 25 + 6 tests + gateway E2E; two mutation checks proved the wiring tests can fail |
| W6 CI/docs | **COMPLETE BUT NOT FULLY VERIFIED** | ci.yml updated and every step executed locally; not run on a hosted runner in this session |

Live LLM inference: **UNVERIFIED** (no provider keys). Gate 8 invokes the tool directly through the
gateway RPC, so the plane-to-plane path is proven while an LLM-initiated call is not.

## Second pass (same day) — required-things closure
Gates: **9/9 from a clean environment.** Added: secure-by-default bridge token; auth-before-body;
config-driven kernel governance (`required`, fail-closed); real-kernel tests un-skipped (87/87);
`agenticos_brain_approve`; brain tools classified R1/R2 in the audited edge risk table; deterministic
stub model + gate 9 proving the LLM-initiated loop; lockfile regenerated (`--frozen-lockfile` green);
port-collision detection that names the foreign owner. Open: hosted CI (no remote — needs operator
confirmation to publish), live-provider inference.

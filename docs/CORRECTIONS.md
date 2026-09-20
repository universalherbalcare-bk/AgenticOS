# Corrections forced by review

An adversarial reviewer (told to break the system) and an independent verifier (told to trust nothing and
re-run every number) were run against this tree after it was first declared ready. Both found real
defects. This file records what was wrong, what changed, and what is still open — including the defects
that were in code the author had described as "fail closed".

## Defects fixed, each with a regression test

| # | Defect | Severity | Fix | Test that locks it in |
|---|---|---|---|---|
| 1 | **Approval gate was fail-OPEN.** A denied or timed-out approval emitted `run.failed` and then let the provider stream continue, executing the very tool the operator refused — and emitted **two** terminal events, violating the contract. Reproduced: a denial was followed by `tool.started wire_money` and the side effect `WIRED $1,000,000`. | CRITICAL | `_handle_pause` now reports its outcome; the caller stops consuming and calls `aclose()` on the provider stream, so the pending tool never runs. Exactly one terminal event. | `tests/e2e/test_approval_gate.py` (4 tests, incl. asserting the side-effect list is empty and that an *approved* call still runs) |
| 2 | **The import half of the deletion gate verified nothing.** `bin/agenticos` invoked it with the system `python3`, which has no `pydantic`; every `import agno.*` failed with a non-`agno` `ModuleNotFoundError`, which the loop deliberately ignored. It printed "193 packages import cleanly" having imported **zero**. | HIGH | The script now REFUSES (exit 2) on an interpreter that cannot import `agno.agent`, refuses to pass if zero packages imported, and reports the real count. The CLI passes the venv interpreter. | Precondition check + honest counter in `scripts_audit_dangling_refs.py`; verified to refuse on system python and report **149/193** on the venv |
| 3 | **Every brain-plane failure reached the edge as the literal string `"RunError"`.** `RunErrorEvent` has no `.error` attribute (it carries `.content`); `RunCancelledEvent` uses `.reason`. All diagnostics were destroyed on 100% of failures. | HIGH | `_error_text()` reads `error`/`content`/`reason`/`message`/`detail` in order. | covered by the bridge suite's failure paths |
| 4 | **The TypeScript contract had no parity enforcement.** The README claimed both planes' types were checked against the schema; only Python had a test. Corrupting `isTerminal` so `run.failed` was not terminal — which hangs the client on every failed turn — still passed `agenticos verify`. | HIGH | Added `bridge/ts/src/contract.parity.test.ts` plus compile-time exhaustiveness assertions, and wired both the test and `tsc --strict` into `agenticos verify` and CI. | `contract.parity.test.ts` (5 tests); proven to fail on exactly that corruption, then restored byte-identical |
| 5 | **58 broken example files.** The audit scanned only `libs/agno`, so `planes/brain/cookbook/` kept 58 files importing deleted modules (`from agno.models.litellm import LiteLLM` → `ModuleNotFoundError`). | HIGH | Audit widened to the whole brain plane (now 4,649 `.py` files). The 58 orphaned examples and 9 emptied example directories were removed. | gate reports the scanned file count |
| 6 | **A transitive orphan hid behind `--continue-on-collection-errors`.** `test_slack_bot_filtering.py` imported a `conftest.py` that was itself removed as an orphan — a hard collection error. | MEDIUM | Removed (it tested the deleted Slack interface). The gate now detects any test importing a non-existent sibling module. | new check in `scripts_audit_dangling_refs.py` |
| 7 | **`/v1/bridge/health` leaked the executor registry to anonymous callers** — the names of every runnable agent, team and workflow. | MEDIUM | Liveness stays public; the inventory requires authentication when a token is configured. | 2 tests in `tests/e2e/test_bridge_e2e.py` |
| 8 | **The CI brain job could never pass.** It asserted `pytest` exits 0 on a plane that inherits ~277 upstream failures needing API keys and vendor SDKs — a job that is always red trains everyone to ignore it. | MEDIUM | Replaced with a real regression gate: assert the failing-test-id set is a **subset** of a recorded pristine baseline. | `scripts/check-no-regressions.py` + `tests/known-failing-baseline.txt`; proven to pass on the real run and to fail on an injected regression |
| 9 | **`docs/deletion-receipt.tsv` was stale**, contradicting `deletions.tsv` on 11 paths after modules were restored and deferred. | LOW | Deleted; `deletions.tsv` + `check-deletion-ledger.py` are authoritative and now gate on tree/ledger agreement. | `scripts/check-deletion-ledger.py` |

## Overclaims corrected in the documentation

| Claim as written | Reality | Where fixed |
|---|---|---|
| "193/193 packages import cleanly" | **149/193** import; 44 fail on uninstalled optional SDKs (same in pristine). The gate that produced "193" had imported nothing. | README, DELETION-LEDGER |
| "20 vector stores" (brain advantage) | 20 in **pristine**; the merge itself deleted `langchaindb` and `llamaindex`, so the merged tree has **18**. Quoting the pre-merge number was wrong. | DECISION-MATRIX |
| "OpenClaw wins 14 areas, Agno wins 11" | Asserted, not derived, and reconciles with nothing in the tables. Counted from the winner column: **edge 23, brain 14**. | DECISION-MATRIX |
| "4,653 passed" presented bare | True, but omitted the 56 failures and 184 errors in the same run. Full-suite figures now carry failures and errors alongside. | README |
| "0 dangling refs" | True only for `libs/agno`; `cookbook/` had 58. Now genuinely 0 across the whole plane. | README, DELETION-LEDGER |

## What survived the attack unchanged

- **The deletion audit itself.** 23/23 deleted paths absent and present in pristine; 11/11 deferred paths present; every removed test file genuinely referenced a deleted module — zero collateral.
- **"Zero regressions vs pristine control" — UPHELD**, and tested harder than asked: the verifier diffed failing-test-id sets on both the 8-directory slice and the full `tests/unit` tree, confirming per-tree `agno.__file__` so the control could not silently import the merged package. Empty diff in both directions.
- Idempotency under concurrency (8 simultaneous identical `turn_id` → one 200, seven 409s).
- `parseSse` reassembles frames fed one byte at a time across multi-byte UTF-8 boundaries.
- `72 paths / 113 operations`, `14 DB backends`, `23 readers`, and the licence claims all re-derived exactly.

## Open, not fixed

- **Repo has no commits and `planes/` is untracked**, so `actions/checkout` would produce a tree with no planes and gitleaks scans nothing under `planes/`. CI is therefore **scaffolded and locally executed, but never run on a real runner**. Committing 45k files was out of scope for this session; this is the single largest gap between "gates exist" and "gates enforce".
- One edge figure is **disputed**: the merge author reproduced `54 files / 1,037 tests` twice with caches cleared; the verifier observed `48 / 915` for the same selection. The discrepancy is unresolved — most likely vitest project selection or cache state. Both observations are recorded rather than one being quietly chosen.
- ~~Deferred items in `DELETION-LEDGER.md` remain deferred; the two hard integration problems named in `DECISION-MATRIX.md` (double tool loop, pause-vs-block) are unimplemented by design.~~ **Closed 2026-09-13:** every deferred item is resolved (KEEP, re-measured consumers, gated by `scripts/check-deletion-ledger.py`), and both integration problems have accepted ADRs (REQ-0041, REQ-0042) enforced in `bridge/py` with executed tests, including against the real APEX kernel. A further defect found on the way: with a real Agno agent the bridge never resumed an approved pause (`acontinue_run` was never called), so an approved tool would not have run at all — the fake executors in the older tests continued their own generator and hid it. Fixed by the REQ-0041 resumption path; `tests/e2e/test_tool_owner.py` drives a real agent.

---

## 2026-09-20 — defects found while orchestrating and wiring to real backends

Found by direct observation in the moved repository, before any new code was written. Each was a
gap between "the pieces exist" and "the pieces are wired".

| # | Defect | Severity | Fix | Proof |
|---|---|---|---|---|
| 10 | **The launcher resolved a foreign interpreter.** `bin/agenticos` looked one directory *above* the repo for `.venv` — a scratch-era path that, after the move to `$HOME/AgenticOS`, resolved to `$HOME/.venv`: another project's Python. `doctor` was red 2/6. A project-boundary violation, not a fallback. | HIGH | Repo-local `.venv` only, else `AGENTICOS_PYTHON`, else refuse. | `doctor` shows the interpreter path; green 12/12 |
| 11 | **`agenticos brain` booted a test fixture.** `tests/e2e/brain_server.py`: hard-coded deterministic executors, **no db**, bare `FastAPI` — the 72-path AgentOS control plane was never served. `agenticos.config.yaml`'s `brain.executors` were empty lists that nothing read. | HIGH | `planes/brain/agenticos_brain/`: fail-closed config loader → executor factory with a real `SqliteDb` (REQ-0041) → AgentOS app **and** bridge on one FastAPI. | 75 paths / 116 ops; `/agents` and `/v1/bridge/health` list identical ids; `tests/brain` 30/30 |
| 12 | **No runtime path from edge to brain.** `BrainClient` existed but was used only by a test; the gateway had no way to reach the brain. | HIGH | `extensions/agenticos-brain` tool plugin; rendered `data/edge/openclaw.json` enables it and points it at the brain. | gate 8: `gateway call tools.invoke` → plugin → brain → SQLite, `run_id`/`trace_id` matched in the db |
| 13 | **Edge plane was unbuilt.** `openclaw --version` passes via a fast path, but every real command needs `dist/`; `gateway` could not start. | MEDIUM | `agenticos install` runs `pnpm build`; `doctor` checks for `dist/entry.*`. | `up` → `[gateway] ready` |
| 14 | **Turn idempotency was single-process.** In-memory store; a redelivered turn landing on a second uvicorn worker would execute twice. | MEDIUM | `SqliteIdempotencyStore` (atomic `INSERT` claim, WAL, TTL sweep), selected by `bridge.idempotency: sqlite`. | 2 live workers: 20 identical turns → 1×200/19×409; 4 processes × 25 claims → exactly 1 winner |
| 15 | **No trace continuity into the brain.** The edge-minted W3C ids stopped at the bridge; persisted runs carried no `trace_id`. | MEDIUM | `arun(metadata={trace_id, parent_span_id, channel, turn_id})`. | gate 8 asserts the persisted metadata equals the gateway response; mutation of this line fails `tests/brain` |
| 16 | **Gate 7 first went red for the right reason.** The new fail-closed loader refused to start the brain because the gate did not set `${AGENTICOS_VERIFY_DB}`. | LOW | The gate's env was fixed; the loader was not weakened. | `verify` 8/8 |
| 17 | **Gateway teardown leaked processes.** The gateway re-execs itself as a detached `openclaw-gateway`, so signalling the spawned child left the listener alive and a rerun hit `EADDRINUSE`; `rm -rf` also raced its still-writing asset builder and turned a genuine PASS into exit 1. | LOW | Port-based teardown on our own isolated ports, wait-then-remove with bounded retry, verdict decided before cleanup. | two consecutive clean runs, both ports free afterwards |

### Corrected in the documentation
- README quick start described `agenticos brain` as "run the brain plane"; it ran a fixture. Replaced with the wiring diagram and a feature→backend→proof table.
- `docs/deletions.tsv` ledger check now reports each deferred entry "with a dated KEEP resolution" (from a later session) — left as is; consistent with tree.

### Still open
- Live LLM inference through the gateway (an LLM *choosing* to call `agenticos_brain_turn`) — **UNVERIFIED**, no provider keys in this environment.
- `AGENTICOS_BRIDGE_TOKEN` unset in local dev ⇒ the bridge is unauthenticated **by config** and says so at startup; production must set it (fail-closed for every other `${VAR}`).
- CI workflow updated and every step executed locally; not observed on a hosted runner this session.
- One edge test figure from 2026-09-06 (54/1037 vs 48/915) remains recorded both ways.

---

## 2026-09-20 (second pass) — "fix all the required things"

Every item the previous pass left open or in a warning state, resolved or named.

| # | Item | Resolution | Proof |
|---|---|---|---|
| 18 | **Bridge unauthenticated by default** (token only if the operator exported one) | Secure by default: `bin/agenticos` generates `data/.bridge-token` (0600) when `AGENTICOS_BRIDGE_TOKEN` is unset and injects it into brain, gateway and `turn`. Rendered edge config always references `${AGENTICOS_BRIDGE_TOKEN}`. | gate 8 asserts anonymous ⇒ **401** |
| 19 | **Auth ran after body validation** — anonymous callers got 422 for a malformed body and 401 only for a well-formed one, leaking schema validity across the auth boundary (found by the new 401 probe) | `require_auth` is a FastAPI dependency evaluated before the body is parsed, on both mutating routes. | `test_authentication_precedes_body_validation` |
| 20 | **Kernel governance was an env-only WARNING** with 5 real-kernel tests permanently skipped | `governance.apex_authority` block in the YAML (`mode: required` by default, launcher resolved from `../APEX-OS`); `required` with no launcher ⇒ refuse to start; verify passes `APEX_AUTHORITY_REAL_LAUNCHER` so the real-kernel tests run. Brain banner now carries the governance mode at WARNING (it was INFO and therefore invisible exactly when governed). | gate 5: **87 passed, 0 skipped**; gates 8/9 log `mode=required` on both planes |
| 21 | **LLM-initiated tool call UNVERIFIED** | `tests/e2e/stub_llm_server.py` (deterministic OpenAI-compatible model) + `scripts/e2e-agent-loop-brain.sh`: the real `openclaw agent --local` loop chooses `agenticos_brain_turn`, the brain answers, the loop finishes with the tool result. First run failed honestly twice: tool "isn't available" (optional plugin tools need `tools.alsoAllow` — now rendered into production config too), then the kernel held an R2 approval for an unclassified plugin tool. | gate 9: model calls exactly `[tool, final]`; brain db holds the run |
| 22 | **Brain tools unclassified in the edge risk table** (unknown ⇒ R2 ⇒ every conversational turn needed a human) | Audited entries in the fixed table, never plugin-declared (C10): `agenticos_brain_turn` **R1** (delegation to a governed plane, like `sessions_spawn`); `agenticos_brain_approve` **R2** (a model must never self-approve). | 3 new unit tests; gate 9 runs governed |
| 23 | **No way to resolve a brain approval from the edge** | `agenticos_brain_approve` tool (6 tests), manifest + parity tests updated, oxlint/oxfmt/tsgo clean. | extension suite **31 passed** |
| 24 | **`pnpm-lock.yaml` stale** for the new workspace package — CI `--frozen-lockfile` would have failed | Regenerated; the only removed importer was `extensions/memory-lancedb` (deleted 2026-09-06, entries left stale) plus its unreachable transitive deps. | `--frozen-lockfile` exit 0 |
| 25 | **Foreign process on the configured brain port** | `doctor` names the holder (pid + command) and fails; `up` refuses and prints the override. The launcher never kills a process it did not start. | `doctor` on this host: `:8899 held by FOREIGN pid 39423 (…web/server.py)` |
| 26 | **Disputed edge test figure (54/1037 vs 48/915)** | Re-measured with caches cleared: **54 files / 1,037 tests**, third consecutive reproduction. 48/915 is not reproducible. | this session |

### Still outside this repository's reach
- **Hosted CI run:** the repo has **no git remote**. `gh` is authenticated, but creating a GitHub repository publishes the code — an outward action that needs the operator's explicit go-ahead. Every CI step has been executed locally.
- **Live inference with a real provider:** requires a key; the loop is proven on a stub.

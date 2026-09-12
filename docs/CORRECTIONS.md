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
- Deferred items in `DELETION-LEDGER.md` remain deferred; the two hard integration problems named in `DECISION-MATRIX.md` (double tool loop, pause-vs-block) are unimplemented by design.

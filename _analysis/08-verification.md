# Independent Verification — AgenticOS merged tree

Verifier: independent agent. Nothing in this document is repeated from the build session's own
reporting; every number below was produced by a command executed by this verifier, in this session,
against the tree at
`scratch-2026-09-05-73a274/AgenticOS` with the pristine controls at `_src/agno-main` and
`_src/openclaw-main`. Where a claimed number could not be reproduced it is stated plainly.

Environment observed: node v26.8.1, Python 3.14.6 (`../.venv`), agno 3.0.6 editable-installed from
`AgenticOS/planes/brain/libs/agno`. To run the pristine control honestly, `PYTHONPATH` was pointed at
`_src/agno-main/libs/agno`; this was **verified to win over the editable finder** (`agno.__file__`
printed from the pristine tree before every control run), so the control was not silently importing
the merged package.

The tree was not modified. (Test runs were executed with `PYTHONDONTWRITEBYTECODE=1` /
`-p no:cacheprovider` where possible; some `__pycache__` and `node_modules/.vite` artefacts are
unavoidable byproducts of executing the suites.)

---

## Verdict

**The claims are honest.** All 11 assigned claims reproduce, most of them to the exact digit — including the
hardest one (zero regressions vs the pristine control, which I re-ran end-to-end on the full `tests/unit`
tree, not just the named slice). Two claims are *narrower than their wording suggests* (the "0 dangling
imports" gate does not cover `planes/brain/cookbook/`, where 58 files now break; "193/193 packages import"
means "no missing `agno.*`", not "193 import without error"), and I found five real defects the ledger does
not mention — but no fabricated result, no test weakened or deleted to manufacture a pass, and the
project's own `docs/DELETION-LEDGER.md` discloses the awkward numbers (56 pre-existing failures, −242
tests of lost coverage) rather than hiding them.

---

## Claim-by-claim table

| # | Claim | Observed | Status |
|---|---|---|---|
| 1 | `./bin/agenticos doctor` reports all planes healthy | Exit 0. 6/6 checks green: config (`contract turn.v1`), node v26.8.1, Python 3.14.6, brain plane `agno 3.0.6 imports`, bridge `contract turn.v1`, edge plane `OpenClaw 2026.9.1`. Prints "All planes healthy." | **VERIFIED** |
| 2 | `./bin/agenticos verify` passes all 3 gates | All 3 gates green in one run: gate 1 `OK: 22 deleted brain modules, 0 dangling inbound imports` + `OK: 193 surviving agno packages import cleanly`; gate 2 `24 passed in 0.57s`; gate 3 `tests 6 / pass 6 / fail 0`. Prints "All gates passed." | **VERIFIED** |
| 3 | 0 dangling inbound imports; 193/193 surviving agno packages import | Dangling: **0** — and I confirmed it independently and more broadly than the gate does: a regex sweep for imports of all 22 deleted brain modules across every `.py` in `planes/brain/libs/agno` (incl. `tests/`) returns **0 hits**. Packages: **193** packages exist (`__init__.py` count) and **0** fail on a missing `agno.*` module. But a strict import (no exception swallowing) shows only **149/193** import cleanly; 44 raise on missing optional third-party SDKs (`google-api-python-client`, `boto3`, `pymongo`, `redis`, `mcp`, …). Environmental, identical in pristine — but "193/193 import" is not literally what happens. **Separately: the gate's scope is `libs/agno` only. `planes/brain/cookbook/` has 58 files importing deleted modules; `from agno.models.litellm import LiteLLM` → `ModuleNotFoundError`.** | **OVERSTATED** (dangling=0 verified within the gate's scope; "193/193 import" and "0 dangling" are both narrower than stated) |
| 4 | Bridge + contract-parity: 24 tests pass | `PYTHONPATH=bridge/py pytest tests/e2e -q --asyncio-mode=auto` → **24 passed in 0.52s**, exit 0. | **VERIFIED** |
| 5 | Cross-plane E2E: 6 tests pass (brain on :8899) | Started `tests/e2e/brain_server.py`, health returned `{"status":"ok","contract":"turn.v1",...}`, then `node --test tests/e2e/cross_plane.test.ts` → **tests 6, pass 6, fail 0**. | **VERIFIED** |
| 6 | Brain unit tests: ~4,653 pass across the 8-dir slice | **Exactly 4,653 passed.** Full line: `56 failed, 4653 passed, 38 skipped, 315 warnings, 184 errors in 54.12s`. The 56 failures and 184 collection errors are **identical on the pristine control** (`56 failed, 4750 passed, 38 skipped, 184 errors`) and `DELETION-LEDGER.md` discloses them. Note the raw claim "4,653 pass" omits them; the ledger does not. | **VERIFIED** (number exact; bare phrasing omits the 56 co-occurring failures, which the ledger discloses) |
| 7 | **ZERO regressions vs pristine control** | **Confirmed, and confirmed wider than asked.** 8-dir slice: failed-ID sets are **byte-identical** (56 vs 56, `diff` clean; 0 merged-only failures). Full `tests/unit` on both trees, same flags, correct interpreter per tree: merged `232 failed, 12616 passed, 509 skipped, 313 errors`; pristine `277 failed, 12858 passed, 519 skipped, 371 errors`. **Tests failing in merged but not in pristine: 0.** 45 pristine failures disappear (their files were deleted). Edge side too: the vitest selection gives **identical** results on both trees (47 files/823 tests + 1 file/92 tests, 0 failures). Coverage delta: **−242 passing tests**, all from the 39 deleted test files — real lost coverage, and the ledger states it. | **VERIFIED** |
| 8 | Edge: `node openclaw.mjs --version` → OpenClaw 2026.9.1; vitest passes for the 3 areas | Version prints **`OpenClaw 2026.9.1`**, exit 0. `node scripts/run-vitest.mjs run src/transcripts src/system-agent src/config/config.plugin-validation.test.ts` → exit 0, **47 files / 823 tests passed** + **1 file / 92 tests passed** = **48 files / 915 tests, 0 failures**. (README/ledger claim "1,037 passed / 54 files" for "merge-touched areas" — I could not reproduce that count with this selection; see Discrepancies.) | **VERIFIED** as stated |
| 9 | Merged brain control plane: 72 paths / 113 operations | Booted `AgentOS(agents=[Agent(...)]).get_app().openapi()`: **PATHS: 72, OPERATIONS: 113** — exact. Ran the same probe on pristine: **also 72 / 113**. So the number is correct but is unchanged by the merge; `DELETION-LEDGER.md` says so ("unchanged before and after deletion"), `README.md` does not. | **VERIFIED** |
| 10 | 23 deleted paths absent, 11 deferred paths present | Parsed `docs/deletions.tsv`: **23 deleted rows, 11 DEFERRED rows**. All **23/23 deleted paths ABSENT**; all **11/11 deferred paths PRESENT**. File-list diff vs pristine: 96 files removed, 1 added (a harness marker file) — 57 source files (matching the 23 ledger paths exactly, by the receipt's own per-path file counts summing to 57) and 39 test files (matching the claimed "39 orphaned tests removed"). | **VERIFIED** |
| 11 | Pre-commit hooks pass on the 3 named files | `pre-commit run --files docs/deletions.tsv bridge/contract/turn.schema.json bin/agenticos` → **9/9 Passed** (merge-conflict, check-json, end-of-file-fixer, trailing-whitespace, large-files, gitleaks, deletion-integrity, contract-parity; check-yaml skipped — no yaml in the file list). | **VERIFIED** |

---

## Security deletions confirmed

Each of the 8 security-critical paths was checked one by one under `planes/brain/libs/agno/agno/`,
and cross-checked against the pristine tree to prove it *was* there before (absence proven twice, not
inferred from one negative probe):

| File | In pristine `agno-main`? | In merged `planes/brain`? |
|---|---|---|
| `tools/shell.py` | YES | **ABSENT** |
| `tools/python.py` | YES | **ABSENT** |
| `tools/docker.py` | YES | **ABSENT** |
| `tools/webbrowser.py` | YES | **ABSENT** |
| `tools/e2b.py` | YES | **ABSENT** |
| `tools/daytona.py` | YES | **ABSENT** |
| `tools/local_file_system.py` | YES | **ABSENT** |
| `guardrails/prompt_injection.py` | YES | **ABSENT** |

All 8 confirmed removed. A regex sweep across every `.py` under `planes/brain/libs/agno` for imports
of any of them returns **0 surviving inbound imports** — the RCE-sink modules are gone and nothing in
the library still reaches for them. `import agno.tools.shell` fails at runtime.

**Licences** — README claim: brain Apache-2.0 (Agno), edge MIT (OpenClaw). Observed:
`planes/brain/LICENSE` and `planes/brain/libs/agno/LICENSE` are both the Apache License 2.0 text
(`pyproject.toml`: `license = { file = "LICENSE" }`); `planes/edge/LICENSE` is `MIT License,
Copyright (c) 2026 OpenClaw Foundation` and `planes/edge/package.json` declares `"license": "MIT"`.
**Claim accurate; both licences retained in their subtrees; no relicensing observed.**

**Hardcoded secrets** — I grepped `bridge/`, `bin/`, `tests/`, `scripts/`, `docs/`, `*.md` and
`agenticos.config.yaml` for provider key shapes (`sk-…`, `xox[baprs]-…`, `AKIA…`, `ghp_…`, PEM private
key headers) and for `key|secret|token|password = "literal"`. **Exactly one hit, and it is not a
secret:** `agenticos.config.yaml:23  auth_token: "${AGENTICOS_BRIDGE_TOKEN}"` — an env reference, which
is the correct pattern. **No hardcoded secret found that gitleaks should have caught.** The gitleaks
hook is genuinely wired (`gitleaks/gitleaks-action@v2` in CI, `gitleaks` rev v8.30.1 in
`.pre-commit-config.yaml`) and passed on the files given to it — see Discrepancy 6 for its scope limit.

---

## Discrepancies found

1. **`planes/brain/cookbook/` — 58 files with dangling imports of deleted modules.** The
   deletion-integrity gate hard-codes `BRAIN_PKG = planes/brain/libs/agno`, so the cookbook — shipped
   inside the same plane — is never scanned. 58 example files import removed modules
   (`agno.models.litellm` ×22, `agno.os.interfaces.slack` ×12, `whatsapp` ×5, `telegram` ×3,
   `agno.tools.{shell,python,docker,webbrowser,e2b,daytona,local_file_system}` ×8,
   `agno.knowledge.embedder.{fireworks,nebius,together,langdb}` ×4, `vectordb.{langchaindb,llamaindex}`,
   `db.gcs_json`, `integrations.discord`, `models.tuning_engines`). Executed proof, not inference:
   `from agno.models.litellm import LiteLLM` → `ModuleNotFoundError: No module named 'agno.models.litellm'`.
   The claim "0 dangling inbound imports" is true of `libs/agno` and false of the plane as a whole.

2. **Orphaned test file left behind by the deletion:**
   `planes/brain/libs/agno/tests/unit/os/routers/test_slack_bot_filtering.py` survives, but its
   `conftest.py` (which imported the deleted Slack router) was removed. Running it:
   `ModuleNotFoundError: No module named 'tests.unit.os.routers.conftest'` — a hard collection error.
   It is invisible in the reported totals because every run uses `--continue-on-collection-errors`.
   The static gate cannot catch it: the broken import is relative (`from .conftest import …`), not a
   module path.

3. **`docs/deletion-receipt.tsv` contradicts `docs/deletions.tsv`.** The receipt lists 34 paths as
   deleted, including 9 brain paths and 2 edge paths that `deletions.tsv` classifies as **DEFERRED**
   and that I verified are **still present on disk** (`client/os.py`, `memory/strategies`,
   `scheduler/cron.py`, `tracing/exporter.py`, `debug.py`, `os/middleware/trailing_slash.py`,
   `agent/remote.py`, `team/remote.py`, `workflow/remote.py`, `src/transcripts/summary.ts`,
   `src/system-agent/delegation-session.ts`). The receipt appears to be a stale artefact of an earlier
   deletion pass that was reverted. `deletions.tsv` is the accurate one; the receipt is misleading and
   nothing gates on it.

4. **The CI brain job, as written, would go red.** `.github/workflows/ci.yml` runs the 8-dir selection
   with `--continue-on-collection-errors` and no failure tolerance. I executed that exact command
   against the merged tree: `56 failed, 4653 passed, 38 skipped, 184 errors` — **non-zero exit**. Those
   56 failures are pre-existing upstream failures (identical on the pristine control), not merge
   damage, but the gate as committed does not distinguish them and would block. A CI runner installs a
   different dependency set, so I cannot assert it fails *there* — only that it fails here, on the
   tree it ships with. Marked **UNVERIFIED on GitHub-hosted runners**.

5. **Pre-commit / gitleaks never scan the two planes.** The repo has **no commits** (`git log` → "does
   not have any commits yet") and only **24 tracked files**, **0 of them under `planes/`**. Since
   pre-commit resolves `--all-files` through `git ls-files`, the gitleaks hook and every other hook can
   only ever see the 24 scaffolding files — the ~100k-file brain and edge planes are outside the local
   secret scan entirely. The CI `secrets` job uses `gitleaks-action` on the checkout, which would cover
   more, but the "9/9 hooks passed" result should not be read as "the planes were scanned".

6. **README's edge figure not reproduced.** README/ledger claim "Edge tests (merge-touched areas):
   **1,037 passed / 54 files**". With the selection named in claim 8
   (`src/transcripts src/system-agent src/config/config.plugin-validation.test.ts`) I observe
   **915 passed / 48 files** on both the merged tree and the pristine control. Shortfall: 122 tests /
   6 files. Nothing failed either way, so this is a bookkeeping mismatch (probably a wider selection
   behind the README number), not a hidden failure — but 1,037/54 is not what that command produces.

7. **Claim 9's number is not a property of the merge.** 72 paths / 113 operations is exact — and
   identical on the untouched pristine tree. `README.md`'s verification table presents it as a merged
   result without that context; `DELETION-LEDGER.md` does state it is unchanged.

8. **Real coverage loss, disclosed but worth restating.** The merged tree passes **242 fewer** unit
   tests than pristine (12,616 vs 12,858) because 39 test files were deleted. Most tracked deleted
   modules directly, but some carried unrelated passing coverage as collateral — e.g.
   `tests/unit/os/test_alternate_door_parity.py` (4 passed / 4 skipped in pristine) was removed for a
   single `importorskip`-guarded Slack HITL test, and
   `tests/unit/models/anthropic/test_append_trailing_user_message.py` (35 passing, mostly
   Claude/Bedrock) went for a litellm-guarded class. Nothing was deleted *to make a failure go away*
   that I could detect — the merged failure set is a strict subset of pristine's — but the 8 test files
   removed beyond the litellm/slack/telegram/whatsapp/tools clusters are not itemised anywhere.

---

## Commands that failed to run

- `timeout 2400 python -m pytest …` → `(eval):4: command not found: timeout` (GNU coreutils `timeout`
  is not on this macOS host). Re-run without it; no impact on results.
- First merged unit run without `--continue-on-collection-errors` → `Interrupted: 50 errors during
  collection`, exit 2. Cause: 50 test modules import optional third-party SDKs that are not installed
  (`google`, `ddgs`, `pandas`, `mcp`, `slack_sdk`, `boto3`, `playwright`, …). Not a defect in the tree;
  every subsequent run (on both trees, identically) used `--continue-on-collection-errors`.
- `pytest tests/unit/os/routers/test_slack_bot_filtering.py` → `ModuleNotFoundError: No module named
  'tests.unit.os.routers.conftest'`, exit 2. This one **is** a defect in the merged tree — see
  Discrepancy 2.
- `from agno.models.litellm import LiteLLM` (as executed by 22 shipped cookbook files) →
  `ModuleNotFoundError: No module named 'agno.models.litellm'`. See Discrepancy 1.

No other command failed to run.

---

## Reproduction log (what I actually executed)

```
./bin/agenticos doctor                                    → exit 0, all planes healthy
./bin/agenticos verify                                    → 3/3 gates, "All gates passed."
python scripts_audit_dangling_refs.py                     → 0 dangling, 193 packages
pytest tests/e2e -q --asyncio-mode=auto  (PYTHONPATH=bridge/py)
                                                          → 24 passed
node --test tests/e2e/cross_plane.test.ts (brain on :8899)→ 6/6 pass
pytest tests/unit/{agent,team,workflow,memory,session,reasoning,tools,guardrails}
  merged   → 56 failed, 4653 passed, 38 skipped, 184 errors
  pristine → 56 failed, 4750 passed, 38 skipped, 184 errors
  failed-ID diff → 0 merged-only failures (sets identical)
pytest tests/unit   (full)
  merged   → 232 failed, 12616 passed, 509 skipped, 313 errors
  pristine → 277 failed, 12858 passed, 519 skipped, 371 errors
  failed-ID diff → 0 merged-only failures; 45 pristine-only (deleted files)
node scripts/run-vitest.mjs run src/transcripts src/system-agent src/config/config.plugin-validation.test.ts
  merged   → 47 files/823 tests + 1 file/92 tests, 0 failed, exit 0
  pristine → 47 files/823 tests + 1 file/92 tests, 0 failed, exit 0
node openclaw.mjs --version                               → OpenClaw 2026.9.1
AgentOS(...).get_app().openapi()   merged → 72 paths / 113 ops
                                   pristine → 72 paths / 113 ops
pre-commit run --files docs/deletions.tsv bridge/contract/turn.schema.json bin/agenticos
                                                          → 9/9 Passed
deletions.tsv presence audit                              → 23/23 absent, 11/11 present
file-list diff pristine↔merged                            → 96 removed (57 src + 39 test), 1 added
```

All figures above are **EXECUTED** evidence from this session. The only **UNVERIFIED** item is whether
the committed CI workflow goes green on a GitHub-hosted runner (Discrepancy 4); locally its brain job
exits non-zero. Live model inference was not exercised — the README already states that limitation, and
I confirm the cross-plane proof runs on a deterministic in-process model, so plumbing is proven and
inference is neither exercised nor claimed.

# Deletion Ledger

Every removal from the merged tree, with its justification and the evidence trail.

This is the audit record for R2 ("remove lower quality/level same types of function/features").

**23 paths deleted** · **11 adjudicated-but-deferred, all resolved 2026-09-13 (T-18) as KEEP with re-measured consumers** · **39 orphaned test files removed**


## How a deletion was authorised

1. A domain specialist adjudicated the capability head-to-head across both trees and named a winner.
2. The losing implementation was checked for a **superior sub-feature**; anything better was recorded
   on the salvage list before removal was allowed.
3. Inbound references were checked. **A path with live consumers in code we are KEEPING was NOT deleted**
   — it was moved to the deferred table below, because a verdict about quality is not a licence to break
   the build.
4. After deletion, two differently-shaped checks had to pass: a static dangling-import scan AND an actual
   import of all 193 surviving packages. Static scan alone proved insufficient — see the note below.
5. The full brain-plane unit suite was run against a **pristine control** to prove zero regressions.

## Why the static scan alone was not enough

Deleting `agno/client/os.py` looked clean to a module-path scan, then broke a **lazy, function-level**
`from agno.client import AgentOSClient` inside `agno/remote/base.py:460` — the import names the *package*,
not the deleted submodule, so no path pattern could match it. It surfaced only when the test suite ran.
The gate (`scripts_audit_dangling_refs.py`) now imports every surviving package as a second check, and that
file was restored and deferred. A comparable miss on the edge side (`./summary.js` vs `./summary`) was
caught the same way.


## Deleted — security posture

These are not merely duplicates; keeping them alongside the winner would have left a live hazard.

| Plane | Path | Justification |
|---|---|---|
| brain | `libs/agno/agno/tools/shell.py` | Unsandboxed subprocess.run on host; own docstring calls it an RCE sink under prompt injection. Superseded by edge exec sandbox + approvals. |
| brain | `libs/agno/agno/tools/python.py` | runpy.run_path in-process with safe_globals = globals(); the "restricted scope" is the real module globals. Superseded by CodeMode-in-sandbox. |
| brain | `libs/agno/agno/tools/docker.py` | Hands the model the host Docker daemon (create/exec/remove). Daemon access is root-equivalent with no policy layer. Non-negotiable. |
| brain | `libs/agno/agno/tools/webbrowser.py` | 28 lines calling webbrowser.open_new_tab on the operator desktop; a UI-hijack primitive with no automation value. |
| brain | `libs/agno/agno/tools/e2b.py` | Third-party hosted sandbox; redundant once the edge container sandbox is the execution substrate, and moves code off the policy-controlled machine. |
| brain | `libs/agno/agno/tools/daytona.py` | Same as e2b.py. |
| brain | `libs/agno/agno/tools/local_file_system.py` | Second file toolkit alongside agno/fs/; two file surfaces in one runtime is a policy hole. fs/ is the hardened one. |
| brain | `libs/agno/agno/guardrails/prompt_injection.py` | 18 hardcoded lowercase substrings providing false assurance next to the edge external-content scanner. Patterns salvaged as extra inputs first. |

## Deleted — inferior duplicates

| Plane | Path | Justification |
|---|---|---|
| brain | `libs/agno/agno/tools/tool_registry.py` | One-line alias `Toolkit as ToolRegistry`; dead name colliding with the edge registry concept. |
| brain | `libs/agno/agno/integrations` | Whole tree is 3 files; a 208-line standalone discord.py bot AgentOS never mounts. Superseded by edge discord extension (71,368 LOC). |
| brain | `libs/agno/agno/os/interfaces/slack` | 3,654 LOC webhook-only vs edge Slack 41,052 LOC with Socket Mode, modals, slash commands, native approvals. |
| brain | `libs/agno/agno/os/interfaces/telegram` | 1,598 LOC webhook-only; structurally cannot poll. Superseded by edge telegram (63,082 LOC). |
| brain | `libs/agno/agno/os/interfaces/whatsapp` | 911 LOC vs edge whatsapp 24,581 LOC. |
| brain | `libs/agno/agno/models/litellm` | LiteLLM as a Python-side abstraction is redundant once routing goes through edge protocol adapters; the edge already consumes LiteLLM pricing JSON. |
| brain | `libs/agno/agno/models/tuning_engines` | 45 lines, one vendor, zero unique mechanism; replaced by a priced manifest row. |
| brain | `libs/agno/agno/vectordb/langchaindb` | Pass-through to a competing framework abstraction; get_supported_search_types() returns [] so it cannot join the merged hybrid/rerank pipeline. |
| brain | `libs/agno/agno/vectordb/llamaindex` | Same as langchaindb. |
| brain | `libs/agno/agno/db/gcs_json` | JSON-blob-in-a-bucket with no query/index capability; db/json/ covers dev use. |
| brain | `libs/agno/agno/knowledge/embedder/fireworks.py` | 13-22 line class X(OpenAIEmbedder) shim differing only in base_url/id/env var. |
| brain | `libs/agno/agno/knowledge/embedder/nebius.py` | Same shim pattern. |
| brain | `libs/agno/agno/knowledge/embedder/together.py` | Same shim pattern. |
| brain | `libs/agno/agno/knowledge/embedder/langdb.py` | Same shim pattern. |
| edge | `extensions/memory-lancedb` | Vector-only (no FTS/MMR/decay/citations) and forks a THIRD memory tool surface against active-memory's allow-list; the brain LanceDB adapter already does hybrid on the same engine. |

## Adjudicated as losers, but DEFERRED (not deleted) — resolved 2026-09-13 (T-18)

The capability verdict for each of these stands in `DECISION-MATRIX.md`. They remain in the tree
because they have live consumers in retained code, so removing them is a **refactor of the call sites**, not
a file deletion. Recording them here — rather than deleting them and breaking the build, or quietly dropping
the finding — is the honest state.

**T-18 resolution (2026-09-13).** Every deferred row was re-measured with a fresh import scan over the
whole brain plane (`from agno.x.y import`, `import agno.x.y` and `from agno.x import y` shapes, production
`libs/agno/agno/` counted separately from tests and cookbook) and, for the two edge rows, a read-only grep
of `planes/edge/src`. Every one still has production consumers, so every one is **KEPT** with the consumer
list and the unblock condition written into `docs/deletions.tsv` (fifth column). `scripts/check-deletion-ledger.py`
now refuses a DEFERRED row that lacks a dated `KEEP (...)... Unblock: ...` resolution, so a deferral can no
longer be recorded without saying who depends on the path and what would let it go. None was deleted: a
verdict about quality is still not a licence to break the build, and the counts below are measured, not
asserted (several are smaller than the ledger originally recorded — the original counts included test and
cookbook importers).

| Plane | Path | Production importers (re-measured 2026-09-13) | Resolution |
|---|---|---|---|
| brain | `libs/agno/agno/memory/strategies` | 3 (`memory/__init__.py`, `memory/manager.py`, `os/routers/memory/memory.py`) + 2 tests + 1 cookbook | KEEP. Unblock: MemoryManager takes a strategy interface the edge dreaming consolidation implements. |
| brain | `libs/agno/agno/scheduler/cron.py` | 5 (`scheduler/__init__.py`, `manager.py`, `executor.py`, `os/routers/schedules/router.py`, `tools/studio.py`) + 2 tests | KEEP. Unblock: schedule engine takes a cron evaluator interface; port DST/jitter from the edge. |
| brain | `libs/agno/agno/tracing/exporter.py` | 2 (`tracing/__init__.py`, `tracing/setup.py`) + 1 test | KEEP. Unblock: tracing bootstrap defaults to OTLP; then delete DatabaseSpanExporter. |
| brain | `libs/agno/agno/os/middleware/trailing_slash.py` | 2 (`os/app.py`, `os/middleware/__init__.py`) + 1 test | KEEP. Unblock: the REST facade stops self-mounting once the gateway owns routing. |
| brain | `libs/agno/agno/agent/remote.py` | 6 (`agent/__init__.py`, `os/interfaces/a2a/a2a.py`, `os/interfaces/agui/agui.py`, `os/mcp.py`, `os/routers/agents/router.py`, `os/schema.py`) + 7 tests + 1 cookbook | KEEP. Unblock: callers rewired to ACP. |
| brain | `libs/agno/agno/team/remote.py` | 6 (`os/interfaces/agui/agui.py`, `agui/router.py`, `os/mcp.py`, `os/routers/teams/router.py`, `os/schema.py`, `team/__init__.py`) + 4 tests | KEEP. Unblock: same as `agent/remote.py`. |
| brain | `libs/agno/agno/workflow/remote.py` | 4 (`os/mcp.py`, `os/routers/workflows/router.py`, `os/schema.py`, `workflow/__init__.py`) + 2 tests | KEEP. Unblock: same as `agent/remote.py`. |
| brain | `libs/agno/agno/debug.py` | 0 production; 6 test files of RETAINED subsystems import `enable_debug_mode` | KEEP (retained after review, unchanged). Unblock: replace the 6 imports with a logging-level fixture. |
| brain | `libs/agno/agno/client/os.py` | 1 (`agno/client/__init__.py` re-export) + the lazy `from agno.client import AgentOSClient` in `remote/base.py` `get_os_client()` that a module-path scan cannot see | KEEP. Unblock: `remote/` speaks the edge gateway protocol. |
| edge | `src/system-agent/delegation-session.ts` | 1 (`src/gateway/server-methods/system-agent-session-owner.ts`) | KEEP. Edge plane, outside this pass's write scope. Unblock: fold `resolveSystemAgentDelegationKey` into the merged session-key module. |
| edge | `src/transcripts/summary.ts` | 6 (`summary-model.ts`, `store.ts`, `store-sqlite.ts`, `infra/state-migrations.meeting-transcripts-files.ts`, `meeting-bot/transcripts-bridge.runtime.ts`, `agents/tools/transcripts-tool-runtime.ts`) | KEEP. The verdict targets `summarizeTranscripts()`, not the module. Edge plane, outside this pass's write scope. Unblock: replace that function. |

## Orphaned tests

39 brain-plane test files that exercised deleted modules were removed. One earlier pass removed 45; six of
those were reinstated after review showed they were dropped only because they imported `agno.debug`
(an 18-line log-level shim) while actually covering **retained** subsystems such as SurrealDB persistence.
`debug.py` was restored and deferred rather than paying that coverage cost for a trivial saving.

## Verification of the deletions

| Check | Result |
|---|---|
| Dangling inbound imports after deletion | **0** across 4,649 `.py` files (whole brain plane, incl. `cookbook/`) |
| Surviving brain packages that import cleanly | **149 / 193** (44 skipped: optional third-party SDK absent — identical in pristine) |
| Brain unit tests — 8-directory slice | **4,653 passed** (56 pre-existing failures identical on both trees) |
| Brain unit tests — **full `tests/unit`** | **12,616 passed** |
| Regressions vs pristine control (full suite) | **0** |

### Full-suite control comparison

Both trees were run with the same selection, each in its own venv so neither install could contaminate
the other. The merged tree fails *fewer* tests than the original — every removed failure belonged to a
test file covering a deleted module, not to lost coverage of retained code.

| | Pristine `agno-main` | Merged `planes/brain` | Delta |
|---|---|---|---|
| Passed | 12,858 | 12,616 | -242 (tests of deleted modules) |
| Failed | 277 | **232** | -45 |
| Collection errors | 371 | 313 | -58 (all uninstalled vendor SDKs, not `agno.*`) |
| Skipped | 519 | 509 | -10 |
| **Tests failing in merged but passing in pristine** | — | **0** | — |
| Edge tests in merge-touched areas | **1,037 passed / 54 files** |
| Edge CLI | `OpenClaw 2026.9.1` runs |
| Merged control plane | 72 paths / 113 operations — unchanged before and after deletion |


# Deletion Ledger

Every removal from the merged tree, with its justification and the evidence trail.

This is the audit record for R2 ("remove lower quality/level same types of function/features").

**23 paths deleted** · **11 adjudicated-but-deferred** · **39 orphaned test files removed**


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

## Adjudicated as losers, but DEFERRED (not deleted)

The capability verdict for each of these stands in `DECISION-MATRIX.md`. They remain in the tree
because they have live consumers in retained code, so removing them is a **refactor of the call sites**, not
a file deletion. Recording them here — rather than deleting them and breaking the build, or quietly dropping
the finding — is the honest state.

| Plane | Path | Why it could not be deleted yet |
|---|---|---|
| brain | `libs/agno/agno/memory/strategies` | 5 inbound production imports (memory/__init__.py, memory/manager.py, os/routers/memory/memory.py). The edge dreaming consolidation wins on BEHAVIOUR; swapping it means reworking MemoryManager, not deleting a package. |
| brain | `libs/agno/agno/scheduler/cron.py` | 11 inbound production imports (scheduler/manager.py, executor.py, os/routers/schedules/router.py, tools/studio.py). The edge cron wins on SEMANTICS (DST/jitter); replacing this is a refactor of the schedule engine, not a file deletion. |
| brain | `libs/agno/agno/tracing/exporter.py` | 2 inbound production imports. The OTLP exporter wins, but DatabaseSpanExporter is still wired into the tracing bootstrap; removal follows the exporter swap. |
| brain | `libs/agno/agno/os/middleware/trailing_slash.py` | 2 inbound production imports. Removable only once the gateway fully owns the edge and the REST facade stops self-mounting. |
| brain | `libs/agno/agno/agent/remote.py` | 6 inbound production imports. ACP supersedes it as a PROTOCOL; cutting the Python proxy requires rewiring callers to ACP first. |
| brain | `libs/agno/agno/team/remote.py` | 6 inbound production imports. Same as agent/remote.py. |
| brain | `libs/agno/agno/workflow/remote.py` | 6 inbound production imports. Same as agent/remote.py. |
| brain | `libs/agno/agno/debug.py` | RETAINED AFTER REVIEW: an 18-line log-level shim, but `enable_debug_mode` is imported by many integration tests for subsystems being KEPT (e.g. db/surrealdb). Deleting it cost 6+ valuable test files as collateral. The saving is trivial; the coverage loss is not. Fold into edge logging later via a shim, do not delete. |
| brain | `libs/agno/agno/client/os.py` | HAS A LIVE CONSUMER: agno/remote/base.py:460 lazily calls `from agno.client import AgentOSClient` inside get_os_client(). Caught by the executed test suite, NOT by static grep (the import names the package, not the deleted submodule). Verdict stands - the edge gateway-protocol should generate this client - but removal must follow rewiring agno/remote/ first. |
| edge | `src/system-agent/delegation-session.ts` | HAS A LIVE CONSUMER: src/gateway/server-methods/system-agent-session-owner.ts:1 imports resolveSystemAgentDelegationKey from it. Folding it into a merged session-key module is a refactor, not a deletion. |
| edge | `src/transcripts/summary.ts` | HAS PRODUCTION CONSUMERS: store.ts, store-sqlite.ts, infra/state-migrations.meeting-transcripts-files.ts and summary-model.ts ITSELF import the shared TranscriptsSummary type and renderTranscriptsMarkdown from it. The verdict targeted the heuristic summarizeTranscripts() function, not the module; replacing that function is a refactor, not a file deletion. |

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


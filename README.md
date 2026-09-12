# AgenticOS

**One Agentic-OS, compiled from two.** `agno` (Python agent platform) and `openclaw`
(TypeScript multi-channel gateway) merged into a single system: one identity, one config,
one CLI, one control plane, and one typed contract joining two runtimes.

```
                        A G E N T I C - O S
   ┌─────────────────────────────────────────────────────────┐
   │  EDGE PLANE   (TypeScript · OpenClaw lineage)           │
   │  27 channels · gateway/daemon/fleet · exec sandbox      │
   │  browser/CDP · plugins · CLI/TUI/web · 4 native apps    │
   └──────────────────────────┬──────────────────────────────┘
                              │   BRIDGE  (turn.v1)
                              │   HTTP + SSE · one trace context
   ┌──────────────────────────▼──────────────────────────────┐
   │  BRAIN PLANE  (Python · Agno lineage)                   │
   │  agents/teams/workflows · reasoning · 20 vector stores  │
   │  knowledge/RAG · memory · 14 DB backends · eval/traces  │
   └─────────────────────────────────────────────────────────┘
```

## Why two planes and not a rewrite

The two systems are **complements, not clones**. Measured, not assumed:

| | Agno (brain) | OpenClaw (edge) |
|---|---|---|
| Strength | reasoning, RAG (20 vector stores, 23 readers), 14 DB backends, workflow engine, per-resource RBAC, MCP server w/ OAuth 2.1 | 27 channels, gateway/fleet, container sandbox, SSRF guard, browser/CDP, OTLP observability, config system, plugin distribution |
| Gap | channel layer was **3 files, never mounted**; **no sandbox** (its own source says so); **no SSRF defence** | reasoning is **39 lines**; no workflow engine; memory/knowledge shallower |

Collapsing either into the other would have destroyed the winning half. So each capability is assigned
to the plane that provably does it better, the loser's duplicate is **deleted**, and the planes are
joined by one contract. See [`docs/DECISION-MATRIX.md`](docs/DECISION-MATRIX.md) — OpenClaw wins 14
areas, Agno wins 11.

## Quick start

```bash
./bin/agenticos doctor     # check both planes and the bridge
./bin/agenticos install    # install brain (python) + edge (node) deps
./bin/agenticos verify     # run every gate, incl. cross-plane E2E
./bin/agenticos brain      # run the brain plane
./bin/agenticos edge --help  # run the edge plane CLI
git config core.hooksPath .githooks   # once per clone: the committed pre-commit gate (gitleaks on
                                      # staged changes, deletion ledger, contract parity), fails closed
```

The brain-plane bridge logs one line at startup saying whether the APEX kernel governs tool calls.
`APEX_AUTHORITY_MODE=native` (the default) logs a **WARNING** that the kernel is *not* in charge;
`required` with `APEX_AUTHORITY_CMD` set is the only configuration that logs at INFO.

## The bridge

[`bridge/contract/turn.schema.json`](bridge/contract/turn.schema.json) is canonical. Both planes project
their types from it and a parity test fails the build if they drift.

- **Edge → Brain**: `TurnRequest` — turn_id (idempotency key), session, target (agent|team|workflow),
  input, principal (with **enforced** scopes), W3C trace context.
- **Brain → Edge**: an SSE stream of `TurnEvent` — `run.started`, `output.delta`, `reasoning.delta`,
  `tool.started/completed`, `approval.required`, terminating in exactly one of `run.completed` / `run.failed`.

Design rules the contract enforces: **exactly one terminal event** ends every stream; a redelivered
`turn_id` is refused; unknown fields are rejected at the boundary; a transport failure is *synthesised*
into `run.failed` so a caller never hangs. `reasoning.delta` exists because the brain plane's reasoning
trace is its strongest differentiator and a narrow waist would otherwise have silently discarded it.

## What was removed

23 paths deleted, 11 adjudicated-but-deferred, 39 orphaned tests removed — each with justification and
an evidence trail in [`docs/DELETION-LEDGER.md`](docs/DELETION-LEDGER.md). Deletions that would have
broken retained code were **not** performed; they are recorded as deferred refactors rather than faked.

## Verification

Every claim below was produced by running code in the session that built this.

| Gate | Result |
|---|---|
| Deletion integrity | 0 dangling refs across 4,649 brain-plane `.py` files · **149/193** packages import (44 skipped: optional SDK absent) |
| Bridge contract + brain suites | 30 passed |
| Cross-plane E2E (TS edge → Python brain over HTTP) | 6 passed |
| Brain unit tests (full `tests/unit`) | 12,616 passed / 232 failed / 313 collection errors · **0 regressions vs pristine control** (the 232 failures and 313 errors are inherited from upstream `agno`: absent API keys and uninstalled vendor SDKs; pristine shows 277 / 371) |
| Edge tests (merge-touched areas) | 1,037 passed / 54 files |
| Edge CLI | `OpenClaw 2026.9.1` |
| Brain control plane | 72 paths / 113 operations |
| Pre-commit hooks (incl. gitleaks) | 9/9 passed · `.githooks/pre-commit` proven to block a staged `sk-proj-` key |
| Secret scan (`gitleaks git` over history, `gitleaks dir` over tracked files) | 0 findings with no test/doc path exemptions; 371 fixtures allowlisted by exact value shape |
| TS contract parity + strict typecheck | 5 passed · `tsc` exit 0 (both gates proven failable) |
| Approval-gate regression suite | 4 passed |

**Not verified here:** live model inference (no provider API keys in this environment). The end-to-end
proof uses a deterministic in-process model, so the *plumbing* is genuinely proven while inference is
neither exercised nor claimed.

**Adversarial review and independent verification** were run against this tree; their reports are in
`docs/analysis/07-adversarial-review.md` and `08-verification.md`, and the defects they found — including
a fail-open approval gate and a vacuous import check — are fixed with regression tests. The corrections
they forced are listed in `docs/CORRECTIONS.md`.

## Layout

```
bin/agenticos              one CLI for both planes
agenticos.config.yaml      one config for both planes
bridge/contract/           canonical JSON Schema (turn.v1)
bridge/py/                 brain-side bridge server + deterministic model
bridge/ts/                 edge-side bridge client
planes/brain/              Python plane (Agno lineage)
planes/edge/               TypeScript plane (OpenClaw lineage)
tests/e2e/                 contract parity, bridge suites, cross-plane E2E
docs/DECISION-MATRIX.md    which system won each capability, and why
docs/DELETION-LEDGER.md    what was removed, and what was deferred
scripts_audit_dangling_refs.py   the deletion-integrity gate
```

## Licences

The brain plane is Apache-2.0 (Agno); the edge plane is MIT (OpenClaw). Both licences are retained in
their respective `planes/` subtrees. This merge does not relicense either.

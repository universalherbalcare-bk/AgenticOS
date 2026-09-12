# PLAN — One Agentic-OS from agno-main + openclaw-main

## 1. The shape of the problem (evidence-based)

These two systems are **complements, not clones**:

| | Agno (Python, 6,614 files) | OpenClaw (TypeScript, 40,010 files / 16,670 TS src) |
|---|---|---|
| Strength | The **brain**: agents/teams/workflows, reasoning, RAG (89 knowledge + 52 vectordb), persistence (84 db), ~45 model providers, control plane **verified at 72 paths / 113 ops** | The **body**: ~30 messaging channels, gateway/daemon/fleet, exec sandbox + net-policy, browser/CDP, plugin distribution, native iOS/Android/macOS/Linux apps |
| Weakness | Channel layer is **3 Python files (Discord only)** — verified | Reasoning/RAG/persistence comparatively thin |

So the merge is **not** "pick one and delete the other". It is: **assign each capability to the plane that provably does it better, delete the loser's duplicate, and join the planes with one real contract.**

## 2. Target architecture — two planes, one OS

```
                     A G E N T I C - O S
   ┌───────────────────────────────────────────────────────┐
   │ EDGE PLANE  (TypeScript · OpenClaw lineage)           │
   │  gateway · channels · devices · sandbox · browser     │
   │  plugins · CLI/TUI/webchat                            │
   └───────────────────────┬───────────────────────────────┘
                           │  BRIDGE
                           │  HTTP + SSE, one typed contract,
                           │  one trace context, one config
   ┌───────────────────────▼───────────────────────────────┐
   │ BRAIN PLANE (Python · Agno lineage)                   │
   │  agent/team/workflow · reasoning · knowledge+vectordb │
   │  memory · model providers · persistence · eval/traces │
   └───────────────────────────────────────────────────────┘
```

**Why this seam and not another:** both sides *already* speak it. Agno's AgentOS exposes a verified
HTTP/SSE control plane; OpenClaw's gateway already dispatches turns to pluggable providers. The bridge
therefore requires **no rewrite of either side** — it uses an interface each system already ships.

**Single-system test (what makes it ONE OS, not two repos in a folder):** one `agenticos` command boots
both planes; one config file configures both; one turn from a channel crosses the bridge and returns.

## 3. Deduplication rule (R2)

For every overlapping capability:
1. Score both implementations on evidence (depth, tests, security posture, breadth).
2. Declare a winner; the winner's implementation is the ONLY one in the merged OS.
3. **Salvage** any specific sub-feature where the loser is genuinely better, porting it into the winner.
4. **Physically delete** the loser's duplicate from the merged tree, recorded in a deletion ledger with justification.

A tie is treated as an analysis failure and re-adjudicated, not left as two implementations.

## 4. Execution pipeline

| Stage | What | Status |
|---|---|---|
| S1 | Extract + survey both trees | DONE |
| S2 | Executed baseline: install & boot each side, measure real capability | DONE (Python) / running (Node) |
| S3 | **Multi-agent domain team** — 6 master-level specialists comparing head-to-head in parallel (R3) | running |
| S4 | Synthesis: Capability Decision Matrix — winner/loser/salvage/delete per domain | pending |
| S5 | Build the merged repo: structure, bridge, unified config, unified CLI | pending |
| S6 | Execute end-to-end: prove a turn crosses the bridge (deterministic model, no API key) | pending |
| S7 | Gates: CI workflow + pre-commit + secret scan, locally executed | pending |
| S8 | Adversarial review + independent verification + honest ledger | pending |

## 5. Domain team (S3) — six parallel specialists
1. Model / provider layer
2. Agent runtime · reasoning · teams · workflows · session
3. Knowledge · RAG · memory · vectordb · persistence
4. Channels · gateway · API surface · clients · edge auth
5. Tools · browser · exec sandbox · security · skills · plugins
6. Platform services · MCP · scheduling · observability · eval/QA · config · CI

Each returns: verdict, comparison tables with path-level evidence, salvage list, DROP list, bridge requirements.

## 6. Verification contract
- No capability is claimed unless it was **run** in this session; everything else is labelled UNVERIFIED.
- Live model inference is NOT verifiable here (no provider keys) → end-to-end proof uses a deterministic
  in-process model so the *plumbing* is genuinely proven without faking inference.
- Final output carries a Completion Ledger: requirement → status → evidence.

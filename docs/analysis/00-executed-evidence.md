# Executed evidence (main thread, this session)

All claims below were produced by RUNNING code, not by reading it.

## Host toolchain (verified present)
Node v26.8.1 · npm 11.19.0 · pnpm 11.25.0 · Python 3.14.6 · uv 0.11.29 · Docker 29.6.2 · git 2.50.1 · jq 1.7.1 · rg 14.1.1

## Agno (Python side) — EXECUTED
- `uv pip install -e libs/agno` → **exit 0**. Installs and imports on Python 3.14.6. agno version **3.0.6**.
- `from agno.agent import Agent; from agno.team import Team; from agno.workflow import Workflow; from agno.os import AgentOS` → **all import OK**
  (AgentOS additionally requires `fastapi`,`uvicorn`,`python-multipart`,`PyJWT`,`websockets` — optional extras, installed).
- `Agent.__init__` exposes **108 parameters**; `AgentOS.__init__` exposes **36 parameters**.
- **Hard default to OpenAI**: `agno/agent/_init.py:88 set_default_model()` imports `agno.models.openai.OpenAIResponses`
  and raises `ImportError("openai not installed")` if the OpenAI SDK is absent — i.e. constructing ANY agent without an
  explicit model requires the OpenAI package. MERGE IMPLICATION: the merged OS must inject a provider-neutral default
  model resolver, otherwise the whole platform has a vendor hard-dependency at agent-construction time.
- **Control plane size (measured, not claimed)**: booted `AgentOS(agents=[...]).get_app()` and read its OpenAPI schema:
  **72 paths / 113 operations**. README claims "50+ endpoints" — the real figure is materially higher.
  Verified surface areas: agents, teams, workflows (each with runs/cancel/continue/resume/checkpoints/session-fork),
  sessions, knowledge (content CRUD + search + remote-content + refresh/status + sources), memories, learnings,
  metrics, traces (+search/filter-schema/session-stats), eval-runs, schedules, queue, approvals, service-accounts,
  components, registry, database migrate, health/info/config.

## Node side
- Node 26.8.1 satisfies OpenClaw's engine floor (`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`); repo notes "Node 26 recommended".
- Repo pins `packageManager: pnpm@12.3.4`; host has pnpm 11.25.0 (corepack can bridge). NOT yet executed at time of writing.

## OpenClaw (TypeScript side) — EXECUTED
- `corepack pnpm install --frozen-lockfile --ignore-scripts` → **exit 0**, completed in 37.7s using pnpm v12.3.4
  (host pnpm is 11.25.0; corepack bridged to the repo-pinned 12.3.4 automatically).
- `node openclaw.mjs --version` → **`OpenClaw 2026.9.1`**. CLI boots on Node 26.8.1.
- Workspace layout confirmed from pnpm-workspace.yaml: `.`, `ui`, `packages/*`, `extensions/*`, `examples/*`.
- Supply-chain posture (notable, favours OpenClaw on dependency hygiene): pnpm-workspace.yaml enforces
  `minimumReleaseAge: 10080` (7 days) with `minimumReleaseAgeStrict: true` and a dated, individually-justified
  exclusion list for security fixes — a real cooldown control against compromised-package attacks.

## Both runtimes proven live on this host
Python brain plane: agno 3.0.6 imports + AgentOS app builds (72 paths/113 ops).
TypeScript edge plane: openclaw 2026.9.1 CLI executes.

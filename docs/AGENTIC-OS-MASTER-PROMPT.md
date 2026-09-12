# AGENTIC OS — MASTER BUILD PROMPT

> Paste everything below the line into Claude Code, running from the folder you want to become your
> Agentic OS workspace. It is written as a single self-contained execution contract.

---

## ROLE

You are my senior systems architect and implementation engineer. You are going to build my personal
**Agentic Operating System** — a file-based workspace that a coding agent (you) operates inside,
plus a visual **Command Centre** dashboard that renders the state of that workspace.

This is not a demo, a mockup, or a scaffold with TODOs. Every file you create must be complete and
runnable. Build it, run it, verify it, then report.

---

## 0 · THE GOVERNING IDEA (read this before you touch anything)

Two claims drive every decision below:

1. **The dashboard is only ~20–30% of the value.** The other ~70% is how the workspace underneath is
   organised so the agent works *with* the file system instead of fighting it. Never let dashboard
   polish come at the expense of the substrate.
2. **Organise for the agent, not for the human file-explorer.** The old instinct — tidy nested
   folders, careful filenames, a navigable tree — is obsolete when the reader is an agent that parses
   at machine speed. What the agent needs instead is **router files**: short index documents that say
   "for this domain, these are the skills and references." Optimise for *fewest steps to the right
   file*, not for human browsability.

The architecture is the **ARMS framework** — four layers, learned and built **bottom-up**:

```
        ┌─────────────────────────────────────────────┐
   A    │  APPLICATIONS   connectors + micro-apps      │  ← build 4th
   R    │  ROUTINES       scheduled / unattended work  │  ← build 3rd
   M    │  MEMORY         router files + second brain  │  ← build 2nd
   S    │  SKILLS         reusable SOPs                │  ← build 1st
        └─────────────────────────────────────────────┘
```

Each layer has three maturity levels. Build **Level 1 → 2 → 3 within a layer** before moving up a
layer. Do not build the dashboard until Skills and Memory are real, because the dashboard renders
them — with nothing underneath it is a shell.

---

## 1 · REQUIREMENTS LOCK

Before writing any code, restate the following as an explicit checklist and confirm each is
understood. Nothing here may be silently dropped.

| # | Requirement |
|---|---|
| R1 | Skills layer: L1 catalogue, L2 rich multi-file skills with a router `SKILL.md`, L3 headless execution |
| R2 | Memory layer: L1 workspace audit, L2 `CLAUDE.md` + department router files, L3 visual second brain graph |
| R3 | Routines layer: L1 local scheduled tasks, L2 always-on cloud execution + file sync, L3 single-host consolidation path |
| R4 | Apps layer: L1 connector catalogue, L2 `search-connectors` skill, L3 custom connectors + micro-apps |
| R5 | Command Centre dashboard: calendar, email triage, routines board, skills deck, artifacts ring, custom widgets, micro-app launcher |
| R6 | Dashboard widgets must be resizable, repositionable, persistent, and new ones addable |
| R7 | Skills deck must expose **model** and **effort level** per run and execute headlessly |
| R8 | Zero npm dependencies; static files only; opens by double-clicking an HTML file |
| R9 | Everything reads from real workspace files — no hardcoded mock data in the shipped build |
| R10 | Dark theme, dense instrument-panel aesthetic, keyboard reachable, responsive |

---

## 2 · HARD CONSTRAINTS

- **Zero npm dependencies. Zero build step.** Vanilla HTML + CSS + ES modules. The dashboard must
  open from `file://` by double-click, and also serve correctly over a static HTTP server.
- **No frameworks, no bundler, no CDN-at-runtime requirement.** If you need a library, vendor it as a
  single local file and justify it in one line.
- **Filesystem is the database.** No SQL, no external service, no account. State lives in JSON and
  Markdown inside the workspace. The dashboard is a *view* over those files.
- **Read-mostly by default.** The dashboard may write only to `os/state/` (layout, preferences) and
  to `os/queue/` (run requests). It never mutates skills, memory, or artifacts directly.
- **Never invent data.** If a data source is missing, the widget renders an explicit empty state
  naming the file it expected. Do not fabricate placeholder content that could be mistaken for real.
- **Secrets never land in the repo.** Environment variables or the OS keychain only. Add a
  `.gitignore` that excludes `os/state/`, `os/queue/`, `.env`, and all credential material.
- **Destructive operations require a dry-run and an explicit confirm.** Anything that deletes, moves,
  or overwrites outside `os/state/` prints a diff and waits.

---

## 3 · WORKSPACE LAYOUT

Create exactly this structure. Ask before overwriting anything that already exists.

```
<workspace>/
├── CLAUDE.md                     # ROOT ROUTER — the single entry point for the agent
├── .gitignore
│
├── routers/                      # department routers, one per domain of work
│   ├── content.md
│   ├── clients.md
│   ├── ops.md
│   └── research.md
│
├── .claude/
│   └── skills/
│       ├── <skill-name>/
│       │   ├── SKILL.md          # router: when to use, how to run, which refs to load
│       │   └── references/       # the substance: HTML/MD/JSON/scripts
│       └── ...
│
├── os/
│   ├── index.html                # THE COMMAND CENTRE
│   ├── css/
│   │   ├── tokens.css            # design tokens — the single source of visual truth
│   │   └── app.css
│   ├── js/
│   │   ├── main.js               # boot, routing, layout engine
│   │   ├── grid.js               # drag / resize / persist
│   │   ├── registry.js           # widget registration
│   │   └── widgets/*.js          # one module per widget
│   ├── apps/                     # micro-apps, each a standalone page
│   │   ├── second-brain/
│   │   ├── generations/
│   │   ├── artifacts/
│   │   └── canvas-pad/
│   ├── data/                     # generated snapshots the UI reads
│   │   ├── graph.json
│   │   ├── skills.json
│   │   ├── routines.json
│   │   ├── artifacts.json
│   │   └── generations.json
│   ├── state/                    # user layout + prefs (gitignored)
│   ├── queue/                    # headless run requests + results (gitignored)
│   └── bin/                      # the indexers and the run bridge
│       ├── index-workspace.mjs
│       ├── index-skills.mjs
│       ├── index-artifacts.mjs
│       └── run-skill.sh
│
├── artifacts/                    # everything the agent produces, dated
│   └── YYYY-MM-DD/<client-or-topic>/
└── generations/                  # image + video outputs
```

---

## 4 · LAYER S — SKILLS  *(build first)*

**Principle: when you catch yourself prompting for the same task twice, it becomes a skill.**

### S1 — Catalogue what exists
Inventory every skill already available to me (pre-built and personal). Write
`routers/skills-index.md`: name, one-line purpose, trigger, whether it is thin or rich. Flag
duplicates and dead skills. Do not delete anything yet — report first.

### S2 — Rich skills (this is the part almost everyone gets wrong)

A skill is **not** a single markdown file. A thin skill is one `SKILL.md` with everything crammed in;
it degrades as it grows. A rich skill uses `SKILL.md` as a **router** that points to reference files
holding the actual substance.

Build my flagship rich skill — the **brand / design-system skill** — as the reference implementation:

```
.claude/skills/brand/
├── SKILL.md                  # router only: when to invoke, decision tree, which ref to load when
└── references/
    ├── brand.html            # LIVE visual reference — renders the actual system in a browser
    ├── typography.md         # families, weights, scale, line-height, tracking, pairing rules
    ├── palette.md            # named tokens + hex + contrast ratios + when to use each
    ├── layout.md             # grid, spacing scale, radii, elevation, density rules
    ├── voice.md              # tone, vocabulary, banned phrases
    └── examples/             # 3+ finished artifacts that exemplify the system
```

`brand.html` matters more than any prose file: a skill aimed at design work should carry a **visual**
reference the agent can open and read directly, not a description of one.

Then convert my other fat skills the same way: `SKILL.md` becomes a router; substance moves into
`references/`. For each conversion, report before/after token weight of the always-loaded portion.

**Acceptance test for S2:** a prompt of the form *"make a PDF guide with /brand on how to set up an
Agentic OS"* must produce a correctly-branded, well-designed artifact in **one or two prompts**, with
no styling instructions in the prompt itself. If it takes more, the skill is under-specified — fix
the references, not the prompt.

### S3 — Headless execution

Skills must be runnable **without opening a chat session**, so the dashboard (and any internal tool)
can trigger them.

Implement `os/bin/run-skill.sh`:

```bash
# Contract:
#   run-skill.sh --skill <name> [--model <model>] [--effort <low|medium|high>] [--arg k=v]...
# Behaviour:
#   - spins up a one-shot non-interactive agent run whose entire prompt is the slash command
#   - streams stdout to os/queue/<run-id>.log
#   - writes os/queue/<run-id>.json  { runId, skill, model, effort, status, startedAt,
#                                      finishedAt, exitCode, summary, reportPath }
#   - writes a human-readable report to artifacts/<date>/runs/<run-id>.md
#   - exit non-zero on failure; never swallow an error
```

Requirements: model and effort must be **per-run parameters**, not baked in. Runs must be
idempotent-safe, cancellable, and must fail loudly. Build one real end-to-end example — a
**system cleanup / maintenance skill** — and actually execute it, so the dashboard has a genuine run
report to render.

---

## 5 · LAYER M — MEMORY  *(build second)*

### M1 — Audit the real cost

Scan the workspace and report honestly: total files, total directories, deepest nesting, largest
directories, file-type histogram, duplicates, and anything that would make retrieval slow. Name the
specific hot spots. (Assume the number is far larger than I think — workspaces routinely hit tens of
thousands of files, which is exactly what makes agent retrieval slow and usage expensive.)

Output `artifacts/<date>/memory-audit.md` with a prioritised remediation list. **Do not delete
anything.** Propose; I decide.

### M2 — Router files (the core of the whole system)

Build the two-tier router.

**`CLAUDE.md` — the root router.** Short. Its job is to route, not to explain. It contains:
- what this workspace is, in two lines
- the department table: domain → router file → when to use it
- global conventions (where artifacts go, naming, dating, the artifact contract)
- the standing rules that must never be violated
- explicitly: *what NOT to load* by default

**`routers/<department>.md` — one per domain.** Each is a flat index of:
- the skills relevant to this domain, with trigger conditions
- the reference files, with a one-line description of what each answers
- active projects and where their state lives
- the domain's own conventions

Rules for every router:
- Links are **relative paths that actually resolve** — verify each one programmatically.
- Every entry carries a one-line "what this answers" so the agent can choose without opening it.
- Routers are indexes, never content. If a router starts explaining, the explanation belongs in a
  reference file.
- Add a `make check-routers` equivalent script that fails if any link is dead. Run it.

### M3 — Visual second brain

Build `os/apps/second-brain/` — a force-directed graph of the workspace.

- `os/bin/index-workspace.mjs` walks the workspace and emits `os/data/graph.json`:
  nodes `{id, path, type: router|skill|reference|artifact|project, title, size, mtime, tags}`,
  edges `{source, target, kind: routes-to|references|produced-by}`. Edges come from **parsing actual
  links** in routers and `SKILL.md` files — not from directory adjacency.
- Render: canvas-based force layout. Node colour by type, radius by connection count. Pan, zoom,
  drag-to-pin.
- **Instant search** — type-ahead across every node; matches highlight, the graph flies to them,
  neighbours stay lit and the rest dims. Finding a named skill must take one keystroke sequence and
  land directly on it. This is the primary reason the graph exists: it must beat the file explorer
  decisively.
- **Inline preview** — clicking a node opens a side panel rendering the file (Markdown rendered,
  HTML in a sandboxed frame, images inline) without leaving the graph.
- Cluster by department, with a legend and per-type filter toggles.
- Must stay smooth at 10k+ nodes: quadtree/Barnes-Hut, viewport culling, and level-of-detail that
  hides labels when zoomed out.

---

## 6 · LAYER R — ROUTINES  *(build third)*

A routine is simply **a prompt the agent sends to itself on a schedule.**

### R1 — Local routines
Define my routines as version-controlled specs in `routines/<name>.md` — schedule, the exact prompt,
the skill it invokes, expected output path, and failure behaviour. Register them with the local
scheduler. Every routine writes its artifact into `artifacts/<date>/` so it surfaces on the dashboard.

Build one real, useful routine end-to-end as the reference: **a daily content-repurposing routine** —
detects a new published piece, drafts a derived long-form post in my voice using my brand skill,
saves 2–3 alternative drafts to `artifacts/<date>/`, and surfaces them in the dashboard for review.
Target: ~70–80% production-ready, needing only light edits.

**State the limitation explicitly in the docs:** local routines only fire while this machine is
awake. That is the reason R2 exists.

### R2 — Always-on execution
Design and document the always-on path: routines run on a machine that is always up, so they fire
whether or not my laptop is on.

- Evaluate the available always-on agent hosts and pick one; justify in three bullets against cost,
  control, and setup friction. Do not silently assume — present the comparison.
- **Solve the context problem, which is the part most people miss.** An always-on agent on its own
  machine has none of my skills or memory. Set up **continuous file sync** between this workspace and
  the remote host, scoped deliberately:
  - **sync:** `.claude/skills/`, `routers/`, `CLAUDE.md`, `routines/`
  - **never sync:** `os/state/`, `os/queue/`, `.env`, credentials, `generations/` (bulk media)
  - handle conflicts explicitly; document the resolution rule; verify a round-trip with a real edit.
- Build the **routines firing board** data source: `os/data/routines.json` merges local and remote
  routines into one list with `{name, host, schedule, nextFire, lastRun, lastStatus, artifactPath}`.

### R3 — Consolidation path
Document — as a decision record, not code — the end-state where a single always-on host runs the
agent, the workspace, and the routines together, eliminating the sync layer entirely. Include the
migration steps, and the storage/security trade-offs that make it a *planned* move rather than
today's default. Mark it clearly as **not yet implemented**.

---

## 7 · LAYER A — APPLICATIONS  *(build fourth)*

### A1 — Connector inventory
Catalogue every app I currently connect to, by integration type (official connector / CLI / API /
MCP), with auth method and scope. Write `routers/connectors.md`. Flag over-scoped permissions.

### A2 — The `search-connectors` skill
Build a rich skill that, given an application name, does the research *for* me:

1. searches for an **official** connector first
2. if none, searches for community options in the three real formats — **CLI, API, MCP**
3. compares them on maintenance recency, popularity, permission scope, and auth model
4. **runs a safety review** of the recommended option — what it can read, what it can write, what it
   sends off-machine, and any obvious red flags
5. emits a recommendation with a reasoned trade-off, then, on my explicit approval, performs the setup

The safety review is mandatory and never skippable. Never auto-install; always present findings and
wait for a yes.

### A3 — Build connectors and micro-apps

**Custom connectors.** For applications with no usable connector, generate a proper CLI wrapper:
typed commands, `--help`, `--dry-run` on every mutating operation, structured JSON output, retry with
backoff, clear error messages, and credentials read from the environment only. Ship it with a README
and a smoke test that actually runs.

**Micro-apps.** Each is standalone, dependency-free, and opens on its own:

- **Generations gallery** — a masonry grid of every image and video output, newest first. Lazy-loaded
  thumbnails, hover-to-play video preview, filter by type/date/project, click for full view with
  metadata, copy-path button. Reads `os/data/generations.json`.
- **Artifacts ring** — a radial/orbital browser of everything the agent has produced, arranged by
  recency. **Search by client or topic** and open the exact artifact — including opening a generated
  HTML file from a specific past date directly in the browser. Reads `os/data/artifacts.json`
  (`{path, title, project, client, type, createdAt, tags, preview}`).
- **Canvas pad** — a landing surface where diagram artifacts the agent produces get dropped, kept,
  arranged, and reused across projects.

---

## 8 · THE COMMAND CENTRE  *(build last — it renders everything above)*

`os/index.html` is my homepage. Dense, instrument-panel, information-first. It answers "what is the
state of my world right now" in a single glance, with no scrolling required for the primary row.

### 8.1 Layout engine

- CSS Grid canvas, 12 columns, 8px base unit, uniform gutters.
- Every widget is **drag-repositionable** and **resize-by-corner**, snapping to grid.
- Layout persists to `os/state/layout.json` and restores exactly on reload.
- **Adding a new widget is a first-class action** — a registry in `js/registry.js` where a widget is
  `{id, title, defaultSize, dataSource, render(el, data), refreshInterval}`. Document how to add one
  in under 20 lines, because I will be asking you to generate new widgets constantly.
- An "edit layout" mode toggles drag/resize handles so normal use never triggers accidental drags.
- Breakpoints: full grid ≥1440px, condensed 2-column 768–1439px, single-column stack <768px.

### 8.2 Required widgets

| Widget | Contents |
|---|---|
| **Calendar** | Today + next 7 days. Multiple **time zones** side by side (I work across regions). Now-line, conflict highlighting, click-through to the event. |
| **Email triage** | Unread count, sender + subject digest, and a distinct **"needs your attention"** lane holding only what the agent has explicitly flagged, with its one-line reason for flagging. |
| **Routines board** | Every routine, local and remote, with **next fire time**, last status, and the host it runs on. Sort by next-fire. Colour-code overdue / failed / healthy. |
| **Skills deck** | Grid of runnable skills. Each tile: name, purpose, **model selector**, **effort selector** (low/medium/high), and a **Run** button executing headlessly via `run-skill.sh`. Live status while running; on completion, a link to the run report. |
| **Micro-app launcher** | Tiles linking to each micro-app, with pixel-art or iconographic identity per app. |
| **Custom metric widget** | A configurable data widget (my primary use: channel/content performance) reading from a local JSON snapshot. Proves the "add your own widget" path works. |
| **Artifacts strip** | The most recent artifacts, with search-to-open. |
| **Second-brain entry** | A visually prominent **centre element** — clicking it opens the full graph. This is the anchor of the dashboard, not a sidebar link. |

### 8.3 Design system

Write these as tokens in `os/css/tokens.css`. Treat the values below as a **calibrated starting
point** for a dark, dense, high-signal control surface — then tune them against my brand skill and
tell me exactly what you changed.

```css
:root {
  /* ground — deep desaturated navy-black, not pure black */
  --bg-void:      #0A0C12;   /* page ground */
  --bg-panel:     #111420;   /* widget surface */
  --bg-raised:    #171B2B;   /* hover / nested */
  --border:       #232838;   /* 1px hairlines, everywhere */
  --border-hot:   #2E3550;   /* focused / dragging */

  /* text */
  --fg:           #E6E9F2;
  --fg-dim:       #8A92A8;   /* labels, metadata */
  --fg-faint:     #565E75;   /* disabled, timestamps */

  /* accents — amber is primary; keep the palette tight */
  --accent:       #F5A524;   /* primary action, active state, now-line */
  --accent-soft:  #F5A52422;
  --ok:           #35C08E;
  --warn:         #F5A524;
  --err:          #F2555A;
  --info:         #5B8DEF;

  /* type — monospace for data, sans for prose */
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  --font-sans: Inter, -apple-system, "Segoe UI", system-ui, sans-serif;
  --fs-label: 10px;   /* uppercase, letter-spacing .08em — widget headers */
  --fs-body:  13px;
  --fs-data:  15px;   /* mono, tabular-nums */
  --fs-hero:  28px;

  --space: 8px;       /* everything is a multiple */
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 1px 0 #FFFFFF08 inset, 0 8px 24px #00000059;
}
```

Rules:
- **Widget headers** are uppercase micro-labels in `--fg-dim` at `--fs-label` with wide tracking —
  the label recedes, the data dominates.
- **All numerals use `font-variant-numeric: tabular-nums`** so columns align and values don't jitter
  on refresh.
- **Hairline borders, not shadows,** separate panels. One subtle shadow for lift; no glow soup.
- **One accent colour carries meaning.** Amber = active/now/primary. Semantic colours only for
  status. Never decorative.
- **Density over whitespace** — this is an instrument panel, but never at the cost of a 4.5:1 contrast
  minimum on text and 3:1 on meaningful borders.
- **Motion is functional and fast**: 120–180ms, `ease-out`, only on state change. Respect
  `prefers-reduced-motion` and disable transforms entirely when set.
- **Empty and error states are designed, not default.** An empty widget names the file it expected
  and offers the command that would populate it.
- Full **keyboard reachability**: every control tabbable, visible focus rings, `/` focuses global
  search, `Esc` closes overlays, arrow keys move a selected widget in edit mode.

### 8.4 Data flow

```
workspace files ──► os/bin/index-*.mjs ──► os/data/*.json ──► widgets (fetch + render)
dashboard "Run" ──► os/queue/<id>.json ──► run-skill.sh ──► artifacts/ + queue result ──► UI polls
```

- Indexers are idempotent, incremental where possible, and runnable on demand or on a schedule.
- Widgets degrade independently: one bad JSON file must not blank the dashboard. Wrap each widget
  render in an error boundary that shows a per-widget error tile.
- Poll `os/queue/` on a short interval for run status; no websockets, no server requirement.

---

## 9 · BUILD ORDER

Work in these milestones. **Verify each by execution before starting the next**, and show me the real
output at each gate.

1. **M1 audit** → memory audit report. *(gate: report exists, numbers are real)*
2. **M2 routers** → `CLAUDE.md` + department routers. *(gate: link-check script passes)*
3. **S1–S2 skills** → catalogue + brand skill converted to rich form + others migrated.
   *(gate: the one-prompt branded-artifact test passes)*
4. **S3 headless** → `run-skill.sh` + one real skill executed. *(gate: a genuine run report exists)*
5. **M3 second brain** → indexer + graph app. *(gate: search finds a named skill in one query, and it
   is demonstrably faster than the file explorer)*
6. **R1 routines** → specs + one working scheduled routine. *(gate: it fires and produces an artifact)*
7. **R2 always-on** → host chosen, sync configured, round-trip verified. *(gate: an edit propagates)*
8. **A1–A2 connectors** → inventory + `search-connectors` skill. *(gate: run it on a real app)*
9. **Dashboard** → grid engine, then widgets one at a time against real data.
10. **A3 micro-apps** → generations, artifacts ring, canvas pad.
11. **R3 + docs** → decision record, README, and a `SETUP.md` that lets me rebuild from scratch.

---

## 10 · ACCEPTANCE CRITERIA

Do not report done until every line is true **and you have executed the check**:

- [ ] `os/index.html` opens by double-click with no server and no network; zero console errors.
- [ ] Every widget renders from a real file in `os/data/`; no mock data in the shipped build.
- [ ] Drag a widget, resize it, reload — the layout is exactly as left.
- [ ] Skills deck runs a real skill headlessly with a chosen model and effort, and links the report.
- [ ] Second-brain search locates a named skill in one query and previews it inline.
- [ ] Router link-check passes with zero dead links.
- [ ] At least one routine has actually fired and produced a dated artifact.
- [ ] Artifacts ring finds an artifact by client name and opens the generated HTML.
- [ ] Responsive at 1440 / 1024 / 390 px wide; no horizontal page scroll.
- [ ] Keyboard-only operation of every control; visible focus throughout.
- [ ] Contrast meets 4.5:1 on text; `prefers-reduced-motion` honoured.
- [ ] No secrets in the repo; `.gitignore` verified against `git status`.
- [ ] `SETUP.md` reproduces the system on a clean machine.

---

## 11 · HOW TO REPORT

When finished, give me exactly this — no padding:

- **Built** — files and paths created, grouped by ARMS layer.
- **Verified** — the exact commands you ran and their real output. Distinguish what you *executed*
  from what you only *inspected*. Never claim a test passed that you did not run.
- **Assumptions** — every judgement call you made, labelled, with the alternative you rejected.
- **Not covered** — what is stubbed, deferred, or untested, and why.
- **Needs my input** — anything genuinely blocking, batched into one list.

If something is broken and you cannot fix it, say so with the failing output. Do not hand me a green
report over a red system.

---

## 12 · WORKING RULES

- Resolve ambiguity with a labelled assumption and keep going. Stop only for something irreversible
  or genuinely blocking — and batch those questions rather than asking one at a time.
- Show me the plan before large multi-file work; show me the diff before destructive changes.
- Prefer the boring, proven approach. Every dependency and every clever abstraction needs a one-line
  justification.
- When a file exceeds what a chat message can hold, write the complete file to disk and summarise it.
  Never truncate real logic to fit a reply.

**Start with Milestone 1. Run the memory audit and show me the real numbers before you build anything.**

# 07 — Adversarial Review of AgenticOS

Hostile review of the merged tree at `AgenticOS/`, pristine controls at `_src/agno-main`
and `_src/openclaw-main`.

**Method.** Everything below marked CONFIRMED was reproduced by executing code in this
session. Reproduction commands are given inline. Scripts live in `/tmp/adv/`.

**Tree state.** I modified exactly two files (`bridge/py/agenticos_bridge/contract.py`,
`bridge/ts/src/contract.ts`) to prove gates red/green, and created one throwaway
`agno/_probe.py`. All were restored and **re-verified byte-identical by md5**; the probe
was deleted; no brain-server processes were left running; `agenticos verify` is green at
exit, exactly as found. Note: `bridge/ts/tsconfig.json`, `scripts/check-deletion-ledger.py`
and `docs/analysis/` appeared in the tree *during* this review (mtimes 01:22–01:24) — **not
mine**; a concurrent writer is active in this workspace.

---

## Verdict

The merge is real and the deletion bookkeeping is genuinely good — better than most
work of this kind. The **deletion ledger is accurate to the file** and the headline
"0 regressions vs pristine control" claim **survives** a proper set-diff of failing test
IDs. That is the strongest part of the deliverable.

The bridge, however, is not what its own docstrings say it is. Three of its four
advertised safety properties are false, and I broke each of them by execution:

1. **The approval gate does not gate anything.** A denied or timed-out approval emits
   `run.failed` and then *lets the agent continue and run the tool it was asked to
   approve*. This is the single worst defect in the system.
2. **"Exactly one terminal event" is false** — the same path emits two.
3. **"No path ends a stream without a terminal event" is false** — a non-`str` `run_id`
   ends the stream with zero terminal events.
4. Every brain-plane failure reaches the edge as the literal string `"RunError"`, with
   the real cause discarded — on 100% of failures, not an edge case.

The **gates cannot enforce any of this**. `agenticos verify` is green against a
deliberately corrupted TypeScript contract; the deletion-integrity "import every package"
check verifies *nothing* under the interpreter the CLI actually invokes; and the committed
CI workflow **cannot pass** — two of its five jobs exit non-zero on a clean checkout, and
the repository has **zero commits** with `planes/` untracked, so `actions/checkout` would
produce a tree without either plane.

Readiness: **NOT PRODUCTION-READY.** The architecture and the merge audit are sound; the
bridge's safety layer and the gate layer are not yet doing their jobs.

---

## CONFIRMED defects (ranked)

### C1 — CRITICAL · A denied or timed-out approval does not stop execution
**What breaks.** `_handle_pause()` yields `run.failed` on deny/timeout and then simply
returns from the *inner* generator. The outer `async for ev in stream` in `_run()` keeps
consuming Agno events, so the gated tool executes anyway, and `_run()` then emits a second
terminal `run.completed`. The edge plane sees `run.failed` first, returns, and never learns
the brain plane went ahead. Human-in-the-loop approval is decorative.

**Trigger / reproduction**
```bash
cd .../scratch-2026-09-05-73a274
PYTHONPATH=AgenticOS/bridge/py ./.venv/bin/python /tmp/adv/atk1_approval.py
```
Observed (deny case), verbatim:
```
run.started → output.delta → approval.required
run.failed  {'error': 'approval denied by operator', 'retryable': False}
tool.started   {'tool': 'wire_money', 'args_preview': '{"amt":1000000}'}
tool.completed {'tool': 'wire_money', 'ok': True}
run.completed  {'output': 'thinking...', 'usage': {'tool_calls': 1}}
  terminal events: 2 -> ['run.failed', 'run.completed']
  SIDE EFFECTS AFTER DENY: ['WIRED $1,000,000']
```
Identical result for the timeout case. `server.py:335-336` (deny) and `:329-330` (timeout).

**Minimal fix.** Make the pause outcome terminate the turn. Have `_handle_pause` report a
decision to the caller and have `_run` `return` on deny/timeout, closing the Agno stream:
```python
elif name in _PAUSED:
    stop = False
    async for frame in self._handle_pause(req, ev, on_stop=lambda: ...): yield frame
    if stop: await stream.aclose(); return
```
Simplest correct form: have `_handle_pause` yield `(frame, terminal: bool)` and `return`
from `_run` when `terminal` is true.

---

### C2 — CRITICAL · The committed CI workflow cannot pass, and the repo has no commits
**What breaks.** Three independent problems, any one of which makes CI red.

**(a) `merge-integrity` job exits 1.** It runs `pip install -e planes/brain/libs/agno`
then `python scripts_audit_dangling_refs.py`. In a from-scratch CI-equivalent venv that is
exactly what I built, the script reports **79 "BROKEN PACKAGE IMPORTS"** — every one of
them an *optional third-party* dep (chromadb, qdrant, boto3, …), not a deletion problem.
The script's `except ImportError: broken.append(...)` catches agno's own friendly
optional-dep guards, which raise plain `ImportError` rather than `ModuleNotFoundError`.
```bash
python3 -m venv /tmp/adv/civenv
/tmp/adv/civenv/bin/pip install -e AgenticOS/planes/brain/libs/agno
cd AgenticOS && /tmp/adv/civenv/bin/python scripts_audit_dangling_refs.py; echo $?
# -> BROKEN PACKAGE IMPORTS: 79 ; exit 1
```

**(b) `brain` job exits 1.** The exact CI command yields
`56 failed, 4653 passed, 38 skipped, 184 errors` → **exit 1**. `--continue-on-collection-errors`
lets collection continue but does not make pytest exit 0.

**(c) Nothing is committed.** `git rev-list --all --count` = **0**; `git ls-files planes` =
**0**; `README.md` and `docs/DELETION-LEDGER.md` are untracked. `actions/checkout` would
yield a tree with no `planes/`, so `pip install -e planes/brain/libs/agno` fails outright.

**Minimal fix.** (a) treat *any* import error whose missing module is not `agno.*` as
out-of-scope — inspect `exc.name` and also parse the friendly re-raises, or import with a
stubbed-out optional-dep set; (b) pin the known-failing set as an xfail baseline, or scope
the job to the subset that is green; (c) commit the tree.

---

### C3 — HIGH · The deletion-integrity "second check" verifies nothing where it runs
**What breaks.** `bin/agenticos:142` hardcodes `run("python3", ...)` — the *system*
interpreter, not `python()`/`.venv`. System `python3` has no `pydantic`, so every
`importlib.import_module("agno.*")` raises `ModuleNotFoundError(name='pydantic')`, which
the `startswith("agno")` filter swallows. The gate then prints
**"OK: 193 surviving agno packages import cleanly"** having imported **zero** packages, and
exits 0.

This is the check the DELETION-LEDGER explicitly leans on ("Static scan alone proved
insufficient… The gate now imports every surviving package: a second, differently-shaped
check"). It is inert exactly where it is invoked.

**Reproduction**
```bash
cd AgenticOS
python3 -c "import sys;sys.path.insert(0,'planes/brain/libs/agno');import agno.agent"
# ModuleNotFoundError: No module named 'pydantic'
python3 scripts_audit_dangling_refs.py; echo $?   # "OK: 193 ... cleanly" ; exit 0
```
The same script under the venv exits 1 (see C2a). So the gate is **vacuously green where
it runs and falsely red where it means something** — both failure modes of one check.

**Minimal fix.** Use `python()` in `bin/agenticos:142`, and hard-fail if `import agno`
itself does not work, so an unusable interpreter can never be mistaken for a clean run:
```python
try: importlib.import_module("agno")
except Exception as e: print(f"gate cannot run: {e}"); return 2
```

---

### C4 — HIGH · Every brain-plane failure reaches the edge as the string "RunError"
**What breaks.** `server.py:276` reads `getattr(ev, "error", "")`. Agno's `RunErrorEvent`
has **no `error` field** — the message is in `.content`; `RunCancelledEvent` uses `.reason`.
So the fallback `or name` always wins and the operator receives `error: "RunError"` with
the real cause discarded. This fires on 100% of run failures.

**Reproduction**
```bash
PYTHONPATH=AgenticOS/bridge/py ./.venv/bin/python /tmp/adv/atk6_errfield.py
```
```
RunErrorEvent      has 'error' attr? False   fields=['content','error_type','error_id']
RunCancelledEvent  has 'error' attr? False   fields=['content','reason']
run.failed.error = 'RunError'          # real cause was "DATABASE CREDENTIALS REJECTED"
```
(`ToolCallErrorEvent` *does* have `.error`, so the tool path is fine.)

**Minimal fix.**
```python
detail = getattr(ev, "content", None) or getattr(ev, "reason", None) \
         or getattr(ev, "error", None) or name
yield _sse(RunFailed(turn_id=req.turn_id, error=str(detail), ...))
```

---

### C5 — HIGH · The TypeScript half of the contract has zero enforcement
**What breaks.** `bridge/ts/src/contract.ts` states *"`contract.parity.test.ts` fails the
build if this file drifts from it, so 'single source of truth' is enforced rather than
merely asserted in a comment."* **That file does not exist** (`find -name
'contract.parity.test.ts'` → 0 results). Nothing type-checks `bridge/ts` either: no `tsc`
step in CI, pre-commit, or the CLI; Node 26 strips types without checking them.

**Reproduction — I corrupted the TS contract and every gate stayed green:**
```bash
# removed the reasoning.delta member AND broke isTerminal:
#   return ev.type === "run.completed";      // run.failed no longer terminal
node bin/agenticos verify        # -> "All gates passed."  exit 0
scripts/hook-contract-parity.sh  # -> exit 0
```
Breaking `isTerminal` this way would make the edge client treat every failed turn as
non-terminal and hang — and no gate notices. **Restored, md5-verified.**

For contrast, the Python side genuinely works: deleting `ReasoningDelta` from the union
made `test_contract_parity.py::test_every_schema_event_has_a_python_model` fail. Restored.

**Minimal fix.** Write the missing `bridge/ts/src/contract.parity.test.ts` (parse
`turn.schema.json`, assert the `TurnEvent` union's `type` literals match `$defs.TurnEvent.oneOf`),
add it to `node --test` in `verify()` and to CI, and add a `tsc --noEmit` step for `bridge/ts`.

---

### C6 — HIGH · A stream can end with no terminal event
**What breaks.** `server.py` docstring: *"There is no path that ends a stream without
either `run.completed` or `run.failed`."* The final `RunCompleted(...)` is constructed at
lines 298-308, **outside** the `try/except`. `run_id` is captured with
`getattr(ev, "run_id", None)` from *any* event and is typed `Optional[str]`, so a non-`str`
value (UUID object, int PK) raises `ValidationError` after the `except` blocks — the
generator dies mid-stream having emitted no terminal event.

**Reproduction**
```bash
PYTHONPATH=AgenticOS/bridge/py ./.venv/bin/python /tmp/adv/atk2_noterminal.py
```
```
VECTOR A: UUID run_id -> ValidationError: run_id Input should be a valid string
  >>> STREAM ENDED WITH NO TERMINAL EVENT
```
Reachability: stock Agno emits `str` run_ids (I verified this for agent, team and workflow
targets), so this needs a custom executor or a future Agno change — but the guarantee is
stated absolutely, and the TS client's own fallback is what actually saves the edge plane,
not the server.

**Minimal fix.** Move the terminal emit inside the try, coerce defensively, and add a
`finally` that guarantees an ending:
```python
run_id = str(rid) if (rid := getattr(ev, "run_id", None)) is not None else run_id
```
plus a `terminal_sent` flag with a `finally:` that emits `RunFailed` if still false.

---

### C7 — MEDIUM-HIGH · The dangling-ref scanner misses 8 of 10 import forms
**What breaks.** The regex `^\s*(?:from\s+MOD(?:\.|\s)|import\s+MOD(?:\.|\s|$))` only
matches fully-qualified module paths at line start.

**Reproduction** (each form planted against the deleted `agno.tools.shell`):
```
from agno.tools.shell import ShellTools   DETECTED
import agno.tools.shell                   DETECTED
from agno.tools import shell              MISSED   <-- most idiomatic form
from .tools.shell import ShellTools       MISSED
from . import shell                       MISSED
importlib.import_module('agno.tools.shell')  MISSED
__import__('agno.tools.shell')            MISSED
if TYPE_CHECKING: from agno.tools import shell  MISSED
x = 1; import agno.tools.shell            MISSED
ENTRY = "agno.tools.shell:ShellTools"     MISSED
```
Non-`.py` referrers are never scanned at all (`rglob("*.py")` only) — YAML/JSON/TOML
config and `pyproject` entry-points are invisible.

The critical part: `from pkg import submodule` is **precisely the shape** of the
`from agno.client import AgentOSClient` miss the ledger documents, and the "second check"
meant to cover it is C3-inert. Both layers fail on the same class.

**Minimal fix.** Replace the regex with an AST walk (`ast.Import` / `ast.ImportFrom`,
resolving `level>0` relative imports against the file's package) plus a literal-string scan
for the dotted path, and extend the file glob to `*.py *.toml *.yaml *.yml *.json *.cfg`.

---

### C8 — MEDIUM · Idempotency holds only for successful turns inside TTL and capacity
**What breaks.** Three ways the same `turn_id` executes twice:
- **Capacity eviction.** At `max_entries` the store drops the oldest decile *by age*, not
  by completion. A still-relevant key is evicted and becomes replayable.
- **TTL expiry.** After `ttl_seconds` (default 3600) the key is replayable — which is the
  same window as the "gateway restart replays an in-flight turn" scenario the docstring
  names as its motivation.
- **Release on failure.** `server.py:294` releases the claim inside the generic
  `except Exception`, so any failing turn is replayable by design.

**Reproduction**
```bash
PYTHONPATH=AgenticOS/bridge/py ./.venv/bin/python /tmp/adv/atk5_auth.py
```
```
claimed VICTIM-TURN; replay correctly blocked
after 120 further turns (max_entries=100): replay claim -> True
  >>> REPLAY ALLOWED — SAME turn_id EXECUTES TWICE
TTL=0s: replay claim -> True
```
**What held:** 8 concurrent POSTs with an identical `turn_id` over real HTTP produced
`[200, 409×7]` and exactly one execution — the `asyncio.Lock` is correct.

**Minimal fix.** Record a completion state, not just presence (`claiming` → `done`), never
evict a key in `claiming` state, and evict by *insertion order among completed keys only*.
Document that the in-memory store is single-process; the docstring already points at
Redis/Postgres — make that the default for any multi-worker deploy.

---

### C9 — MEDIUM · Non-ASCII `Authorization` header → HTTP 500, not 401
**What breaks.** `hmac.compare_digest` on `str` requires ASCII; anything else raises
`TypeError`, which is not an `HTTPException`, so FastAPI returns 500 with a server-side
traceback. An unauthenticated remote caller can force 500s and log noise at will.

**Reproduction** (server started with `AGENTICOS_BRIDGE_TOKEN=supersecret`):
```bash
curl -X POST http://127.0.0.1:8901/v1/turns -H "$(printf 'Authorization: Bearer s3cr3t\xc3\xa9')" ...
#   HTTP 500   <-- expected 401
#   TypeError occurrences in server log: 1
```
**Minimal fix.** Compare bytes: `hmac.compare_digest((authorization or "").encode(), expected.encode())`.

---

### C10 — MEDIUM · `/v1/bridge/health` is unauthenticated and leaks the executor registry
**What breaks.** The health route never calls `_authenticate`. With a token configured, an
anonymous caller still gets every agent/team/workflow id — the exact reconnaissance needed
to target `/v1/turns`.

**Reproduction**
```bash
curl -s http://127.0.0.1:8901/v1/bridge/health
{"status":"ok","contract":"turn.v1","executors":{"agent":["support"],"team":["triage"],"workflow":[]}}
```
**Minimal fix.** Return `{status, contract}` unauthenticated; gate `executors` behind
`_authenticate`.

---

### C11 — MEDIUM · TS client never cancels the response body
**What breaks.** `dispatch()` `return`s on the first terminal event (`client.ts:101`).
`parseSse`'s `finally` calls only `reader.releaseLock()` — the body is never `cancel()`ed,
so the HTTP response stays open and the undici connection is not returned to the pool.
It also means the brain plane keeps streaming into a socket nobody reads — which is what
lets C1's post-deny execution proceed unnoticed.

**Reproduction**
```bash
cd /tmp/adv/ts && node --test atk7.test.ts
#   events: run.started, run.completed
#   underlying body cancel() called? false   <-- DEFECT
```
**Minimal fix.** `finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }`,
and have `dispatch` abort the controller on early return.

---

### C12 — MEDIUM · `resolveApproval` has no timeout and no abort signal
**What breaks.** It calls `fetchImpl` with neither `signal` nor a timer, so a hung brain
plane hangs the approval path indefinitely — while `dispatch` is carefully bounded.

**Reproduction**: same test file — after 400 ms against a never-resolving fetch with
`timeoutMs: 100`, the call is `STILL HANGING`.

**Minimal fix.** Wrap in the same `AbortController` + `setTimeout(this.timeoutMs)` pattern
`dispatch` already uses.

---

### C13 — MEDIUM-LOW · Three real workflow pause events are silently dropped
**What breaks.** `_STEP_LIFECYCLE` maps `StepPaused` but not `ConditionPaused`,
`RouterPaused` or `StepExecutorPaused` (all real `WorkflowRunEvent` members). A workflow
that pauses inside a condition or router branch emits **no** `approval.required` — the
stream just goes quiet until something else ends it.

**Reproduction**: enumerated against the live enums —
```bash
PYTHONPATH=AgenticOS/bridge/py ./.venv/bin/python  # see /tmp/adv (enum sweep)
#  dropped  ConditionPaused -> ConditionPaused
#  dropped  RouterPaused    -> RouterPaused
#  dropped  StepExecutorPaused -> StepExecutorPaused
```
**Minimal fix.** Add all three to `_STEP_LIFECYCLE` mapping to `RunPaused`.

---

### C14 — LOW · `options.timeout_ms: 0` aborts the turn instantly
`turn.options?.timeout_ms ?? this.timeoutMs` — `??` preserves `0`, so `setTimeout(…, 0)`
aborts before the request completes. The server rejects `<1000`, but the client aborts
before the server ever sees it. Reproduced: single `run.failed "turn aborted or timed out"`.
**Fix:** `const ms = turn.options?.timeout_ms || this.timeoutMs;` (or validate `>= 1000`).

### C15 — LOW · `parseSse` does not handle CRLF frame separators
Splits only on `"\n\n"`. A spec-legal `\r\n\r\n` stream yields **0 events**, silently.
The Python server emits `\n\n`, so this only bites behind a proxy that rewrites line
endings. Reproduced: `CRLF frames parsed: 0`.
**Fix:** normalise `buf = buf.replace(/\r\n/g, "\n")` before splitting.

---

## SUSPECTED issues (reasoned, not reproduced)

- **S1 — Inner workflow-step failures hijack the outer turn.** A workflow stream nests
  *un-prefixed* inner `RunStarted`/`RunCompleted`/`RunError` events (I dumped this: the
  raw stream contains bare `RunStarted`, `RunContent`, `RunCompleted` between
  `StepStarted`/`StepCompleted`). `_normalize_event` erases the distinction and there is no
  check that an event belongs to the turn's own run, so a nested `RunError` hits
  `_TERMINAL_ERR` and terminates the whole bridge turn. I *did* observe this end-to-end
  (a failing step 1 produced `run.failed` and step 2 never reported), but Agno also
  cancelled the workflow itself, so I cannot cleanly separate bridge behaviour from Agno's.
  The structural hazard is real regardless: filter on `ev.run_id == top_level_run_id`.
- **S2 — `_authorize` with `scopes=None` raises `TypeError` → 500.** Confirmed by direct
  call; **not** reachable over HTTP because pydantic defaults `scopes` to `[]` and rejects
  `null`. Latent for any non-pydantic caller.
- **S3 — Substring scope matching.** `self._required_scope not in principal.scopes` does
  substring matching if `scopes` is ever a `str` (`"turn" in "turns:write"` → True).
  Pydantic blocks this over HTTP today; it is one model change away from being live.
- **S4 — `_resolve` inside `_run` (line 221) is outside the try** and runs lazily after the
  200 has been sent. A `register()`/deregister between the route check (line 367) and body
  evaluation yields an `HTTPException` inside the response body — zero events, no terminal.
- **S5 — `CancelledError` handler yields then re-raises** (`server.py:290-291`). Yielding
  during cancellation inside an async generator is fragile; the frame may never reach the
  client. Not reproduced under uvicorn.
- **S6 — First-step-only output.** `_TERMINAL_OK` appends inner content only `if not
  final_text`. A workflow whose first step streams no `RunContent` would capture that step's
  full content and then suppress the real `WorkflowCompleted` output.

---

## Overclaims found in docs

| # | Claim | Where | Reality |
|---|---|---|---|
| O1 | "193/193 packages import" | README, LEDGER | **Vacuous** under the interpreter `verify` uses (0 imported); **79 failures** under a real agno install (C2a/C3) |
| O2 | "20 vector stores" | README diagram + table | Merged has **18**. 20 is the *pristine* count — the merge deleted `langchaindb` + `llamaindex`, which the ledger itself lists as deletions. The README describes the merged system with a pre-merge number |
| O3 | "OpenClaw wins 14 areas, Agno wins 11" | README + DECISION-MATRIX headline | DECISION-MATRIX has **6** capability sections: 3 EDGE-wins, 3 SPLIT, **0** Agno-wins. Row-level bold tally is 21 OpenClaw / 9 Agno. **Neither reading yields 14/11** — unreproducible |
| O4 | "Both planes project their types from it and a parity test fails the build if they drift" | README | Only Python is parity-tested. `contract.parity.test.ts` **does not exist**; TS is never type-checked (C5) |
| O5 | "There is no path that ends a stream without `run.completed`/`run.failed`" | server.py docstring | **Refuted** (C6) |
| O6 | "terminating in exactly one of run.completed / run.failed"; "**exactly one terminal event** ends every stream" | README | **Refuted** — deny/timeout emits two (C1) |
| O7 | "Brain unit tests \| 4,653 passed" | README | True in the authoring venv, but silently omits **56 failed + 184 errors** (pytest exits 1). In a CI-equivalent venv it is **4,635 passed / 74 failed / 184 errors**. The LEDGER is more honest (mentions 56) but neither mentions the 184 errors |
| O8 | "Pre-commit hooks (incl. gitleaks) 9/9 passed" | README | 9/9 does pass locally, but the deletion hook passes **vacuously** (C3), and `hook-contract-parity.sh` **hard-fails (exit 1)** on any machine without a pytest-bearing interpreter — system `python3` here has no pytest |
| O9 | "`agenticos verify` — run every gate" / "run every verification gate" | README, CLI help | Runs 3 of 5 CI jobs. It never runs the brain unit suite or the edge suite, and gate 1 uses system `python3` rather than `python()` |
| O10 | "a redelivered `turn_id` is refused" | README | Only for turns that **succeeded**, within TTL and capacity (C8) |
| O11 | "Design rules the contract **enforces**" | README | The contract enforces shape (pydantic `extra="forbid"` is real). It does not enforce the terminal-event or approval rules — those are server logic, and they are broken |

---

## What held up under attack

Credit where it is due — I tried to break all of these and could not:

- **Deletion ledger path bookkeeping is exact.** All **23/23** deleted paths are absent
  from the merged tree *and* present in pristine (so no deletion is justified by a claim
  about a path that never existed). All **11/11** DEFERRED paths are still present.
- **"39 orphaned test files removed" is exact — and they are genuinely orphans.**
  `pristine − merged` = exactly 39 test files, and **all 39** reference at least one
  deleted module. Zero collateral removals. `added = 0`.
- **"0 regressions vs pristine control" is UPHELD.** I built two isolated venvs
  (pristine and merged agno installed editable, identical dep sets) and ran the identical
  suite. Both produce **258** failing/erroring node IDs and the sets are **identical** —
  `comm -13` and `comm -23` both return 0. This is a real, verified claim.
- **`72 paths / 113 operations`** — re-derived from a live `AgentOS` OpenAPI doc: exactly 72 and 113.
- **`14 DB backends`** (excluding `migrations`/`schemas`), **`23 knowledge readers`**,
  **"channel layer was 3 files"** (`integrations/` has exactly 3 `.py`) — all exact.
- **Edge tests `1,037 passed / 54 files`** — reproduced exactly (`54 passed (54)`, `1037 passed (1037)`).
- **Edge CLI `OpenClaw 2026.9.1`** — exact.
- **`4,653 passed`** reproduces exactly in the authoring venv.
- **The Python contract-parity gate genuinely goes red.** Removing `ReasoningDelta` from the
  union failed `test_every_schema_event_has_a_python_model`. This gate works.
- **Idempotency under concurrency is correct.** 8 simultaneous identical `turn_id` POSTs →
  `[200, 409, 409, 409, 409, 409, 409, 409]`, exactly one execution. The `asyncio.Lock` holds.
- **`parseSse` frame reassembly is solid.** I fed it a frame **one byte at a time**,
  splitting multi-byte UTF-8 mid-character (`héllo ✅`) — parsed correctly. The
  `TextDecoder({stream:true})` + buffer design is right.
- **Auth/authz work on the normal paths**: no token → 401, wrong scope → 403.
- **Workflow targets genuinely work.** I expected empty output (no `WorkflowRunContent`
  event exists) and was wrong: Agno nests inner agent events, so the bridge correctly
  assembled `STEP-ONE-OUTPUTSTEP-TWO-OUTPUT` with per-step `tool.started`/`tool.completed`.
- **The TS client's fail-closed fallback is real** and is what saves the edge plane from C6.
- **The deferred-vs-deleted discipline is honest** — refusing to delete paths with live
  consumers, and recording them, is the right call and is accurately documented.

---

## Minimal fix list (ordered)

1. **C1** — `_run` must `return` (and `aclose()` the Agno stream) after a denied or
   timed-out approval. Add a test asserting a denied approval produces exactly one terminal
   event and zero subsequent `tool.started`. *Highest priority: this is a safety control
   that currently does nothing.*
2. **C4** — read `ev.content` / `ev.reason` before `ev.error` when building `RunFailed`.
   One-line fix, restores all failure diagnostics.
3. **C2c** — commit the tree (`planes/`, `README.md`, `docs/DELETION-LEDGER.md` are untracked;
   the repo has 0 commits). Nothing else in CI can be true until this is done.
4. **C3** — `bin/agenticos:142` → use `python()`; make the audit script abort with exit 2 if
   `import agno` fails, so an inert interpreter can never read as a pass.
5. **C2a** — stop counting agno's optional-dep `ImportError` re-raises as broken packages.
6. **C6** — coerce `run_id` to `str`, move the terminal emit inside the try, add a `finally`
   that guarantees exactly one terminal event.
7. **C5** — write `bridge/ts/src/contract.parity.test.ts`; add `tsc --noEmit` for `bridge/ts`
   to CI, pre-commit and `verify()`.
8. **C10** — drop `executors` from the unauthenticated health payload.
9. **C9** — `hmac.compare_digest` on **bytes**.
10. **C11/C12** — cancel the response body in `parseSse`'s `finally`; bound `resolveApproval`
    with the same abort/timeout pattern as `dispatch`.
11. **C8** — track claim state (`claiming`/`done`), never evict `claiming` keys.
12. **C7** — replace the import regex with an AST walk + literal-string scan; widen the glob
    beyond `*.py`.
13. **C13** — map `ConditionPaused`, `RouterPaused`, `StepExecutorPaused` → `RunPaused`.
14. **C2b** — establish an xfail baseline for the 56/74 known brain failures so the job can
    go green and *stay* meaningful.
15. **C14/C15** — `||` instead of `??` for `timeout_ms`; normalise CRLF in `parseSse`.
16. **Docs** — fix O1, O2, O3; soften O5/O6/O10 to what the code actually guarantees; state
    the 56 failures **and** 184 errors alongside the 4,653; scope O9 to the gates `verify`
    actually runs.

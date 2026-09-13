"""REQ-0041 -- ONE owner of tool execution across the bridge (turn.v1).

Decision (docs/DECISION-MATRIX.md, ADR 2026-09-13): the brain executor's own
Agno loop is the only place a tool runs; the bridge never executes a tool and
never lets the edge execute one on the brain's behalf. What the bridge DOES own
is the pause: every confirmation-gated tool call surfaces as a RunPaused frame,
the kernel/operator decide, and on approval the bridge RESUMES the same run
(``acontinue_run`` with the requirements confirmed) so the tool executes exactly
once, inside the brain loop, after the kernel consumed its approval.

Every test here drives a REAL ``agno.agent.Agent`` with a REAL confirmation-
gated tool; only the model is scripted (``DeterministicModel(tool_call=...)``),
so Agno's actual tool loop, pause and resume paths are exercised, not a fake.
The side-effect list is the assertion: an event stream that "looks" governed
while the tool ran twice, or never, is exactly what this file exists to catch.
"""

from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest
from fastapi import FastAPI

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.tools import tool

from agenticos_bridge import BrainBridge
from agenticos_bridge.contract import TERMINAL_EVENT_TYPES, TurnRequest
from agenticos_bridge.deterministic import DeterministicModel
from test_kernel_authority import FIXED_APPROVAL_ID, PRINCIPAL, TRACE, _read_log, shim_env  # noqa: F401

REAL_LAUNCHER = os.environ.get("APEX_AUTHORITY_REAL_LAUNCHER")


def _make_agent(sink: list, *, db=InMemoryDb, gated: bool = True) -> Agent:
    """A real agent whose only tool wires money; ``gated`` makes it pause."""

    @tool(requires_confirmation=gated)
    def wire_money(amount: int, to: str) -> str:
        """Wire money to an account."""
        sink.append(("WIRED", amount, to))
        return "wired"

    return Agent(
        id="payer",
        name="payer",
        model=DeterministicModel(reply="done", tool_call=("wire_money", {"amount": 1000000, "to": "acct-9"})),
        tools=[wire_money],
        db=db() if db is not None else None,
    )


def _turn(turn_id: str, timeout_ms: int = 5000, **extra) -> dict:
    body = {
        "turn_id": turn_id,
        "session_id": "s",
        "target": {"kind": "agent", "id": "payer"},
        "input": {"text": "wire it"},
        "principal": dict(PRINCIPAL),
        "trace": TRACE,
        "options": {"timeout_ms": timeout_ms},
    }
    body.update(extra)
    return body


async def _drive_agent(agent: Agent, decision: str | None, turn_id: str, timeout_ms: int = 5000):
    bridge = BrainBridge(agents={"payer": agent})
    app = FastAPI()
    app.include_router(bridge.router())
    events: list[dict] = []

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bridge") as c:

        async def answer():
            if decision is None:
                return
            for _ in range(200):
                await asyncio.sleep(0.05)
                async with bridge._pending_lock:
                    pending = list(bridge._pending)
                if pending:
                    aid = pending[0]
                    await c.post(
                        f"/v1/turns/{turn_id}/approvals/{aid}",
                        json={"approval_id": aid, "decision": decision, "principal": dict(PRINCIPAL)},
                    )
                    return

        task = asyncio.create_task(answer())
        async with c.stream("POST", "/v1/turns", json=_turn(turn_id, timeout_ms)) as r:
            async for line in r.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
        await task
    return events


def _one_terminal(events):
    types = [e["type"] for e in events]
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1, types


# ---------------------------------------------------------------------------
# 1. The tool runs exactly once, inside the brain loop, through the kernel path.


@pytest.mark.asyncio
async def test_kernel_governed_tool_runs_exactly_once_inside_the_brain_loop(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list = []

    events = await _drive_agent(_make_agent(sink), "approve", "owner-approve")
    types = [e["type"] for e in events]

    assert sink == [("WIRED", 1000000, "acct-9")], f"the tool must run exactly once: {sink}"
    assert types.count("tool.started") == 1 and types.count("tool.completed") == 1, types
    assert types[-1] == "run.completed" and events[-1]["output"] == "done", events[-1]
    assert events[-1]["usage"]["tool_calls"] == 1
    _one_terminal(events)

    required = [e for e in events if e["type"] == "approval.required"]
    assert len(required) == 1 and required[0]["tool"] == "wire_money"
    assert required[0]["approval_id"] == FIXED_APPROVAL_ID, "the kernel's id, not a bridge-minted one"
    assert "expires_at" in required[0]

    # The tool ran AFTER the kernel consumed the approval: the event order is
    # approval.required -> tool.started, and the kernel saw the exact tool+args.
    assert types.index("approval.required") < types.index("tool.started")
    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "resolve", "decide", "finish"], logged
    assert logged[0]["tool"] == "wire_money" and logged[0]["args"] == {"amount": 1000000, "to": "acct-9"}
    assert logged[2]["approval_id"] == FIXED_APPROVAL_ID and logged[3]["outcome"] == "succeeded"


@pytest.mark.asyncio
async def test_kernel_governed_denial_never_runs_the_tool(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list = []

    events = await _drive_agent(_make_agent(sink), "deny", "owner-deny")
    types = [e["type"] for e in events]

    assert sink == [], sink
    assert "tool.started" not in types
    assert events[-1]["type"] == "run.failed" and events[-1]["reason"] == "approval_denied"
    assert events[-1]["retryable"] is False
    _one_terminal(events)
    logged = _read_log(log_path)
    assert [(r["op"], r.get("approve")) for r in logged] == [("decide", None), ("resolve", False)]


@pytest.mark.asyncio
async def test_kernel_deny_at_decide_never_resumes_the_run(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("deny_at_decide")
    sink: list = []

    events = await _drive_agent(_make_agent(sink), None, "owner-kernel-deny")
    assert sink == []
    assert events[-1]["type"] == "run.failed" and events[-1]["reason"] == "kernel_denied"
    assert "approval.required" not in [e["type"] for e in events]
    _one_terminal(events)


# ---------------------------------------------------------------------------
# 2. Native mode: the bridge's own gate, same single owner.


@pytest.mark.asyncio
async def test_native_mode_resumes_the_real_agent_once(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("deny_at_decide")  # would fail the run if native ever consulted the kernel
    os.environ["APEX_AUTHORITY_MODE"] = "native"
    sink: list = []

    events = await _drive_agent(_make_agent(sink), "approve", "owner-native-approve")
    assert sink == [("WIRED", 1000000, "acct-9")], sink
    assert events[-1]["type"] == "run.completed" and events[-1]["output"] == "done"
    _one_terminal(events)

    sink2: list = []
    events2 = await _drive_agent(_make_agent(sink2), "deny", "owner-native-deny")
    assert sink2 == [] and events2[-1]["type"] == "run.failed" and events2[-1]["reason"] == "approval_denied"
    assert not os.path.exists(log_path), "the kernel shim was invoked in native mode"


# ---------------------------------------------------------------------------
# 3. Illegal states are unrepresentable or refused at registration.


def test_edge_cannot_supply_tools_to_the_brain():
    """turn.v1 gives the edge no way to hand tool definitions (or results) to the
    brain: a request carrying `tools` is rejected at the boundary, which is what
    makes a second loop on the edge side unable to execute on the brain's behalf."""
    with pytest.raises(Exception) as excinfo:
        TurnRequest.model_validate(_turn("owner-tools", tools=[{"name": "wire_money"}]))
    assert "tools" in str(excinfo.value)
    with pytest.raises(Exception):
        TurnRequest.model_validate({**_turn("owner-tool-result"), "input": {"text": "x", "tool_results": []}})


@pytest.mark.asyncio
async def test_edge_supplied_tools_are_rejected_over_http():
    bridge = BrainBridge(agents={"payer": _make_agent([])})
    app = FastAPI()
    app.include_router(bridge.router())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bridge") as c:
        r = await c.post("/v1/turns", json=_turn("owner-http-tools", tools=[{"name": "wire_money"}]))
    assert r.status_code == 422, r.text


def test_registering_a_gated_executor_without_a_db_is_refused():
    """Agno cannot resume a paused run without a db (RunNotFoundError, verified
    against the installed package). The bridge refuses such an executor up
    front instead of turning every approval into a silent no-op."""
    with pytest.raises(ValueError) as excinfo:
        BrainBridge(agents={"payer": _make_agent([], db=None)})
    assert "wire_money" in str(excinfo.value) and "no db" in str(excinfo.value)

    bridge = BrainBridge()
    with pytest.raises(ValueError):
        bridge.register("agent", "payer", _make_agent([], db=None))
    assert bridge._registry["agent"] == {}

    # A db makes it registrable; an ungated tool needs no db to be governed.
    BrainBridge(agents={"payer": _make_agent([])})
    BrainBridge(agents={"payer": _make_agent([], db=None, gated=False)})


class _ResumableWithoutRequirements:
    """An executor that has `acontinue_run` (so the bridge would resume it) but
    pauses without confirmable requirements and then ends: nothing can run."""

    def __init__(self):
        self.db = object()
        self.tools = []

    async def acontinue_run(self, **_):  # pragma: no cover - must never be called
        raise AssertionError("resumed without requirements")

    def arun(self, **_):
        class _Ev:
            def __init__(self, event, **kw):
                self.event = event
                for k, v in kw.items():
                    setattr(self, k, v)

        async def gen():
            yield _Ev("RunStarted", run_id="r1")
            yield _Ev("RunPaused", run_id="r1", content="Step needs input", requirements=None)

        return gen()


@pytest.mark.asyncio
async def test_unresumable_pause_is_a_block_not_a_silent_completion():
    os.environ["APEX_AUTHORITY_MODE"] = "native"
    bridge = BrainBridge(agents={"payer": _ResumableWithoutRequirements()})
    app = FastAPI()
    app.include_router(bridge.router())
    events: list[dict] = []
    turn_id = "owner-unresumable"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bridge") as c:

        async def answer():
            for _ in range(200):
                await asyncio.sleep(0.05)
                async with bridge._pending_lock:
                    pending = list(bridge._pending)
                if pending:
                    await c.post(
                        f"/v1/turns/{turn_id}/approvals/{pending[0]}",
                        json={"approval_id": pending[0], "decision": "approve", "principal": dict(PRINCIPAL)},
                    )
                    return

        task = asyncio.create_task(answer())
        async with c.stream("POST", "/v1/turns", json=_turn(turn_id)) as r:
            async for line in r.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
        await task
    assert events[-1]["type"] == "run.failed" and events[-1]["reason"] == "pause_not_resumable", events[-1]
    assert events[-1]["retryable"] is False
    _one_terminal(events)


# ---------------------------------------------------------------------------
# 4. The same proof against the REAL kernel (skips outside the merged product).


@pytest.mark.skipif(
    not REAL_LAUNCHER or not os.path.exists(REAL_LAUNCHER),
    reason="APEX_AUTHORITY_REAL_LAUNCHER does not name the kernel launcher",
)
@pytest.mark.asyncio
async def test_real_kernel_real_agent_tool_runs_exactly_once(tmp_path, monkeypatch):
    workspace = tmp_path / "authority-workspace"
    workspace.mkdir(mode=0o700)
    monkeypatch.setenv("APEX_AUTHORITY_MODE", "required")
    monkeypatch.setenv("APEX_AUTHORITY_CMD", str(REAL_LAUNCHER))
    monkeypatch.setenv("APEX_AUTHORITY_DIR", str(workspace))
    sink: list = []

    events = await _drive_agent(_make_agent(sink), "approve", "owner-real-kernel", timeout_ms=20000)
    assert sink == [("WIRED", 1000000, "acct-9")], sink
    assert events[-1]["type"] == "run.completed" and events[-1]["output"] == "done"
    _one_terminal(events)
    required = [e for e in events if e["type"] == "approval.required"]
    assert len(required) == 1 and len(required[0]["approval_id"]) == 64

    # Consumed once: the kernel refuses to spend the same record again.
    from agenticos_bridge import authority

    replay = authority.decide(
        plane="brain", tool="wire_money", risk="R3", principal=dict(PRINCIPAL),
        args={"amount": 1000000, "to": "acct-9"}, approval_id=required[0]["approval_id"],
    )
    assert replay["decision"] == "deny" and replay.get("record_status") == "consumed", replay


def test_registration_guard_understands_toolkit_shaped_executors():
    """`Toolkit.requires_confirmation_tools` gates by NAME, not by a flag on the
    function object; the guard must read that shape too."""
    from agno.tools import Toolkit

    class Bank(Toolkit):
        def __init__(self):
            super().__init__(name="bank", tools=[self.balance, self.wire], requires_confirmation_tools=["wire"])

        def balance(self) -> str:
            """Balance."""
            return "1"

        def wire(self, amount: int) -> str:
            """Wire."""
            return "ok"

    def agent(db):
        return Agent(id="bank", model=DeterministicModel(), tools=[Bank()], db=db)

    with pytest.raises(ValueError) as excinfo:
        BrainBridge(agents={"bank": agent(None)})
    assert "['wire']" in str(excinfo.value)
    BrainBridge(agents={"bank": agent(InMemoryDb())})

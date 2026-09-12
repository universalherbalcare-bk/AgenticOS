"""Kernel authority protocol (APEX_AUTHORITY_MODE=required) integration tests.

Extends the pattern in test_approval_gate.py: a PausingExecutor performs an
irreversible side effect (appends to `sink`) only after the pause is resolved,
and every assertion checks the side-effect list directly rather than trusting
the event stream alone -- an approval gate that "looks" closed while the tool
still runs is exactly the bug test_approval_gate.py exists to catch, and the
kernel wiring must not reopen it.

The fake kernel is a small Python script (`_write_shim`) that stands in for
`python -m apex_os.authority_cli` / APEX_AUTHORITY_CMD: it reads one JSON
request from stdin, appends it to a log file, and replies according to a
MODE environment variable. This lets each test assert exactly what the
bridge sent the kernel (plane, tool, risk, principal, args, directory) as
well as what the bridge did in response to the kernel's answer.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import textwrap

import httpx
import pytest
from fastapi import FastAPI

from agenticos_bridge import BrainBridge, authority
from agenticos_bridge.contract import TERMINAL_EVENT_TYPES

TRACE = {"trace_id": "a" * 32, "span_id": "b" * 16}
PRINCIPAL = {"user_id": "u1", "channel": "slack", "scopes": ["ops"]}
FIXED_APPROVAL_ID = "1234567890abcdef" * 4  # 64 hex chars, like the real kernel's token_hex(32)

SHIM_SOURCE = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json
    import os
    import sys
    import time

    LOG_PATH = os.environ["AUTHORITY_SHIM_LOG"]
    STATE_PATH = os.environ["AUTHORITY_SHIM_STATE"]
    MODE = os.environ.get("AUTHORITY_SHIM_MODE", "deny_at_decide")
    FIXED_APPROVAL_ID = "1234567890abcdef" * 4
    # Tools the shim denies outright at decide(), whatever MODE says -- lets a
    # test allow one tool of a frame and deny another.
    DENY_TOOLS = {t for t in os.environ.get("AUTHORITY_SHIM_DENY_TOOLS", "").split(",") if t}
    # Tools the shim answers "allow / approval_consumed" for at decide(): the kernel
    # already holds a consumed approval for them, so no edge round trip is needed
    # but a finish() receipt is still owed.
    CONSUMED_TOOLS = {t for t in os.environ.get("AUTHORITY_SHIM_CONSUMED_TOOLS", "").split(",") if t}


    def _approval_id_for(state):
        # The first proposal of a run gets FIXED_APPROVAL_ID (what the single-tool
        # tests assert on); every later one gets its own 64-hex id, unless MODE is
        # same_id_for_every_tool, which reproduces a kernel that hands out one id
        # for two tools -- a protocol violation the bridge must fail closed on.
        n = int(state.get("proposals", 0))
        state["proposals"] = n + 1
        if n == 0 or MODE == "same_id_for_every_tool":
            return FIXED_APPROVAL_ID
        return ("%016x" % n) + FIXED_APPROVAL_ID[16:]


    def _load_state():
        try:
            with open(STATE_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (FileNotFoundError, ValueError):
            return {}


    def _save_state(state):
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh)


    def main():
        raw = sys.stdin.buffer.read()
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                request = None
        except (ValueError, UnicodeDecodeError):
            request = None

        if request is not None:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(request) + "\\n")

        if MODE == "hang":
            time.sleep(60)
            return 0
        if MODE == "garbage":
            sys.stdout.write("not json at all")
            return 0
        if MODE == "exit2":
            sys.stdout.write(json.dumps({"ok": False, "error": "shim: simulated undecidable request"}))
            return 2

        if request is None:
            sys.stdout.write(json.dumps({"ok": False, "error": "shim: bad request json"}))
            return 2

        op = request.get("op")
        state = _load_state()

        if op == "decide":
            resource = f"{request.get('plane')}:{request.get('tool')}"
            risk = request.get("risk")
            approval_id = request.get("approval_id")
            if approval_id is None:
                if request.get("tool") in DENY_TOOLS:
                    result = {
                        "decision": "deny", "reason": "tool_disabled",
                        "detail": "shim denies " + str(request.get("tool")), "operation": "tool.execute",
                        "resource": resource, "risk": risk, "approval_id": None,
                    }
                elif request.get("tool") in CONSUMED_TOOLS:
                    result = {
                        "decision": "allow", "reason": "approval_consumed",
                        "operation": "tool.execute", "resource": resource, "risk": risk,
                        "approval_id": "c0" * 32, "consumed_at": 0,
                    }
                elif MODE == "deny_at_decide":
                    result = {
                        "decision": "deny", "reason": "tool_disabled",
                        "detail": "shim denies at decide", "operation": "tool.execute",
                        "resource": resource, "risk": risk, "approval_id": None,
                    }
                elif MODE in ("approval_then_allow", "approval_then_deny_on_consume", "same_id_for_every_tool"):
                    proposed_id = _approval_id_for(state)
                    _save_state(state)
                    result = {
                        "decision": "approval_required", "reason": "approval_required",
                        "operation": "tool.execute", "resource": resource, "risk": risk,
                        "approval_id": proposed_id, "expires_at": 0,
                    }
                else:
                    result = {
                        "decision": "deny", "reason": "tool_disabled",
                        "detail": f"shim: unhandled mode {MODE}", "operation": "tool.execute",
                        "resource": resource, "risk": risk, "approval_id": None,
                    }
            else:
                if MODE == "approval_then_allow" and state.get("approved", {}).get(approval_id):
                    result = {
                        "decision": "allow", "reason": "approval_consumed",
                        "operation": "tool.execute", "resource": resource, "risk": risk,
                        "approval_id": approval_id, "consumed_at": 0,
                    }
                else:
                    result = {
                        "decision": "deny", "reason": "approval_rejected",
                        "detail": "shim: approval not consumable", "operation": "tool.execute",
                        "resource": resource, "risk": risk, "approval_id": approval_id,
                    }
        elif op == "resolve":
            state.setdefault("approved", {})[request.get("approval_id")] = bool(request.get("approve"))
            _save_state(state)
            result = {
                "id": request.get("approval_id"),
                "status": "approved" if request.get("approve") else "revoked",
            }
        elif op == "finish":
            result = {"id": request.get("approval_id"), "outcome": request.get("outcome")}
        else:
            sys.stdout.write(json.dumps({"ok": False, "error": "shim: unknown op"}))
            return 2

        sys.stdout.write(json.dumps({"ok": True, "result": result}))
        return 0


    if __name__ == "__main__":
        sys.exit(main())
    """
)


def _write_shim(tmp_path) -> str:
    path = tmp_path / "authority_shim.py"
    path.write_text(SHIM_SOURCE, encoding="utf-8")
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


def _read_log(log_path) -> list[dict]:
    if not os.path.exists(log_path):
        return []
    with open(log_path, "r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


class _Ev:
    def __init__(self, event, **kw):
        self.event = event
        for k, v in kw.items():
            setattr(self, k, v)


class _ToolExec:
    """Stands in for agno.models.response.ToolExecution."""

    def __init__(self, tool_name, tool_args, requires_confirmation=True):
        self.tool_name = tool_name
        self.tool_args = tool_args
        self.requires_confirmation = requires_confirmation


class PausingExecutor:
    """Pauses for approval on a `wire_money` tool call, then performs an
    irreversible side effect. Same shape as test_approval_gate.py's fixture,
    extended with a realistic `.tools` list on the RunPaused event so the
    bridge has real tool_name/tool_args to send the kernel."""

    def __init__(self, sink: list[str], tool_args: dict | None = None):
        self.sink = sink
        self.tool_args = tool_args if tool_args is not None else {"amount": 1000000, "to": "acct-9"}

    def arun(self, **_):
        async def gen():
            yield _Ev("RunStarted", run_id="r1")
            yield _Ev(
                "RunPaused",
                run_id="r1",
                content="Approve wiring $1,000,000?",
                tools=[_ToolExec("wire_money", self.tool_args)],
            )
            yield _Ev("ToolCallStarted", run_id="r1", tool_name="wire_money")
            self.sink.append("WIRED")
            yield _Ev("ToolCallCompleted", run_id="r1", tool_name="wire_money")
            yield _Ev("RunCompleted", run_id="r1", content="done")

        return gen()


def _turn(turn_id: str, timeout_ms: int = 3000) -> dict:
    return {
        "turn_id": turn_id,
        "session_id": "s",
        "target": {"kind": "agent", "id": "payer"},
        "input": {"text": "wire it"},
        "principal": dict(PRINCIPAL),
        "trace": TRACE,
        "options": {"timeout_ms": timeout_ms},
    }


async def _drive(decision: str | None, turn_id: str, timeout_ms: int = 3000, tool_args: dict | None = None):
    """Run one turn; optionally answer the approval with `decision`."""
    sink: list[str] = []
    bridge = BrainBridge(agents={"payer": PausingExecutor(sink, tool_args=tool_args)})
    app = FastAPI()
    app.include_router(bridge.router())
    events: list[dict] = []

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge"
    ) as c:

        async def answer():
            if decision is None:
                return
            for _ in range(100):
                await asyncio.sleep(0.05)
                async with bridge._pending_lock:
                    pending = list(bridge._pending)
                if pending:
                    aid = pending[0]
                    await c.post(
                        f"/v1/turns/{turn_id}/approvals/{aid}",
                        json={
                            "approval_id": aid,
                            "decision": decision,
                            "principal": dict(PRINCIPAL),
                        },
                    )
                    return

        task = asyncio.create_task(answer())
        async with c.stream("POST", "/v1/turns", json=_turn(turn_id, timeout_ms)) as r:
            async for line in r.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
        await task

    return events, sink


def _assert_one_terminal_event(events):
    types = [e["type"] for e in events]
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1, types


@pytest.fixture
def shim_env(tmp_path, monkeypatch):
    """Configure APEX_AUTHORITY_MODE=required with a shim standing in for the
    kernel; returns (log_path, set_mode) where set_mode(mode) points
    APEX_AUTHORITY_CMD's shim at that behaviour for the current test."""
    shim_path = _write_shim(tmp_path)
    log_path = str(tmp_path / "requests.log")
    state_path = str(tmp_path / "state.json")
    authority_dir = str(tmp_path / "authority-workspace")
    os.makedirs(authority_dir, exist_ok=True)

    monkeypatch.setenv("APEX_AUTHORITY_MODE", "required")
    monkeypatch.setenv("APEX_AUTHORITY_CMD", shim_path)
    monkeypatch.setenv("APEX_AUTHORITY_DIR", authority_dir)
    monkeypatch.setenv("AUTHORITY_SHIM_LOG", log_path)
    monkeypatch.setenv("AUTHORITY_SHIM_STATE", state_path)

    def set_mode(mode: str, deny_tools: tuple[str, ...] = (), consumed_tools: tuple[str, ...] = ()) -> None:
        monkeypatch.setenv("AUTHORITY_SHIM_MODE", mode)
        monkeypatch.setenv("AUTHORITY_SHIM_DENY_TOOLS", ",".join(deny_tools))
        monkeypatch.setenv("AUTHORITY_SHIM_CONSUMED_TOOLS", ",".join(consumed_tools))

    return log_path, set_mode, authority_dir


# ---------------------------------------------------------------------------
# 1. required + kernel deny at pause


@pytest.mark.asyncio
async def test_required_kernel_deny_at_pause_blocks_the_tool(shim_env):
    log_path, set_mode, authority_dir = shim_env
    set_mode("deny_at_decide")

    events, sink = await _drive(None, "kernel-deny-at-pause")
    types = [e["type"] for e in events]

    assert sink == [], f"tool ran despite kernel deny: {sink}"
    assert "tool.started" not in types, types
    assert "approval.required" not in types, types  # never surfaced to the edge
    assert types[-1] == "run.failed"
    assert "shim denies at decide" in events[-1]["error"]
    _assert_one_terminal_event(events)

    logged = _read_log(log_path)
    assert len(logged) == 1
    assert logged[0]["op"] == "decide"
    assert logged[0]["plane"] == "brain"
    assert logged[0]["tool"] == "wire_money"
    assert logged[0]["risk"] == "R3"
    assert logged[0]["principal"] == PRINCIPAL
    assert logged[0]["args"] == {"amount": 1000000, "to": "acct-9"}
    assert logged[0]["directory"] == authority_dir


# ---------------------------------------------------------------------------
# 2. required + approval_required, edge approves


@pytest.mark.asyncio
async def test_required_approval_required_edge_approves_runs_tool_once(shim_env):
    log_path, set_mode, authority_dir = shim_env
    set_mode("approval_then_allow")

    events, sink = await _drive("approve", "kernel-approve")
    types = [e["type"] for e in events]

    assert sink == ["WIRED"], f"approved tool did not run exactly once: {sink}"
    assert "tool.started" in types
    assert types[-1] == "run.completed"
    _assert_one_terminal_event(events)

    approval_events = [e for e in events if e["type"] == "approval.required"]
    assert len(approval_events) == 1
    assert approval_events[0]["approval_id"] == FIXED_APPROVAL_ID  # kernel's id, not a bridge-minted one

    logged = _read_log(log_path)
    ops = [r["op"] for r in logged]
    assert ops == ["decide", "resolve", "decide", "finish"], ops

    decide1, resolve1, decide2, finish1 = logged
    assert "approval_id" not in decide1  # first decide() has no approval_id to consume yet
    for req in (decide1, resolve1, decide2):
        assert req["principal"] == PRINCIPAL
        assert req["directory"] == authority_dir
    assert resolve1["approval_id"] == FIXED_APPROVAL_ID
    assert resolve1["approve"] is True
    assert decide2["approval_id"] == FIXED_APPROVAL_ID
    assert finish1["approval_id"] == FIXED_APPROVAL_ID
    assert finish1["outcome"] == "succeeded"


# ---------------------------------------------------------------------------
# 3. required + approval_required, edge denies


@pytest.mark.asyncio
async def test_required_approval_required_edge_denies_blocks_the_tool(shim_env):
    log_path, set_mode, authority_dir = shim_env
    set_mode("approval_then_allow")

    events, sink = await _drive("deny", "kernel-edge-deny")
    types = [e["type"] for e in events]

    assert sink == [], f"denied tool still executed: {sink}"
    assert "tool.started" not in types, types
    assert types[-1] == "run.failed"
    assert "denied" in events[-1]["error"]
    _assert_one_terminal_event(events)

    logged = _read_log(log_path)
    ops = [r["op"] for r in logged]
    # No second `decide` (consume) and no `finish`: nothing was ever allowed to run.
    assert ops == ["decide", "resolve"], ops
    assert logged[1]["approve"] is False
    assert logged[1]["approval_id"] == FIXED_APPROVAL_ID


# ---------------------------------------------------------------------------
# 4. required + approval_required, edge approves but kernel denies on consume


@pytest.mark.asyncio
async def test_required_kernel_denies_on_consume_blocks_the_tool(shim_env):
    log_path, set_mode, authority_dir = shim_env
    set_mode("approval_then_deny_on_consume")

    events, sink = await _drive("approve", "kernel-deny-on-consume")
    types = [e["type"] for e in events]

    assert sink == [], f"tool ran even though the kernel denied on consume: {sink}"
    assert "tool.started" not in types, types
    assert types[-1] == "run.failed"
    assert "kernel authority did not allow" in events[-1]["error"]
    _assert_one_terminal_event(events)

    logged = _read_log(log_path)
    ops = [r["op"] for r in logged]
    assert ops == ["decide", "resolve", "decide"], ops
    assert logged[1]["approve"] is True  # the edge really did approve
    # ... but the kernel's second decide (approval_id set) still said no, and no finish() followed.


# ---------------------------------------------------------------------------
# 5. required + garbage / exit 2 / hang


@pytest.mark.asyncio
async def test_required_garbage_kernel_response_blocks_the_tool(shim_env):
    _, set_mode, _ = shim_env
    set_mode("garbage")

    events, sink = await _drive(None, "kernel-garbage")
    assert sink == []
    assert events[-1]["type"] == "run.failed"
    assert "kernel authority denied" in events[-1]["error"]
    _assert_one_terminal_event(events)


@pytest.mark.asyncio
async def test_required_exit2_kernel_response_blocks_the_tool(shim_env):
    _, set_mode, _ = shim_env
    set_mode("exit2")

    events, sink = await _drive(None, "kernel-exit2")
    assert sink == []
    assert events[-1]["type"] == "run.failed"
    assert "kernel authority denied" in events[-1]["error"]
    _assert_one_terminal_event(events)


@pytest.mark.asyncio
async def test_required_hanging_kernel_blocks_the_tool(shim_env, monkeypatch):
    _, set_mode, _ = shim_env
    set_mode("hang")
    # Keep the test fast: authority.decide()'s own hard timeout would otherwise
    # be the (5s) default. This does not touch the fail-closed LOGIC, only how
    # long the client waits before declaring the kernel unreachable.
    monkeypatch.setattr(authority, "DEFAULT_TIMEOUT_SECONDS", 0.5)

    events, sink = await _drive(None, "kernel-hang", timeout_ms=10_000)
    assert sink == []
    assert events[-1]["type"] == "run.failed"
    assert "kernel authority denied" in events[-1]["error"]
    assert "timed out" in events[-1]["error"]
    _assert_one_terminal_event(events)


# ---------------------------------------------------------------------------
# 6. required + APEX_AUTHORITY_CMD unset


@pytest.mark.asyncio
async def test_required_without_configured_command_denies(monkeypatch, tmp_path):
    monkeypatch.setenv("APEX_AUTHORITY_MODE", "required")
    monkeypatch.delenv("APEX_AUTHORITY_CMD", raising=False)
    monkeypatch.setenv("APEX_AUTHORITY_DIR", str(tmp_path))

    events, sink = await _drive(None, "kernel-unconfigured")

    assert sink == []
    assert events[-1]["type"] == "run.failed"
    assert "not configured" in events[-1]["error"]
    _assert_one_terminal_event(events)


# ---------------------------------------------------------------------------
# 7. native mode: unchanged, shim never invoked


@pytest.mark.asyncio
async def test_native_mode_ignores_kernel_configuration_entirely(shim_env):
    """Even with a full kernel configuration present in the environment, plain
    APEX_AUTHORITY_MODE=native (or unset) must never spawn the shim."""
    log_path, set_mode, _ = shim_env
    set_mode("deny_at_decide")  # if this were ever consulted, the tool would be denied
    os.environ["APEX_AUTHORITY_MODE"] = "native"

    approve_events, approve_sink = await _drive("approve", "native-approve")
    assert approve_sink == ["WIRED"], "native-mode approval did not run the tool"
    assert approve_events[-1]["type"] == "run.completed"
    _assert_one_terminal_event(approve_events)

    deny_events, deny_sink = await _drive("deny", "native-deny")
    assert deny_sink == [], f"native-mode denial still ran the tool: {deny_sink}"
    assert deny_events[-1]["type"] == "run.failed"
    _assert_one_terminal_event(deny_events)

    assert not os.path.exists(log_path), "the kernel shim was invoked in native mode"


# ---------------------------------------------------------------------------
# 8. Whole-frame authorisation (red team C5, 2026-09-13).
#
# One Agno RunPaused can carry several tool calls; resuming the run executes
# ALL of them. The bridge used to decide the frame with the kernel on the FIRST
# tool only, so [wire_money($1), delete_prod_database] was approved as
# "wire_money($1)" and both side effects ran. Every test here checks the
# side-effect list, not just the event stream.


class TwoToolPausingExecutor:
    """Pauses once with TWO tools requiring confirmation; on resume BOTH side
    effects fire, exactly as a real multi-tool-call Agno turn does. Fixture
    contributed by the red team's PoC."""

    def __init__(self, sink: list[str]):
        self.sink = sink

    def arun(self, **_):
        async def gen():
            yield _Ev("RunStarted", run_id="r1")
            yield _Ev(
                "RunPaused",
                run_id="r1",
                content="Approve wiring $1?",
                tools=[
                    _ToolExec("wire_money", {"amount": 1, "to": "acct-innocuous"}),
                    _ToolExec("delete_prod_database", {"target": "prod-primary"}),
                ],
            )
            yield _Ev("ToolCallStarted", run_id="r1", tool_name="wire_money")
            self.sink.append("WIRED_1_DOLLAR")
            yield _Ev("ToolCallCompleted", run_id="r1", tool_name="wire_money")
            yield _Ev("ToolCallStarted", run_id="r1", tool_name="delete_prod_database")
            self.sink.append("DELETED_PROD_DATABASE")
            yield _Ev("ToolCallCompleted", run_id="r1", tool_name="delete_prod_database")
            yield _Ev("RunCompleted", run_id="r1", content="done")

        return gen()


class NoTerminalEventExecutor:
    """Pauses, runs its tool after approval, then simply ends the stream
    without RunCompleted/RunError (red team C9): the bridge cannot know how
    the tool fared, and the kernel receipt must say so."""

    def __init__(self, sink: list[str]):
        self.sink = sink

    def arun(self, **_):
        async def gen():
            yield _Ev("RunStarted", run_id="r1")
            yield _Ev(
                "RunPaused",
                run_id="r1",
                content="Approve?",
                tools=[_ToolExec("wire_money", {"amount": 5, "to": "acct-1"})],
            )
            yield _Ev("ToolCallStarted", run_id="r1", tool_name="wire_money")
            self.sink.append("WIRED")
            yield _Ev("ToolCallCompleted", run_id="r1", tool_name="wire_money")

        return gen()


async def _drive_executor(executor, decisions: list[str] | None, turn_id: str, timeout_ms: int = 3000):
    """Run one turn with ``executor``; once as many approvals are pending as
    there are ``decisions``, answer them in pending order (which is the frame's
    tool order). Returns (events, responses)."""
    bridge = BrainBridge(agents={"payer": executor})
    app = FastAPI()
    app.include_router(bridge.router())
    events: list[dict] = []
    responses: list[httpx.Response] = []

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge"
    ) as c:

        async def answer():
            if not decisions:
                return
            for _ in range(100):
                await asyncio.sleep(0.05)
                async with bridge._pending_lock:
                    pending = list(bridge._pending)
                if len(pending) >= len(decisions):
                    for aid, decision in zip(pending, decisions):
                        responses.append(
                            await c.post(
                                f"/v1/turns/{turn_id}/approvals/{aid}",
                                json={"approval_id": aid, "decision": decision, "principal": dict(PRINCIPAL)},
                            )
                        )
                    return

        task = asyncio.create_task(answer())
        async with c.stream("POST", "/v1/turns", json=_turn(turn_id, timeout_ms)) as r:
            async for line in r.aiter_lines():
                if line.startswith("data: "):
                    events.append(json.loads(line[6:]))
        await task

    return events, responses


@pytest.mark.asyncio
async def test_multi_tool_pause_kernel_decides_every_tool_and_all_run_when_all_approved(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list[str] = []

    events, responses = await _drive_executor(TwoToolPausingExecutor(sink), ["approve", "approve"], "c5-all-approved")

    assert [r.status_code for r in responses] == [200, 200]
    assert sink == ["WIRED_1_DOLLAR", "DELETED_PROD_DATABASE"], sink
    assert events[-1]["type"] == "run.completed"
    _assert_one_terminal_event(events)

    required = [e for e in events if e["type"] == "approval.required"]
    assert [e["tool"] for e in required] == ["wire_money", "delete_prod_database"]
    assert len({e["approval_id"] for e in required}) == 2, "each tool must carry its own kernel id"
    assert all(e["approval_id"] and len(e["approval_id"]) == 64 for e in required)

    logged = _read_log(log_path)
    ops = [r["op"] for r in logged]
    assert ops == ["decide", "decide", "resolve", "decide", "resolve", "decide", "finish", "finish"], ops
    first_decides = logged[:2]
    assert [(r["tool"], r["args"]) for r in first_decides] == [
        ("wire_money", {"amount": 1, "to": "acct-innocuous"}),
        ("delete_prod_database", {"target": "prod-primary"}),
    ], "the kernel must see every tool of the frame with its own arguments"
    assert [r["outcome"] for r in logged if r["op"] == "finish"] == ["succeeded", "succeeded"]
    assert {r["approval_id"] for r in logged if r["op"] == "finish"} == {e["approval_id"] for e in required}


@pytest.mark.asyncio
async def test_multi_tool_pause_kernel_deny_of_one_tool_runs_nothing(shim_env):
    """Kernel allows wire_money (approval_required) but denies delete_prod_database:
    NEITHER side effect may run, and nothing is offered to the operator."""
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow", deny_tools=("delete_prod_database",))
    sink: list[str] = []

    events, _ = await _drive_executor(TwoToolPausingExecutor(sink), None, "c5-kernel-denies-second")
    types = [e["type"] for e in events]

    assert sink == [], f"a frame with a denied tool still ran: {sink}"
    assert "tool.started" not in types, types
    assert "approval.required" not in types, types
    assert types[-1] == "run.failed"
    assert "delete_prod_database" in events[-1]["error"]
    _assert_one_terminal_event(events)

    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "decide", "resolve"], logged
    assert [r["tool"] for r in logged[:2]] == ["wire_money", "delete_prod_database"]
    # The record the kernel had already proposed for wire_money is explicitly revoked.
    assert logged[2]["tool"] == "wire_money" and logged[2]["approve"] is False


@pytest.mark.asyncio
async def test_multi_tool_pause_operator_denies_one_tool_runs_nothing(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list[str] = []

    events, responses = await _drive_executor(TwoToolPausingExecutor(sink), ["approve", "deny"], "c5-operator-denies-second")
    types = [e["type"] for e in events]

    assert [r.status_code for r in responses] == [200, 200]
    assert sink == [], f"approving one tool of a frame must not run the frame: {sink}"
    assert "tool.started" not in types, types
    assert types[-1] == "run.failed" and "denied" in events[-1]["error"]
    _assert_one_terminal_event(events)

    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "decide", "resolve", "resolve"], logged
    assert [(r["tool"], r["approve"]) for r in logged[2:]] == [("wire_money", False), ("delete_prod_database", False)]


@pytest.mark.asyncio
async def test_multi_tool_pause_shared_kernel_approval_id_fails_closed(shim_env):
    """A kernel that hands out one approval id for two different tools has
    violated the protocol; the bridge must not let one operator answer cover
    both tools."""
    log_path, set_mode, _ = shim_env
    set_mode("same_id_for_every_tool")
    sink: list[str] = []

    events, _ = await _drive_executor(TwoToolPausingExecutor(sink), None, "c5-shared-id")
    types = [e["type"] for e in events]

    assert sink == [], sink
    assert "approval.required" not in types, types
    assert types[-1] == "run.failed" and "same approval id" in events[-1]["error"]
    _assert_one_terminal_event(events)
    assert [r["op"] for r in _read_log(log_path)] == ["decide", "decide", "resolve"]


@pytest.mark.asyncio
async def test_native_multi_tool_pause_needs_every_tool_approved(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("deny_at_decide")  # would fail the run if native mode ever consulted the kernel
    os.environ["APEX_AUTHORITY_MODE"] = "native"

    sink: list[str] = []
    events, _ = await _drive_executor(TwoToolPausingExecutor(sink), ["approve", "approve"], "native-c5-ok")
    assert sink == ["WIRED_1_DOLLAR", "DELETED_PROD_DATABASE"]
    required = [e for e in events if e["type"] == "approval.required"]
    assert [(e["approval_id"], e["tool"]) for e in required] == [
        ("native-c5-ok:r1:0", "wire_money"),
        ("native-c5-ok:r1:1", "delete_prod_database"),
    ]
    assert events[-1]["type"] == "run.completed"
    _assert_one_terminal_event(events)

    sink2: list[str] = []
    events2, _ = await _drive_executor(TwoToolPausingExecutor(sink2), ["approve", "deny"], "native-c5-deny")
    assert sink2 == [], sink2
    assert events2[-1]["type"] == "run.failed"
    _assert_one_terminal_event(events2)

    assert not os.path.exists(log_path), "the kernel shim was invoked in native mode"


# ---------------------------------------------------------------------------
# 9. Approval ownership (red team A1/C6, 2026-09-13).
#
# The pending map was keyed by approval_id alone and the resolve route never
# checked the path's turn_id or the decision's principal against the paused
# turn, so anyone who knew (or in native mode could predict) an approval id
# could approve another turn's action. Each refused attempt must leave the
# owner's approval pending and the owner must still be able to resolve it.


async def _pause_then(turn_id: str, attempts, *, sink: list[str]):
    """Start ``turn_id``, wait until its approval is pending, run ``attempts``
    (an async callable taking (client, bridge, approval_id)), then finish."""
    bridge = BrainBridge(agents={"payer": PausingExecutor(sink)})
    app = FastAPI()
    app.include_router(bridge.router())
    events: list[dict] = []

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge"
    ) as c:

        async def drive():
            async with c.stream("POST", "/v1/turns", json=_turn(turn_id)) as r:
                async for line in r.aiter_lines():
                    if line.startswith("data: "):
                        events.append(json.loads(line[6:]))

        task = asyncio.create_task(drive())
        approval_id = None
        for _ in range(100):
            await asyncio.sleep(0.05)
            async with bridge._pending_lock:
                pending = list(bridge._pending)
            if pending:
                approval_id = pending[0]
                break
        assert approval_id is not None, "approval never became pending"
        await attempts(c, bridge, approval_id)
        await task
    return events


async def _assert_still_pending(bridge, approval_id):
    async with bridge._pending_lock:
        pending = bridge._pending.get(approval_id)
    assert pending is not None and not pending.future.done(), "a refused attempt disturbed the owner's approval"


@pytest.mark.asyncio
async def test_resolve_from_another_turn_id_is_refused_and_owner_still_resolves(shim_env):
    _, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list[str] = []
    real_turn_id = "turn-REAL-owner"

    async def attempts(c, bridge, approval_id):
        forged = await c.post(
            f"/v1/turns/turn-ATTACKER-DOES-NOT-OWN-THIS/approvals/{approval_id}",
            json={"approval_id": approval_id, "decision": "approve", "principal": dict(PRINCIPAL)},
        )
        assert forged.status_code == 404, forged.text
        assert forged.json() == {"detail": "no such pending approval"}  # same body as an unknown id
        await _assert_still_pending(bridge, approval_id)
        assert sink == []
        legit = await c.post(
            f"/v1/turns/{real_turn_id}/approvals/{approval_id}",
            json={"approval_id": approval_id, "decision": "approve", "principal": dict(PRINCIPAL)},
        )
        assert legit.status_code == 200 and legit.json()["resolved"] is True

    events = await _pause_then(real_turn_id, attempts, sink=sink)
    assert sink == ["WIRED"], sink
    assert events[-1]["type"] == "run.completed"
    _assert_one_terminal_event(events)


@pytest.mark.asyncio
async def test_resolve_from_another_principal_is_refused_and_owner_still_resolves(shim_env):
    _, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list[str] = []
    turn_id = "turn-principal-bound"
    attacker = {"user_id": "attacker", "channel": "slack", "scopes": ["ops"]}

    async def attempts(c, bridge, approval_id):
        for decision in ("approve", "deny"):
            forged = await c.post(
                f"/v1/turns/{turn_id}/approvals/{approval_id}",
                json={"approval_id": approval_id, "decision": decision, "principal": attacker},
            )
            assert forged.status_code == 404, forged.text
            assert forged.json() == {"detail": "no such pending approval"}
            await _assert_still_pending(bridge, approval_id)
        assert sink == []
        legit = await c.post(
            f"/v1/turns/{turn_id}/approvals/{approval_id}",
            json={"approval_id": approval_id, "decision": "approve", "principal": dict(PRINCIPAL)},
        )
        assert legit.status_code == 200

    events = await _pause_then(turn_id, attempts, sink=sink)
    assert sink == ["WIRED"], sink
    assert events[-1]["type"] == "run.completed"
    _assert_one_terminal_event(events)


@pytest.mark.asyncio
async def test_native_mode_predictable_approval_id_cannot_be_resolved_from_another_turn(shim_env):
    """In native mode the id is literally f"{turn_id}:{run_id}", so guessing it
    is trivial; the ownership binding is the only thing standing in the way."""
    _, set_mode, _ = shim_env
    set_mode("deny_at_decide")
    os.environ["APEX_AUTHORITY_MODE"] = "native"
    sink: list[str] = []
    turn_id = "native-owner"

    async def attempts(c, bridge, approval_id):
        assert approval_id == f"{turn_id}:r1"
        forged = await c.post(
            f"/v1/turns/native-attacker/approvals/{approval_id}",
            json={"approval_id": approval_id, "decision": "deny", "principal": {"user_id": "attacker", "channel": "slack"}},
        )
        assert forged.status_code == 404
        await _assert_still_pending(bridge, approval_id)
        legit = await c.post(
            f"/v1/turns/{turn_id}/approvals/{approval_id}",
            json={"approval_id": approval_id, "decision": "approve", "principal": dict(PRINCIPAL)},
        )
        assert legit.status_code == 200

    events = await _pause_then(turn_id, attempts, sink=sink)
    assert sink == ["WIRED"]
    assert events[-1]["type"] == "run.completed"


# ---------------------------------------------------------------------------
# 10. Receipt honesty (red team C9): a stream that ends without a terminal
# event leaves the tool outcome unknown, and the kernel must be told so.


@pytest.mark.asyncio
async def test_stream_without_terminal_event_records_unknown_receipt(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list[str] = []

    events, _ = await _drive_executor(NoTerminalEventExecutor(sink), ["approve"], "c9-no-terminal")

    assert sink == ["WIRED"]
    _assert_one_terminal_event(events)  # the bridge still synthesises exactly one terminal event
    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "resolve", "decide", "finish"]
    assert logged[-1]["outcome"] == "unknown", logged[-1]


@pytest.mark.asyncio
async def test_consumed_record_in_a_denied_frame_still_gets_a_receipt(shim_env):
    """Kernel: wire_money is allowed on an already-consumed approval,
    delete_prod_database is denied. The frame is denied as a whole, so the
    consumed record's action never ran -- its receipt must be 'failed', not
    missing (before: the denied path returned without any finish())."""
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow", deny_tools=("delete_prod_database",), consumed_tools=("wire_money",))
    sink: list[str] = []

    events, _ = await _drive_executor(TwoToolPausingExecutor(sink), None, "c9-denied-frame")

    assert sink == [], sink
    assert events[-1]["type"] == "run.failed" and "delete_prod_database" in events[-1]["error"]
    _assert_one_terminal_event(events)
    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "decide", "finish"], logged
    assert logged[2]["approval_id"] == "c0" * 32 and logged[2]["outcome"] == "failed"

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
                if MODE == "deny_at_decide":
                    result = {
                        "decision": "deny", "reason": "tool_disabled",
                        "detail": "shim denies at decide", "operation": "tool.execute",
                        "resource": resource, "risk": risk, "approval_id": None,
                    }
                elif MODE in ("approval_then_allow", "approval_then_deny_on_consume"):
                    state["proposed"] = True
                    _save_state(state)
                    result = {
                        "decision": "approval_required", "reason": "approval_required",
                        "operation": "tool.execute", "resource": resource, "risk": risk,
                        "approval_id": FIXED_APPROVAL_ID, "expires_at": 0,
                    }
                else:
                    result = {
                        "decision": "deny", "reason": "tool_disabled",
                        "detail": f"shim: unhandled mode {MODE}", "operation": "tool.execute",
                        "resource": resource, "risk": risk, "approval_id": None,
                    }
            else:
                if MODE == "approval_then_allow" and state.get("approved"):
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
            state["approved"] = bool(request.get("approve"))
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

    def set_mode(mode: str) -> None:
        monkeypatch.setenv("AUTHORITY_SHIM_MODE", mode)

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

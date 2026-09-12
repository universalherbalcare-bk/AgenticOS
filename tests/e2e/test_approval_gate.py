"""Regression tests for the human-in-the-loop approval gate.

These exist because the first implementation was FAIL-OPEN: `_handle_pause`
emitted `run.failed` for a denial and then fell through to the next loop
iteration, so the provider stream kept running and executed the very tool the
operator had just refused — while emitting two terminal events. Found by
adversarial review, reproduced, fixed.

The side-effect assertion is the point. Asserting only on the event sequence
would have passed while money moved.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from agenticos_bridge import BrainBridge
from agenticos_bridge.contract import TERMINAL_EVENT_TYPES

TRACE = {"trace_id": "a" * 32, "span_id": "b" * 16}


class _Ev:
    def __init__(self, event, **kw):
        self.event = event
        for k, v in kw.items():
            setattr(self, k, v)


class PausingExecutor:
    """Pauses for approval, then performs an irreversible side effect."""

    def __init__(self, sink: list[str]):
        self.sink = sink

    def arun(self, **_):
        async def gen():
            yield _Ev("RunStarted", run_id="r1")
            yield _Ev("RunPaused", run_id="r1", content="Approve wiring $1,000,000?")
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
        "principal": {"user_id": "u", "channel": "slack"},
        "trace": TRACE,
        "options": {"timeout_ms": timeout_ms},
    }


async def _drive(decision: str | None, turn_id: str, timeout_ms: int = 3000):
    """Run one turn; optionally answer the approval with `decision`."""
    sink: list[str] = []
    bridge = BrainBridge(agents={"payer": PausingExecutor(sink)})
    app = FastAPI()
    app.include_router(bridge.router())
    events: list[dict] = []

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge"
    ) as c:

        async def answer():
            if decision is None:
                return
            for _ in range(80):
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
                            "principal": {"user_id": "u", "channel": "slack"},
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


@pytest.mark.asyncio
async def test_denied_approval_prevents_the_tool_from_running():
    events, sink = await _drive("deny", "gate-deny")
    types = [e["type"] for e in events]

    assert sink == [], f"DENIED tool still executed: {sink}"
    assert "tool.started" not in types, types
    assert types[-1] == "run.failed"
    assert "denied" in events[-1]["error"]


@pytest.mark.asyncio
async def test_denied_approval_emits_exactly_one_terminal_event():
    events, _ = await _drive("deny", "gate-deny-terminal")
    types = [e["type"] for e in events]
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1, types


@pytest.mark.asyncio
async def test_approval_timeout_prevents_the_tool_from_running():
    events, sink = await _drive(None, "gate-timeout", timeout_ms=1000)
    types = [e["type"] for e in events]

    assert sink == [], f"tool ran after approval TIMEOUT: {sink}"
    assert types[-1] == "run.failed"
    assert "timed out" in events[-1]["error"]
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1, types


@pytest.mark.asyncio
async def test_granted_approval_allows_the_run_to_continue():
    """The gate must not be so closed that a legitimate approval is refused."""
    events, sink = await _drive("approve", "gate-approve")
    types = [e["type"] for e in events]

    assert sink == ["WIRED"], "approved tool did NOT run"
    assert "tool.started" in types
    assert types[-1] == "run.completed"
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1, types

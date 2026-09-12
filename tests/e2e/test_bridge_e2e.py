"""End-to-end proof that a turn crosses the AgenticOS plane boundary.

What this genuinely proves: the contract, auth, scope enforcement, idempotency,
executor resolution, Agno event translation, SSE framing and terminal-event
guarantees all work against a REAL Agno agent running a REAL streaming run loop.

What it does NOT prove: model inference quality. The model is deterministic by
design so the plumbing is tested rather than an LLM. That distinction is stated
here rather than blurred in a summary.
"""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI

from agno.agent import Agent
from agno.team import Team
from agenticos_bridge import BrainBridge
from agenticos_bridge.contract import TERMINAL_EVENT_TYPES
from agenticos_bridge.deterministic import DeterministicModel

TRACE = {"trace_id": "a" * 32, "span_id": "b" * 16}
TOKEN = "test-bridge-token"


def build_app(**bridge_kwargs) -> tuple[FastAPI, BrainBridge]:
    agent = Agent(
        name="support",
        id="support",
        model=DeterministicModel(reply="Handled by the brain plane.", chunk_size=6),
    )
    member = Agent(name="m", id="m", model=DeterministicModel(reply="member"))
    team = Team(
        name="triage",
        id="triage",
        members=[member],
        model=DeterministicModel(reply="Team answered."),
    )
    bridge = BrainBridge(agents={"support": agent}, teams={"triage": team}, **bridge_kwargs)
    app = FastAPI()
    app.include_router(bridge.router())
    return app, bridge


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge"
    )


def turn(turn_id: str = "t-1", *, kind: str = "agent", tid: str = "support", scopes=None) -> dict:
    return {
        "turn_id": turn_id,
        "session_id": "sess-1",
        "target": {"kind": kind, "id": tid},
        "input": {"text": "hello"},
        "principal": {
            "user_id": "u-1",
            "channel": "slack",
            "scopes": scopes if scopes is not None else ["turns:create"],
        },
        "trace": TRACE,
    }


async def collect(resp: httpx.Response) -> list[dict]:
    events: list[dict] = []
    async for line in resp.aiter_lines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    return events


@pytest.mark.asyncio
async def test_turn_crosses_bridge_and_streams_to_terminal_event():
    app, _ = build_app()
    async with client(app) as c:
        async with c.stream("POST", "/v1/turns", json=turn()) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            assert r.headers["x-agenticos-trace-id"] == TRACE["trace_id"]
            events = await collect(r)

    types = [e["type"] for e in events]
    assert types[0] == "run.started", types
    assert types[-1] in TERMINAL_EVENT_TYPES, types
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1, "exactly one terminal event"
    assert "output.delta" in types, types

    deltas = "".join(e["text"] for e in events if e["type"] == "output.delta")
    assert deltas == "Handled by the brain plane."
    final = events[-1]
    assert final["type"] == "run.completed"
    assert final["output"] == "Handled by the brain plane."
    assert final["usage"]["duration_ms"] >= 0


@pytest.mark.asyncio
async def test_team_target_resolves():
    app, _ = build_app()
    async with client(app) as c:
        async with c.stream("POST", "/v1/turns", json=turn("t-team", kind="team", tid="triage")) as r:
            events = await collect(r)
    assert events[-1]["type"] == "run.completed"
    assert events[-1]["output"] == "Team answered."


@pytest.mark.asyncio
async def test_unknown_target_404s_before_opening_a_stream():
    app, _ = build_app()
    async with client(app) as c:
        r = await c.post("/v1/turns", json=turn("t-404", tid="nope"))
    assert r.status_code == 404
    assert "nope" in r.json()["detail"]


@pytest.mark.asyncio
async def test_idempotent_turn_id_is_rejected():
    app, _ = build_app()
    async with client(app) as c:
        async with c.stream("POST", "/v1/turns", json=turn("dup")) as r:
            await collect(r)
        replay = await c.post("/v1/turns", json=turn("dup"))
    assert replay.status_code == 409, "redelivered turn must not execute twice"


@pytest.mark.asyncio
async def test_auth_is_fail_closed():
    app, _ = build_app(auth_token=TOKEN)
    async with client(app) as c:
        missing = await c.post("/v1/turns", json=turn("t-a"))
        wrong = await c.post(
            "/v1/turns", json=turn("t-b"), headers={"Authorization": "Bearer nope"}
        )
        async with c.stream(
            "POST", "/v1/turns", json=turn("t-c"), headers={"Authorization": f"Bearer {TOKEN}"}
        ) as ok:
            events = await collect(ok)
    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert events[-1]["type"] == "run.completed"


@pytest.mark.asyncio
async def test_scope_is_enforced_not_merely_logged():
    app, _ = build_app(required_scope="turns:create")
    async with client(app) as c:
        denied = await c.post("/v1/turns", json=turn("t-s1", scopes=["turns:read"]))
        async with c.stream("POST", "/v1/turns", json=turn("t-s2", scopes=["turns:create"])) as ok:
            events = await collect(ok)
    assert denied.status_code == 403
    assert events[-1]["type"] == "run.completed"


@pytest.mark.asyncio
async def test_malformed_turn_is_rejected_at_the_boundary():
    app, _ = build_app()
    bad_cases = [
        {**turn("m1"), "trace": {"trace_id": "short", "span_id": "b" * 16}},
        {**turn("m2"), "target": {"kind": "daemon", "id": "x"}},
        {**turn("m3"), "unexpected_field": True},
    ]
    async with client(app) as c:
        for payload in bad_cases:
            r = await c.post("/v1/turns", json=payload)
            assert r.status_code == 422, payload


@pytest.mark.asyncio
async def test_executor_failure_becomes_a_terminal_failed_event():
    """Fail closed: a brain-plane exception must still terminate the stream."""

    class Exploding:
        def arun(self, **_):
            raise RuntimeError("brain plane exploded")

    app, bridge = build_app()
    bridge.register("agent", "boom", Exploding())
    async with client(app) as c:
        async with c.stream("POST", "/v1/turns", json=turn("t-boom", tid="boom")) as r:
            events = await collect(r)
    assert events[-1]["type"] == "run.failed"
    assert "brain plane exploded" in events[-1]["error"]
    assert events[-1]["retryable"] is True


@pytest.mark.asyncio
async def test_failed_turn_releases_idempotency_claim_so_it_can_retry():
    class Exploding:
        def arun(self, **_):
            raise RuntimeError("transient")

    app, bridge = build_app()
    bridge.register("agent", "boom", Exploding())
    async with client(app) as c:
        async with c.stream("POST", "/v1/turns", json=turn("retry-me", tid="boom")) as r:
            await collect(r)
        again = await c.post("/v1/turns", json=turn("retry-me", tid="boom"))
        assert again.status_code == 200, "a genuinely failed turn must be retryable"
        await collect(again)


@pytest.mark.asyncio
async def test_health_reports_registered_executors():
    app, _ = build_app()
    async with client(app) as c:
        r = await c.get("/v1/bridge/health")
    body = r.json()
    assert body["contract"] == "turn.v1"
    assert body["executors"]["agent"] == ["support"]
    assert body["executors"]["team"] == ["triage"]


@pytest.mark.asyncio
async def test_workflow_target_uses_the_third_event_vocabulary():
    """Agno names the same lifecycle three ways; workflows must map too.

    Regression guard: matching only the agent vocabulary produced a stream that
    looked healthy (run.started -> run.completed) with a silently EMPTY payload.
    """
    from agno.workflow import Step, Workflow

    inner = Agent(name="w", id="w", model=DeterministicModel(reply="Workflow answered."))
    wf = Workflow(id="flow", name="flow", steps=[Step(name="only", agent=inner)])

    app, bridge = build_app()
    bridge.register("workflow", "flow", wf)
    async with client(app) as c:
        async with c.stream(
            "POST", "/v1/turns", json=turn("t-wf", kind="workflow", tid="flow")
        ) as r:
            events = await collect(r)

    types = [e["type"] for e in events]
    assert types[-1] in TERMINAL_EVENT_TYPES, types
    assert sum(t in TERMINAL_EVENT_TYPES for t in types) == 1
    assert events[-1]["type"] == "run.completed", events[-1]
    assert events[-1]["output"], "workflow produced an EMPTY payload — event mapping regressed"


@pytest.mark.asyncio
async def test_health_does_not_leak_the_executor_registry_to_anonymous_callers():
    """The registry names every runnable agent/team/workflow — reconnaissance.

    Liveness stays public so load balancers keep working; the inventory does not.
    """
    app, _ = build_app(auth_token=TOKEN)
    async with client(app) as c:
        anon = (await c.get("/v1/bridge/health")).json()
        authed = (
            await c.get("/v1/bridge/health", headers={"Authorization": f"Bearer {TOKEN}"})
        ).json()

    assert anon["status"] == "ok" and anon["contract"] == "turn.v1"
    assert "executors" not in anon, f"anonymous caller saw the registry: {anon}"
    assert authed["executors"]["agent"] == ["support"]


@pytest.mark.asyncio
async def test_health_still_reports_executors_when_no_token_is_configured():
    """Unauthenticated by choice must not become unusable by accident."""
    app, _ = build_app()
    async with client(app) as c:
        body = (await c.get("/v1/bridge/health")).json()
    assert body["executors"]["agent"] == ["support"]

"""ONE app, real persistence, trace propagation — proven through the ASGI app."""

from __future__ import annotations

import json
import sqlite3

import httpx
import pytest

from agenticos_brain import build_app, build_executors

TRACE = "abc" + "0" * 29


def _turn(turn_id: str, session: str = "s-persist", text: str = "hello") -> dict:
    return {
        "turn_id": turn_id,
        "session_id": session,
        "target": {"kind": "agent", "id": "support"},
        "input": {"text": text},
        "principal": {"user_id": "u-persist", "channel": "test", "scopes": ["turns:create"]},
        "trace": {"trace_id": TRACE, "span_id": "0000000000000001"},
    }


async def _collect(resp):
    out = []
    async for line in resp.aiter_lines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


def test_control_plane_and_bridge_share_one_app(cfg):
    app = build_app(cfg, executors=build_executors(cfg))
    paths = app.openapi()["paths"]
    # bridge
    assert "/v1/turns" in paths and "/v1/bridge/health" in paths
    # control plane, same app
    for p in ("/agents", "/teams", "/workflows", "/sessions", "/memories", "/health"):
        assert p in paths, f"control plane path missing from the merged app: {p}"
    assert len(paths) >= 70


@pytest.mark.asyncio
async def test_bridge_and_control_plane_expose_the_same_executors(cfg):
    ex = build_executors(cfg)
    app = build_app(cfg, executors=ex)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://b") as c:
        health = (await c.get("/v1/bridge/health")).json()
        agents = (await c.get("/agents")).json()
    assert health["executors"]["agent"] == sorted(ex.agents) == sorted(a["id"] for a in agents)


@pytest.mark.asyncio
async def test_turn_persists_runs_with_trace_metadata_in_the_real_db(cfg, tmp_db):
    app = build_app(cfg, executors=build_executors(cfg))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://b") as c:
        for tid, text in (("p-1", "first"), ("p-2", "second")):
            async with c.stream("POST", "/v1/turns", json=_turn(tid, text=text)) as r:
                assert r.status_code == 200
                events = await _collect(r)
            assert events[-1]["type"] == "run.completed", events[-1]

        # The control plane reads the SAME session back over HTTP.
        sessions = (await c.get("/sessions", params={"type": "agent"})).json()
        rows = sessions.get("data", sessions) if isinstance(sessions, dict) else sessions
        assert any(s.get("session_id") == "s-persist" for s in rows), rows

    # And the database on disk holds both runs, each carrying the edge trace.
    db = sqlite3.connect(tmp_db)
    runs = db.execute("select run_data from agno_runs where session_id='s-persist' order by created_at").fetchall()
    assert len(runs) == 2, "two turns must persist two runs"
    metas = [json.loads(r[0]).get("metadata") or {} for r in runs]
    assert [m.get("trace_id") for m in metas] == [TRACE, TRACE]
    assert [m.get("turn_id") for m in metas] == ["p-1", "p-2"]
    assert all(m.get("channel") == "test" for m in metas)


@pytest.mark.asyncio
async def test_history_flows_into_the_next_turn_in_the_same_session(cfg):
    """add_history_to_context=True + a real db => the model SEES the prior turn."""
    ex = build_executors(cfg)
    model = ex.agents["support"].model
    app = build_app(cfg, executors=ex)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://b") as c:
        async with c.stream("POST", "/v1/turns", json=_turn("h-1", session="s-hist", text="REMEMBER-ME")) as r:
            await _collect(r)
        async with c.stream("POST", "/v1/turns", json=_turn("h-2", session="s-hist", text="what did I say?")) as r:
            await _collect(r)
    seen = " ".join(str(getattr(m, "content", "")) for m in model.seen_messages)
    assert "REMEMBER-ME" in seen, "prior turn was not loaded from the db into the second turn's context"


@pytest.mark.asyncio
async def test_sqlite_idempotency_store_is_selected_from_config(cfg, tmp_db):
    from agenticos_bridge.idempotency_sqlite import SqliteIdempotencyStore

    app = build_app(cfg, executors=build_executors(cfg))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://b") as c:
        async with c.stream("POST", "/v1/turns", json=_turn("idem-1")) as r:
            await _collect(r)
        assert (await c.post("/v1/turns", json=_turn("idem-1"))).status_code == 409
    side = tmp_db.with_suffix(".bridge.db")
    assert side.exists(), "sqlite idempotency store must live beside the brain db"
    assert SqliteIdempotencyStore(side).active_claims() >= 1

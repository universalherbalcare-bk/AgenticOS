"""Runnable brain-plane server used by the cross-plane test.

This is a real uvicorn process serving the real bridge router over real HTTP —
not an in-process shortcut. The TypeScript edge client talks to it exactly as
the gateway would in production.
"""

from __future__ import annotations

import os

from fastapi import FastAPI

from agno.agent import Agent
from agno.team import Team
from agenticos_bridge import BrainBridge
from agenticos_bridge.deterministic import DeterministicModel


def build() -> FastAPI:
    support = Agent(
        name="support",
        id="support",
        model=DeterministicModel(reply="Crossed the plane boundary.", chunk_size=7),
    )
    triage = Team(
        name="triage",
        id="triage",
        members=[Agent(name="m", id="m", model=DeterministicModel(reply="m"))],
        model=DeterministicModel(reply="Team crossed too."),
    )
    bridge = BrainBridge(
        agents={"support": support},
        teams={"triage": triage},
        auth_token=os.environ.get("AGENTICOS_BRIDGE_TOKEN") or None,
        required_scope=os.environ.get("AGENTICOS_BRIDGE_SCOPE") or None,
    )
    app = FastAPI(title="AgenticOS Brain Plane")
    app.include_router(bridge.router())
    return app


app = build()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8899")), log_level="warning")

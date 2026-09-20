"""ONE FastAPI app: the AgentOS control plane + the bridge router.

Before: the bridge lived on a bare ``FastAPI()`` and the 72-path control plane
was never served at all by ``agenticos brain``. Two servers, or rather one
server and one absence. Now ``AgentOS(...).get_app()`` is built from the SAME
executors the bridge dispatches to, and the bridge router is included on it —
so ``/agents``, ``/sessions``, ``/memories`` … and ``/v1/turns`` share one
process, one db, one set of executors.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import FastAPI

from agenticos_bridge import BrainBridge
from agenticos_bridge.idempotency_sqlite import SqliteIdempotencyStore
from agenticos_bridge.server import IdempotencyStore

from .config import AgenticOSConfig, load_config
from .factory import Executors, build_executors

logger = logging.getLogger("agenticos.brain")


def build_app(cfg: Optional[AgenticOSConfig] = None, *, executors: Optional[Executors] = None) -> FastAPI:
    cfg = cfg or load_config()
    ex = executors or build_executors(cfg)

    if cfg.bridge.idempotency == "sqlite":
        store = SqliteIdempotencyStore(cfg.brain.db_file.with_suffix(".bridge.db"))
    else:
        store = IdempotencyStore()

    bridge = BrainBridge(
        agents=ex.agents,
        teams=ex.teams,
        workflows=ex.workflows,
        auth_token=cfg.bridge.auth_token,
        required_scope=cfg.bridge.required_scope,
        store=store,
    )

    # The control plane, built from the very same executor objects.
    from agno.os import AgentOS

    agent_os = AgentOS(
        id=cfg.identity_name,
        agents=list(ex.agents.values()) or None,
        teams=list(ex.teams.values()) or None,
        workflows=list(ex.workflows.values()) or None,
    )
    app: FastAPI = agent_os.get_app()
    app.title = "AgenticOS Brain Plane"
    app.include_router(bridge.router())

    # One unmistakable startup line: what is wired, and to what. Governance is
    # included HERE at WARNING because the bridge's own notice is INFO in
    # `required` mode and therefore invisible under the default log level -
    # i.e. the governed state was the one state you could not see in the log.
    from agenticos_bridge import authority

    gov_mode = authority.get_mode()
    gov_cmd = os.environ.get("APEX_AUTHORITY_CMD") or "unset"
    logger.warning(
        "agenticos brain: %d executors (%d agents, %d teams, %d workflows) | db=%s | "
        "idempotency=%s | bridge_auth=%s | required_scope=%s | governance=mode=%s cmd=%s | config=%s",
        ex.count(), len(ex.agents), len(ex.teams), len(ex.workflows),
        cfg.brain.db_file, cfg.bridge.idempotency,
        "token" if cfg.bridge.auth_token else "NONE (unauthenticated by config)",
        cfg.bridge.required_scope or "none", gov_mode, gov_cmd, cfg.source_path,
    )
    app.state.agenticos_config = cfg
    app.state.agenticos_executors = ex
    return app


__all__ = ["build_app"]

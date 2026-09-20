"""Build real Agno executors from ``brain.executors``.

Every executor gets the SAME SQLite database so:
  * sessions and memories persist across restarts (real backend data, not
    process memory);
  * the bridge can resume a paused run — REQ-0041: Agno's ``acontinue_run``
    reloads the run from ``db`` and raises ``RunNotFoundError`` without one,
    which would turn every approval into a silent no-op. ``BrainBridge``
    refuses db-less governable executors at registration; this factory never
    produces one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict

from agno.agent import Agent
from agno.db.sqlite import SqliteDb
from agno.team import Team
from agno.workflow import Step, Workflow

from .config import AgenticOSConfig, ConfigError, ExecutorSpec
from .models import resolve_model


@dataclass(frozen=True)
class Executors:
    agents: Dict[str, Agent]
    teams: Dict[str, Team]
    workflows: Dict[str, Workflow]
    db: SqliteDb

    def count(self) -> int:
        return len(self.agents) + len(self.teams) + len(self.workflows)


def build_db(cfg: AgenticOSConfig) -> SqliteDb:
    cfg.brain.db_file.parent.mkdir(parents=True, exist_ok=True)
    return SqliteDb(db_file=str(cfg.brain.db_file))


def build_executors(cfg: AgenticOSConfig, *, db: SqliteDb | None = None) -> Executors:
    db = db or build_db(cfg)
    agents: Dict[str, Agent] = {}
    teams: Dict[str, Team] = {}
    workflows: Dict[str, Workflow] = {}

    # Agents first: teams and workflows reference them by id.
    for spec in (s for s in cfg.brain.executors if s.kind == "agent"):
        agents[spec.id] = _agent(spec, db)

    for spec in (s for s in cfg.brain.executors if s.kind == "team"):
        members = [agents[m] for m in spec.members]
        teams[spec.id] = Team(
            id=spec.id,
            name=spec.name,
            description=spec.description,
            members=members,
            model=resolve_model(spec.model, owner=f"team {spec.id}"),
            instructions=spec.instructions or None,
            db=db,
        )

    for spec in (s for s in cfg.brain.executors if s.kind == "workflow"):
        steps = [Step(name=f"{spec.id}.{a}", agent=agents[a]) for a in spec.steps]
        workflows[spec.id] = Workflow(
            id=spec.id,
            name=spec.name,
            description=spec.description,
            steps=steps,
            db=db,
        )

    return Executors(agents=agents, teams=teams, workflows=workflows, db=db)


def _agent(spec: ExecutorSpec, db: SqliteDb) -> Agent:
    try:
        return Agent(
            id=spec.id,
            name=spec.name,
            description=spec.description,
            model=resolve_model(spec.model, owner=f"agent {spec.id}"),
            instructions=spec.instructions or None,
            db=db,
            add_history_to_context=True,
        )
    except ConfigError:
        raise
    except Exception as exc:  # noqa: BLE001 - surface the executor id, not a bare trace
        raise ConfigError(f"agent {spec.id}: could not construct: {type(exc).__name__}: {exc}") from exc


__all__ = ["Executors", "build_db", "build_executors"]

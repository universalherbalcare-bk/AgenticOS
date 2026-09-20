"""Executors are REAL Agno objects, built from config, each with a real db."""

from __future__ import annotations

import pytest

from agenticos_brain import ConfigError, build_executors
from agenticos_brain.models import resolve_model
from agenticos_bridge.deterministic import DeterministicModel


def test_every_executor_is_constructed_and_db_backed(cfg):
    ex = build_executors(cfg)
    assert sorted(ex.agents) == ["m", "support"]
    assert sorted(ex.teams) == ["triage"]
    assert sorted(ex.workflows) == ["flow"]
    everything = [*ex.agents.values(), *ex.teams.values(), *ex.workflows.values()]
    assert all(getattr(e, "db", None) is ex.db for e in everything), "REQ-0041: shared real db"


def test_team_members_are_the_same_agent_objects(cfg):
    ex = build_executors(cfg)
    assert ex.teams["triage"].members[0] is ex.agents["m"]


def test_deterministic_model_with_canned_reply():
    m = resolve_model("agenticos-deterministic:hello there", owner="agent x")
    assert isinstance(m, DeterministicModel) and m.reply == "hello there"


def test_provider_model_string_resolves_without_a_key():
    """Construction must not require credentials; only a call does."""
    m = resolve_model("anthropic:claude-sonnet-4-5", owner="agent x")
    assert type(m).__name__ == "Claude" and m.id == "claude-sonnet-4-5"


@pytest.mark.parametrize("bad", ["", "gpt-4o", "openai/gpt-4o", "nonexistent-provider:model"])
def test_bad_model_strings_are_config_errors_naming_the_owner(bad):
    with pytest.raises(ConfigError) as ei:
        resolve_model(bad, owner="agent broken")
    assert "agent broken" in str(ei.value)


def test_db_file_is_created_under_the_configured_path(cfg, tmp_db):
    ex = build_executors(cfg)
    # SqliteDb creates lazily; force table creation through a real write path.
    ex.db.get_sessions()  # any read triggers schema creation in agno's SqliteDb
    assert tmp_db.exists()

"""agenticos.config.yaml loader: fail-closed, validated, never partially valid."""

from __future__ import annotations

import pytest

from agenticos_brain import ConfigError, load_config

from conftest import HERE, ROOT

ROOT_CFG = ROOT / "agenticos.config.yaml"
VERIFY_CFG = HERE / "verify.config.yaml"


def test_root_config_loads_and_defines_real_executors():
    cfg = load_config(ROOT_CFG, env={})
    kinds = {e.kind for e in cfg.brain.executors}
    assert kinds == {"agent", "team", "workflow"}, "root config must exercise all three executor kinds"
    assert cfg.bridge.idempotency == "sqlite"
    assert cfg.brain.db_file.is_absolute() and cfg.brain.db_file.parent == ROOT / "data"


def test_optional_secret_unset_resolves_to_none_not_empty_string():
    cfg = load_config(ROOT_CFG, env={})
    assert cfg.bridge.auth_token is None
    assert cfg.otlp_endpoint is None


def test_optional_secret_set_is_used():
    cfg = load_config(ROOT_CFG, env={"AGENTICOS_BRIDGE_TOKEN": "s3cr3t"})
    assert cfg.bridge.auth_token == "s3cr3t"


def test_required_var_unset_fails_closed(verify_env):
    """${AGENTICOS_VERIFY_DB} is NOT an optional secret: unset => refuse to start."""
    env = dict(verify_env)
    env.pop("AGENTICOS_VERIFY_DB", None)
    with pytest.raises(ConfigError) as ei:
        load_config(VERIFY_CFG, env=env)
    assert "AGENTICOS_VERIFY_DB" in str(ei.value) and "fail-closed" in str(ei.value)


def test_empty_string_var_counts_as_unset(verify_env):
    env = dict(verify_env, AGENTICOS_VERIFY_DB="")
    with pytest.raises(ConfigError):
        load_config(VERIFY_CFG, env=env)


@pytest.mark.parametrize(
    "mutate, needle",
    [
        (lambda d: d["brain"]["executors"]["agents"].append({"id": "assistant"}), "duplicate"),
        (lambda d: d["brain"]["executors"]["teams"][0].__setitem__("members", ["ghost"]), "ghost"),
        (lambda d: d["bridge"].__setitem__("idempotency", "redis"), "idempotency"),
        (lambda d: d.__setitem__("version", 2), "version"),
        (lambda d: d["bridge"].__setitem__("contract", "turn.v9"), "turn.v1"),
        (lambda d: d["brain"]["executors"]["agents"].append({"id": "bad id!"}), "valid executor id"),
        (lambda d: d["brain"]["executors"]["workflows"].append({"id": "w2", "steps": []}), "at least one step"),
    ],
)
def test_invalid_configs_are_refused_with_the_key_named(tmp_path, mutate, needle):
    import yaml

    data = yaml.safe_load(ROOT_CFG.read_text())
    mutate(data)
    p = tmp_path / "bad.yaml"
    p.write_text(yaml.safe_dump(data))
    with pytest.raises(ConfigError) as ei:
        load_config(p, env={})
    assert needle.lower() in str(ei.value).lower()


def test_missing_file_is_a_config_error(tmp_path):
    with pytest.raises(ConfigError):
        load_config(tmp_path / "nope.yaml", env={})

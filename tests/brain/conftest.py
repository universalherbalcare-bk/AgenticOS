from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


@pytest.fixture
def tmp_db(tmp_path: Path) -> Path:
    return tmp_path / "brain.db"


@pytest.fixture
def verify_env(tmp_db: Path) -> dict[str, str]:
    """Env for tests/brain/verify.config.yaml: db under tmp, no token, no OTLP."""
    env = {k: v for k, v in os.environ.items() if k not in ("AGENTICOS_BRIDGE_TOKEN", "OTEL_EXPORTER_OTLP_ENDPOINT")}
    env["AGENTICOS_VERIFY_DB"] = str(tmp_db)
    return env


@pytest.fixture
def cfg(verify_env):
    from agenticos_brain import load_config

    return load_config(HERE / "verify.config.yaml", env=verify_env)


def pytest_configure(config):
    # The verify config's db must resolve even when a test only imports the
    # loader; a fail-closed loader would otherwise refuse on ${AGENTICOS_VERIFY_DB}.
    os.environ.setdefault("AGENTICOS_VERIFY_DB", os.path.join(tempfile.gettempdir(), "agenticos-verify.db"))

"""AgenticOS brain plane — the real, config-driven server.

Before this package existed, ``agenticos brain`` booted ``tests/e2e/brain_server.py``:
hard-coded deterministic executors, no database, a bare FastAPI app with only the
bridge router. Nothing read ``agenticos.config.yaml``. This package is what the
config file was always describing:

  agenticos.config.yaml ──► load_config()   fail-closed ${VAR} substitution
                        ──► build_executors() Agent/Team/Workflow from brain.executors,
                                              each with a REAL db (REQ-0041)
                        ──► build_app()      the AgentOS control plane (72 paths) AND
                                              the bridge router on ONE FastAPI app
"""

from .config import AgenticOSConfig, ConfigError, load_config  # noqa: F401
from .factory import build_executors  # noqa: F401
from .app import build_app  # noqa: F401

__all__ = ["AgenticOSConfig", "ConfigError", "load_config", "build_executors", "build_app"]

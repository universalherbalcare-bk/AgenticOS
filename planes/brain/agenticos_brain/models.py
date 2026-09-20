"""Provider-neutral model resolution for the brain plane.

Stock Agno hard-defaults every agent to OpenAI at construction
(``agno/agent/_init.py:set_default_model``) and raises ImportError without the
OpenAI SDK. AgenticOS resolves models from config instead:

  "agenticos-deterministic"          -> zero-dependency DeterministicModel
  "<provider>:<model-id>"            -> agno.models.utils.get_model(), e.g.
                                        "anthropic:claude-sonnet-4-5"
Anything else is a ConfigError naming the executor, not an ImportError three
frames deep at first request.
"""

from __future__ import annotations

from typing import Any

from agenticos_bridge.deterministic import DeterministicModel

from .config import ConfigError

DETERMINISTIC_ID = "agenticos-deterministic"


def resolve_model(spec: str, *, owner: str) -> Any:
    spec = (spec or "").strip()
    if not spec:
        raise ConfigError(f"{owner}: model is empty")
    if spec == DETERMINISTIC_ID or spec.startswith(DETERMINISTIC_ID + ":"):
        # Optional canned reply after the colon: agenticos-deterministic:hello
        reply = spec.partition(":")[2] or f"[{owner}] deterministic reply"
        return DeterministicModel(reply=reply)
    if ":" not in spec:
        raise ConfigError(
            f"{owner}: model {spec!r} must be '{DETERMINISTIC_ID}' or '<provider>:<model-id>' "
            "(e.g. 'anthropic:claude-sonnet-4-5')"
        )
    from agno.models.utils import get_model  # local: keeps import cost off the config path

    try:
        model = get_model(spec)
    except ImportError as exc:
        raise ConfigError(
            f"{owner}: model {spec!r} needs a provider SDK that is not installed: {exc}"
        ) from exc
    except ValueError as exc:
        raise ConfigError(f"{owner}: {exc}") from exc
    if model is None:
        raise ConfigError(f"{owner}: model {spec!r} could not be resolved")
    return model


__all__ = ["resolve_model", "DETERMINISTIC_ID"]

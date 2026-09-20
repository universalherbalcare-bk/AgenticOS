"""Loader for ``agenticos.config.yaml`` — the ONE config for both planes.

Semantics deliberately mirror the edge plane's config system, which won the
config domain in the merge: ``${VAR}`` references are resolved from the
environment at load time and are **fail-closed** — an unset variable that a
*required* field depends on is an error, never a silent empty string. That is
what stops a missing ``AGENTICOS_BRIDGE_TOKEN`` from quietly booting an
unauthenticated bridge.

Optional secret fields (``bridge.auth_token``) resolve to ``None`` when their
variable is unset, and the caller decides what that means (for the bridge:
"no token configured", logged loudly at startup, never assumed).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional

import yaml

_VAR_RE = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")

# Fields whose ${VAR} may legitimately be unset. Everything else fails closed.
_OPTIONAL_SECRET_PATHS = frozenset(
    {
        ("bridge", "auth_token"),
        ("observability", "otlp_endpoint"),
        # The kernel launcher path may come from the environment or be resolved by
        # the launcher from a well-known sibling location; unset is a valid state
        # that the governance mode then decides how to treat (fail closed if required).
        ("governance", "apex_authority", "cmd"),
    }
)


class ConfigError(ValueError):
    """Raised for any config problem. Always names the offending key path."""


@dataclass(frozen=True)
class ExecutorSpec:
    kind: str  # agent | team | workflow
    id: str
    name: str
    model: str
    instructions: list[str] = field(default_factory=list)
    members: list[str] = field(default_factory=list)  # team member agent ids
    steps: list[str] = field(default_factory=list)  # workflow step agent ids
    description: Optional[str] = None


@dataclass(frozen=True)
class BridgeConfig:
    contract: str
    base_url: str
    auth_token: Optional[str]
    required_scope: Optional[str]
    timeout_ms: int
    idempotency: str  # memory | sqlite


@dataclass(frozen=True)
class BrainConfig:
    host: str
    port: int
    default_model: str
    db_file: Path
    executors: list[ExecutorSpec]


@dataclass(frozen=True)
class GovernanceConfig:
    """APEX kernel authority wiring (the kernel lives in a separate project).

    mode: "required" -> every consequential tool call on BOTH planes consults the
    kernel and is DENIED if the kernel is unreachable (fail closed).
          "native"   -> plane-local approval policy only; both planes log a WARNING.
    cmd:  the kernel launcher. When unset here, the launcher looks for the
          well-known sibling checkout `<repo>/../APEX-OS/kernel/bin/apex-authority`.
    """

    mode: str  # required | native
    cmd: Optional[str]
    default_cmd_relative: str


@dataclass(frozen=True)
class AgenticOSConfig:
    version: int
    identity_name: str
    service_namespace: str
    bridge: BridgeConfig
    brain: BrainConfig
    otlp_endpoint: Optional[str]
    governance: GovernanceConfig
    source_path: Path


def _resolve(value: Any, path: tuple[str, ...], env: Mapping[str, str]) -> Any:
    """Recursively substitute ${VAR}. Fail closed unless the path is optional."""
    if isinstance(value, dict):
        return {k: _resolve(v, path + (str(k),), env) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve(v, path + (str(i),), env) for i, v in enumerate(value)]
    if not isinstance(value, str):
        return value

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        if name in env and env[name] != "":
            return env[name]
        if path in _OPTIONAL_SECRET_PATHS:
            raise _Unset(name)
        raise ConfigError(
            f"{'.'.join(path)}: references ${{{name}}} but {name} is not set in the environment. "
            "Refusing to start with an unresolved value (fail-closed)."
        )

    try:
        return _VAR_RE.sub(sub, value)
    except _Unset:
        return None


class _Unset(Exception):
    pass


def _require(d: Mapping[str, Any], key: str, path: str, typ: type) -> Any:
    if key not in d:
        raise ConfigError(f"{path}.{key}: required key missing")
    v = d[key]
    if typ is int and isinstance(v, bool):
        raise ConfigError(f"{path}.{key}: expected int, got bool")
    if not isinstance(v, typ):
        raise ConfigError(f"{path}.{key}: expected {typ.__name__}, got {type(v).__name__}")
    return v


def _executor(kind: str, raw: Any, idx: int, default_model: str) -> ExecutorSpec:
    path = f"brain.executors.{kind}s[{idx}]"
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: expected a mapping")
    ex_id = _require(raw, "id", path, str)
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", ex_id):
        raise ConfigError(f"{path}.id: {ex_id!r} is not a valid executor id")
    name = raw.get("name", ex_id)
    model = raw.get("model", default_model)
    instructions = raw.get("instructions", [])
    if isinstance(instructions, str):
        instructions = [instructions]
    if not isinstance(instructions, list) or not all(isinstance(s, str) for s in instructions):
        raise ConfigError(f"{path}.instructions: expected a string or list of strings")
    members = raw.get("members", [])
    steps = raw.get("steps", [])
    if kind == "team" and not members:
        raise ConfigError(f"{path}: a team needs at least one member agent id")
    if kind == "workflow" and not steps:
        raise ConfigError(f"{path}: a workflow needs at least one step agent id")
    return ExecutorSpec(
        kind=kind,
        id=ex_id,
        name=str(name),
        model=str(model),
        instructions=list(instructions),
        members=[str(m) for m in members],
        steps=[str(s) for s in steps],
        description=raw.get("description"),
    )


def load_config(
    path: Optional[os.PathLike[str] | str] = None,
    *,
    env: Optional[Mapping[str, str]] = None,
) -> AgenticOSConfig:
    """Load, substitute, validate. Never returns a partially-valid config."""
    env = os.environ if env is None else env
    cfg_path = Path(path) if path else _default_path()
    if not cfg_path.exists():
        raise ConfigError(f"config file not found: {cfg_path}")
    try:
        raw = yaml.safe_load(cfg_path.read_text()) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{cfg_path}: invalid YAML: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError(f"{cfg_path}: top level must be a mapping")

    data = _resolve(raw, (), env)

    version = _require(data, "version", "<root>", int)
    if version != 1:
        raise ConfigError(f"version: unsupported config version {version}; this loader speaks 1")

    ident = data.get("identity") or {}
    bridge_raw = _require(data, "bridge", "<root>", dict)
    brain_raw = _require(data, "brain", "<root>", dict)
    obs = data.get("observability") or {}

    idem = str(bridge_raw.get("idempotency", "sqlite"))
    if idem not in ("memory", "sqlite"):
        raise ConfigError(f"bridge.idempotency: expected 'memory' or 'sqlite', got {idem!r}")

    bridge = BridgeConfig(
        contract=str(_require(bridge_raw, "contract", "bridge", str)),
        base_url=str(_require(bridge_raw, "base_url", "bridge", str)),
        auth_token=bridge_raw.get("auth_token") or None,
        required_scope=bridge_raw.get("required_scope") or None,
        timeout_ms=int(bridge_raw.get("timeout_ms", 120_000)),
        idempotency=idem,
    )
    if bridge.contract != "turn.v1":
        raise ConfigError(f"bridge.contract: this brain speaks turn.v1, config says {bridge.contract!r}")

    default_model = str(brain_raw.get("default_model", "agenticos-deterministic"))
    execs_raw = brain_raw.get("executors") or {}
    executors: list[ExecutorSpec] = []
    for kind in ("agent", "team", "workflow"):
        for i, item in enumerate(execs_raw.get(f"{kind}s") or []):
            executors.append(_executor(kind, item, i, default_model))

    ids = [e.id for e in executors]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise ConfigError(f"brain.executors: duplicate executor ids {dupes}")
    known_agents = {e.id for e in executors if e.kind == "agent"}
    for e in executors:
        for ref in (*e.members, *e.steps):
            if ref not in known_agents:
                raise ConfigError(
                    f"brain.executors: {e.kind} {e.id!r} references agent {ref!r}, which is not defined"
                )

    db_raw = brain_raw.get("db") or {}
    db_file = Path(str(db_raw.get("file", "data/agenticos-brain.db")))
    if not db_file.is_absolute():
        db_file = cfg_path.parent / db_file

    gov_raw = (data.get("governance") or {}).get("apex_authority") or {}
    gov_mode = str(gov_raw.get("mode", "native"))
    if gov_mode not in ("required", "native"):
        raise ConfigError(f"governance.apex_authority.mode: expected 'required' or 'native', got {gov_mode!r}")
    governance = GovernanceConfig(
        mode=gov_mode,
        cmd=gov_raw.get("cmd") or None,
        default_cmd_relative=str(gov_raw.get("default_cmd", "../APEX-OS/kernel/bin/apex-authority")),
    )

    brain = BrainConfig(
        host=str(brain_raw.get("host", "127.0.0.1")),
        port=int(brain_raw.get("port", 8899)),
        default_model=default_model,
        db_file=db_file,
        executors=executors,
    )

    return AgenticOSConfig(
        version=version,
        identity_name=str(ident.get("name", "agenticos")),
        service_namespace=str(ident.get("service_namespace", "agenticos")),
        bridge=bridge,
        brain=brain,
        otlp_endpoint=obs.get("otlp_endpoint") or None,
        governance=governance,
        source_path=cfg_path,
    )


def _default_path() -> Path:
    env_path = os.environ.get("AGENTICOS_CONFIG")
    if env_path:
        return Path(env_path)
    # planes/brain/agenticos_brain/config.py -> repo root
    return Path(__file__).resolve().parents[3] / "agenticos.config.yaml"


__all__ = ["AgenticOSConfig", "BridgeConfig", "BrainConfig", "GovernanceConfig", "ExecutorSpec", "ConfigError", "load_config"]

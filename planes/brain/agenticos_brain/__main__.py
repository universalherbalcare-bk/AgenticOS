"""``python -m agenticos_brain`` — boot the real brain plane from config."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from .app import build_app
from .config import ConfigError, load_config


def _dump_json(cfg) -> int:
    """Machine-readable projection of the RESOLVED config for the launcher.

    The launcher (bin/agenticos) renders the edge plane's openclaw.json from this
    rather than parsing the YAML a second time, so there is exactly ONE loader
    and ONE set of fail-closed rules. Secrets are never emitted: the token is
    reported only as a boolean, and the edge config references it by env name.
    """
    import json

    print(
        json.dumps(
            {
                "identity": {"name": cfg.identity_name, "service_namespace": cfg.service_namespace},
                "bridge": {
                    "contract": cfg.bridge.contract,
                    "base_url": cfg.bridge.base_url,
                    "auth_token_set": cfg.bridge.auth_token is not None,
                    "required_scope": cfg.bridge.required_scope,
                    "timeout_ms": cfg.bridge.timeout_ms,
                    "idempotency": cfg.bridge.idempotency,
                },
                "brain": {
                    "host": cfg.brain.host,
                    "port": cfg.brain.port,
                    "default_model": cfg.brain.default_model,
                    "db_file": str(cfg.brain.db_file),
                    "executors": [
                        {"kind": e.kind, "id": e.id, "name": e.name, "model": e.model}
                        for e in cfg.brain.executors
                    ],
                },
                "otlp_endpoint_set": cfg.otlp_endpoint is not None,
                "governance": {
                    "mode": cfg.governance.mode,
                    "cmd": cfg.governance.cmd,
                    "default_cmd": str((cfg.source_path.parent / cfg.governance.default_cmd_relative).resolve()),
                },
                "source_path": str(cfg.source_path),
            }
        )
    )
    return 0


def main() -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    try:
        cfg = load_config()
        if "--dump-json" in sys.argv[1:]:
            return _dump_json(cfg)
        app = build_app(cfg)
    except ConfigError as exc:
        print(f"agenticos brain: refusing to start — {exc}", file=sys.stderr)
        return 2
    # Operational override for port collisions on a shared host; the config file
    # remains the source of truth and this is logged, never silent.
    port = int(os.environ.get("AGENTICOS_BRAIN_PORT") or cfg.brain.port)
    if port != cfg.brain.port:
        logging.getLogger("agenticos.brain").warning(
            "port override: AGENTICOS_BRAIN_PORT=%d (config says %d)", port, cfg.brain.port
        )
    uvicorn.run(app, host=cfg.brain.host, port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Stdlib-only client for the APEX kernel authority protocol (apex.authority v1).

Speaks to whatever executable ``APEX_AUTHORITY_CMD`` names (in the merged
product, ``/Users/brijesh/APEX-OS/kernel/bin/apex-authority``) over
stdin/stdout: one JSON request object out, one JSON response object back, per
``APEX-OS/kernel/docs/AUTHORITY-PROTOCOL.md`` and the accompanying
``AuthorityRequest``/``AuthorityResponse`` JSON schemas.

Every call in this module fails closed. A spawn failure, a non-zero exit, a
timeout, a response that is not parseable JSON, ``ok: false``, or (for
``decide``) a ``decision`` that is not one of ``allow``/``deny``/
``approval_required`` are all treated identically: the kernel could not be
consulted, so the call is denied. There is no code path here that lets an
unreachable or misbehaving kernel process silently become an allow.

Configuration is read fresh from the environment on every call (never cached
at import time), so long-lived processes pick up a changed configuration and
tests can inject their own mapping without mutating real process state:

  APEX_AUTHORITY_CMD    executable that speaks this protocol; spawned as
                        ``[APEX_AUTHORITY_CMD]`` with no shell and no extra
                        argv entries (the executable itself, e.g. a wrapper
                        script, is responsible for invoking the actual
                        interpreter/module it needs).
  APEX_AUTHORITY_DIR    sent as the request's "directory" field.
  APEX_AUTHORITY_MODE   "required" or "native" (default "native"). This
                        module does not read the mode itself for decide/
                        resolve/finish (a caller decides whether to call them
                        at all); ``get_mode`` is exposed as a small, shared
                        helper so every plane adapter agrees on the default
                        and on how to fail closed on a garbled value.

No argument or principal VALUE is ever logged by this module: on failure the
returned "detail" names only the failure class (timeout, non-zero exit, bad
JSON, ...), never request or response payload content, and this module never
calls ``logging`` itself.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from typing import Any, Mapping, MutableMapping, Optional

DEFAULT_TIMEOUT_SECONDS = 5.0
MAX_STDOUT_BYTES = 256 * 1024

_VALID_DECISIONS = ("allow", "deny", "approval_required")
_VALID_MODES = ("required", "native")
_DETAIL_LIMIT = 500

__all__ = [
    "DEFAULT_TIMEOUT_SECONDS",
    "MAX_STDOUT_BYTES",
    "get_mode",
    "is_configured",
    "startup_notice",
    "decide",
    "resolve",
    "finish",
]


def _env(env: Optional[Mapping[str, str]]) -> Mapping[str, str]:
    return env if env is not None else os.environ


def _str(env: Mapping[str, str], key: str) -> Optional[str]:
    value = env.get(key)
    if value is None:
        return None
    value = value.strip()
    return value or None


def get_mode(env: Optional[Mapping[str, str]] = None) -> str:
    """``APEX_AUTHORITY_MODE``, defaulting to "native".

    A value other than "required"/"native" is treated as "required": fail
    closed on a garbled configuration rather than silently falling back to
    the plane's own (unmediated) gate.
    """
    mode = _str(_env(env), "APEX_AUTHORITY_MODE") or "native"
    return mode if mode in _VALID_MODES else "required"


def is_configured(env: Optional[Mapping[str, str]] = None) -> bool:
    """Whether an authority command is configured in ``env`` (or the process
    environment). Callers use this to distinguish "kernel said no" from
    "kernel was never wired up" before spending a round-trip."""
    return _str(_env(env), "APEX_AUTHORITY_CMD") is not None


def startup_notice(env: Optional[Mapping[str, str]] = None) -> tuple[int, str]:
    """The one line a plane adapter logs at startup about kernel governance.

    Returns ``(logging level, message)``; this module still never logs, the
    caller does. The level is WARNING whenever the kernel is NOT governing
    tool calls -- native mode (the default, including an unset variable), a
    garbled mode value (which ``get_mode`` fails closed to "required"), or
    "required" without an ``APEX_AUTHORITY_CMD`` (every governed call will be
    denied) -- and INFO only for a fully configured "required". Pure: reads
    ``env`` (or the process environment), touches nothing else.
    """
    active = _env(env)
    raw = _str(active, "APEX_AUTHORITY_MODE")
    mode = get_mode(active)
    command = _str(active, "APEX_AUTHORITY_CMD")
    if mode == "native":
        shown = "unset" if raw is None else repr(raw)
        return (
            logging.WARNING,
            f"APEX kernel authority: mode=native (APEX_AUTHORITY_MODE {shown}); the APEX kernel "
            "is NOT governing tool calls -- the bridge's own operator approval is the only gate. "
            "Set APEX_AUTHORITY_MODE=required and APEX_AUTHORITY_CMD to put the kernel in charge.",
        )
    if raw not in _VALID_MODES:
        prefix = (
            f"APEX kernel authority: APEX_AUTHORITY_MODE={raw!r} is not a recognised value; "
            "failing closed to mode=required. "
        )
    else:
        prefix = "APEX kernel authority: mode=required. "
    if command is None:
        return (
            logging.WARNING,
            prefix + "APEX_AUTHORITY_CMD is not set, so every governed tool call will be DENIED "
            "until it names the kernel launcher.",
        )
    return (
        logging.INFO,
        prefix + f"The APEX kernel governs every tool call via APEX_AUTHORITY_CMD={command}.",
    )


def _deny(reason: str, detail: str) -> dict:
    return {"decision": "deny", "reason": reason, "detail": detail[:_DETAIL_LIMIT]}


def _fail(detail: str) -> dict:
    """Transport-failure envelope for resolve()/finish(), which (unlike
    decide()) have no "decision" field on a normal answer."""
    return {"ok": False, "reason": "kernel_unreachable", "detail": detail[:_DETAIL_LIMIT]}


def _invoke(
    payload: MutableMapping[str, Any],
    *,
    directory: Optional[str],
    command: Optional[str],
    timeout: Optional[float],
    env: Optional[Mapping[str, str]],
) -> tuple[bool, Any]:
    """Send one request, return ``(ok, result_or_failure_detail)``.

    ``ok`` True means the kernel answered normally (that answer may itself be
    a "deny" -- that is a trusted decision, not a transport failure). ``ok``
    False means the kernel could not be consulted at all; the second element
    is then a short, loggable failure-class string, never raw stdout/stderr.
    """
    active_env = _env(env)
    cmd = command if command is not None else _str(active_env, "APEX_AUTHORITY_CMD")
    if not cmd:
        return False, "APEX_AUTHORITY_CMD not configured"

    request = dict(payload)
    directory_value = directory if directory is not None else _str(active_env, "APEX_AUTHORITY_DIR")
    if directory_value is not None:
        request.setdefault("directory", directory_value)

    try:
        body = json.dumps(request).encode("utf-8")
    except (TypeError, ValueError):
        return False, "request not JSON-serialisable"

    wait = timeout if timeout is not None else DEFAULT_TIMEOUT_SECONDS
    try:
        proc = subprocess.run(
            [cmd],
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=wait,
            shell=False,
        )
    except subprocess.TimeoutExpired:
        return False, "authority command timed out"
    except OSError as exc:
        return False, f"authority command could not be started ({type(exc).__name__})"

    stdout = proc.stdout or b""
    if len(stdout) > MAX_STDOUT_BYTES:
        return False, "authority response exceeded size limit"
    if proc.returncode != 0:
        return False, f"authority command exited {proc.returncode}"

    try:
        text = stdout.decode("utf-8")
    except UnicodeDecodeError:
        return False, "authority response was not valid utf-8"

    try:
        response = json.loads(text)
    except (ValueError, RecursionError):
        return False, "authority response was not valid json"

    if not isinstance(response, dict):
        return False, "authority response was not a json object"
    if response.get("ok") is not True:
        return False, "authority response had ok != true"
    result = response.get("result")
    if not isinstance(result, dict):
        return False, "authority response missing a result object"
    return True, result


def decide(
    *,
    plane: str,
    tool: str,
    risk: str,
    principal: Mapping[str, Any],
    args: Mapping[str, Any],
    approval_id: Optional[str] = None,
    directory: Optional[str] = None,
    command: Optional[str] = None,
    timeout: Optional[float] = None,
    env: Optional[Mapping[str, str]] = None,
) -> dict:
    """One ``decide`` round-trip.

    Returns the kernel's result object on a normal answer (``decision`` in
    allow/deny/approval_required), or the fail-closed deny shape
    ``{"decision": "deny", "reason": "kernel_unreachable", "detail": ...}``
    on any transport problem. Never raises for a kernel-side failure; never
    returns "allow" unless the kernel itself said so.
    """
    request: dict = {
        "op": "decide",
        "plane": plane,
        "tool": tool,
        "risk": risk,
        "principal": dict(principal),
        "args": dict(args),
    }
    if approval_id is not None:
        request["approval_id"] = approval_id
    ok, result = _invoke(request, directory=directory, command=command, timeout=timeout, env=env)
    if not ok:
        return _deny("kernel_unreachable", str(result))
    if result.get("decision") not in _VALID_DECISIONS:
        return _deny("kernel_unreachable", "authority response had an unexpected decision")
    return result


def resolve(
    *,
    approval_id: str,
    approve: bool,
    plane: str,
    tool: str,
    risk: str,
    principal: Mapping[str, Any],
    args: Mapping[str, Any],
    directory: Optional[str] = None,
    command: Optional[str] = None,
    timeout: Optional[float] = None,
    env: Optional[Mapping[str, str]] = None,
) -> dict:
    """Relay the human's answer for a pending approval.

    The request names the exact pending action (same plane/tool/risk/
    principal/args as the original ``decide``); the kernel refuses a
    decision that does not match. Returns ``{"ok": True, ...kernel record}``
    on a normal answer, or ``{"ok": False, "reason": "kernel_unreachable",
    "detail": ...}`` on any transport problem -- callers must treat
    ``ok`` False identically to a deny (the approval must not be treated as
    resolved).
    """
    request = {
        "op": "resolve",
        "approval_id": approval_id,
        "approve": bool(approve),
        "plane": plane,
        "tool": tool,
        "risk": risk,
        "principal": dict(principal),
        "args": dict(args),
    }
    ok, result = _invoke(request, directory=directory, command=command, timeout=timeout, env=env)
    if not ok:
        return _fail(str(result))
    return {"ok": True, **result}


def finish(
    *,
    approval_id: str,
    outcome: str,
    directory: Optional[str] = None,
    command: Optional[str] = None,
    timeout: Optional[float] = None,
    env: Optional[Mapping[str, str]] = None,
) -> dict:
    """Record the effect's outcome ("succeeded"/"failed"/"unknown") after it
    ran. This is a receipt, not a gate: a transport failure here cannot and
    must not unwind a run that already executed. It is surfaced as
    ``{"ok": False, ...}`` purely so the caller can log it; callers must
    never retry the run itself because a ``finish`` call failed.
    """
    request = {"op": "finish", "approval_id": approval_id, "outcome": outcome}
    ok, result = _invoke(request, directory=directory, command=command, timeout=timeout, env=env)
    if not ok:
        return _fail(str(result))
    return {"ok": True, **result}

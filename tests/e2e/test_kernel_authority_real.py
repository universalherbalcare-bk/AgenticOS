"""Phase 2 done-criterion, brain plane, against the REAL kernel.

test_kernel_authority.py proves the bridge wiring with a shim. This file repeats the decisive
cases with APEX_AUTHORITY_CMD pointed at the real launcher (kernel/bin/apex-authority in the
merged product) over a fresh authority workspace, so every decision below was made by
apex_os.authority_service over a real SQLite store. It runs only when
APEX_AUTHORITY_REAL_LAUNCHER names that launcher; the merged product's integration job sets it,
a standalone AgenticOS checkout skips with a visible reason rather than a silent pass.
"""

from __future__ import annotations

import json
import os

import pytest

from test_kernel_authority import _assert_one_terminal_event, _drive

LAUNCHER = os.environ.get("APEX_AUTHORITY_REAL_LAUNCHER")
pytestmark = pytest.mark.skipif(
    not LAUNCHER or not os.path.exists(LAUNCHER),
    reason="APEX_AUTHORITY_REAL_LAUNCHER does not name the kernel launcher",
)


@pytest.fixture
def real_kernel(tmp_path, monkeypatch):
    workspace = tmp_path / "authority-workspace"
    workspace.mkdir(mode=0o700)
    monkeypatch.setenv("APEX_AUTHORITY_MODE", "required")
    monkeypatch.setenv("APEX_AUTHORITY_CMD", str(LAUNCHER))
    monkeypatch.setenv("APEX_AUTHORITY_DIR", str(workspace))
    monkeypatch.setenv("APEX_AUTHORITY_TIMEOUT_S", "20")
    return workspace


@pytest.mark.asyncio
async def test_real_kernel_operator_approves_tool_runs_exactly_once(real_kernel):
    events, sink = await _drive("approve", "real-approve", timeout_ms=20000)
    _assert_one_terminal_event(events)
    assert sink == ["WIRED"], sink
    required = [e for e in events if e["type"] == "approval.required"]
    assert len(required) == 1 and len(required[0]["approval_id"]) == 64, required
    assert events[-1]["type"] == "run.completed", events[-1]
    # The kernel's record is consumed with a receipt: the same id cannot be spent again.
    from agenticos_bridge import authority
    replay = authority.decide(
        plane="brain", tool="wire_money", risk="R3",
        principal={"user_id": "u1", "channel": "slack", "scopes": ["ops"]},
        args={"amount": 1000000, "to": "acct-9"}, approval_id=required[0]["approval_id"],
    )
    assert replay["decision"] == "deny", replay


@pytest.mark.asyncio
async def test_real_kernel_operator_denies_tool_never_runs(real_kernel):
    events, sink = await _drive("deny", "real-deny", timeout_ms=20000)
    _assert_one_terminal_event(events)
    assert sink == [], sink
    assert events[-1]["type"] == "run.failed", events[-1]


@pytest.mark.asyncio
async def test_real_kernel_kill_switch_denies_before_any_approval_is_offered(real_kernel):
    policy = real_kernel / "authority-policy.json"
    policy.write_text(json.dumps({"schema": "apex.authority-policy.v1", "disabled": ["brain:wire_money"]}))
    policy.chmod(0o600)
    events, sink = await _drive(None, "real-kill", timeout_ms=20000)
    _assert_one_terminal_event(events)
    assert sink == [], sink
    assert not [e for e in events if e["type"] == "approval.required"], events
    assert events[-1]["type"] == "run.failed" and "tool_disabled" in events[-1]["error"], events[-1]

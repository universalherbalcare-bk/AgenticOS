"""REQ-0042 -- PAUSE vs BLOCK across planes (docs/DECISION-MATRIX.md, 2026-09-13).

PAUSE: the run waits for a decision with a TTL (the turn's ``timeout_ms``,
capped by the kernel record's own TTL), surfaced on ``approval.required`` as
``expires_at``; an approve inside the TTL resumes the run exactly once.

BLOCK: the tool call is refused and the run ends as ``run.failed`` with
``retryable=false`` and a ``reason``. A timed-out pause is a block, and under
kernel governance the kernel's record must be RESOLVED AS REVOKED -- not left to
lapse by TTL (Phase 4 P2) -- before the terminal event is emitted.
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

import pytest

from agenticos_bridge.contract import BLOCK_REASONS
from test_kernel_authority import (  # noqa: F401
    FIXED_APPROVAL_ID,
    PRINCIPAL,
    TwoToolPausingExecutor,
    _assert_one_terminal_event,
    _drive,
    _drive_executor,
    _read_log,
    shim_env,
)

REAL_LAUNCHER = os.environ.get("APEX_AUTHORITY_REAL_LAUNCHER")


def _ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


# ---------------------------------------------------------------------------
# 1. Timeout -> kernel record revoked -> run blocked.


@pytest.mark.asyncio
async def test_timeout_revokes_the_kernel_record_and_blocks_the_run(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    before_ms = int(time.time() * 1000)

    events, sink = await _drive(None, "block-timeout", timeout_ms=1000)
    types = [e["type"] for e in events]

    assert sink == [], f"tool ran after a timed-out approval: {sink}"
    assert "tool.started" not in types
    last = events[-1]
    assert last["type"] == "run.failed" and last["reason"] == "approval_timed_out" and last["retryable"] is False
    assert last["reason"] in BLOCK_REASONS
    _assert_one_terminal_event(events)

    # The kernel was told: resolve(approve=False) on the exact pending action,
    # BEFORE the terminal event, so its ledger shows "revoked", not "expired".
    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "resolve"], logged
    revoke = logged[1]
    assert revoke["approve"] is False and revoke["approval_id"] == FIXED_APPROVAL_ID
    assert revoke["tool"] == "wire_money" and revoke["args"] == {"amount": 1000000, "to": "acct-9"}
    assert revoke["principal"] == PRINCIPAL

    # The pause carried its TTL: expires_at == start + timeout_ms (within slack).
    required = [e for e in events if e["type"] == "approval.required"]
    assert len(required) == 1
    expires_ms = _ms(required[0]["expires_at"])
    assert before_ms + 1000 <= expires_ms <= before_ms + 1000 + 2000, (before_ms, expires_ms)


@pytest.mark.asyncio
async def test_timeout_revokes_every_record_of_a_multi_tool_frame(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")
    sink: list[str] = []

    events, _ = await _drive_executor(TwoToolPausingExecutor(sink), None, "block-timeout-multi", timeout_ms=1000)
    assert sink == [] and events[-1]["type"] == "run.failed" and events[-1]["reason"] == "approval_timed_out"
    _assert_one_terminal_event(events)
    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "decide", "resolve", "resolve"], logged
    assert [(r["tool"], r["approve"]) for r in logged[2:]] == [("wire_money", False), ("delete_prod_database", False)]


@pytest.mark.asyncio
async def test_pause_ttl_is_capped_by_the_kernel_records_ttl(shim_env):
    """The bridge never waits past the kernel record's expires_at: an answer
    arriving after the record lapsed could not be resolved anyway."""
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow", ttl_ms=700)
    before_ms = int(time.time() * 1000)

    started = time.monotonic()
    events, sink = await _drive(None, "block-kernel-ttl", timeout_ms=30000)
    elapsed = time.monotonic() - started

    assert sink == []
    assert events[-1]["type"] == "run.failed" and events[-1]["reason"] == "approval_timed_out"
    assert elapsed < 10, f"waited {elapsed:.1f}s past the kernel TTL"
    required = [e for e in events if e["type"] == "approval.required"]
    assert before_ms + 700 <= _ms(required[0]["expires_at"]) <= before_ms + 700 + 2000
    assert [r["op"] for r in _read_log(log_path)] == ["decide", "resolve"]
    assert _read_log(log_path)[1]["approve"] is False


@pytest.mark.asyncio
async def test_native_timeout_is_a_block_with_a_reason(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("deny_at_decide")
    os.environ["APEX_AUTHORITY_MODE"] = "native"

    events, sink = await _drive(None, "block-native-timeout", timeout_ms=1000)
    assert sink == []
    assert events[-1]["type"] == "run.failed" and events[-1]["reason"] == "approval_timed_out"
    assert events[-1]["retryable"] is False
    assert "expires_at" in next(e for e in events if e["type"] == "approval.required")
    _assert_one_terminal_event(events)
    assert not os.path.exists(log_path), "the kernel shim was invoked in native mode"


# ---------------------------------------------------------------------------
# 2. Approve before the TTL -> resumes exactly once.


@pytest.mark.asyncio
async def test_approve_before_timeout_resumes_exactly_once(shim_env):
    log_path, set_mode, _ = shim_env
    set_mode("approval_then_allow")

    events, sink = await _drive("approve", "pause-approve", timeout_ms=5000)
    types = [e["type"] for e in events]

    assert sink == ["WIRED"], f"approved tool must run exactly once: {sink}"
    assert types.count("approval.required") == 1 and types.count("tool.started") == 1
    assert types[-1] == "run.completed"
    _assert_one_terminal_event(events)
    logged = _read_log(log_path)
    assert [r["op"] for r in logged] == ["decide", "resolve", "decide", "finish"], logged
    assert sum(1 for r in logged if r["op"] == "resolve") == 1, "resolved once, never re-resolved"
    assert logged[1]["approve"] is True and logged[3]["outcome"] == "succeeded"


# ---------------------------------------------------------------------------
# 3. Every block carries a reason from the closed set; every reason is BLOCK.


@pytest.mark.asyncio
async def test_every_block_path_names_its_reason(shim_env):
    _, set_mode, _ = shim_env
    set_mode("deny_at_decide")
    denied, _ = await _drive(None, "reason-kernel-deny")
    assert denied[-1]["reason"] == "kernel_denied"

    set_mode("garbage")
    garbage, _ = await _drive(None, "reason-garbage")
    assert garbage[-1]["reason"] == "kernel_unreachable"

    set_mode("approval_then_deny_on_consume")
    consumed, _ = await _drive("approve", "reason-consume")
    assert consumed[-1]["reason"] == "kernel_denied"

    set_mode("approval_then_allow")
    operator, _ = await _drive("deny", "reason-operator")
    assert operator[-1]["reason"] == "approval_denied"

    for ev in (denied, garbage, consumed, operator):
        assert ev[-1]["type"] == "run.failed" and ev[-1]["retryable"] is False
        assert ev[-1]["reason"] in BLOCK_REASONS


# ---------------------------------------------------------------------------
# 4. Against the REAL kernel: the record's own status after a timeout.


@pytest.fixture
def real_kernel(tmp_path, monkeypatch):
    workspace = tmp_path / "authority-workspace"
    workspace.mkdir(mode=0o700)
    monkeypatch.setenv("APEX_AUTHORITY_MODE", "required")
    monkeypatch.setenv("APEX_AUTHORITY_CMD", str(REAL_LAUNCHER))
    monkeypatch.setenv("APEX_AUTHORITY_DIR", str(workspace))
    return workspace


@pytest.mark.skipif(
    not REAL_LAUNCHER or not os.path.exists(REAL_LAUNCHER),
    reason="APEX_AUTHORITY_REAL_LAUNCHER does not name the kernel launcher",
)
@pytest.mark.asyncio
async def test_real_kernel_timeout_leaves_the_record_revoked_not_pending(real_kernel):
    from agenticos_bridge import authority

    events, sink = await _drive(None, "real-block-timeout", timeout_ms=1000)
    assert sink == []
    assert events[-1]["type"] == "run.failed" and events[-1]["reason"] == "approval_timed_out"
    _assert_one_terminal_event(events)
    required = [e for e in events if e["type"] == "approval.required"]
    assert len(required) == 1 and len(required[0]["approval_id"]) == 64
    # Kernel ledger truth: consuming the id now is refused with record_status
    # "revoked" (the bridge's resolve landed), not "pending"/"expired".
    after = authority.decide(
        plane="brain", tool="wire_money", risk="R3", principal=dict(PRINCIPAL),
        args={"amount": 1000000, "to": "acct-9"}, approval_id=required[0]["approval_id"],
    )
    assert after["decision"] == "deny" and after.get("record_status") == "revoked", after
    # And the pause TTL the edge saw never exceeded the kernel's 5-minute record TTL.
    assert _ms(required[0]["expires_at"]) <= int(time.time() * 1000) + 300_000

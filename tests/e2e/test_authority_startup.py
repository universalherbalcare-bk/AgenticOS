"""The one startup line that says whether the APEX kernel governs tool calls.

Red team C7 (2026-09-13): nothing in a running bridge's logs distinguished
APEX_AUTHORITY_MODE=required from native, so an operator could not tell from
the logs that the kernel was NOT in charge. ``authority.startup_notice`` is a
pure helper (env in, (level, message) out); ``BrainBridge`` logs it once at
construction.
"""

from __future__ import annotations

import logging

import pytest

from agenticos_bridge import BrainBridge, authority


def test_native_mode_is_a_warning_that_names_the_gap():
    level, message = authority.startup_notice({})
    assert level == logging.WARNING
    assert "mode=native" in message
    assert "NOT governing tool calls" in message
    assert "APEX_AUTHORITY_MODE unset" in message


def test_explicit_native_shows_the_value_it_read():
    level, message = authority.startup_notice({"APEX_AUTHORITY_MODE": "native"})
    assert level == logging.WARNING
    assert "'native'" in message and "NOT governing" in message


def test_required_without_a_command_warns_that_everything_will_be_denied():
    level, message = authority.startup_notice({"APEX_AUTHORITY_MODE": "required"})
    assert level == logging.WARNING
    assert "mode=required" in message
    assert "APEX_AUTHORITY_CMD is not set" in message and "DENIED" in message


def test_required_with_a_command_is_the_only_info_line():
    env = {"APEX_AUTHORITY_MODE": "required", "APEX_AUTHORITY_CMD": "/opt/apex/bin/apex-authority"}
    level, message = authority.startup_notice(env)
    assert level == logging.INFO
    assert "mode=required" in message
    assert "APEX_AUTHORITY_CMD=/opt/apex/bin/apex-authority" in message
    assert "NOT governing" not in message


def test_garbled_mode_fails_closed_to_required_and_says_so():
    env = {"APEX_AUTHORITY_MODE": "yes please", "APEX_AUTHORITY_CMD": "/opt/apex/bin/apex-authority"}
    level, message = authority.startup_notice(env)
    assert authority.get_mode(env) == "required"
    assert level == logging.INFO
    assert "'yes please'" in message and "not a recognised value" in message and "failing closed" in message


@pytest.mark.parametrize("mode", ["native", "required"])
def test_bridge_construction_logs_the_notice_once(monkeypatch, caplog, mode):
    monkeypatch.setenv("APEX_AUTHORITY_MODE", mode)
    monkeypatch.setenv("APEX_AUTHORITY_CMD", "/opt/apex/bin/apex-authority")
    with caplog.at_level(logging.INFO, logger="agenticos.bridge"):
        BrainBridge()
    lines = [r for r in caplog.records if "APEX kernel authority" in r.getMessage()]
    assert len(lines) == 1, [r.getMessage() for r in caplog.records]
    expected_level = logging.WARNING if mode == "native" else logging.INFO
    assert lines[0].levelno == expected_level
    assert f"mode={mode}" in lines[0].getMessage()

"""The JSON Schema is canonical; the Python models are its projection.

These tests fail the build if the two drift. Without this, the "single source of
truth" claim in the contract file is only a comment.
"""

from __future__ import annotations

import json
import typing
from pathlib import Path

import pytest

from agenticos_bridge import contract as C

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "bridge" / "contract" / "turn.schema.json"


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def test_schema_file_exists_and_is_versioned(schema):
    assert schema["$id"].endswith("turn.v1.json")
    assert schema["version"] == "1.0.0"


def test_every_schema_event_has_a_python_model(schema):
    schema_types = {
        m["properties"]["type"]["const"] for m in schema["$defs"]["TurnEvent"]["oneOf"]
    }
    python_types = {
        m.model_fields["type"].default
        for m in typing.get_args(typing.get_args(C.TurnEvent)[0])
    }
    assert schema_types == python_types, (
        f"contract drift — only in schema: {schema_types - python_types}; "
        f"only in python: {python_types - schema_types}"
    )


def test_terminal_events_match_schema_intent():
    assert C.TERMINAL_EVENT_TYPES == {"run.completed", "run.failed"}


@pytest.mark.parametrize("model_name", ["TurnRequest", "Principal", "Target", "TraceContext"])
def test_required_fields_match(schema, model_name):
    schema_required = set(schema["$defs"][model_name]["required"])
    model = getattr(C, model_name)
    python_required = {n for n, f in model.model_fields.items() if f.is_required()}
    assert schema_required == python_required, (
        f"{model_name} required-field drift: schema={schema_required} python={python_required}"
    )


@pytest.mark.parametrize("model_name", ["TurnRequest", "Principal", "Target", "TraceContext", "Attachment"])
def test_property_names_match(schema, model_name):
    schema_props = set(schema["$defs"][model_name]["properties"])
    python_props = set(getattr(C, model_name).model_fields)
    assert schema_props == python_props, (
        f"{model_name} property drift: only-schema={schema_props - python_props} "
        f"only-python={python_props - schema_props}"
    )


def test_models_forbid_unknown_fields():
    """additionalProperties:false in the schema must be enforced in Python too."""
    for name in ("TurnRequest", "Principal", "Target", "TraceContext"):
        assert getattr(C, name).model_config.get("extra") == "forbid", name


# ---------------------------------------------------------------------------
# Per-event property parity (added with REQ-0041/REQ-0042, 2026-09-13). The
# tests above compare event TYPE sets and request-side properties; an optional
# field added to one event in the schema but not in Python (or vice versa)
# passed unnoticed. Every event member's property names must now match exactly.


def _schema_event(schema: dict, type_name: str) -> dict:
    return next(m for m in schema["$defs"]["TurnEvent"]["oneOf"] if m["properties"]["type"]["const"] == type_name)


def _python_event(type_name: str):
    return next(
        m for m in typing.get_args(typing.get_args(C.TurnEvent)[0]) if m.model_fields["type"].default == type_name
    )


@pytest.mark.parametrize(
    "type_name",
    ["run.started", "output.delta", "reasoning.delta", "tool.started", "tool.completed",
     "approval.required", "run.completed", "run.failed"],
)
def test_event_property_names_match(schema, type_name):
    schema_props = set(_schema_event(schema, type_name)["properties"])
    python_props = set(_python_event(type_name).model_fields)
    assert schema_props == python_props, (
        f"{type_name} property drift: only-schema={schema_props - python_props} "
        f"only-python={python_props - schema_props}"
    )


def test_run_failed_reason_enum_matches_schema(schema):
    schema_reasons = set(_schema_event(schema, "run.failed")["properties"]["reason"]["enum"])
    python_reasons = set(typing.get_args(C.FailureReason))
    assert schema_reasons == python_reasons, (
        f"reason enum drift: only-schema={schema_reasons - python_reasons} only-python={python_reasons - schema_reasons}"
    )
    assert C.BLOCK_REASONS < python_reasons, "every BLOCK reason must be a valid reason"
    assert "approval_timed_out" in C.BLOCK_REASONS and "approval_denied" in C.BLOCK_REASONS


def test_approval_required_carries_the_pause_ttl(schema):
    props = _schema_event(schema, "approval.required")["properties"]
    assert props["expires_at"]["format"] == "date-time"
    assert "expires_at" not in _schema_event(schema, "approval.required")["required"], "additive: optional"

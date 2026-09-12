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

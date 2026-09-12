"""Typed mirror of bridge/contract/turn.schema.json.

The JSON Schema is canonical. This module is the Python projection of it, and
`test_contract_parity` asserts the two never drift. Illegal states are made
unrepresentable here (discriminated unions, constrained strings, forbidden
extras) so a malformed turn is rejected at the boundary rather than halfway
through an agent run.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

TRACE_ID_RE = r"^[0-9a-f]{32}$"
SPAN_ID_RE = r"^[0-9a-f]{16}$"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Strict(BaseModel):
    """Reject unknown fields at the plane boundary rather than silently dropping them."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class TraceContext(_Strict):
    trace_id: str = Field(pattern=TRACE_ID_RE)
    span_id: str = Field(pattern=SPAN_ID_RE)
    sampled: bool = True


class Target(_Strict):
    kind: Literal["agent", "team", "workflow"]
    id: str = Field(min_length=1, max_length=128)


class Attachment(_Strict):
    kind: Literal["image", "audio", "video", "file"]
    uri: str
    mime_type: Optional[str] = None
    size_bytes: Optional[int] = Field(default=None, ge=0)


class Principal(_Strict):
    user_id: str = Field(min_length=1)
    display_name: Optional[str] = None
    channel: str
    channel_user: Optional[str] = None
    scopes: list[str] = Field(default_factory=list)


class TurnInput(_Strict):
    text: str
    attachments: list[Attachment] = Field(default_factory=list, max_length=32)


class TurnOptions(_Strict):
    stream: bool = True
    timeout_ms: int = Field(default=120_000, ge=1_000, le=3_600_000)


class TurnRequest(_Strict):
    turn_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    target: Target
    input: TurnInput
    principal: Principal
    trace: TraceContext
    options: TurnOptions = Field(default_factory=TurnOptions)


class Usage(_Strict):
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    tool_calls: int = Field(default=0, ge=0)
    duration_ms: int = Field(default=0, ge=0)


class RunStarted(_Strict):
    type: Literal["run.started"] = "run.started"
    turn_id: str
    run_id: Optional[str] = None
    ts: str = Field(default_factory=_utcnow)


class OutputDelta(_Strict):
    type: Literal["output.delta"] = "output.delta"
    turn_id: str
    text: str
    ts: str = Field(default_factory=_utcnow)


class ReasoningDelta(_Strict):
    """Brain-plane reasoning trace.

    Agno emits ReasoningStarted/ReasoningStep/ReasoningContentDelta/ReasoningCompleted.
    Without this member the bridge would discard the brain plane's strongest
    differentiator at the boundary. The edge plane may decline to *render* these
    in a channel, but must still receive them so traces stay complete.
    """

    type: Literal["reasoning.delta"] = "reasoning.delta"
    turn_id: str
    text: str
    ts: str = Field(default_factory=_utcnow)


class ToolStarted(_Strict):
    type: Literal["tool.started"] = "tool.started"
    turn_id: str
    tool: str
    args_preview: Optional[str] = Field(default=None, max_length=512)
    ts: str = Field(default_factory=_utcnow)


class ToolCompleted(_Strict):
    type: Literal["tool.completed"] = "tool.completed"
    turn_id: str
    tool: str
    ok: bool
    error: Optional[str] = None
    ts: str = Field(default_factory=_utcnow)


class ApprovalRequired(_Strict):
    type: Literal["approval.required"] = "approval.required"
    turn_id: str
    approval_id: str
    prompt: str
    tool: Optional[str] = None
    ts: str = Field(default_factory=_utcnow)


class RunCompleted(_Strict):
    type: Literal["run.completed"] = "run.completed"
    turn_id: str
    run_id: Optional[str] = None
    output: str
    usage: Usage = Field(default_factory=Usage)
    ts: str = Field(default_factory=_utcnow)


class RunFailed(_Strict):
    type: Literal["run.failed"] = "run.failed"
    turn_id: str
    error: str
    retryable: bool = False
    ts: str = Field(default_factory=_utcnow)


TurnEvent = Annotated[
    Union[
        RunStarted,
        OutputDelta,
        ReasoningDelta,
        ToolStarted,
        ToolCompleted,
        ApprovalRequired,
        RunCompleted,
        RunFailed,
    ],
    Field(discriminator="type"),
]

TERMINAL_EVENT_TYPES = frozenset({"run.completed", "run.failed"})


class ApprovalDecision(_Strict):
    approval_id: str
    decision: Literal["approve", "deny"]
    principal: Principal
    reason: Optional[str] = Field(default=None, max_length=1024)


__all__ = [
    "TraceContext", "Target", "Attachment", "Principal", "TurnInput",
    "TurnOptions", "TurnRequest", "Usage", "RunStarted", "OutputDelta",
    "ReasoningDelta", "ToolStarted", "ToolCompleted", "ApprovalRequired", "RunCompleted",
    "RunFailed", "TurnEvent", "ApprovalDecision", "TERMINAL_EVENT_TYPES",
]

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
    """PAUSE (REQ-0042): the run is waiting for a decision.

    ``expires_at`` is the instant the pause lapses. Until then the brain
    waits and resumes on approve; past it the run is BLOCKED (``RunFailed``
    with ``reason="approval_timed_out"``) and, under kernel governance, the
    kernel's own approval record is resolved as revoked rather than merely
    left to lapse by TTL.
    """

    type: Literal["approval.required"] = "approval.required"
    turn_id: str
    approval_id: str
    prompt: str
    tool: Optional[str] = None
    expires_at: Optional[str] = None
    ts: str = Field(default_factory=_utcnow)


class RunCompleted(_Strict):
    type: Literal["run.completed"] = "run.completed"
    turn_id: str
    run_id: Optional[str] = None
    output: str
    usage: Usage = Field(default_factory=Usage)
    ts: str = Field(default_factory=_utcnow)


FailureReason = Literal[
    "approval_timed_out",
    "approval_denied",
    "kernel_denied",
    "kernel_unreachable",
    "pause_not_resumable",
    "executor_error",
    "client_disconnected",
    "cancelled",
]

# The reasons that mean BLOCK (REQ-0042): a tool call was refused, or an
# approval could not be obtained, and the run was ended rather than resumed.
BLOCK_REASONS = frozenset(
    {"approval_timed_out", "approval_denied", "kernel_denied", "kernel_unreachable", "pause_not_resumable"}
)


class RunFailed(_Strict):
    """Terminal. A BLOCKED run is a ``RunFailed`` with ``retryable=False`` and
    a ``reason`` in ``BLOCK_REASONS``; ``error`` stays the human-readable text."""

    type: Literal["run.failed"] = "run.failed"
    turn_id: str
    error: str
    retryable: bool = False
    reason: Optional[FailureReason] = None
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
    "RunFailed", "FailureReason", "BLOCK_REASONS", "TurnEvent", "ApprovalDecision",
    "TERMINAL_EVENT_TYPES",
]

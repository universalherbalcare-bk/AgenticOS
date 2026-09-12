"""AgenticOS bridge — the single sanctioned boundary between planes."""
from .contract import (  # noqa: F401
    ApprovalDecision, Principal, Target, TraceContext, TurnEvent, TurnRequest,
)
from .server import BrainBridge, IdempotencyStore  # noqa: F401

__version__ = "1.0.0"
CONTRACT_VERSION = "turn.v1"

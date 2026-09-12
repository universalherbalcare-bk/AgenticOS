"""Brain-plane bridge server.

Mounts onto the Agno AgentOS FastAPI app and exposes the ONE endpoint the edge
plane is allowed to call. Everything here is fail-closed: an unresolvable
target, an unauthorised principal, a replayed turn, or an executor exception
all terminate the stream with an explicit terminal event. There is no path that
ends a stream without either `run.completed` or `run.failed`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Iterable, Mapping, Optional

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from . import authority
from .contract import (
    ApprovalDecision,
    ApprovalRequired,
    OutputDelta,
    Principal,
    ReasoningDelta,
    RunCompleted,
    RunFailed,
    RunStarted,
    ToolCompleted,
    ToolStarted,
    TurnRequest,
    Usage,
)

logger = logging.getLogger("agenticos.bridge")

# Agno RunEvent.value -> bridge event factory. Agno emits ~35 event types; the
# bridge is a deliberately narrow waist. Anything not mapped here is dropped on
# purpose (it is brain-plane-internal), EXCEPT terminal and reasoning events,
# which must always cross.
_TOOL_OK = {"ToolCallCompleted"}
_TOOL_ERR = {"ToolCallError"}
_CONTENT = {"RunContent", "RunIntermediateContent"}
_REASONING = {"ReasoningStep", "ReasoningContentDelta"}
_TERMINAL_OK = {"RunCompleted"}
_TERMINAL_ERR = {"RunError", "RunCancelled"}
_PAUSED = {"RunPaused"}

# Agno exposes THREE separate event vocabularies with different names for the
# same lifecycle: RunEvent (agent), TeamRunEvent (Team-prefixed) and
# WorkflowRunEvent (Workflow-/Step-prefixed). Verified by enumerating the enums.
# Matching only the agent names silently produced empty output for team targets,
# so every incoming name is normalised to the agent vocabulary first.
_WORKFLOW_LIFECYCLE = {
    "WorkflowStarted": "RunStarted",
    "WorkflowCompleted": "RunCompleted",
    "WorkflowError": "RunError",
    "WorkflowCancelled": "RunCancelled",
    "WorkflowPaused": "RunPaused",
}
# A workflow Step is the closest analogue the contract has to a unit of work, so
# steps are surfaced as tool events. This is a deliberate rendering choice: the
# edge plane gets per-step progress instead of a silent gap between start and end.
_STEP_LIFECYCLE = {
    "StepStarted": "ToolCallStarted",
    "StepCompleted": "ToolCallCompleted",
    "StepError": "ToolCallError",
    "StepPaused": "RunPaused",
}


def _normalize_event(name: str) -> str:
    """Fold Team*/Workflow*/Step* event names onto the agent vocabulary."""
    if name.startswith("Team"):
        return name[len("Team") :]
    if name in _WORKFLOW_LIFECYCLE:
        return _WORKFLOW_LIFECYCLE[name]
    if name in _STEP_LIFECYCLE:
        return _STEP_LIFECYCLE[name]
    return name


class IdempotencyStore:
    """Turn-level replay guard.

    The bridge contract declares `turn_id` an idempotency key: a redelivered
    turn must not execute twice. Channels genuinely redeliver (Slack retries on
    a slow ack, a gateway restart replays an in-flight turn), so this is a
    correctness control, not an optimisation.

    In-memory by default. Swap in a Redis/Postgres-backed implementation for
    multi-process deployments by passing `store=` to BrainBridge; the interface
    is deliberately two methods.
    """

    def __init__(self, ttl_seconds: int = 3600, max_entries: int = 100_000) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._seen: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def claim(self, turn_id: str) -> bool:
        """Return True if this turn_id is new (caller owns execution)."""
        now = time.monotonic()
        async with self._lock:
            self._evict(now)
            if turn_id in self._seen:
                return False
            if len(self._seen) >= self._max:
                # Bounded memory: drop the oldest decile rather than grow without limit.
                for key in sorted(self._seen, key=self._seen.__getitem__)[: self._max // 10 or 1]:
                    self._seen.pop(key, None)
            self._seen[turn_id] = now
            return True

    async def release(self, turn_id: str) -> None:
        """Release a claim so a genuinely failed turn can be retried."""
        async with self._lock:
            self._seen.pop(turn_id, None)

    def _evict(self, now: float) -> None:
        expired = [k for k, t in self._seen.items() if now - t > self._ttl]
        for k in expired:
            self._seen.pop(k, None)


@dataclass
class PendingApproval:
    """One paused tool call awaiting an operator decision.

    ``turn_id`` and ``principal`` are the ownership binding checked by
    ``BrainBridge.resolve_approval``: a decision is accepted only when it names
    this turn AND comes from the principal that started it. Before this binding
    existed the map was keyed by approval_id alone, so any caller who knew (or,
    in native mode, could predict -- ``f"{turn_id}:{run_id}"``) an approval id
    could approve or deny another turn's paused action (red team A1/C6,
    2026-09-13).
    """

    future: asyncio.Future
    turn_id: str
    principal: Principal
    created_at: float = field(default_factory=time.monotonic)


@dataclass
class _Gate:
    """One tool call of a paused frame that still needs an operator decision."""

    tool: str
    args: dict
    approval_id: str


def _sse(payload: Any) -> str:
    """Serialise one contract event as an SSE frame."""
    body = payload.model_dump(exclude_none=True) if hasattr(payload, "model_dump") else payload
    return f"data: {json.dumps(body, separators=(',', ':'))}\n\n"


def _event_name(ev: Any) -> str:
    """Extract Agno's event discriminator across its enum/str representations."""
    raw = getattr(ev, "event", None)
    if raw is None:
        return ""
    return getattr(raw, "value", None) or str(raw)


class BrainBridge:
    """Serves the bridge contract on behalf of registered Agno executors."""

    def __init__(
        self,
        *,
        agents: Optional[Mapping[str, Any]] = None,
        teams: Optional[Mapping[str, Any]] = None,
        workflows: Optional[Mapping[str, Any]] = None,
        auth_token: Optional[str] = None,
        required_scope: Optional[str] = None,
        store: Optional[IdempotencyStore] = None,
    ) -> None:
        self._registry: dict[str, Mapping[str, Any]] = {
            "agent": dict(agents or {}),
            "team": dict(teams or {}),
            "workflow": dict(workflows or {}),
        }
        self._auth_token = auth_token
        self._required_scope = required_scope
        self._store = store or IdempotencyStore()
        self._pending: dict[str, PendingApproval] = {}
        self._pending_lock = asyncio.Lock()
        # One unmistakable line, at bridge construction, saying whether the APEX
        # kernel governs tool calls in this process (red team C7: nothing in the
        # logs distinguished a governed bridge from an ungoverned one).
        level, message = authority.startup_notice()
        logger.log(level, message)

    # -- registry ---------------------------------------------------------

    def register(self, kind: str, executor_id: str, executor: Any) -> None:
        if kind not in self._registry:
            raise ValueError(f"unknown executor kind: {kind!r}")
        self._registry[kind][executor_id] = executor

    def _resolve(self, kind: str, executor_id: str) -> Any:
        try:
            return self._registry[kind][executor_id]
        except KeyError:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"no {kind} registered with id {executor_id!r}",
            ) from None

    # -- auth -------------------------------------------------------------

    def _authenticate(self, authorization: Optional[str]) -> None:
        """Bridge auth. Fail closed: if a token is configured it is required."""
        if self._auth_token is None:
            return
        expected = f"Bearer {self._auth_token}"
        # Constant-time compare to avoid leaking the token through timing.
        import hmac

        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="bridge authentication failed",
            )

    def _authorize(self, principal: Principal) -> None:
        """Enforce, not merely log, the scopes the edge plane asserted."""
        if self._required_scope is None:
            return
        if self._required_scope not in principal.scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"principal lacks required scope {self._required_scope!r}",
            )

    # -- execution --------------------------------------------------------

    async def _run(self, req: TurnRequest) -> AsyncIterator[str]:
        """Execute one turn, translating Agno events onto the bridge contract."""
        started = time.monotonic()
        executor = self._resolve(req.target.kind, req.target.id)
        yield _sse(RunStarted(turn_id=req.turn_id))

        final_text: list[str] = []
        tool_calls = 0
        run_id: Optional[str] = None
        # Set when the executor stream delivers its own terminal event. A stream
        # that simply exhausts without one leaves the tool outcome genuinely
        # unknown to the bridge, and the kernel receipt must say so (red team
        # C9: it used to say "succeeded").
        terminal_seen = False
        # Kernel approval ids consumed via _handle_pause in APEX_AUTHORITY_MODE
        # "required", awaiting a finish() receipt once this run's own outcome
        # is known. Empty in "native" mode and whenever the kernel path denied
        # or was never consulted.
        kernel_finish_ids: list[str] = []
        try:
            stream = executor.arun(
                input=req.input.text,
                stream=True,
                stream_events=True,
                session_id=req.session_id,
                user_id=req.principal.user_id,
            )
            async for ev in stream:
                name = _normalize_event(_event_name(ev))
                raw_run_id = getattr(ev, "run_id", None)
                if raw_run_id is not None:
                    # Coerce: a non-str run_id would raise inside the terminal
                    # event constructor, which is built OUTSIDE the try block.
                    run_id = str(raw_run_id)

                if name in _CONTENT:
                    chunk = getattr(ev, "content", None)
                    if isinstance(chunk, str) and chunk:
                        final_text.append(chunk)
                        yield _sse(OutputDelta(turn_id=req.turn_id, text=chunk))

                elif name in _REASONING:
                    text = getattr(ev, "content", None) or getattr(ev, "reasoning_content", None)
                    if isinstance(text, str) and text:
                        yield _sse(ReasoningDelta(turn_id=req.turn_id, text=text))

                elif name == "ToolCallStarted":
                    tool_calls += 1
                    tool = _tool_name(ev)
                    yield _sse(ToolStarted(turn_id=req.turn_id, tool=tool, args_preview=_args_preview(ev)))

                elif name in _TOOL_OK:
                    yield _sse(ToolCompleted(turn_id=req.turn_id, tool=_tool_name(ev), ok=True))

                elif name in _TOOL_ERR:
                    yield _sse(
                        ToolCompleted(
                            turn_id=req.turn_id,
                            tool=_tool_name(ev),
                            ok=False,
                            error=str(getattr(ev, "error", "") or "tool call failed"),
                        )
                    )

                elif name in _PAUSED:
                    # SECURITY: the outcome must gate whether the run continues.
                    # The previous version consumed _handle_pause and then fell
                    # through to the next loop iteration, so a DENIED approval
                    # emitted run.failed and the pending tool executed anyway
                    # (and the stream emitted two terminal events). Verified by
                    # tests/e2e/test_approval_gate.py, which wires $1,000,000
                    # after a denial if this regresses.
                    outcome: dict[str, Any] = {}
                    async for frame in self._handle_pause(req, ev, outcome):
                        yield frame
                    kernel_finish_ids.extend(outcome.get("kernel_finish_ids") or ())
                    if not outcome.get("approved", False):
                        await _aclose(stream)
                        # Every kernel record this run consumed gets a receipt,
                        # including one consumed inside a frame that was then
                        # denied as a whole: the action did not run, so the
                        # honest outcome for its record is "failed".
                        if kernel_finish_ids:
                            await self._finish_kernel_approvals(kernel_finish_ids, "failed")
                        return

                elif name in _TERMINAL_ERR:
                    # Agno does NOT expose `.error` on these events: RunErrorEvent
                    # carries `.content` and RunCancelledEvent carries `.reason`.
                    # Reading `.error` made every brain-plane failure reach the edge
                    # as the literal string "RunError", destroying all diagnostics.
                    if kernel_finish_ids:
                        await self._finish_kernel_approvals(kernel_finish_ids, "failed")
                    yield _sse(
                        RunFailed(
                            turn_id=req.turn_id,
                            error=_error_text(ev, default=name),
                            retryable=(name == "RunCancelled"),
                        )
                    )
                    return

                elif name in _TERMINAL_OK:
                    terminal_seen = True
                    content = getattr(ev, "content", None)
                    if isinstance(content, str) and content and not final_text:
                        final_text.append(content)

        except asyncio.CancelledError:
            # Client disconnected mid-stream. The tool's own outcome is genuinely
            # unknown to the bridge at this point (it may have run, or not).
            if kernel_finish_ids:
                await self._finish_kernel_approvals(kernel_finish_ids, "unknown")
            # Surface it as a terminal event for any recorder downstream, then
            # re-raise so the server tears down.
            yield _sse(RunFailed(turn_id=req.turn_id, error="client disconnected", retryable=True))
            raise
        except Exception as exc:  # noqa: BLE001 - boundary: everything becomes a terminal event
            logger.exception("bridge turn %s failed", req.turn_id)
            await self._store.release(req.turn_id)  # genuine failure -> allow retry
            if kernel_finish_ids:
                await self._finish_kernel_approvals(kernel_finish_ids, "failed")
            yield _sse(RunFailed(turn_id=req.turn_id, error=f"{type(exc).__name__}: {exc}", retryable=True))
            return

        if kernel_finish_ids:
            if not terminal_seen:
                logger.warning(
                    "bridge turn %s: executor stream ended without a terminal event; "
                    "kernel receipts recorded as 'unknown'",
                    req.turn_id,
                )
            await self._finish_kernel_approvals(
                kernel_finish_ids, "succeeded" if terminal_seen else "unknown"
            )
        yield _sse(
            RunCompleted(
                turn_id=req.turn_id,
                run_id=run_id,
                output="".join(final_text),
                usage=Usage(
                    tool_calls=tool_calls,
                    duration_ms=int((time.monotonic() - started) * 1000),
                ),
            )
        )

    async def _finish_kernel_approvals(self, approval_ids: list[str], outcome_label: str) -> None:
        """Best-effort receipt for every kernel approval this run consumed.

        ``authority.finish`` never raises (it reports transport failure via its
        return value, not an exception); the guard below only protects against a
        programming error in this integration, since the run's own terminal
        event has already been decided by the time this is called and must
        never be masked by a bookkeeping failure here.
        """
        for approval_id in approval_ids:
            try:
                await asyncio.to_thread(authority.finish, approval_id=approval_id, outcome=outcome_label)
            except Exception:  # noqa: BLE001 - see docstring
                logger.debug("authority.finish failed for %s", approval_id, exc_info=True)

    async def _revoke_kernel_approvals(
        self, gates: Iterable[_Gate], principal_payload: Mapping[str, Any]
    ) -> None:
        """Best-effort ``resolve(approve=False)`` for kernel records that were
        proposed for a frame the bridge is now denying as a whole, so the
        kernel's own ledger shows them revoked rather than merely lapsing."""
        for gate in gates:
            try:
                await asyncio.to_thread(
                    authority.resolve,
                    approval_id=gate.approval_id,
                    approve=False,
                    plane="brain",
                    tool=gate.tool,
                    risk="R3",
                    principal=principal_payload,
                    args=gate.args,
                )
            except Exception:  # noqa: BLE001 - revocation is bookkeeping, the frame is already denied
                logger.debug("authority.resolve(revoke) failed for %s", gate.approval_id, exc_info=True)

    async def _handle_pause(
        self, req: TurnRequest, ev: Any, outcome: dict
    ) -> AsyncIterator[str]:
        """Translate an Agno RunPaused into a bridge approval round-trip.

        Sets ``outcome["approved"]`` so the caller can decide whether the run may
        continue, and ``outcome["kernel_finish_ids"]`` (APEX_AUTHORITY_MODE
        "required" only) listing every kernel approval record this frame
        CONSUMED, so the caller can send a finish() receipt for each once the
        run's own outcome is known. Emits a terminal event ONLY when the answer
        is no; on approval it emits nothing and the run proceeds to its own
        terminal event.

        THE FRAME IS THE UNIT OF AUTHORISATION. Agno resumes a paused run as a
        whole: one continue executes every queued tool call. A version of this
        method authorised only the first tool of the frame, so a frame of
        ``[wire_money($1), delete_prod_database]`` reached the kernel as
        "wire_money($1)", was approved on that basis, and both side effects ran
        (red team C5, 2026-09-13). Now every tool in the frame is decided on its
        own name and arguments, and the run resumes only when EVERY one of them
        is allowed; a deny for any tool denies the whole frame, because the
        runtime offers no way to resume some of a frame's tool calls and not
        others.

        In APEX_AUTHORITY_MODE "native" (the default) no kernel process is ever
        spawned; the bridge's own approval id / pending-future gate is the only
        check, and it is applied per tool: one ``approval.required`` per tool
        in the frame, all of which must be approved. In "required":

          1. Immediately on pause, the kernel is asked to `decide` on EACH
             tool in the frame (risk R3 -- Agno's own `requires_confirmation`
             flag does not carry a risk class). Any `deny` fails the run
             without surfacing anything to the edge, and revokes whatever
             records the kernel had already proposed for the frame. Tools the
             kernel answers `allow` need no edge round trip. Every tool
             answered `approval_required` is surfaced to the edge as its own
             ``approval.required`` carrying the KERNEL's approval id, so the
             edge's answer resolves the kernel's own record. Two tools in one
             frame sharing a kernel approval id is a protocol violation and
             fails closed.
          2. When the edge's answers arrive: the first `deny` revokes every
             proposed record and fails the run. Once ALL are approved, each
             record is `resolve(approve=True)`d and then consumed with
             `decide(..., approval_id=...)`; only when every consume returns
             `allow` does the run continue. A consume that does not allow
             fails the run and revokes the records not yet resolved.

        A bridge-side approval TIMEOUT while running in "required" mode does
        not itself call kernel `resolve`: the pending kernel records already
        carry their own short TTL (<= 300s, see AuthorityService.propose) and
        will lapse on their own. This is a deliberate simplification, not an
        oversight -- flagged here since a reviewer should be able to find it
        without re-deriving it from the diff.
        """
        outcome["approved"] = False
        outcome["kernel_finish_ids"] = []
        mode = authority.get_mode()
        tools = _paused_tool_calls(ev)
        prompt_text = str(getattr(ev, "content", None) or "Approval required to continue.")
        principal_payload = req.principal.model_dump(exclude_none=True)
        multi = len(tools) > 1

        gates: list[_Gate] = []
        if mode == "required":
            consumed: list[str] = []
            proposed: list[_Gate] = []
            for name, args in tools:
                kernel_tool = name or "unknown"
                decide_result = await asyncio.to_thread(
                    authority.decide,
                    plane="brain",
                    tool=kernel_tool,
                    risk="R3",
                    principal=principal_payload,
                    args=args,
                )
                decision_value = decide_result.get("decision")
                if decision_value == "allow":
                    # Low risk under the kernel's own policy, or (per the
                    # protocol doc) an already-consumed approval -- either way
                    # the kernel has already spoken for this tool.
                    already_consumed = decide_result.get("approval_id")
                    if already_consumed and decide_result.get("reason") == "approval_consumed":
                        consumed.append(already_consumed)
                    continue
                if decision_value == "approval_required":
                    kernel_approval_id = decide_result.get("approval_id")
                    if not isinstance(kernel_approval_id, str) or not kernel_approval_id:
                        error = "kernel authority approval_required without an approval id"
                    elif any(g.approval_id == kernel_approval_id for g in proposed):
                        error = "kernel authority returned the same approval id for two tools"
                    else:
                        proposed.append(_Gate(tool=kernel_tool, args=args, approval_id=kernel_approval_id))
                        continue
                elif decision_value == "deny":
                    detail = decide_result.get("detail") or decide_result.get("reason") or "denied"
                    error = f"kernel authority denied {kernel_tool}: {detail}"
                else:
                    # authority.decide() only ever returns one of allow/deny/
                    # approval_required (anything else is normalised to deny by
                    # the client itself) -- this branch exists purely so a
                    # future change to that contract fails closed here too.
                    error = "kernel authority returned an unrecognised decision"
                # Whole-frame deny: nothing in this frame may run.
                await self._revoke_kernel_approvals(proposed, principal_payload)
                outcome["kernel_finish_ids"] = consumed
                yield _sse(RunFailed(turn_id=req.turn_id, error=error, retryable=False))
                return
            outcome["kernel_finish_ids"] = consumed
            if not proposed:
                outcome["approved"] = True
                return
            gates = proposed
        else:
            base = f"{req.turn_id}:{getattr(ev, 'run_id', 'run')}"
            for index, (name, args) in enumerate(tools):
                # Single-tool frames keep the historical id shape; a multi-tool
                # frame gets one id per tool so each can be answered on its own.
                approval_id = f"{base}:{index}" if multi else base
                gates.append(_Gate(tool=name or "unknown", args=args, approval_id=approval_id))

        loop = asyncio.get_running_loop()
        futures: dict[str, asyncio.Future] = {}
        async with self._pending_lock:
            for gate in gates:
                fut: asyncio.Future = loop.create_future()
                futures[gate.approval_id] = fut
                self._pending[gate.approval_id] = PendingApproval(
                    future=fut, turn_id=req.turn_id, principal=req.principal
                )
        for index, gate in enumerate(gates):
            prompt = f"{prompt_text} [{index + 1}/{len(gates)}: {gate.tool}]" if multi else prompt_text
            yield _sse(
                ApprovalRequired(
                    turn_id=req.turn_id,
                    approval_id=gate.approval_id,
                    prompt=prompt,
                    tool=gate.tool if gate.tool != "unknown" or multi else None,
                )
            )

        denied = False
        deadline = loop.time() + req.options.timeout_ms / 1000
        try:
            waiting = set(futures.values())
            while waiting and not denied:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                done, waiting = await asyncio.wait(
                    waiting, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
                )
                if not done:
                    raise asyncio.TimeoutError
                for fut in done:
                    decision: ApprovalDecision = fut.result()
                    if decision.decision == "deny":
                        denied = True
        except asyncio.TimeoutError:
            yield _sse(RunFailed(turn_id=req.turn_id, error="approval timed out", retryable=False))
            return
        finally:
            async with self._pending_lock:
                for approval_id, fut in futures.items():
                    self._pending.pop(approval_id, None)
                    if not fut.done():
                        fut.cancel()

        if denied:
            if mode == "required":
                await self._revoke_kernel_approvals(gates, principal_payload)
            yield _sse(
                RunFailed(turn_id=req.turn_id, error="approval denied by operator", retryable=False)
            )
            return

        if mode == "required":
            for position, gate in enumerate(gates):
                resolve_result = await asyncio.to_thread(
                    authority.resolve,
                    approval_id=gate.approval_id,
                    approve=True,
                    plane="brain",
                    tool=gate.tool,
                    risk="R3",
                    principal=principal_payload,
                    args=gate.args,
                )
                if not resolve_result.get("ok"):
                    await self._revoke_kernel_approvals(gates[position + 1 :], principal_payload)
                    yield _sse(
                        RunFailed(
                            turn_id=req.turn_id,
                            error="kernel authority unreachable while resolving the approval",
                            retryable=False,
                        )
                    )
                    return
                consume_result = await asyncio.to_thread(
                    authority.decide,
                    plane="brain",
                    tool=gate.tool,
                    risk="R3",
                    principal=principal_payload,
                    args=gate.args,
                    approval_id=gate.approval_id,
                )
                if consume_result.get("decision") != "allow":
                    detail = consume_result.get("detail") or consume_result.get("reason") or "not allowed"
                    await self._revoke_kernel_approvals(gates[position + 1 :], principal_payload)
                    yield _sse(
                        RunFailed(
                            turn_id=req.turn_id,
                            error=f"kernel authority did not allow the approved action: {detail}",
                            retryable=False,
                        )
                    )
                    return
                outcome["kernel_finish_ids"].append(gate.approval_id)

        outcome["approved"] = True

    async def resolve_approval(self, decision: ApprovalDecision, *, turn_id: str) -> bool:
        """Deliver an operator decision to the paused turn that owns it.

        Returns False -- indistinguishably -- when there is no such pending
        approval, when it belongs to a different turn than ``turn_id``, or when
        ``decision.principal`` is not the principal that started that turn. The
        pending future is left untouched in every refused case, so a refused
        attempt cannot consume, expire or otherwise disturb the owner's approval.

        The binding is on ``user_id``: the other Principal fields (display
        name, channel user, scopes) are descriptive or authorisation attributes
        the edge may legitimately re-derive differently when it relays the
        answer, none of them is secret, and scopes are already enforced by
        ``_authorize`` -- requiring them here would add false rejections
        without adding a check an attacker could not satisfy.
        """
        async with self._pending_lock:
            pending = self._pending.get(decision.approval_id)
            if pending is None or pending.future.done():
                return False
            if pending.turn_id != turn_id:
                return False
            if pending.principal.user_id != decision.principal.user_id:
                return False
            pending.future.set_result(decision)
        return True

    # -- router -----------------------------------------------------------

    def router(self) -> APIRouter:
        router = APIRouter(prefix="/v1", tags=["agenticos-bridge"])

        @router.get("/bridge/health")
        async def health(authorization: Optional[str] = Header(default=None)) -> dict:
            """Liveness is public; the executor inventory is not.

            The registry names every agent, team and workflow the brain plane can
            run. That is reconnaissance for anyone probing the bridge, so it is
            returned only to an authenticated caller. When no token is configured
            the bridge is already unauthenticated by choice and the full body is
            returned, which keeps local development unchanged.
            """
            body: dict = {"status": "ok", "contract": "turn.v1"}
            if self._auth_token is not None:
                try:
                    self._authenticate(authorization)
                except HTTPException:
                    return body
            body["executors"] = {k: sorted(v) for k, v in self._registry.items()}
            return body

        @router.post("/turns")
        async def create_turn(
            req: TurnRequest,
            request: Request,
            authorization: Optional[str] = Header(default=None),
        ) -> StreamingResponse:
            self._authenticate(authorization)
            self._authorize(req.principal)
            self._resolve(req.target.kind, req.target.id)  # 404 before opening a stream

            if not await self._store.claim(req.turn_id):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"turn {req.turn_id!r} already processed (idempotency replay)",
                )

            return StreamingResponse(
                self._run(req),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                    "X-AgenticOS-Trace-Id": req.trace.trace_id,
                },
            )

        @router.post("/turns/{turn_id}/approvals/{approval_id}")
        async def resolve(
            turn_id: str,
            approval_id: str,
            decision: ApprovalDecision,
            authorization: Optional[str] = Header(default=None),
        ) -> dict:
            self._authenticate(authorization)
            self._authorize(decision.principal)
            if decision.approval_id != approval_id:
                raise HTTPException(status_code=400, detail="approval_id mismatch")
            # One status and one message for "unknown id", "not this turn's
            # approval" and "not this turn's principal" alike: the response must
            # not tell a caller whether an approval id exists.
            ok = await self.resolve_approval(decision, turn_id=turn_id)
            if not ok:
                raise HTTPException(status_code=404, detail="no such pending approval")
            return {"resolved": True, "approval_id": approval_id, "decision": decision.decision}

        return router


async def _aclose(stream: Any) -> None:
    """Close the underlying provider stream so a halted run stops executing.

    Merely returning from our generator is not enough: the provider generator
    stays suspended and may resume, which is exactly how a denied approval still
    ran its tool.
    """
    closer = getattr(stream, "aclose", None)
    if closer is None:
        return
    try:
        await closer()
    except Exception:  # noqa: BLE001 - closing must never mask the real outcome
        logger.debug("provider stream aclose failed", exc_info=True)


def _error_text(ev: Any, default: str) -> str:
    """Extract a human-meaningful error across Agno's inconsistent event shapes."""
    for attr in ("error", "content", "reason", "message", "detail"):
        value = getattr(ev, attr, None)
        if value is None:
            continue
        text = value if isinstance(value, str) else str(value)
        if text and text.strip():
            return text
    return default


def _tool_name(ev: Any) -> str:
    tool = getattr(ev, "tool", None)
    if tool is None:
        # Workflow Step* events carry step_name rather than a tool object.
        return str(getattr(ev, "tool_name", None) or getattr(ev, "step_name", None) or "")
    return str(getattr(tool, "tool_name", None) or getattr(tool, "name", None) or tool)


def _args_preview(ev: Any) -> Optional[str]:
    tool = getattr(ev, "tool", None)
    args = getattr(tool, "tool_args", None) if tool is not None else None
    if args is None:
        return None
    try:
        return json.dumps(args, separators=(",", ":"))[:512]
    except (TypeError, ValueError):
        return str(args)[:512]


def _paused_tool_calls(ev: Any) -> list[tuple[str, dict]]:
    """Every tool call a RunPaused-family event is waiting on, as (name, args).

    Agno's agent/team RunPausedEvent expose the tool(s) involved in the pause
    on `.tools`, a list of `agno.models.response.ToolExecution` (verified
    against agno/run/agent.py and agno/run/team.py in the installed package:
    both declare `tools: Optional[List[ToolExecution]]`). ToolExecution
    carries `.tool_name`, `.tool_args` (a dict) and `.requires_confirmation`.

    The tools flagged `requires_confirmation` are returned, in order. If the
    frame carries tools but none is flagged (Agno also pauses for user-input
    and external-execution tools), every tool in the frame is returned rather
    than none: the run DID pause, resuming it executes all of them, and the
    bridge would rather over-ask than let a tool through unnamed. The result is
    never empty -- a frame with no tool list at all yields one entry named by
    whatever `_tool_name` can find (typically a workflow step name) with no
    arguments, because Agno's Workflow/Step pause events carry no
    ToolExecution-shaped attribute.

    A previous version returned only the FIRST flagged tool; see
    BrainBridge._handle_pause for why that was a whole-frame bypass.
    """
    tools = getattr(ev, "tools", None)
    if isinstance(tools, list) and tools:
        flagged = [t for t in tools if getattr(t, "requires_confirmation", False)]
        calls = []
        for tool in flagged or tools:
            name = str(getattr(tool, "tool_name", None) or "")
            args = getattr(tool, "tool_args", None)
            calls.append((name, dict(args) if isinstance(args, dict) else {}))
        return calls
    return [(_tool_name(ev), {})]


__all__ = ["BrainBridge", "IdempotencyStore"]

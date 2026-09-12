"""A provider-neutral, fully deterministic Agno model.

Two jobs, both real:

1. **Removes a vendor hard-dependency.** Stock Agno resolves a default model in
   `agno/agent/_init.py:set_default_model()`, which imports
   `agno.models.openai.OpenAIResponses` and raises ImportError if the OpenAI SDK
   is absent — so constructing *any* agent without an explicit model requires
   OpenAI to be installed. In a merged OS that must speak to ~45 providers, that
   is the wrong default. `DeterministicModel` gives AgenticOS a zero-dependency
   default that always constructs.

2. **Makes the bridge testable without network or API keys.** Streaming,
   tool-calling and terminal behaviour are exercised for real; only the token
   generation is canned. Plumbing is genuinely proven; inference is not
   simulated and never claimed to be.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Iterator, List, Optional

from agno.models.base import Model
from agno.models.response import ModelResponse


@dataclass(init=False)
class DeterministicModel(Model):
    """Emits a scripted reply, chunked, with no I/O.

    `responder` receives the outgoing message list and returns the reply text,
    so tests can assert on what the agent actually sent to the model.
    """

    def __init__(
        self,
        id: str = "agenticos-deterministic",
        name: str = "AgenticOS Deterministic",
        provider: str = "agenticos",
        reply: str = "ack",
        chunk_size: int = 8,
        responder: Optional[Callable[[List[Any]], str]] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(id=id, name=name, provider=provider, **kwargs)
        self.reply = reply
        self.chunk_size = max(1, int(chunk_size))
        self.responder = responder
        self.seen_messages: List[Any] = []

    # -- helpers ----------------------------------------------------------

    def _text(self, messages: Optional[List[Any]] = None) -> str:
        if messages:
            self.seen_messages = list(messages)
        if self.responder is not None:
            return self.responder(self.seen_messages)
        return self.reply

    def _full(self, text: str) -> ModelResponse:
        return ModelResponse(
            role="assistant",
            content=text,
            input_tokens=len(self.seen_messages),
            output_tokens=max(1, len(text) // 4),
            total_tokens=len(self.seen_messages) + max(1, len(text) // 4),
        )

    def _chunks(self, text: str) -> Iterator[ModelResponse]:
        for i in range(0, len(text), self.chunk_size):
            yield ModelResponse(role="assistant", content=text[i : i + self.chunk_size])

    # -- Model interface (all six abstract methods implemented) -----------

    def invoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        return self._full(self._text(kwargs.get("messages")))

    async def ainvoke(self, *args: Any, **kwargs: Any) -> ModelResponse:
        return self._full(self._text(kwargs.get("messages")))

    def invoke_stream(self, *args: Any, **kwargs: Any) -> Iterator[ModelResponse]:
        yield from self._chunks(self._text(kwargs.get("messages")))

    async def ainvoke_stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[ModelResponse]:
        for chunk in self._chunks(self._text(kwargs.get("messages"))):
            yield chunk

    def _parse_provider_response(self, response: Any, **kwargs: Any) -> ModelResponse:
        return response if isinstance(response, ModelResponse) else self._full(str(response))

    def _parse_provider_response_delta(self, response: Any) -> ModelResponse:
        return response if isinstance(response, ModelResponse) else ModelResponse(
            role="assistant", content=str(response)
        )


__all__ = ["DeterministicModel"]

"""A deterministic OpenAI-compatible chat-completions server.

PURPOSE — verify the LLM-INITIATED path without an external model or API key:
the REAL OpenClaw agent loop talks to this server over the real openai-completions
wire protocol; this server always decides to call ``agenticos_brain_turn`` first,
then, once the tool result is present in the conversation, answers with it. So
what gets tested is the genuine loop — model → tool call → plugin → bridge →
brain → tool result → final answer — with only the token generation scripted.

It is a STUB and is labelled as one everywhere. It proves plumbing, not
inference quality.

Protocol coverage: POST /v1/chat/completions (stream and non-stream, OpenAI
chunk format incl. tool_calls deltas), GET /v1/models, GET /health.
stdlib only, single-threaded is fine (one agent run at a time in the gate).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = os.environ.get("STUB_MODEL_ID", "tool-caller")
TOOL_HINT = os.environ.get("STUB_TOOL_HINT", "agenticos_brain_turn")
FINAL_PREFIX = "BRAIN SAID: "
STARTED = time.time()
CALLS: list[dict] = []


def _pick_tool_name(tools: list | None) -> str:
    for t in tools or []:
        fn = (t or {}).get("function") or {}
        name = fn.get("name") or (t or {}).get("name") or ""
        if TOOL_HINT in name:
            return name
    return TOOL_HINT


def _last_user_text(messages: list) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _tool_result_text(messages: list) -> str | None:
    for m in reversed(messages):
        if m.get("role") == "tool":
            c = m.get("content")
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            return json.dumps(c)
    return None


def _decide(body: dict) -> dict:
    """Return {'kind': 'tool'|'final', ...} — the entire 'intelligence' of the stub."""
    messages = body.get("messages") or []
    result = _tool_result_text(messages)
    if result is None:
        return {
            "kind": "tool",
            "name": _pick_tool_name(body.get("tools")),
            "arguments": json.dumps({"text": _last_user_text(messages) or "hello"}),
            "call_id": f"call_{uuid.uuid4().hex[:12]}",
        }
    # The tool result may be plain text or JSON from the plugin; surface it verbatim.
    text = result.strip()
    m = re.search(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if m:
        text = json.loads(f'"{m.group(1)}"')
    return {"kind": "final", "text": FINAL_PREFIX + text}


def _usage() -> dict:
    return {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}


class Handler(BaseHTTPRequestHandler):
    server_version = "agenticos-stub-llm/1"

    def log_message(self, fmt, *args):  # quiet
        return

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            return self._json(200, {"ok": True, "stub": True, "calls": len(CALLS), "uptime_s": int(time.time() - STARTED)})
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "agenticos-stub"}]})
        if self.path.rstrip("/").endswith("/calls"):
            return self._json(200, {"calls": CALLS})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid JSON"}})
        decision = _decide(body)
        CALLS.append({"kind": decision["kind"], "n_messages": len(body.get("messages") or []), "n_tools": len(body.get("tools") or [])})
        cid = f"chatcmpl-{uuid.uuid4().hex[:16]}"
        created = int(time.time())
        if body.get("stream"):
            return self._stream(cid, created, decision)
        return self._json(200, self._complete(cid, created, decision))

    # -- non-streaming -----------------------------------------------------
    def _complete(self, cid: str, created: int, d: dict) -> dict:
        if d["kind"] == "tool":
            msg = {"role": "assistant", "content": None,
                   "tool_calls": [{"id": d["call_id"], "type": "function", "function": {"name": d["name"], "arguments": d["arguments"]}}]}
            finish = "tool_calls"
        else:
            msg = {"role": "assistant", "content": d["text"]}
            finish = "stop"
        return {"id": cid, "object": "chat.completion", "created": created, "model": MODEL_ID,
                "choices": [{"index": 0, "message": msg, "finish_reason": finish}], "usage": _usage()}

    # -- streaming (OpenAI chunk format) -----------------------------------
    def _stream(self, cid: str, created: int, d: dict) -> None:
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.end_headers()

        def chunk(delta: dict, finish=None, usage=None):
            payload = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": MODEL_ID,
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage is not None:
                payload["usage"] = usage
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()

        chunk({"role": "assistant"})
        if d["kind"] == "tool":
            chunk({"tool_calls": [{"index": 0, "id": d["call_id"], "type": "function",
                                   "function": {"name": d["name"], "arguments": ""}}]})
            args = d["arguments"]
            for i in range(0, len(args), 12):
                chunk({"tool_calls": [{"index": 0, "function": {"arguments": args[i:i + 12]}}]})
            chunk({}, finish="tool_calls", usage=_usage())
        else:
            text = d["text"]
            for i in range(0, len(text), 10):
                chunk({"content": text[i:i + 10]})
            chunk({}, finish="stop", usage=_usage())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> int:
    port = int(os.environ.get("PORT", "8931"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"stub llm listening on 127.0.0.1:{port} model={MODEL_ID}", file=sys.stderr, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

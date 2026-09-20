#!/usr/bin/env bash
# LLM-INITIATED end-to-end: the REAL OpenClaw agent loop decides to call the brain.
#
#   openclaw agent --local -m "..."  ->  agent loop  ->  model (deterministic
#   OpenAI-compatible STUB, tests/e2e/stub_llm_server.py)  ->  tool_call
#   agenticos_brain_turn  ->  plugin  ->  bridge  ->  python -m agenticos_brain
#   ->  tool result back into the loop  ->  model  ->  final answer.
#
# The model is a stub and is named as such in every line of output. What this
# proves is the genuine agent loop and tool dispatch, which previously could only
# be exercised with a live provider key. What it does NOT prove is inference.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EDGE="$ROOT/planes/edge"
PY="${AGENTICOS_PYTHON:-$ROOT/.venv/bin/python}"
BRAIN_PORT="${E2E_BRAIN_PORT:-8939}"
STUB_PORT="${E2E_STUB_PORT:-8940}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agenticos-loop.XXXXXX")"
STATE="$WORK/edge"; mkdir -p "$STATE"
DB="$WORK/brain.db"
export PYTHONPATH="$ROOT/bridge/py:$ROOT/planes/brain"
export AGENTICOS_CONFIG="$ROOT/tests/brain/verify.config.yaml"
export AGENTICOS_VERIFY_DB="$DB"
export AGENTICOS_BRAIN_PORT="$BRAIN_PORT"
unset OTEL_EXPORTER_OTLP_ENDPOINT || true
export AGENTICOS_BRIDGE_TOKEN="${AGENTICOS_BRIDGE_TOKEN:-loop-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
KERNEL="${APEX_AUTHORITY_CMD:-$ROOT/../APEX-OS/kernel/bin/apex-authority}"
if [[ -x "$KERNEL" ]]; then export APEX_AUTHORITY_MODE="${APEX_AUTHORITY_MODE:-required}" APEX_AUTHORITY_CMD="$KERNEL" APEX_AUTHORITY_DIR="$ROOT"; else export APEX_AUTHORITY_MODE=native; unset APEX_AUTHORITY_CMD; fi

for port in "$BRAIN_PORT" "$STUB_PORT"; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '  ✗ port %s already in use (pid %s) — refusing\n' "$port" "$(lsof -tiTCP:"$port" -sTCP:LISTEN | head -1)" >&2; exit 2
  fi
done
pids=()
cleanup() {
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && wait "$p" 2>/dev/null || true; done
  for port in "$BRAIN_PORT" "$STUB_PORT"; do lp="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"; [[ -n "$lp" ]] && kill $lp 2>/dev/null || true; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do rm -rf "$WORK" 2>/dev/null && break; sleep 0.5; done
}
trap cleanup EXIT
say() { printf '  %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

# 1) brain
"$PY" -m agenticos_brain >"$WORK/brain.log" 2>&1 & pids+=($!)
# 2) stub model
PORT="$STUB_PORT" "$PY" "$ROOT/tests/e2e/stub_llm_server.py" >"$WORK/stub.log" 2>&1 & pids+=($!)
for _ in $(seq 1 80); do curl -sf "http://127.0.0.1:$BRAIN_PORT/v1/bridge/health" >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$STUB_PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$BRAIN_PORT/v1/bridge/health" >/dev/null || { cat "$WORK/brain.log" >&2; fail "brain did not come up"; }
curl -sf "http://127.0.0.1:$STUB_PORT/health" >/dev/null || { cat "$WORK/stub.log" >&2; fail "stub model did not come up"; }
say "✓ brain :$BRAIN_PORT and STUB model :$STUB_PORT up (governance=${APEX_AUTHORITY_MODE})"

# 3) edge config: the agent's model IS the stub; the brain plugin is enabled.
cat >"$STATE/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "auth": { "mode": "token", "token": "\${AGENTICOS_EDGE_GATEWAY_TOKEN}" } },
  "models": {
    "providers": {
      "agenticos-stub": {
        "baseUrl": "http://127.0.0.1:$STUB_PORT/v1",
        "api": "openai-completions",
        "apiKey": "stub-no-key-needed",
        "models": [
          { "id": "tool-caller", "name": "AgenticOS deterministic STUB (not an LLM)", "reasoning": false,
            "input": ["text"], "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 32000, "maxTokens": 4096 }
        ]
      }
    }
  },
  "agents": { "defaults": { "model": { "primary": "agenticos-stub/tool-caller" } } },
  "tools": { "alsoAllow": ["agenticos_brain_turn", "agenticos_brain_approve"] },
  "plugins": { "enabled": true, "allow": ["agenticos-brain"],
    "entries": { "agenticos-brain": { "enabled": true,
      "config": { "baseUrl": "http://127.0.0.1:$BRAIN_PORT", "timeoutMs": 30000,
                  "authToken": "\${AGENTICOS_BRIDGE_TOKEN}",
                  "defaultTarget": { "kind": "agent", "id": "support" } } } } }
}
JSON
export AGENTICOS_EDGE_GATEWAY_TOKEN="loop-gw-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export OPENCLAW_CONFIG_PATH="$STATE/openclaw.json" OPENCLAW_STATE_DIR="$STATE"

# 4) ONE REAL AGENT TURN, locally embedded (no gateway needed for the loop itself).
OUT="$( cd "$EDGE" && node openclaw.mjs agent --local --json --session-id "loop-e2e" \
        -m "Please ask the brain plane this exact question: what is the plane boundary?" 2>"$WORK/agent.err" || true )"
echo "$OUT" >"$WORK/agent.out"
REPLY="$(echo "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | jq -r '.. | .text? // empty' 2>/dev/null | tail -1)"
[[ -n "$REPLY" ]] || { sed 's/\x1b\[[0-9;]*m//g' "$WORK/agent.err" | tail -20 >&2; echo "--- stdout ---" >&2; head -c 1500 "$WORK/agent.out" >&2; fail "agent turn produced no reply"; }

# 5) The reply must be the STUB's final answer wrapping the BRAIN's real output.
[[ "$REPLY" == BRAIN\ SAID:* ]] || fail "reply did not come from the tool-result round: $REPLY"
[[ "$REPLY" == *"Crossed the plane boundary."* ]] || fail "reply does not contain the brain's output: $REPLY"
say "✓ agent loop -> STUB model chose agenticos_brain_turn -> brain -> final: $REPLY"

# 6) The stub must have been consulted exactly twice: once to decide, once after the tool result.
CALLS="$(curl -s "http://127.0.0.1:$STUB_PORT/calls" | jq -c '[.calls[].kind]')"
[[ "$CALLS" == '["tool","final"]' ]] || fail "unexpected model call sequence: $CALLS"
say "✓ model call sequence was exactly [tool, final]"

# 7) The brain's database holds the run the agent loop caused, from channel=openclaw.
"$PY" - "$DB" <<'PYEOF'
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
rows = c.execute("select session_id, run_data from agno_runs").fetchall()
assert rows, "no run persisted — the tool never reached the brain"
md = (json.loads(rows[-1][1]) or {}).get("metadata") or {}
assert md.get("channel") == "openclaw", md
print(f"  ✓ persisted by the brain: session={rows[-1][0]} channel={md['channel']} trace_id={md.get('trace_id')}")
PYEOF
echo "AGENT-LOOP E2E: PASS  (model = deterministic stub; loop, dispatch, bridge, brain, persistence = real)"
trap - EXIT; cleanup; exit 0

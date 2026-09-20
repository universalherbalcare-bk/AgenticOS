#!/usr/bin/env bash
# End-to-end through the REAL edge gateway:
#   openclaw gateway call tools.invoke -> agenticos-brain plugin -> BrainClient
#   -> HTTP+SSE -> python -m agenticos_brain (config-driven, SQLite) -> back,
# then the run is looked up in the brain's database by the run_id the gateway
# returned. Fully isolated: own brain port, own gateway port, own state dir,
# own db, own rendered openclaw.json. No model, no API key: tools.invoke calls
# the tool directly, which is exactly the plane-to-plane path under test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EDGE="$ROOT/planes/edge"
PY="${AGENTICOS_PYTHON:-$ROOT/.venv/bin/python}"
BRAIN_PORT="${E2E_BRAIN_PORT:-8929}"
GW_PORT="${E2E_GATEWAY_PORT:-18929}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agenticos-e2e.XXXXXX")"
STATE="$WORK/edge"; mkdir -p "$STATE"
DB="$WORK/brain.db"
GW_TOKEN="e2e-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export PYTHONPATH="$ROOT/bridge/py:$ROOT/planes/brain"
export AGENTICOS_CONFIG="$ROOT/tests/brain/verify.config.yaml"
export AGENTICOS_VERIFY_DB="$DB"
export AGENTICOS_BRAIN_PORT="$BRAIN_PORT"
unset OTEL_EXPORTER_OTLP_ENDPOINT || true
# Authenticated bridge: the brain REQUIRES this token (verify.config.yaml references
# ${AGENTICOS_BRIDGE_TOKEN}); the rendered edge config passes the same reference.
export AGENTICOS_BRIDGE_TOKEN="${AGENTICOS_BRIDGE_TOKEN:-e2e-bridge-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
# Kernel governance: use the real APEX kernel when a launcher is resolvable, so this
# gate proves the governed path; otherwise run native and SAY so.
KERNEL="${APEX_AUTHORITY_CMD:-$ROOT/../APEX-OS/kernel/bin/apex-authority}"
if [[ -x "$KERNEL" ]]; then
  export APEX_AUTHORITY_MODE="${APEX_AUTHORITY_MODE:-required}" APEX_AUTHORITY_CMD="$KERNEL" APEX_AUTHORITY_DIR="$ROOT"
else
  export APEX_AUTHORITY_MODE=native; unset APEX_AUTHORITY_CMD
fi

for port in "$BRAIN_PORT" "$GW_PORT"; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '  ✗ port %s already in use (pid %s) — refusing to run against an unknown process\n' "$port" "$(lsof -tiTCP:"$port" -sTCP:LISTEN | head -1)" >&2; exit 2
  fi
done
pids=()
# Teardown must be ordered: stop processes, WAIT for them (the gateway spawns a
# control-UI asset builder that keeps writing for a moment after SIGTERM), then
# remove the workdir with a bounded retry. A cleanup hiccup must never flip a
# genuine PASS into exit 1, so the verdict is decided before cleanup runs.
cleanup() {
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null || true; done
  for p in "${pids[@]:-}"; do [[ -n "$p" ]] && wait "$p" 2>/dev/null || true; done
  # The gateway re-execs itself as a detached "openclaw-gateway" process, so the
  # subshell pid is not the listener. Kill by PORT — ours is isolated, so this is
  # deterministic and cannot touch anyone else's gateway.
  for _ in 1 2 3 4 5 6; do
    lp="$(lsof -tiTCP:"$GW_PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$lp" ]] && break
    kill $lp 2>/dev/null || true; sleep 0.5
  done
  bp="$(lsof -tiTCP:"$BRAIN_PORT" -sTCP:LISTEN 2>/dev/null || true)"; [[ -n "$bp" ]] && kill $bp 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do rm -rf "$WORK" 2>/dev/null && break; sleep 0.5; done
  [[ -d "$WORK" ]] && printf '  (note: workdir %s left behind; a child process was still writing)\n' "$WORK" >&2 || true
}
trap cleanup EXIT

say() { printf '  %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

# 1) brain
"$PY" -m agenticos_brain >"$WORK/brain.log" 2>&1 & pids+=($!)
for _ in $(seq 1 80); do curl -sf "http://127.0.0.1:$BRAIN_PORT/v1/bridge/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$BRAIN_PORT/v1/bridge/health" >/dev/null || { cat "$WORK/brain.log" >&2; fail "brain did not come up on :$BRAIN_PORT"; }
say "✓ brain up on :$BRAIN_PORT (isolated db $DB)"
# The bridge must REFUSE an unauthenticated caller — prove the token is enforced.
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$BRAIN_PORT/v1/turns" -H 'content-type: application/json' -d '{}')"
[[ "$code" == "401" ]] || fail "bridge accepted an unauthenticated request (HTTP $code) — token not enforced"
say "✓ bridge rejects unauthenticated callers (401)"
if grep -q "mode=required" "$WORK/brain.log"; then say "✓ brain governed by the APEX kernel (mode=required)"; else say "  brain running native (no kernel launcher on this host)"; fi

# 2) rendered edge config (same shape bin/agenticos renders, isolated paths)
cat >"$STATE/openclaw.json" <<JSON
{
  "gateway": { "mode": "local", "port": $GW_PORT, "auth": { "mode": "token", "token": "\${AGENTICOS_EDGE_GATEWAY_TOKEN}" } },
  "plugins": { "enabled": true, "allow": ["agenticos-brain"],
    "entries": { "agenticos-brain": { "enabled": true,
      "config": { "baseUrl": "http://127.0.0.1:$BRAIN_PORT", "timeoutMs": 30000,
                  "authToken": "\${AGENTICOS_BRIDGE_TOKEN}",
                  "defaultTarget": { "kind": "agent", "id": "support" } } } } }
}
JSON
export AGENTICOS_EDGE_GATEWAY_TOKEN="$GW_TOKEN" OPENCLAW_CONFIG_PATH="$STATE/openclaw.json" OPENCLAW_STATE_DIR="$STATE"

# 3) gateway
( cd "$EDGE" && node openclaw.mjs gateway --port "$GW_PORT" >"$WORK/gateway.log" 2>&1 ) & pids+=($!)
for _ in $(seq 1 240); do grep -q "\[gateway\] ready" "$WORK/gateway.log" 2>/dev/null && break; sleep 0.5; done
grep -q "\[gateway\] ready" "$WORK/gateway.log" || { tail -30 "$WORK/gateway.log" >&2; fail "gateway did not become ready on :$GW_PORT"; }
grep -q "agenticos-brain" "$WORK/gateway.log" || fail "gateway started without loading the agenticos-brain plugin"
say "✓ gateway ready on :$GW_PORT with agenticos-brain loaded"
if [[ "${APEX_AUTHORITY_MODE:-}" == "required" ]]; then
  grep -q "kernel authority: mode=required" "$WORK/gateway.log" || fail "gateway did not report kernel governance although mode=required"
  say "✓ gateway governed by the APEX kernel (mode=required)"
fi

# 4) invoke the tool THROUGH the gateway
OUT="$( cd "$EDGE" && node openclaw.mjs gateway call tools.invoke --port "$GW_PORT" --token "$GW_TOKEN" --timeout 30000 --json \
  --params '{"name":"agenticos_brain_turn","args":{"text":"e2e via gateway","session_id":"e2e-gw"}}' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' )"
echo "$OUT" | jq -e '.ok == true and .source == "plugin"' >/dev/null || { echo "$OUT" >&2; fail "tools.invoke did not succeed through the plugin"; }
TEXT="$(echo "$OUT" | jq -r '.output.content[0].text')"
RUN_ID="$(echo "$OUT" | jq -r '.output.details.run_id')"
TRACE="$(echo "$OUT" | jq -r '.output.details.trace_id')"
[[ "$TEXT" == "Crossed the plane boundary." ]] || fail "unexpected brain output: $TEXT"
say "✓ gateway -> plugin -> brain returned: $TEXT (run $RUN_ID, trace $TRACE)"

# 5) the run must be in the brain's REAL database with the edge's trace id
"$PY" - "$DB" "$RUN_ID" "$TRACE" <<'PYEOF'
import json, sqlite3, sys
db, run_id, trace = sys.argv[1:]
c = sqlite3.connect(db)
row = c.execute("select session_id, run_data from agno_runs where run_id=?", (run_id,)).fetchone()
assert row, f"run {run_id} not persisted"
md = (json.loads(row[1]) or {}).get("metadata") or {}
assert row[0] == "e2e-gw", row[0]
assert md.get("trace_id") == trace, (md.get("trace_id"), trace)
assert md.get("channel") == "openclaw", md.get("channel")
print(f"  ✓ persisted: session={row[0]} trace_id={md['trace_id']} channel={md['channel']}")
PYEOF

# 6) idempotency through the gateway: the plugin mints a fresh turn_id per call,
#    so a second call is a NEW turn (200), not a replay — assert exactly that.
OUT2="$( cd "$EDGE" && node openclaw.mjs gateway call tools.invoke --port "$GW_PORT" --token "$GW_TOKEN" --timeout 30000 --json \
  --params '{"name":"agenticos_brain_turn","args":{"text":"second","session_id":"e2e-gw"}}' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' )"
echo "$OUT2" | jq -e '.ok == true' >/dev/null || fail "second gateway call failed"
N="$("$PY" -c "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(\"select count(*) from agno_runs where session_id='e2e-gw'\").fetchone()[0])" "$DB")"
[[ "$N" == "2" ]] || fail "expected 2 runs in session e2e-gw, found $N"
say "✓ second gateway call persisted as a second run in the same session (history-bearing)"
echo "GATEWAY E2E: PASS"
trap - EXIT; cleanup; exit 0

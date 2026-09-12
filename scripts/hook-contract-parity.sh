#!/usr/bin/env bash
# Runs the bridge contract-parity suite with an interpreter that has the deps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for candidate in "$ROOT/../.venv/bin/python" "$ROOT/.venv/bin/python" "${AGENTICOS_PYTHON:-}" python3; do
  [[ -n "$candidate" ]] || continue
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import pytest" >/dev/null 2>&1; then
    exec env PYTHONPATH="$ROOT/bridge/py" "$candidate" -m pytest "$ROOT/tests/e2e/test_contract_parity.py" -q
  fi
done
echo "no interpreter with pytest found (tried .venv, \$AGENTICOS_PYTHON, python3)" >&2
exit 1

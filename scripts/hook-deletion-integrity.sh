#!/usr/bin/env bash
# Runs the deletion-integrity gate on an interpreter that can import agno.
# The gate REFUSES (exit 2) otherwise, because its import half would silently
# pass without importing anything — which is exactly how it was once vacuously
# green. Resolving the right interpreter here is part of the fix.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for candidate in "$ROOT/../.venv/bin/python" "$ROOT/.venv/bin/python" "${AGENTICOS_PYTHON:-}" python3; do
  [[ -n "$candidate" ]] || continue
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import agno" >/dev/null 2>&1; then
    exec "$candidate" "$ROOT/scripts_audit_dangling_refs.py"
  fi
done
echo "no interpreter able to import agno (tried .venv, \$AGENTICOS_PYTHON, python3)" >&2
exit 1

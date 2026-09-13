#!/usr/bin/env python3
"""Ledger/tree consistency gate.

Asserts the deletion ledger describes the tree that actually exists:
  * every ACTIVE deletion  -> the path is absent
  * every DEFERRED entry   -> the path is still present AND carries a dated
    resolution (`KEEP (YYYY-MM-DD): ...`) naming the re-measured consumers and
    the unblock condition. A deferral is a decision postponed; the ledger may
    not hold one without saying who still depends on the path and what would
    let it go (T-18, 2026-09-13).

A directory whose only remaining content is `node_modules` counts as deleted:
`pnpm install` recreates that shell for a workspace path even after its source
is removed, and treating an install artifact as a failed deletion produces a
false alarm on every fresh install.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs" / "deletions.tsv"
RESOLUTION_RE = re.compile(r"^KEEP \(\d{4}-\d{2}-\d{2}\): \S.*\bUnblock: \S")


def is_effectively_absent(p: Path) -> bool:
    if not p.exists():
        return True
    if p.is_dir():
        remaining = [c for c in p.iterdir() if c.name != "node_modules"]
        return not remaining
    return False


def main() -> int:
    if not MANIFEST.exists():
        print(f"manifest not found: {MANIFEST}", file=sys.stderr)
        return 2

    problems: list[str] = []
    active = deferred = 0

    for line in MANIFEST.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if line.startswith("DEFERRED"):
            deferred += 1
            plane, path = parts[1], parts[2]
            if not (ROOT / "planes" / plane / path).exists():
                problems.append(f"DEFERRED but MISSING from tree: {plane}/{path}")
            resolution = parts[4] if len(parts) > 4 else ""
            if not RESOLUTION_RE.match(resolution):
                problems.append(
                    f"DEFERRED without a dated resolution ('KEEP (YYYY-MM-DD): ... Unblock: ...'): {plane}/{path}"
                )
        else:
            active += 1
            plane, path = parts[0], parts[1]
            if not is_effectively_absent(ROOT / "planes" / plane / path):
                problems.append(f"declared DELETED but still PRESENT: {plane}/{path}")

    if problems:
        print(f"LEDGER INCONSISTENT ({len(problems)}):")
        for p in problems:
            print(f"  {p}")
        return 1

    print(f"OK: ledger matches tree — {active} deleted absent, {deferred} deferred present, each with a dated KEEP resolution")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

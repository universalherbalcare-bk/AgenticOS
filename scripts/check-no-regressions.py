#!/usr/bin/env python3
"""Regression gate: the merged tree may not fail anything pristine passes.

The brain plane inherits ~277 test failures from upstream `agno` that need API
keys or uninstalled vendor SDKs. A CI job that simply asserts "pytest exits 0"
can therefore never go green, which teaches everyone to ignore it.

This gate encodes the comparison that actually matters instead: run the suite and
assert the set of failing test ids is a SUBSET of the recorded pristine baseline.
A brand-new failure fails the build; an inherited one does not.

Baseline: tests/known-failing-baseline.txt — the failing ids observed on
un-merged agno-main, captured in its own venv so the control could not import the
merged package.

Usage:  check-no-regressions.py <pytest-output-file>
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "tests" / "known-failing-baseline.txt"
FAILED_RE = re.compile(r"^FAILED (\S+)")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    output = Path(argv[1])
    if not output.exists():
        print(f"pytest output not found: {output}", file=sys.stderr)
        return 2
    if not BASELINE.exists():
        print(f"baseline not found: {BASELINE}", file=sys.stderr)
        return 2

    baseline = {ln.strip() for ln in BASELINE.read_text().splitlines() if ln.strip()}
    observed = {
        m.group(1)
        for line in output.read_text(errors="ignore").splitlines()
        if (m := FAILED_RE.match(line))
    }

    regressions = sorted(observed - baseline)
    fixed = sorted(baseline - observed)

    print(f"failing now: {len(observed)}  |  baseline: {len(baseline)}")
    print(f"no longer failing (tests of deleted modules, or genuinely fixed): {len(fixed)}")

    if regressions:
        print(f"\nREGRESSIONS — fail in merged, pass in pristine: {len(regressions)}")
        for r in regressions:
            print(f"  {r}")
        return 1

    print("\nOK: zero regressions against the pristine baseline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

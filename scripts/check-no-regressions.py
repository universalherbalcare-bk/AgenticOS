#!/usr/bin/env python3
"""Regression gate: the merged tree may not fail anything pristine passes.

The brain plane inherits ~277 test failures from upstream `agno` that need API
keys or uninstalled vendor SDKs. A CI job that simply asserts "pytest exits 0"
can therefore never go green, which teaches everyone to ignore it.

This gate encodes the comparison that actually matters instead: run the suite and
assert the set of failing test ids is a SUBSET of the recorded pristine baseline.
A brand-new failure fails the build; an inherited one does not.

Baselines: tests/known-failing-baseline.txt — the failing ids observed on
un-merged agno-main, captured in its own venv so the control could not import the
merged package; tests/known-erroring-baseline.txt — the ids pytest reports as ERROR
(collection/import failures, fixture errors), captured 2026-09-12 from the same tree.

Both classes are gated. The first version of this script matched only `^FAILED`, and
CI ran pytest with `-rf`, so ERROR lines were neither printed nor compared: a merge
that broke a module's import would surface as ERROR, not FAILED, and pass unseen.
CI now runs `-rfE`; a new ERROR outside its baseline fails the build like a new FAILED.

Usage:  check-no-regressions.py <pytest-output-file>
        check-no-regressions.py --capture <pytest-output-file>   # rewrite BOTH baselines
                                                                # from that run, using the
                                                                # exact parser used to check

Ids are matched as a run of non-space characters after the status word, so a parametrize id containing a space is
truncated at that space -- identically on capture and on check. That is deliberate: the
original failing baseline was recorded with the same rule, and the first error baseline
was captured with a different one, which produced two false regressions for one id.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE = ROOT / "tests" / "known-failing-baseline.txt"
ERROR_BASELINE = ROOT / "tests" / "known-erroring-baseline.txt"
FAILED_RE = re.compile(r"^FAILED (\S+)")
ERROR_RE = re.compile(r"^ERROR (\S+)")
# pytest prints "= 232 failed, 12616 passed, 509 skipped, 312 errors in 363.00s ="
SUMMARY_RE = re.compile(r"=+ .*\b\d+ (?:passed|failed|error|errors|skipped|deselected)\b.* in [0-9.]+s(?: \([^)]*\))? =+")


def main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[1] == "--capture":
        lines = Path(argv[2]).read_text(errors="ignore").splitlines()
        for pattern, path in ((FAILED_RE, BASELINE), (ERROR_RE, ERROR_BASELINE)):
            ids = sorted({m.group(1) for line in lines if (m := pattern.match(line))})
            path.write_text("\n".join(ids) + "\n")
            print(f"wrote {len(ids)} ids -> {path.relative_to(ROOT)}")
        return 0
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    output = Path(argv[1])
    if not output.exists():
        print(f"pytest output not found: {output}", file=sys.stderr)
        return 2
    for path in (BASELINE, ERROR_BASELINE):
        if not path.exists():
            print(f"baseline not found: {path}", file=sys.stderr)
            return 2

    lines = output.read_text(errors="ignore").splitlines()

    # The short summary (-r) is what we parse; the final "= N failed, M errors in ... ="
    # line is printed regardless of -r flags. Cross-check them: if the totals say errors
    # or failures happened but no matching summary lines were printed, the run was made
    # without -rfE and the comparison below would be silently vacuous. A first version
    # of this guard only refused when NO summary lines existed at all, so a run with
    # failures present but ERROR lines suppressed sailed through reporting "0 erroring"
    # and "312 no longer erroring" -- exactly the shape of the real brain suite.
    totals = None
    for line in reversed(lines):
        m = SUMMARY_RE.search(line)
        if m:
            totals = m.group(0)
            break
    if totals is None:
        print("pytest output has no final summary line; run pytest to completion with -rfE",
              file=sys.stderr)
        return 2
    counted = {kind: int(n) for n, kind in re.findall(r"(\d+) (failed|error)", totals)}
    parsed_failed = sum(1 for line in lines if FAILED_RE.match(line))
    parsed_error = sum(1 for line in lines if ERROR_RE.match(line))
    if counted.get("failed", 0) and not parsed_failed:
        print(f"summary reports {counted['failed']} failed but no FAILED lines were printed; "
              "run pytest with -rfE", file=sys.stderr)
        return 2
    if counted.get("error", 0) and not parsed_error:
        print(f"summary reports {counted['error']} errors but no ERROR lines were printed; "
              "run pytest with -rfE", file=sys.stderr)
        return 2

    def load(path):
        return {ln.strip() for ln in path.read_text().splitlines() if ln.strip()}

    def observe(pattern):
        return {m.group(1) for line in lines if (m := pattern.match(line))}

    status = 0
    for label, pattern, baseline_path in (("failing", FAILED_RE, BASELINE),
                                          ("erroring", ERROR_RE, ERROR_BASELINE)):
        baseline = load(baseline_path)
        observed = observe(pattern)
        regressions = sorted(observed - baseline)
        fixed = sorted(baseline - observed)
        print(f"{label} now: {len(observed)}  |  baseline: {len(baseline)}")
        print(f"no longer {label} (tests of deleted modules, or genuinely fixed): {len(fixed)}")
        if regressions:
            print(f"\nREGRESSIONS ({label}) — in merged but not in pristine: {len(regressions)}")
            for r in regressions:
                print(f"  {r}")
            status = 1
        print()

    if status:
        return status
    print("OK: zero regressions against the pristine baselines (failures and errors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

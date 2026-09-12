#!/usr/bin/env python3
"""Post-deletion integrity gate.

"Nothing is deleted alone": after applying docs/deletions.tsv, every module that
was removed must have zero surviving inbound imports. A dangling import is a
build break that would otherwise surface only at runtime, in whichever code path
happens to touch it first.

Exit 1 on any dangling reference so CI blocks on it.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "docs" / "deletions.tsv"
BRAIN_PKG = ROOT / "planes" / "brain" / "libs" / "agno"
# Scan the WHOLE brain plane, not just the library. The first version scanned only
# libs/agno and therefore reported "0 dangling refs" while planes/brain/cookbook/
# held 58 example files importing deleted modules (independent verification found
# them). Anything shipped in the plane is in scope.
BRAIN_PLANE = ROOT / "planes" / "brain"


def module_for(path: str) -> str:
    rel = path.removeprefix("libs/agno/")
    rel = rel.removesuffix(".py")
    return rel.replace("/", ".")


def main() -> int:
    if not MANIFEST.exists():
        print(f"manifest not found: {MANIFEST}", file=sys.stderr)
        return 2

    deleted_modules: list[str] = []
    for line in MANIFEST.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2 or parts[0] != "brain":
            continue
        deleted_modules.append(module_for(parts[1]))

    sources = [p for p in BRAIN_PLANE.rglob("*.py")]
    failures: list[tuple[str, str, int, str]] = []

    for mod in deleted_modules:
        own_dir = BRAIN_PKG / mod.replace(".", "/")
        own_file = own_dir.with_suffix(".py")
        pattern = re.compile(rf"^\s*(?:from\s+{re.escape(mod)}(?:\.|\s)|import\s+{re.escape(mod)}(?:\.|\s|$))")
        for src in sources:
            # Skip the deleted module's own surviving siblings.
            if own_dir in src.parents or src == own_file:
                continue
            if "__pycache__" in src.parts:
                continue
            try:
                text = src.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if mod not in text:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if pattern.match(line):
                    failures.append((mod, str(src.relative_to(ROOT)), i, line.strip()))

    if failures:
        print(f"DANGLING REFERENCES: {len(failures)}\n")
        for mod, src, ln, line in failures:
            print(f"  {src}:{ln}\n      -> {line}\n      (imports deleted module: {mod})")
        return 1

    print(f"OK: {len(deleted_modules)} deleted brain modules, 0 dangling inbound imports "
          f"(scanned {len(sources)} .py files across the whole brain plane)")

    # Static grep is NOT sufficient on its own. Deleting agno/client/os.py broke a
    # LAZY, function-level `from agno.client import AgentOSClient` in
    # agno/remote/base.py:460 -- the import names the PACKAGE, not the deleted
    # submodule, so no module-path pattern could match it. That regression was
    # caught by executing the test suite, not by reading source. So this gate also
    # imports every surviving package: a second, differently-shaped check.
    import importlib
    import warnings

    sys.path.insert(0, str(BRAIN_PKG))

    # PRECONDITION. This check is worthless on an interpreter that cannot import
    # agno's dependencies: every import then fails with a non-agno
    # ModuleNotFoundError, which the loop below deliberately ignores, and the gate
    # reports "N packages import cleanly" having imported ZERO. That is exactly
    # what happened when this ran under the system python3 (no pydantic), and it
    # made the gate vacuously green. Fail loudly instead of lying.
    try:
        importlib.import_module("agno.agent")
    except Exception as exc:  # noqa: BLE001
        print(
            "REFUSING TO RUN: this interpreter cannot import agno.agent "
            f"({type(exc).__name__}: {exc}).\n"
            "  The import check would silently pass without importing anything.\n"
            f"  Interpreter: {sys.executable}\n"
            "  Use the project venv, e.g. .venv/bin/python, or install agno's deps.",
            file=sys.stderr,
        )
        return 2
    broken: list[tuple[str, str]] = []
    imported = 0
    skipped_optional = 0
    packages = sorted(
        p.parent.relative_to(BRAIN_PKG).as_posix().replace("/", ".")
        for p in (BRAIN_PKG / "agno").rglob("__init__.py")
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for pkg in packages:
            try:
                importlib.import_module(pkg)
                imported += 1
            except ModuleNotFoundError as exc:
                # A missing THIRD-PARTY dep is not our problem; a missing agno.* is.
                if str(exc.name or "").startswith("agno"):
                    broken.append((pkg, f"{type(exc).__name__}: {exc}"))
                else:
                    skipped_optional += 1
            except ImportError as exc:
                # agno re-raises a friendly ImportError for absent optional SDKs
                # ("`openai` not installed..."). Only treat it as breakage when it
                # names an agno module; otherwise it is an uninstalled extra.
                message = str(exc)
                if "agno." in message and "not installed" not in message:
                    broken.append((pkg, f"{type(exc).__name__}: {exc}"))
                else:
                    skipped_optional += 1
            except Exception:
                # Import-time side effects (optional SDK probes) are out of scope.
                skipped_optional += 1

    if broken:
        print(f"\nBROKEN PACKAGE IMPORTS: {len(broken)}")
        for pkg, err in broken:
            print(f"  {pkg}\n      -> {err}")
        return 1

    # Transitive orphans: a test importing a sibling module that was itself removed
    # as an orphan is a HARD collection error, and `--continue-on-collection-errors`
    # hides it. Found by independent verification (test_slack_bot_filtering.py
    # importing a deleted conftest).
    import re as _re

    dangling_siblings: list[str] = []
    tests_root = BRAIN_PLANE / "libs" / "agno" / "tests"
    for f in tests_root.rglob("*.py"):
        if "__pycache__" in f.parts:
            continue
        body = f.read_text(encoding="utf-8", errors="ignore")
        for m in _re.finditer(r"^\s*from\s+\.([A-Za-z_][A-Za-z0-9_]*)\s+import", body, _re.M):
            if not (f.parent / f"{m.group(1)}.py").exists():
                dangling_siblings.append(f"{f.relative_to(ROOT)} -> from .{m.group(1)} import ...")

    if dangling_siblings:
        print(f"\nTESTS IMPORTING A DELETED SIBLING MODULE: {len(dangling_siblings)}")
        for d in dangling_siblings:
            print(f"  {d}")
        return 1

    if imported == 0:
        print(
            "REFUSING TO PASS: zero packages actually imported — the check is vacuous.",
            file=sys.stderr,
        )
        return 2

    print(
        f"OK: {imported}/{len(packages)} surviving agno packages imported successfully "
        f"({skipped_optional} skipped: optional third-party dep absent)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

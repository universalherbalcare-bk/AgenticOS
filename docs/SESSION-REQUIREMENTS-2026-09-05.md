# REQUIREMENTS — Agentic-OS Merge

## Source prompt (verbatim)
> @agno-main.zip @openclaw-main.zip
> compile/merge these 2 Agentic-OS into One Agentic-OS.
> remove lower quality/level same types of function/features by comparing with each other.
> run this task by Agentic-Ai's multi-agent professional master level team.

## Requirement lock
| ID | Requirement (verbatim intent) | Status |
|----|-------------------------------|--------|
| R1 | Compile/merge the TWO given Agentic-OS (agno-main, openclaw-main) into ONE Agentic-OS | pending |
| R2 | Remove lower-quality / lower-level SAME-TYPE functions & features, decided BY COMPARING the two against each other | pending |
| R3 | Execute the task via a multi-agent professional master-level team (not a single-threaded pass) | pending |

## Derived / implied requirements
| ID | Requirement | Rationale |
|----|-------------|-----------|
| R4 | The result must be ONE coherent system — one identity, one CLI, one config, one control plane — not two repos in a folder | "into One Agentic-OS" |
| R5 | Every dedup decision must be evidence-based and auditable (why this side won) | "by comparing with each other" |
| R6 | The merged repo must actually build and run, verified by execution | global kernel §2.5 / §3A |
| R7 | Real verification gates (CI + hooks) scaffolded and locally executed | global kernel §3A |

## Constraints & stated assumptions
- **ASSUMPTION A1**: Agno is Python (6,614 files); OpenClaw is TypeScript + Swift/Kotlin (40,010 files, 16,670 TS src).
  A single-language line-level merge would require a full rewrite of one system (months) and would destroy the
  strongest half of each. Therefore "One Agentic-OS" is delivered as a **unified polyglot monorepo**: one product,
  one CLI, one config, one control plane, one typed bridge — with per-domain winner selection deleting the loser.
  Flagged to the user before work began; user did not redirect.
- **ASSUMPTION A2**: Where two implementations of the same capability exist, the merged system keeps exactly one
  and physically deletes the other, salvaging any specific superior sub-feature from the loser first.
- **ASSUMPTION A3**: Target host toolchain is the one verified present in this session:
  Node 26.8.1 / pnpm 11.25.0 / Python 3.14.6 / uv 0.11.29 / Docker 29.6.2 / git 2.50.1.
- **CONSTRAINT C1**: No network-dependent live model calls are verified in this session (no provider API keys).
  Anything requiring live inference is marked UNVERIFIED rather than claimed.

## Definition of done
- Merged repo exists, builds, and runs — with captured command output and exit codes.
- A Capability Decision Matrix covering every overlapping domain: winner, loser, evidence, salvage, deletion.
- CI + pre-commit gates scaffolded AND locally executed.
- Honest completion ledger: what is verified, what is not, what was deferred and why.

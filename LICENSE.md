# Licences

AgenticOS is a merge of two independently licensed codebases plus original integration work.
Each component keeps its own licence; nothing here relicenses anything.

| Path | Origin | Licence | Full text |
|---|---|---|---|
| `planes/brain/` | Agno (agno-agi/agno), Python agent platform | **Apache License 2.0** | [`planes/brain/LICENSE`](planes/brain/LICENSE) |
| `planes/edge/` | OpenClaw (openclaw/openclaw), TypeScript multi-channel gateway | **MIT License** | [`planes/edge/LICENSE`](planes/edge/LICENSE) — third-party notices in [`planes/edge/THIRD_PARTY_NOTICES.md`](planes/edge/THIRD_PARTY_NOTICES.md) |
| `bridge/`, `bin/`, `scripts/`, `tests/`, `docs/`, `planes/brain/agenticos_brain/`, `planes/edge/extensions/agenticos-brain/` | Original AgenticOS integration work (2026) | **Apache License 2.0** | same text as `planes/brain/LICENSE` |

Modifications to the upstream trees are recorded in `docs/DELETION-LEDGER.md` and `docs/CORRECTIONS.md`
and in this repository's git history, which satisfies the Apache-2.0 requirement to mark changed files
and the MIT requirement to retain the copyright notice. Upstream copyright notices are unchanged.

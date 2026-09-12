# Domain analysis — the evidence behind the merge

Six master-level specialists compared the two source trees head-to-head, in parallel, each scoped to one
domain. Every capability verdict in `../DECISION-MATRIX.md` and every entry in `../DELETION-LEDGER.md`
traces back to one of these reports.

| Report | Domain | Headline verdict |
|---|---|---|
| `00-executed-evidence.md` | Measurements taken by RUNNING both systems | both runtimes boot on this host; Agno control plane measured, not claimed |
| `01-models.md` | Model / provider layer | **Edge wins** — catalog, retry, circuit breaking, tool-call repair, cancellation |
| `02-agent-runtime.md` | Agent loop, reasoning, teams, workflows, session, HITL | **Split** — edge owns the loop and context; brain owns reasoning and workflows |
| `03-knowledge-memory.md` | RAG, vector stores, memory, persistence | **Split 3–2 to brain** — but edge memory wins decisively |
| `04-channels-gateway.md` | Channels, gateway, API surface, clients, edge auth | **Edge wins 4 of 5**; brain wins RBAC |
| `05-tools-sandbox.md` | Toolkits, sandbox, browser, skills, plugins | **Edge wins all but breadth**; brain has no sandbox and no SSRF defence |
| `06-platform-services.md` | MCP, scheduling, observability, eval, config, CI | **Split** — brain owns MCP server + scheduling; edge owns observability + config |

## Standards these reports were held to

- Every claim cites a path, and usually a line number.
- Anything the specialist could not verify is labelled **UNVERIFIED** and was NOT used to authorise a deletion.
- Specialists were instructed that a tie is a failure of analysis, so each names a winner.
- Several reports **corrected the brief they were given** — those corrections are preserved in
  `../DECISION-MATRIX.md` under "Corrections the team made to the brief" rather than quietly dropped.

# Edge Layer Merge Analysis — Channels, Gateway, API Surface, Clients, Edge Auth

**Scope:** messaging channels, gateway/daemon runtime, serving/API surface, client interfaces, edge auth.
**A** = `_src/agno-main` (Python/FastAPI) · **B** = `_src/openclaw-main` (TypeScript/Node).
All paths below are relative to those roots. Every claim was read in source; unverified items are labelled.

---

## Verdict

**Channels — OpenClaw wins, decisively.** Agno's README claims Slack/Telegram/WhatsApp/Discord (`README.md:50`). Three of the four are real AgentOS interfaces (Slack 3,654 LOC, Telegram 1,598, WhatsApp 911); the fourth is **not an AgentOS interface at all** — `agno/integrations/` contains exactly 3 files (verified: `__init__.py`, `discord/__init__.py`, `discord/client.py`), and `discord/client.py` is a 208-line standalone `discord.py` bot that AgentOS never mounts (`os/interfaces/__init__.py` is empty, 0 bytes). So Agno ships **3 served channels + 1 detached bot script**. OpenClaw ships **27 bundled channels** enumerated in generated metadata (`src/config/bundled-channel-config-metadata.generated.ts`), of which ~20 are real third-party networks, totalling ~430k LOC. The decisive gap is not count but *transport class*: every Agno channel is inbound-webhook-only (`slack/router.py:129`, `telegram/router.py:112`, `whatsapp/router.py:181` — all `@router.post`), which structurally excludes any network without a webhook API. OpenClaw additionally implements Socket Mode (`extensions/slack/src/client-options.ts`), Telegram polling, and local-daemon channels (iMessage, Signal) that Agno cannot express. A single OpenClaw Slack file, `extensions/slack/src/monitor/message-handler/prepare.ts` (1,910 lines), is over half the size of Agno's entire Slack interface.

**Gateway/daemon — OpenClaw wins.** Agno is a FastAPI app started by `uvicorn.run(..., workers=workers)` (`os/app.py:2377-2427`) with **in-process dict singletons** for connection state: `websocket_manager = WebSocketManager(...)` at `os/managers.py:499`, holding `active_connections: Dict[str, WebSocket]`. Setting `workers>1` therefore silently breaks WS routing unless the Redis event stream is separately configured. There is no daemon supervisor, no node/fleet concept, and no backpressure handling anywhere in `os/`. OpenClaw runs a supervised long-lived daemon (launchd/systemd install under `src/daemon/`, 122 files), a WS-RPC gateway (`src/gateway/`, 331k LOC non-test), remote node hosts (`src/node-host/`), workers (`src/worker/`), and **container-per-tenant fleet cells** (`src/fleet/registry.ts` — `FleetCellRecord{tenantId, runtime: "docker"|"podman", hostPort, dataDir}`). It has real slow-consumer backpressure (`src/gateway/server-broadcast.ts:472-495`: `bufferedAmount > MAX_BUFFERED_BYTES` → drop-with-seq-burn or `close(1008, "slow consumer")`) and exponential-backoff reconnect (`packages/gateway-client/src/protocol-client.ts:63` `RetrySupervisor`, `client.ts:455` `{initialMs: 1_000, multiplier: 2, maxMs: 30_000}`). Agno has none of this.

**API surface — OpenClaw wins on scale; Agno's claim is honest.** Agno's "50+ endpoints with SSE and websockets" (`README.md:50`) is **verified and understated**: 110 distinct route paths / 149 route decorators across `os/routers/`. But the "websockets" half is thin — exactly **one** WS endpoint exists, `/workflows/ws` (`os/router.py:291`), workflow-only. OpenClaw's gateway advertises **415 core RPC methods** in a single canonical policy table (`src/gateway/methods/core-descriptors.ts`, `CORE_GATEWAY_METHOD_SPECS`, 767 lines) — 57 `sessions.*`, 35 `skills.*`, 20 `users.*`, 19 `node.*` — plus aux methods and per-channel plugin methods merged at runtime (`src/gateway/server-methods-list.ts`). Its HTTP surface is deliberately tiny (health/readiness + worker bootstrap, `gateway-http-route-contracts.ts`); everything real is WS-RPC. Agno wins only on *REST-idiomatic* shape, which matters for third-party integration.

**Clients — OpenClaw wins by default; Agno has no client layer.** Agno ships a Python SDK (`agno/client/os.py`, 3,023 lines) and nothing else: no CLI, no TUI, no web UI, no static asset serving (grep for `StaticFiles` in `os/app.py` returns nothing). OpenClaw ships a CLI (`src/cli/`, 794 files), a TUI (`src/tui/`, 123 files), a Vite web control UI (`ui/`, 2,878 TS/TSX files) served through the gateway (`src/gateway/control-ui-asset-manifest.ts`), and **four native apps**: macOS (599 Swift files), Android (471 Kotlin), iOS (292 Swift), plus 342 shared files under `apps/shared/`. This is not close.

**Edge auth — Agno wins, and this is its one clear victory.** Agno has genuine fine-grained RBAC: `AgentOSScope` (`os/scopes.py:38-90`) defines ~30 resource verbs plus **per-resource and wildcard scopes** (`agents:<agent-id>:run`, `agents:*:run`), enforced through a shared route→scope mapping used identically by REST, MCP and WS (`os/router.py` calls `get_required_scopes_for_route`). It adds JWT middleware (`os/middleware/jwt.py`, 1,205 lines), service-account PATs (`os/service_accounts.py`, `agno_pat_...`), and opt-in per-user row isolation (`os/middleware/user_scope.py`). OpenClaw's gateway scopes are a **closed set of only 8 coarse operator scopes** (`src/gateway/operator-scopes.ts:3-10`: `operator.admin/read/write/approvals/questions/pairing/talk/talk.secrets`) — no per-resource granularity. OpenClaw's "access groups" solve a *different* problem: they are channel-sender allowlists (`src/config/types.access-groups.ts` — `MessageSendersAccessGroup`, `DiscordChannelAudienceAccessGroup`), i.e. *who may talk to the bot*, not *what an API caller may touch*. The two models are complementary, not competing.

---

## Channel coverage table

Depth = non-test LOC in the channel's own implementation. Agno figures from `libs/agno/agno/os/interfaces/`; OpenClaw from `extensions/`.

| Channel | Agno depth | OpenClaw depth | Winner |
|---|---|---|---|
| Slack | 3,654 LOC, 15 files; webhook-only; HITL (`hitl.py` 514), Block Kit builders (608), HMAC verify (`security.py`) | 41,052 LOC, 393 files; Socket Mode + webhook, slash cmds, modals, block-actions, native approvals | **OpenClaw** |
| Telegram | 1,598 LOC, 8 files; webhook POST only (`router.py:112`) | 63,082 LOC, 547 files; polling + webhook, ingress worker w/ deadlines | **OpenClaw** |
| WhatsApp | 911 LOC, 5 files; webhook + GET verify handshake | 24,581 LOC, 291 files | **OpenClaw** |
| Discord | **208 LOC, standalone `discord.py` bot — NOT an AgentOS interface** | 71,368 LOC, 692 files (largest channel) | **OpenClaw** |
| iMessage | absent | 24,870 LOC, 196 files (local daemon) | **OpenClaw** |
| Signal | absent | 12,962 LOC, 129 files | **OpenClaw** |
| Feishu | absent | 35,596 LOC, 281 files | **OpenClaw** |
| Matrix | absent | 43,909 LOC, 391 files | **OpenClaw** |
| MS Teams | absent | 23,669 LOC, 247 files | **OpenClaw** |
| Mattermost | absent | 13,474 LOC, 143 files | **OpenClaw** |
| Google Chat | absent | 6,865 LOC, 93 files | **OpenClaw** |
| LINE | absent | 10,956 LOC, 133 files | **OpenClaw** |
| Zalo / Zalo-user | absent | 6,415 / 9,046 LOC | **OpenClaw** |
| IRC | absent | 4,082 LOC | **OpenClaw** |
| Nostr | absent | 5,028 LOC | **OpenClaw** |
| SMS | absent | 4,716 LOC | **OpenClaw** |
| Tlon | absent | 7,797 LOC | **OpenClaw** |
| Twitch | absent | 3,744 LOC | **OpenClaw** |
| Synology Chat | absent | 4,472 LOC | **OpenClaw** |
| Nextcloud Talk | absent | 4,055 LOC | **OpenClaw** |
| A2A (agent-to-agent) | 1,973 LOC, 5 files; agent-card + `message:send`/`message:stream`/`tasks:get`/`tasks:cancel` | registered as channel id `a2a` w/ peer tokens (generated metadata) | **Agno** (richer task lifecycle) |
| AG-UI | 1,316 LOC, 8 files (streaming UI protocol, HITL resume) | absent | **Agno** |
| QQ / WeChat | **absent both sides** | **absent both sides** | — (neither) |

Notes: `buzz`, `clickclack`, `raft`, `reef`, `qa-channel` are also registered channel ids in OpenClaw's generated metadata but are internal/test transports, not public networks — excluded from the count of ~20 real networks. **QQ and WeChat appear in neither codebase** — the task brief listed them speculatively; no code exists on either side.

---

## Capability comparison table

| Capability | Agno impl + path | OpenClaw impl + path | Winner | Evidence strength |
|---|---|---|---|---|
| Channel count (served) | 3 (`os/interfaces/{slack,telegram,whatsapp}`) | 27 bundled ids (`src/config/bundled-channel-config-metadata.generated.ts`) | OpenClaw | **EXECUTED** (enumerated both) |
| Non-webhook transports | none — all `@router.post` webhooks | Socket Mode (`extensions/slack/src/client-options.ts`), polling, local daemons | OpenClaw | **OBSERVED** |
| Channel plugin contract | none; interfaces hardcoded in `os/app.py` | `ChannelPlugin` + `defineBundledChannelEntry` (`src/plugin-sdk/channel-entry-contract.ts:499`) | OpenClaw | **OBSERVED** |
| Shared channel runtime | none (per-interface ad hoc) | `src/channels/` 488 files — streaming, typing, threading, debounce, progress drafts | OpenClaw | **OBSERVED** |
| Webhook signature verify | HMAC-SHA256 + 5-min replay window (`slack/security.py`) | per-extension equivalents | Tie→Agno (cleaner) | **OBSERVED** |
| Process model | `uvicorn.run(workers=N)` (`os/app.py:2420-2427`) | supervised daemon + launchd/systemd (`src/daemon/`, 122 files) | OpenClaw | **OBSERVED** |
| Transport | HTTP + SSE + 1 WS endpoint (`os/router.py:291`) | WS-RPC primary + SSE (`src/gateway/http-common.ts`) + minimal HTTP | OpenClaw | **EXECUTED** |
| Backpressure | **none found in `os/`** | `bufferedAmount > MAX_BUFFERED_BYTES` → drop or `close(1008)` (`server-broadcast.ts:472-495`) | OpenClaw | **OBSERVED** |
| Seq/gap detection | none | per-client `clientSeq`, seq burned on drop so gap detector fires (`server-broadcast.ts:485-488`) | OpenClaw | **OBSERVED** |
| Reconnect/backoff | client-side none | `RetrySupervisor` 1s→30s ×2 (`protocol-client.ts:63`, `client.ts:455`) | OpenClaw | **OBSERVED** |
| Stream resume across replicas | **Redis Streams w/ writer-generation fence** (`os/event_streams/redis.py`, 742 LOC) | session projection + subscriptions (`packages/gateway-client/src/session-projection.ts`) | **Agno** | **OBSERVED** |
| WS multi-node | broken — in-process dict singleton (`managers.py:499`) | node registry + fleet (`gateway/node-registry.ts`, `fleet/registry.ts`) | OpenClaw | **OBSERVED** |
| Multi-tenancy | row-level `user_id` scoping, opt-in, **per-endpoint convention that "will silently bypass user isolation with no runtime error"** (`middleware/user_scope.py` docstring) | container-per-tenant cells (`fleet/registry.ts` `tenantId`+`dataDir`) | OpenClaw | **OBSERVED** |
| API method count | 110 paths / 149 decorators | 415 core RPC + aux + plugin methods (`methods/core-descriptors.ts`) | OpenClaw | **EXECUTED** |
| REST idiomatic surface | full CRUD REST across 20 routers | health-only HTTP | **Agno** | **EXECUTED** |
| RBAC granularity | per-resource + wildcard scopes (`os/scopes.py:38-90`) | 8 coarse operator scopes (`operator-scopes.ts:3-10`) | **Agno** | **OBSERVED** |
| JWT / service accounts | `middleware/jwt.py` (1,205 LOC), `service_accounts.py` (`agno_pat_`) | shared-secret + device tokens (`gateway/auth.ts`, `device-auth.ts`) | **Agno** | **OBSERVED** |
| Channel sender authz | none | access groups + allowlists + DM guards (`src/channels/allow-from.ts`, `message-access/`) | OpenClaw | **OBSERVED** |
| Device pairing | none | `src/pairing/` + `extensions/device-pair` (challenge, join codes, SQLite store) | OpenClaw | **OBSERVED** |
| Secrets management | env vars only | `src/secrets/` 184 files — secret refs, audit store, egress proxy | OpenClaw | **OBSERVED** |
| CLI / TUI / Web UI | **none** | `src/cli/` 794 · `src/tui/` 123 · `ui/` 2,878 files | OpenClaw | **EXECUTED** |
| Native apps | none | macOS 599 · Android 471 · iOS 292 Swift/Kotlin files | OpenClaw | **EXECUTED** |
| Typed protocol pkg | Pydantic schemas per router | `packages/gateway-protocol` 21,619 LOC, versioned, validator registry | OpenClaw | **OBSERVED** |
| MCP server surface | `os/mcp.py` + OAuth (`mcp_auth.py`) | `src/mcp/` + `mcp.*` gateway methods | Tie | **OBSERVED** |
| Human-in-the-loop | Slack HITL (`slack/hitl.py` 514) + `/approvals` REST | approvals across all channels + native gates (`slack/approval-native-gates.ts`) | OpenClaw | **OBSERVED** |

---

## Salvage list

### From Agno (the losing side in 4 of 5 areas) — MUST port

| Item | Path | Reason |
|---|---|---|
| Redis Streams event stream | `libs/agno/agno/os/event_streams/redis.py` (742 LOC) | Best-in-repo cross-replica run resume: writer-generation Lua fence, monotonic-not-gapless index contract, idle status re-check so dead producers can't hang tails. OpenClaw has no equivalent replica-agnostic replay. |
| Event-stream interface | `os/event_streams/base.py` | Clean pluggable ABC (`register_run`/`set_run_status`/`tail`) with the race contract documented; adopt as the merged buffer interface. |
| Scope model + wildcards | `os/scopes.py:38-90`, `RouteScopeCheck` | Per-resource (`agents:<id>:run`) and wildcard (`agents:*:run`) scopes — the single biggest edge-auth gap in OpenClaw's 8-scope set. |
| JWT middleware | `os/middleware/jwt.py` (1,205 LOC) | Production JWKS/audience/issuer validation; OpenClaw has only shared-secret + device tokens. |
| Service-account PATs | `os/service_accounts.py` (403 LOC) | Mint/revoke machine tokens with attached scopes — needed for third-party API consumers. |
| Route→scope mapping table | `get_default_scope_mappings()` (used at `os/router.py`) | One mapping enforced by REST, MCP **and** WS alike; port the pattern onto OpenClaw's `core-descriptors.ts`. |
| A2A interface | `os/interfaces/a2a/` (1,973 LOC) | Agent-card discovery + `message:send`/`message:stream`/`tasks:get`/`tasks:cancel` task lifecycle, richer than OpenClaw's `a2a` channel. |
| AG-UI interface | `os/interfaces/agui/` (1,316 LOC) | Streaming-UI protocol with HITL resume + state sync; no OpenClaw counterpart. |
| REST router set | `os/routers/` (110 paths) | Keep as a **thin REST facade over the WS-RPC gateway** for third-party/serverless callers who cannot hold a socket. |
| Slack signature verify | `os/interfaces/slack/security.py` | Textbook HMAC + 5-min replay window; use as the reference when auditing OpenClaw's per-extension verifiers. |

### From OpenClaw (winner) — carry over wholesale

`src/gateway/`, `src/daemon/`, `src/channels/`, `src/fleet/`, `src/worker/`, `src/node-host/`, `src/pairing/`, `src/secrets/`, `packages/gateway-protocol`, `packages/gateway-client`, all 27 `extensions/<channel>/`, `src/cli/`, `src/tui/`, `ui/`, `apps/{macos,ios,android,shared}`. Specifically non-negotiable: `server-broadcast.ts` backpressure, `protocol-client.ts` reconnect supervisor, `channel-entry-contract.ts` plugin contract, `fleet/registry.ts` tenant cells.

---

## DROP list

| Path (in A) | Justification |
|---|---|
| `libs/agno/agno/integrations/discord/client.py` | 208-line standalone `discord.py` bot, never mounted by AgentOS (`os/interfaces/__init__.py` empty). Strictly inferior to `extensions/discord` (71,368 LOC). Delete the whole `integrations/` tree — it is only these 3 files. |
| `libs/agno/agno/os/interfaces/slack/` | 3,654 LOC webhook-only vs 41,052 LOC with Socket Mode, modals, slash commands, native approvals. Salvage only `security.py` as a reference. |
| `libs/agno/agno/os/interfaces/telegram/` | 1,598 LOC webhook-only; cannot do polling. Superseded by `extensions/telegram` (63,082 LOC). |
| `libs/agno/agno/os/interfaces/whatsapp/` | 911 LOC vs `extensions/whatsapp` 24,581 LOC. |
| `libs/agno/agno/os/managers.py` — `WebSocketManager` + module singletons (`:499-508`) | In-process `Dict[str, WebSocket]` state that breaks under `workers>1`; replaced by the gateway's connection registry. Keep `EventsBuffer`/`SSESubscriberManager` only until the Redis stream is the sole path. |
| `libs/agno/agno/os/router.py` — `get_websocket_router` (`:276-291`) | Single workflow-only WS endpoint with bespoke message-based auth; strictly inferior to a 415-method typed WS-RPC protocol. |
| `libs/agno/agno/client/os.py` | 3,023-line Python HTTP SDK against the REST surface; regenerate from `packages/gateway-protocol` instead of hand-maintaining a second client contract. |
| `libs/agno/agno/os/middleware/trailing_slash.py` | FastAPI-specific routing shim with no meaning once the gateway owns the edge. |

**Do NOT drop** `os/routers/` — retain as the REST facade (see salvage). **Do NOT drop** `os/event_streams/`, `os/scopes.py`, `os/auth.py`, `os/service_accounts.py`, `os/middleware/jwt.py`, `os/interfaces/{a2a,agui}/`.

---

## Bridge requirements

**Winning gateway:** OpenClaw's WS-RPC gateway (`src/gateway/`). **Foreign runtime:** Agno's Python agent/team/workflow engine.

**Protocol:** reuse OpenClaw's existing **node/worker WS-RPC channel** — the Agno engine registers as a *remote node* exactly like `src/node-host/`, so no new transport is invented. Frames are the existing gateway envelopes defined in `packages/gateway-protocol/src/schema/frames.ts`; validation via `protocol-validator.ts`; capability negotiation via `server-capabilities.ts`.

**Registration & handshake**
1. Agno host dials the gateway using `packages/gateway-client` (`protocol-client.ts`) — inherits the `RetrySupervisor` backoff for free.
2. `connect.challenge` → device/node auth (`connect-auth.ts`, `device-auth.ts`), advertising a new runtime kind `agno-python`.
3. Node advertises inventory through the existing `node.*` family (19 methods, `core-descriptors.ts`) — the Agno agent/team/workflow registry maps onto `agents.list` / `models.list` / `skills.list` shapes.

**Turn dispatch (channel message → Agno engine)**
1. Channel extension ingests inbound message → `src/channels/` normalizes to a session envelope (`session-envelope.ts`) and resolves routing (`route-projection.ts`, `thread-bindings-policy.ts`).
2. Gateway resolves/creates the session via `sessions.resolve` / `sessions.create` (`schema/sessions-create.ts`, `sessions-resolve.ts`).
3. Gateway invokes the turn on the Agno node using the **`agent.run` / `agent` method family** (`server-methods/agent-run-handler.ts`, `agent-request-types.ts`), scoped by `method-scopes.ts`.
4. Agno host maps that request onto its internal `Agent.arun` / `Team.arun` / `Workflow.arun`.

**Event return path (the load-bearing part)**
- Agno emits `RunOutputEvent` / `TeamRunOutputEvent` / `WorkflowRunOutputEvent` into the **salvaged `BaseEventStream`** (`os/event_streams/base.py`), backed by `redis.py` in multi-replica deployments.
- A thin adapter tails that stream (`tail()`, honouring the monotonic-not-gapless `event_index` contract) and republishes each event as a gateway `agent` / `chat` event frame (`GATEWAY_EVENTS` in `server-methods-list.ts:44+`).
- Fan-out to channels and UIs then rides the **existing** `server-broadcast.ts` path — so Agno turns automatically inherit slow-consumer backpressure (`:472`), seq-gap signalling (`:485`), and `close(1008)` eviction, none of which Agno has today.

**Message types on the bridge (all pre-existing):** `connect.challenge`, `node.*` (register/inventory/invoke), `sessions.resolve|create|patch`, `agent.run`, `agent` (streamed output events), `chat`, `session.approval`, `question.*`, `ui.command`.

**Approvals/HITL:** Agno pauses (`os/interfaces/slack/pause.py`, `/approvals` routers) map onto `session.approval` + the `approval.*` methods, so approvals surface natively in *all 27* channels rather than Slack only.

**Auth composition:** OpenClaw's 8 operator scopes gate *transport admission*; Agno's ported `AgentOSScope` per-resource scopes (`agents:<id>:run`) gate *resource authorization* on the Agno node. Both must pass. Extend `core-descriptors.ts` so each method row can carry a resource-scope requirement alongside its existing `OperatorScope`.

**UNVERIFIED:** I did not execute either system — no runtime, no credentials, no build was run this session. All findings are static source reading. Specifically unverified: actual wire behaviour of the Redis fence under concurrent retries; whether OpenClaw's `a2a` extension is protocol-compatible with Agno's A2A v1.0 implementation (schemas were not diffed field-by-field); and real throughput/latency of either transport.

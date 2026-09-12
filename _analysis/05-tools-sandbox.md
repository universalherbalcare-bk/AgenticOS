# 05 — Tools, Toolkits, Sandbox, Browser, Skills, Plugins

Domain: tools / toolkits / browser automation / code-execution sandbox / security policy.
A = `_src/agno-main` (Python). B = `_src/openclaw-main` (TypeScript).
All paths below are relative to those two roots. Every claim carries a file path; anything
I could not confirm by reading code is marked **UNVERIFIED**.

---

## Verdict

**Toolkit breadth — Agno wins, decisively.** `libs/agno/agno/tools/` holds 192 `.py` files and
**152 classes that subclass `Toolkit`** (`grep -rh "^class .*(Toolkit)"` → 152), each a
first-party SaaS/API integration: Slack, Jira, Salesforce, Notion, GitHub, Shopify, Zendesk,
Twilio, Stripe-adjacent finance providers, ~15 web-search vendors, ~12 media-generation vendors.
OpenClaw ships **~57 built-in tool ids** (`src/agents/tool-catalog.ts`, `id: "…"` entries:
`ls read write edit apply_patch exec process code_execution secrets web_search web_fetch
x_search memory_search memory_get sessions… browser screen dashboard terminal portal canvas
show_widget message gateway nodes computer mobile_ui …`) plus **151 extensions**
(`find extensions -maxdepth 2 -name openclaw.plugin.json` → 151), but only ~26 of those
extensions declare `"tools"` in their manifest (`grep -l '"tools"' extensions/*/openclaw.plugin.json`);
the rest are model providers and chat channels. OpenClaw's breadth strategy is *capability
depth + MCP + skills*, not a vendor toolkit catalog.

**Tool definition model — OpenClaw wins.** OpenClaw declares tools as TypeBox schemas with a
compiled validator (`packages/llm-core/src/validation.ts` — `Compile` from `typebox/compile`,
cached in a `WeakMap`, plus schema-gated JSON coercion capped at `MAX_JSON_COERCE_LENGTH =
64 * 1024`), a typed result envelope with streaming (`AgentToolResult<T>` +
`AgentToolUpdateCallback`, `packages/agent-core/src/types.ts:528-593`), an availability
expression language (`src/tools/types.ts:31-46`, `ToolAvailabilityExpression` over
`auth`/`config`/`env`/`plugin-enabled`/`context` signals), owner/executor provenance
(`ToolOwnerRef` = core|plugin|channel|mcp), and a malformed-tool-call repair package
(`packages/tool-call-repair/`). Agno's `Function` (`libs/agno/agno/tools/function.py:1182`)
derives JSON Schema from Python type hints + docstring (`function.py:686`
`get_json_schema(type_hints=…, strict=strict)`) and validates via pydantic `validate_call` —
elegant and lower-friction, but it has no availability algebra, no owner/executor model, and no
tool-call repair. Agno *does* beat OpenClaw on one axis: MCP behaviour annotations validated at
definition time (`function.py:1196-1200`, `_validate_annotations`).

**Sandbox / security — OpenClaw wins by a wide margin; this is not close.** Agno's own code says
so: `tools/shell.py:20` — *"runs an arbitrary command on the host OS with no sandboxing — an RCE
sink if the agent is prompt-injected"*; `tools/code/code_mode.py:9` — *"It is not a sandbox and
does not pretend to be one"*; `tools/python.py:12` — *"PythonTools can run arbitrary code, please
provide human supervision."* Agno's isolation story is *delegate to a SaaS sandbox* (E2B,
Daytona) or *the operator runs the whole agent in a container*. OpenClaw builds the container
itself: `src/agents/sandbox/docker.ts` emits `--read-only` (368), `--cap-drop` (392),
`--security-opt no-new-privileges` (394), `seccomp=` (396), `apparmor=` (398), `--pids-limit`
(413), `--memory`, `--cpus`, `--ulimit`; `src/agents/sandbox/validate-sandbox-security.ts`
refuses bind mounts of `/etc /proc /sys /dev /root /run /var/run/docker.sock` and
`~/.ssh ~/.aws ~/.gnupg ~/.docker ~/.netrc` (lines 23-49), refuses `network: host` and
`network: container:*` (375-398), and refuses `seccomp=unconfined` / `apparmor=unconfined`
(51-52, 400-418). On top of that sits an argv-level exec allowlist with GNU long-flag
abbreviation resolution (`src/infra/exec-safe-bin-policy-profiles.ts`), a persistent
approval store (`src/infra/exec-approvals-*.ts`, ~50 files), and a DNS-pinned SSRF guard
(`src/infra/net/ssrf.ts` + `packages/net-policy/src/ip.ts`). Agno has **zero** equivalent of the
last one — `grep -rn "169.254|ssrf" libs/agno/agno` returns only an OpenRouter comment.

**Browser — OpenClaw wins, overwhelmingly.** OpenClaw has a full CDP stack
(`extensions/browser/src/browser/cdp.ts`, `cdp-websocket.ts`, `cdp-page-session.ts`,
`cdp-target-filter.ts`, `cdp-auth.ts`), a signed Chrome extension + native messaging host
(`extensions/browser/chrome-extension/`, `extension-native-host.ts`), a 24-action tool
(`browser-tool.schema.ts:36-60`: `doctor status start stop profiles importprofile tabs open
focus close snapshot screenshot navigate console requests errors text emulate pdf download
waitfordownload upload dialog act`) with 14 `act` kinds including `clickCoords`, `drag`,
`evaluate`, ARIA/AI accessibility snapshots, named browser profiles for session persistence
(`browser-profiles.ts`), and three targets — `sandbox | host | node`
(`browser-tool.schema.ts:62`) — where `sandbox` is a dedicated Chrome+noVNC container on its own
docker network (`src/agents/sandbox/browser.ts`, `browser-network.ts`). Agno's best browser tool
is `tools/browserbase.py`: a Playwright `connect_over_cdp` to a hosted Browserbase session
(line 138) exposing exactly four model-facing tools — `navigate_to`, `screenshot`,
`get_page_content`, `close_session`. No clicking, no typing, no DOM refs. `tools/webbrowser.py`
is 28 lines wrapping Python's `webbrowser.open_new_tab`. **Agno has nothing comparable.**

**Skills — OpenClaw wins.** Both use `SKILL.md` + frontmatter. Agno's is a loader:
`libs/agno/agno/skills/` is 5 files / 987 lines, `LocalSkills` walks a directory for `SKILL.md`
(`skills/loaders/local.py:44-60`) and `Skills.get_tools()` (`skills/agent_skills.py:150`) exposes
`get_skill_instructions` / `get_skill_reference` / `get_skill_script`. There is no registry, no
install, no scanner. OpenClaw's `src/skills/` has 8 subsystems — `discovery/` (chat-command
registration), `loading/`, `lifecycle/` (ClawHub install with sha256 integrity + lockfile +
trust checks, `lifecycle/clawhub.ts`, `clawhub-install-core.ts`), `library/`, `runtime/`
(remote skills, cron snapshots, env overrides), `workshop/` (an agent that authors and reviews
skills from session history), `config/`, and **`security/`** — a 1038-line static scanner with 15
rule ids including `dangerous-exec`, `dynamic-code-execution`, `crypto-mining`,
`potential-exfiltration`, `env-harvesting`, `prompt-injection-ignore-instructions`,
`shell-pipe-to-shell`, `secret-exfiltration` (`src/skills/security/scanner.ts:154-260`), backed
by a registry-side verdict API (`security/clawhub-verdicts.ts`). Skills are mounted read-only
into the sandbox (`src/agents/sandbox/workspace-mounts.ts:124` — `:ro`).

**Plugin distribution — OpenClaw wins; Agno effectively does not compete.** OpenClaw has a
versioned plugin manifest (`extensions/*/openclaw.plugin.json` with `contracts.tools`,
`configContracts.secretInputs`, `activation`, `uiHints`), a published SDK with ~39 export
subpaths (`packages/plugin-sdk/package.json`), a package contract
(`packages/plugin-package-contract/`), six install sources with declared authority levels
(`src/security/install-policy.ts:56-70` — `archive|bundled|clawhub|file|git|local-path|managed|
npm|upload|workspace` × `openclaw|official|third-party|unknown|user`), an external policy hook
that can veto an install (`install-policy.ts`, `runCommandWithTimeout` over a policy binary),
and a pre-activation security scan (`src/plugins/install-security-scan.ts`). Agno's
`agno/registry/registry.py` (896 lines) is an **in-process object registry** for
non-serializable tools/models/dbs, with a `DECLARED` vs `DISCOVERED` provenance flag
(`ToolSource`, line 29) — useful, but it is not distribution: no fetch, no versioning, no
signature, no scan. `agno/tools/tool_registry.py` is a one-line alias of `Toolkit`.

---

## Toolkit coverage table

| Toolkit / Capability | Agno | OpenClaw | Winner |
|---|---|---|---|
| Vendor API toolkits (Slack, Jira, Notion, Salesforce, GitHub, Shopify, Zendesk, Trello, Linear, ClickUp, Confluence, Discord, Telegram, WhatsApp, Twilio, Zoom, Webex…) | 152 `Toolkit` subclasses in `tools/` | ~26 tool-declaring extensions; rest via MCP/skills | **Agno** |
| Web search vendors | ~15 (`exa, tavily, serpapi, serper, serply, brave, baidu, searxng, duckduckgo, linkup, perplexity, you, searchapi, parallel, valyu`) | `web_search`/`x_search` core + `tavily`, `brave`, `exa`, `duckduckgo`, `searxng`, `perplexity`, `parallel`, `firecrawl` extensions | **Agno** (count) |
| Scraping / extraction | `firecrawl, crawl4ai, spider, oxylabs, brightdata, scrapegraph, trafilatura, newspaper4k, jina, agentql, apify, docling` | `web_fetch` core, `firecrawl`, `web-readability`, `document-extract` extensions | **Agno** |
| Media generation (image/video/music/TTS) | `dalle, nano_banana, fal, replicate, models_labs, lumalab, wavespeed, eleven_labs, cartesia, minimax, desi_vocal, smallest, gandr, moviepy_video` | `image_generate music_generate video_generate tts` core tools + `elevenlabs, fal, runway, pixverse, comfy, inworld, deepgram, azure-speech, fish-audio-speech, senseaudio` extensions | Tie-ish → **Agno** on vendor count, **OpenClaw** on a unified tool surface |
| Data / SQL / analytics | `postgres, redshift, duckdb, sql, pandas, neo4j, visualization, openbb, yfinance, financial_datasets` | none built-in (via MCP/skills) | **Agno** |
| Chat channels as first-class runtime | Toolkits only (send/read) | 30+ channel plugins with a full inbound/outbound runtime | **OpenClaw** |
| Shell / process control | `ShellTools` (68 lines, unsandboxed) | `exec`, `process`, `terminal` with approval + sandbox + argv allowlist | **OpenClaw** |
| Code execution | `PythonTools`, `CodeMode` (IPython kernel), `E2BTools`, `DaytonaTools`, `DockerTools` | `code_execution` + sandboxed `exec` in own container | **OpenClaw** |
| Filesystem | `agno/fs/` (`FileSystem` toolkit, namespaced, quota'd, DB or local backend) | `read write edit apply_patch ls` + fs bridge into container | **Tie** — genuinely different designs (see Salvage) |
| Browser automation | `BrowserbaseTools` (4 tools), `webbrowser.open` | 24-action CDP tool, 3 targets, extension + native host | **OpenClaw** |
| Desktop / computer use | none found | `computer` tool + `cua-computer` extension (macOS/Windows/Linux drivers) | **OpenClaw** |
| Mobile UI control | none found | `mobile_ui` tool (Android AccessibilityService) | **OpenClaw** |
| MCP client | `MCPTools` / `MultiMCPTools` (`tools/mcp/mcp.py`, stdio + sse + streamable-http) | `bundle-mcp`, `src/agents/agent-bundle-mcp-*.ts` (~25 files) | **OpenClaw** (lifecycle mgmt) |
| MCP server (expose own tools) | AgentOS `/mcp` (`agno/os/app.py:337`, `os/mcp.py`, `os/mcp_auth.py`) | `src/mcp/tools-stdio-server.ts`, `openclaw-tools-serve.ts` | **Tie** |
| Human-in-the-loop / approval | `requires_confirmation`, `requires_user_input`, `external_execution`, `@approval(type=required\|audit)` | exec approvals store, `ask_user`, ACP approval classifier, gateway owner-only tools | **OpenClaw** (persistence + transport) |
| Guardrails (PII, injection) | `agno/guardrails/{pii,prompt_injection,openai}.py` | `src/security/external-content.ts`, `secret-mask.ts`, `safe-regex.ts` | **OpenClaw** (see below) |
| Eval / rollout harness | `agno/environments/` — task sets, K-rollouts, scorers, SFT export | not found | **Agno** |

> Note for the merge team: `agno/environments/` is **not** a sandbox. `environments/__init__.py`
> states its purpose plainly — "run an agent many times against a set of tasks, score every
> attempt". It belongs to the eval domain, not this one.

---

## Security posture comparison

| Control | Agno | OpenClaw | Winner | Risk if the loser's design is kept |
|---|---|---|---|---|
| Container isolation for tool exec | None built. `E2BTools`/`DaytonaTools` outsource to a SaaS sandbox; `DockerTools` (`tools/docker.py`) hands the agent the *host* Docker daemon | `src/agents/sandbox/docker.ts` builds the container: `--init`, `--read-only`, `--cap-drop`, `no-new-privileges`, seccomp, AppArmor, pids/memory/cpu/ulimit caps | **OpenClaw** | Agent-driven RCE on the host; `DockerTools` is a documented container-escape primitive (daemon access ⇒ root) |
| Bind-mount denylist | none | `validate-sandbox-security.ts:23-49` blocks `/etc /proc /sys /dev /root /boot /run /var/run/docker.sock` + `~/.ssh ~/.aws ~/.gnupg ~/.docker ~/.netrc ~/.npm ~/.cargo ~/.config` | **OpenClaw** | Credential theft from the host via a mount the model chose |
| Network isolation | none | `validateNetworkMode` rejects `host` and `container:*` (375-398); browser containers on a dedicated network (`browser-network.ts`) | **OpenClaw** | Sandbox that shares the host netns is not a sandbox |
| seccomp / AppArmor | none | configurable, and `unconfined` is *rejected* at three layers: zod schema (`src/config/zod-schema.agent-runtime.ts:226-233`), runtime validator (`validate-sandbox-security.ts:400-418`), and the audit (`src/security/audit-extra.sync.ts:940-948`, `sandbox.dangerous_seccomp_profile`) | **OpenClaw** | Full syscall surface from inside the container |
| Shell command gating | `ShellTools` runs `subprocess.run(args)` with no filter; opt-in `requires_confirmation_tools=["run_shell_command"]` only | argv-level safe-bin profiles with denied-flag sets and GNU abbreviation resolution (`exec-safe-bin-policy-profiles.ts`, `exec-safe-bin-policy-validator.ts`), closed POSIX-builtin set (`exec-safe-builtins.ts`), + approval store | **OpenClaw** | One prompt injection ⇒ arbitrary host command |
| Approval persistence & scope | in-memory run-pause; `@approval(type="audit")` writes a record | SQLite-backed allowlist with `allow-always` entries carrying `pattern`, `argPattern`, `lastResolvedPath` (`exec-approvals.types.ts`), per-session/per-agent scope (`exec-approvals-*.ts`) | **OpenClaw** | Approval fatigue → operators disable it wholesale |
| Filesystem scoping | **Strong.** `agno/fs/_paths.py` (NFC-normalize, reject control chars/backslashes/`..`, 512-char/16-segment caps) + `fs/local.py:_safe_join` rejects any name the on-disk map would alter (fullwidth dots, trailing dots, NFKC compat variants); `utils/path_safety.py` blocks Windows device names and UNC | Container-relative FS bridge + `wrapToolWorkspaceRootGuardWithOptions` containment root (`core-coding-tools.ts:56-63`), read-only skill mounts | **Agno** (on the pure path-grammar layer) | Unicode-normalization traversal escapes; OpenClaw should port Agno's rejection rule |
| SSRF / DNS rebinding | **none** (`grep 169.254\|ssrf` → 1 unrelated comment) | `src/infra/net/ssrf.ts` — pinned DNS lookup, IPv4-in-IPv6 extraction, loopback/link-local/special-use blocks, cloud-metadata denylist (`packages/net-policy/src/ip.ts:66`), `blockedHostnames` wildcard rules, per-redirect re-evaluation | **OpenClaw** | Cloud IMDS credential theft via any URL the model supplies |
| Prompt-injection defense | `guardrails/prompt_injection.py` — 18 hardcoded lowercase substrings, `if any(keyword in input.lower())`; trivially bypassed | `security/external-content.ts` — untrusted content wrapped in `<<<EXTERNAL_UNTRUSTED_CONTENT id="<8 random bytes>">>>` boundaries so injected fake markers cannot spoof, + 15 detection patterns logged not trusted; `resultContentSource: "network"` taints tool output (`agent-core/src/types.ts:558`) | **OpenClaw** | Agno's substring list gives false assurance; it is a filter, not a boundary |
| PII detection | `guardrails/pii.py` — SSN/CC/email/phone regex, optional masking | secret masking only (`security/secret-mask.ts`) | **Agno** | No PII redaction in the merged product |
| Secret handling | env vars by convention | `spawn-secret-input.ts`, `sandbox/sanitize-env-vars.ts` (blocks/warns on suspicious sandbox env), `secrets/runtime-sandbox-secret-owner.ts`, `secret-equal.ts` (timing-safe) | **OpenClaw** | Secrets leaking into container env / logs |
| Tool exposure over HTTP | n/a (AgentOS `/mcp` guarded by `os/mcp_auth.py` — **UNVERIFIED** in depth) | `DEFAULT_GATEWAY_HTTP_TOOL_DENY` (`src/security/dangerous-tools.ts:10-48`) denies `exec spawn shell fs_write fs_delete fs_move apply_patch terminal portal sessions_spawn sessions_send conversations_* automations gateway nodes computer mobile_ui`; `GATEWAY_OWNER_ONLY_CORE_TOOLS` gates the rest on owner identity | **OpenClaw** | Remote RCE through the control plane |
| Supply-chain scan on install | none | `src/skills/security/scanner.ts` (15 rules) + `src/plugins/install-security-scan.ts` + `install-policy.ts` external veto hook + sha256 artifact integrity (`lifecycle/clawhub.ts`) | **OpenClaw** | Malicious skill/plugin installs unchecked |
| Self-audit tooling | none | `src/security/audit*.ts` (~57 files) — a shipped `openclaw doctor`-style security audit incl. `audit-exec-sandbox-host`, `audit-sandbox-docker-config`, `audit-plugins-trust`, `audit-gateway-exposure` | **OpenClaw** | No way to prove config safety after the fact |
| Static policy enforcement in CI | none found | `security/opengrep/rules/openclaw-policy/no-raw-http2-connect.yml` + `compile-rules.mjs` | **OpenClaw** | Policy regressions land silently |
| Config-level "dangerous flag" registry | none | `src/security/dangerous-config-flags*.ts` + explicit `dangerouslyAllow*` naming in `types.sandbox.ts` | **OpenClaw** | Unsafe config indistinguishable from safe config |

---

## Capability comparison table

| Capability | Agno impl + path | OpenClaw impl + path | Winner | Evidence strength |
|---|---|---|---|---|
| Tool schema generation | type hints + docstring → JSON Schema, `tools/function.py:686` `get_json_schema(...)`; `strict` marks all fields required (688-691) | TypeBox `TSchema` on `AgentTool.parameters`, `packages/agent-core/src/types.ts:561` | OpenClaw | OBSERVED (read both) |
| Argument validation | pydantic `validate_call` wrapper, `function.py:1710-1726` (async-generator shim) | compiled TypeBox validator + JSON coercion, `packages/llm-core/src/validation.ts` | OpenClaw | OBSERVED |
| Result shaping | free-form return or `ToolResult`; generators/async-generators stream (`function.py:2619-2631, 2879-2883`) | `AgentToolResult<T>` = `content[] + details + progress + terminate`, `types.ts:540-552` | OpenClaw | OBSERVED |
| Streaming partial results | generator return value | `onUpdate?: AgentToolUpdateCallback` in `execute()` signature, `types.ts:580-585` | OpenClaw | OBSERVED |
| Conditional tool availability | `include_tools` / `exclude_tools` name lists, `tools/toolkit.py:214-236` | `ToolAvailabilityExpression` (`allOf`/`anyOf` over auth/config/env/plugin/context), `src/tools/types.ts:31-46` | OpenClaw | OBSERVED |
| Tool ownership / provenance | `owning_toolkit` + `source_toolkit` on `Function` (`function.py:1261-1268`); `ToolSource.DECLARED/DISCOVERED` in registry | `ToolOwnerRef` + `ToolExecutorRef` (core/plugin/channel/mcp), `src/tools/types.ts:17-27` | OpenClaw | OBSERVED |
| HITL confirmation | `requires_confirmation`, `requires_user_input`, `external_execution`, `@approval` (`agno/approval/decorator.py:50-64`) | exec approvals subsystem, `src/infra/exec-approvals*.ts` (~50 files) + `ask_user` tool | OpenClaw | OBSERVED |
| Host-shell execution | `subprocess.run`, `tools/shell.py:53-60`, no sandbox (self-documented line 20) | `src/process/exec-spawn.ts` + `src/infra/exec-host.ts` behind policy | OpenClaw | OBSERVED |
| Stateful code REPL | `CodeMode` — real IPython kernel subprocess with snapshot/restore, `tools/code/kernel.py`, `snapshot.py` (546 lines) | `code_execution` tool id (`tool-catalog.ts:113`); execution path **UNVERIFIED** in depth | **Agno** on REPL statefulness | OBSERVED (Agno) / PARTIAL (OpenClaw) |
| Tools callable *from inside* the REPL | `tools/code/bridge.py` (1155 lines) — comm-channel RPC binding host toolkits into the kernel, control-channel replies to avoid shell deadlock; refuses any tool that would pause the run | `TOOL_SEARCH_CODE_MODE_TOOL_NAME` in `src/agents/tool-search.ts`; mechanism **UNVERIFIED** | **Agno** | OBSERVED (Agno) |
| Container sandbox | none | `src/agents/sandbox/` (57 files: docker, podman, ssh backends, fs-bridge, workspace mounts) | OpenClaw | OBSERVED |
| Browser: CDP | `connect_over_cdp` to Browserbase only, `tools/browserbase.py:138` | own CDP client `extensions/browser/src/browser/cdp*.ts` (7 files) | OpenClaw | OBSERVED |
| Browser: DOM/ARIA snapshot | `get_page_content` → HTML→text (`browserbase.py:204-246`) | `snapshot` action, `aria`/`ai` formats, `role`/`aria` refs (`browser-tool.schema.ts:64-66`) | OpenClaw | OBSERVED |
| Browser: input actions | none | 14 `act` kinds incl. `click clickCoords type press hover drag select fill resize evaluate` (`browser-tool.schema.ts:19-34`) | OpenClaw | OBSERVED |
| Browser: session persistence | Browserbase `session_id`/`connect_url` reuse (`browserbase.py:106-133`) | named local profiles + import (`browser-profiles.ts`, `importprofile` action) | OpenClaw | OBSERVED |
| Browser: isolated browser container | none | Chrome+noVNC container on `openclaw-sandbox-browser` net, token-gated observer URL (`src/agents/sandbox/browser.ts`, `novnc-auth.ts`) | OpenClaw | OBSERVED |
| Computer use (desktop) | none found | `computer` tool + `extensions/cua-computer` (driver artifacts + verification, `driver-artifact-verification.ts`) | OpenClaw | OBSERVED |
| Skills discovery | directory walk for `SKILL.md`, `skills/loaders/local.py:44-60` | multi-root loader + chat-command registration + remote/node skills, `src/skills/{loading,discovery,runtime}/` | OpenClaw | OBSERVED |
| Skills packaging/install | none | ClawHub archive install, sha256 integrity, lockfile, trust check (`src/skills/lifecycle/clawhub*.ts`) | OpenClaw | OBSERVED |
| Skills static scanning | none | `src/skills/security/scanner.ts` (1038 lines, 15 rules) | OpenClaw | OBSERVED |
| Skill authoring agent | none | `src/skills/workshop/` (~30 files: curator, history-scan, experience-review) + `skill_workshop` tool | OpenClaw | OBSERVED |
| Plugin SDK | n/a — plugins are Python imports | `packages/plugin-sdk` (~39 export subpaths incl. `exec-approvals-runtime`, `file-access-runtime`, `sandbox`) | OpenClaw | OBSERVED |
| Registry/marketplace | in-process `agno/registry/registry.py` only | ClawHub for skills + `src/plugins/clawhub.ts`, `git-install.ts`, npm/archive/upload sources | OpenClaw | OBSERVED |
| Eval harness over tools | `agno/environments/` (Task, rollouts, scorer fingerprints, SFT export) | not found | **Agno** | OBSERVED |
| PII guardrail | `agno/guardrails/pii.py` | none found | **Agno** | OBSERVED |

---

## Salvage list

**From Agno (the loser in most of this domain) — port these:**

1. `libs/agno/agno/tools/` — all 152 `Toolkit` classes. This is the single largest asset either
   side owns in this domain and cannot be rebuilt. Port as a bridged runtime (see Bridge).
2. `libs/agno/agno/tools/code/bridge.py` + `kernel.py` + `snapshot.py` — stateful IPython kernel
   with host toolkits bound in as awaitable RPC stubs, plus session snapshot/restore. OpenClaw's
   `code_execution` has no equivalent; run this *inside* an OpenClaw sandbox container and it
   becomes strictly better than either side alone.
3. `libs/agno/agno/tools/code/bridge.py` refusal rule (module docstring, "A tool that would pause
   the run … is refused in the kernel") — the correct invariant for code-mode + HITL. Keep it.
4. `libs/agno/agno/fs/_paths.py` and `libs/agno/agno/fs/local.py:_safe_join` — reject any path the
   on-disk normalization would *alter* (fullwidth dots, NFKC compat variants, trailing dots).
   Stronger than OpenClaw's containment-root guard; port into `src/agents/sandbox/fs-bridge-path-safety.ts`.
5. `libs/agno/agno/utils/path_safety.py` — Windows device-name (`CON`, `NUL`, `LPT1`) and UNC
   rejection applied cross-platform. OpenClaw has `windows-acl.ts` but no device-name rule.
6. `libs/agno/agno/guardrails/pii.py` — SSN/credit-card/email/phone detection with a masking mode.
   OpenClaw masks secrets but not PII.
7. `libs/agno/agno/tools/function.py:1196-1200` + `tools/annotations.py` — MCP behaviour
   annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) validated at
   declaration time. OpenClaw's `ToolDescriptor.annotations` is untyped `JsonObject`
   (`src/tools/types.ts:57`); adopt Agno's validator there.
8. `libs/agno/agno/tools/function.py` `has_side_effects` + `SERIALIZED_FIELDS` /
   `RUNTIME_ONLY_FIELDS` split — a clean answer to "which parts of a tool definition are the saved
   config's and which are the live registry's". Worth copying as a design rule.
9. `libs/agno/agno/environments/` — out of this domain's scope but flag it: no OpenClaw
   equivalent exists, and tool regressions are exactly what it measures.

**From OpenClaw (winner) — must survive the merge untouched:**

10. `src/agents/sandbox/` in full, especially `docker.ts` and `validate-sandbox-security.ts`.
11. `src/infra/net/ssrf.ts` + `packages/net-policy/` — apply to *every* Agno toolkit's outbound
    HTTP once bridged; Agno toolkits currently call `httpx`/`requests` unguarded.
12. `src/infra/exec-*.ts` approval + safe-bin subsystem.
13. `src/security/dangerous-tools.ts` — the HTTP deny list must be extended with every bridged
    Agno toolkit that writes or executes.
14. `src/skills/security/scanner.ts` and `src/plugins/install-security-scan.ts`.
15. `extensions/browser/` entire stack.
16. `src/security/external-content.ts` — random-boundary untrusted-content wrapping.

---

## DROP list

Delete from the merged repo; each is a strictly inferior duplicate of something OpenClaw already
has, or an unmitigated hazard:

| Path (in A unless noted) | Justification |
|---|---|
| `libs/agno/agno/tools/shell.py` | Unsandboxed `subprocess.run` on the host; superseded by OpenClaw `exec` + approvals + safe-bins. Its own docstring calls it an RCE sink. |
| `libs/agno/agno/tools/python.py` | `runpy.run_path` in the agent process with `safe_globals = globals()` — the "restricted scope" is the module's real globals. Superseded by CodeMode-in-sandbox. |
| `libs/agno/agno/tools/docker.py` | Hands the model the host Docker daemon (create/exec/remove containers). Daemon access is root-equivalent; there is no policy layer. Non-negotiable drop. |
| `libs/agno/agno/tools/webbrowser.py` | 28 lines calling `webbrowser.open_new_tab` on the operator's desktop. No automation value; a UI-hijack primitive. |
| `libs/agno/agno/tools/browserbase.py` | 4 tools vs OpenClaw's 24-action CDP stack; keep only if a hosted-browser fallback is a product requirement, otherwise drop. |
| `libs/agno/agno/guardrails/prompt_injection.py` | 18 hardcoded lowercase substrings; provides false assurance next to `src/security/external-content.ts`. Drop the class, keep the pattern strings as extra inputs to OpenClaw's `SUSPICIOUS_PATTERNS`. |
| `libs/agno/agno/tools/tool_registry.py` | One-line alias `Toolkit as ToolRegistry`; dead name that collides with OpenClaw's real registry concepts. |
| `libs/agno/agno/tools/e2b.py`, `daytona.py` | Third-party hosted sandboxes. Redundant once OpenClaw's own container sandbox is the execution substrate, and they move code off the machine whose policy you control. Drop unless a specific customer requires them. |
| `libs/agno/agno/tools/local_file_system.py` | Superseded by `agno/fs/` (the newer, path-hardened, quota'd design) and by OpenClaw's fs tools. Two file toolkits in one runtime is a policy hole. |
| `libs/agno/agno/tools/streamlit/` | UI helper unrelated to an agent tool surface; OpenClaw owns presentation (`canvas`, `dashboard`, `show_widget`). |
| Duplicated web-search toolkits beyond the ones OpenClaw already wraps (`tools/{brave,duckduckgo,exa,tavily,searxng,perplexity,parallel}.py`) | Two implementations of the same vendor, one of them outside the SSRF guard. Keep the OpenClaw extension, drop the Agno twin. |

---

## Bridge requirements

Agno's 152 toolkits are the one thing OpenClaw cannot replace, and OpenClaw's runtime is the one
that must own execution and policy. Bridge, do not rewrite.

**Transport: MCP over stdio, Agno-side server, OpenClaw-side `bundle-mcp` client.**
Both ends already exist and were read:

- Agno serves MCP today: `AgentOS(mcp=True)` mounts an MCP endpoint at `/mcp`
  (`libs/agno/agno/os/app.py:337`, implementation in `agno/os/mcp.py`, auth in
  `agno/os/mcp_auth.py`). For a local bridge, prefer a thin stdio wrapper over the same
  `Toolkit` → `Function` list rather than the HTTP surface — it avoids a listening port.
- OpenClaw consumes MCP servers as first-class tool owners: `ToolOwnerRef = { kind: "mcp";
  serverId }` and `ToolExecutorRef = { kind: "mcp"; serverId; toolName }`
  (`src/tools/types.ts:20, 26`), managed by `src/agents/agent-bundle-mcp-*.ts` and surfaced
  through `group:plugins` (`docs/gateway/config-tools.md:48` — "including configured MCP servers
  exposed through `bundle-mcp`").
- OpenClaw can also serve *its* tools back to an Agno agent via
  `src/mcp/tools-stdio-server.ts` (`createToolsMcpServer` → `ListToolsRequestSchema` /
  `CallToolRequestSchema`), so the bridge is bidirectional if a migration period needs it.

**Schema on the wire.** Agno already produces exactly the shape MCP wants:
`Function.to_dict()` serializes `name, description, parameters (JSON Schema), strict,
requires_confirmation, external_execution, approval_type` (`tools/function.py:1104-1112`,
`SERIALIZED_FIELDS`). Map that to `ToolDescriptor` (`src/tools/types.ts:49-59`) as:

- `name` → `name` (namespaced `agno__<toolkit>__<tool>` to avoid collision with the ~57 core ids)
- `description` → `description`; `Function.title` → `ToolDescriptor.title`
- `parameters` → `inputSchema` (already JSON Schema; OpenClaw compiles it with the same
  TypeBox path used for JSON-Schema-declared tools, `packages/llm-core/src/validation.ts`)
- `Function.annotations` (MCP hints) → `ToolDescriptor.annotations`, validated by the ported
  `tools/annotations.py` validator
- `owner` → `{ kind: "mcp", serverId: "agno" }`; `availability` → `{ kind: "env", name: "<TOOLKIT>_API_KEY" }`
  derived from each toolkit's required env var

**Policy must be re-asserted on the OpenClaw side — the bridge is a trust boundary.**

1. Every bridged tool name that writes or executes goes into `DEFAULT_GATEWAY_HTTP_TOOL_DENY`
   (`src/security/dangerous-tools.ts`). Default-deny the whole `agno__*` prefix over
   `POST /tools/invoke` and allowlist reads explicitly.
2. `Function.requires_confirmation` / `external_execution` / `approval_type` must be translated
   into OpenClaw approvals, not honored by Agno's own pause loop — the Agno process is a tool
   server, not the agent, so its run-pause mechanism has no user to ask. Map
   `approval_type="required"` → OpenClaw approval request; `"audit"` → audit record only.
3. Run the Agno MCP server **inside** an OpenClaw sandbox container
   (`src/agents/sandbox/docker.ts`) with `--network` set to a restricted bridge, not `host`.
   Agno toolkits make unguarded outbound HTTP; container-level egress control is the only place
   the SSRF policy in `src/infra/net/ssrf.ts` can be enforced against them without patching 152
   files. **Egress enforcement at the container edge is the open design item** — whether that is
   an egress proxy pinned to the SSRF policy or per-toolkit host allowlists is **UNVERIFIED**
   and needs a decision.
4. Tool results from bridged toolkits carry `resultContentSource: "network"`
   (`packages/agent-core/src/types.ts:558`) so downstream taint tracking and
   `src/security/external-content.ts` wrapping apply.
5. Secrets stay on the OpenClaw side: inject per-toolkit API keys via the sandbox's sanitized env
   path (`src/agents/sandbox/sanitize-env-vars.ts`, `src/secrets/runtime-sandbox-secret-owner.ts`),
   never through tool arguments.

# Model / LLM Provider Layer — Agno (A) vs OpenClaw (B)

Scope: model layer only. All paths below are relative to
`A = _src/agno-main` and `B = _src/openclaw-main`.
Every claim is OBSERVED (read in source this session) unless marked UNVERIFIED.
No code was executed; nothing outside `_analysis/` was modified.

## Verdict

**OpenClaw wins the model layer, decisively.** Agno has a competent, conventional
Python `Model` ABC with per-provider subclasses; OpenClaw has an actual *LLM
infrastructure platform*: a small, protocol-family-based core (`packages/llm-core`,
8 wire protocols, not 64 classes), a declarative, versioned, remotely-refreshable
**model catalog** with per-model cost, tiered pricing, context windows, thinking-level
maps and ~40 per-model compatibility flags (`packages/model-catalog-core/src/model-catalog-types.ts`),
a genuine reliability stack (16 frozen failover reason codes, `Retry-After`-honoring
jittered backoff, per-provider cooldown + half-open probing, an entire ~5.7k-line
`tool-call-repair` package that recovers tool calls models leaked as plain text), and
first-class `AbortSignal` cancellation and cost accounting on every response.
Agno's equivalents are: a 4-line `sleep(delay)` retry loop with no `Retry-After`
support, no circuit breaking, no catalog, no pricing, no cost computation, no
tool-call repair, and cancellation only as a cooperative exception between tool calls.
The gap is not stylistic — it is one to two orders of magnitude in reliability
surface. Agno nonetheless has three things OpenClaw genuinely lacks and which must
be salvaged: **pre-flight local token counting**, **per-error-class fallback chains**,
and a **first-class multimodal message model (audio/video/file) plus HITL tool-call pausing**.

## Provider coverage table

Counting method:
- Agno: rows in the single `_PROVIDERS` registry, `A/libs/agno/agno/models/utils.py:15-79`
  — **64 registry keys / ~52 distinct vendors**; 51 provider directories under
  `A/libs/agno/agno/models/`.
- OpenClaw: extensions whose `openclaw.plugin.json` declares `providers`, excluding
  speech/image/video/search-only ones — **54 LLM extensions / 73 provider ids**
  (plan-tier and alias ids inflate the id count).

| Provider | Agno | OpenClaw | Unique to |
|---|---|---|---|
| Anthropic (API) | `models/anthropic/claude.py` | `extensions/anthropic` + `packages/ai/src/providers/anthropic.ts` | both |
| Anthropic via Claude CLI | — | `extensions/anthropic` (`claude-cli` provider) | OpenClaw |
| Anthropic on Vertex | `models/vertexai/claude.py` | `extensions/anthropic-vertex` | both |
| Amazon Bedrock | `models/aws/bedrock.py`, `models/aws/claude.py` | `extensions/amazon-bedrock`, `amazon-bedrock-mantle` | both |
| OpenAI (chat + responses) | `models/openai/{chat,responses,open_responses}.py` | `extensions/openai` (`openai-responses`) | both |
| Azure OpenAI | `models/azure/openai_chat.py` | `extensions/openai` (`azure-openai-responses` api) | both |
| Azure AI Foundry / MS Foundry | `models/azure/` | `extensions/microsoft-foundry` | both |
| Google Gemini | `models/google/gemini.py` (+`gemini_interactions.py`) | `extensions/google` (`google`, `google-gemini-cli`, `google-vertex`) | both |
| Google Gemini CLI | — | `extensions/google` | OpenClaw |
| Mistral | `models/mistral/` | `extensions/mistral` + `mistral-conversations` api | both |
| Cohere | `models/cohere/` | `extensions/cohere` | both |
| Groq | `models/groq/` | `extensions/groq` | both |
| xAI | `models/xai/` | `extensions/xai` | both |
| DeepSeek | `models/deepseek/` | `extensions/deepseek` | both |
| Moonshot / Kimi | `models/moonshot/` | `extensions/moonshot`, `extensions/kimi-coding` | both |
| MiniMax | `models/minimax/` | `extensions/minimax` | both |
| Qwen / DashScope | `models/dashscope/` | `extensions/qwen` (6 ids incl. `dashscope`, `modelstudio`) | both |
| Xiaomi MiMo | `models/xiaomi/` | `extensions/xiaomi` | both |
| Z.ai / GLM | — | `extensions/zai` | OpenClaw |
| Meta Llama | `models/meta/` | `extensions/meta` | both |
| NVIDIA | `models/nvidia/` | `extensions/nvidia` | both |
| Cerebras | `models/cerebras/` | `extensions/cerebras` | both |
| Fireworks | `models/fireworks/` | `extensions/fireworks` | both |
| Together | `models/together/` | `extensions/together` | both |
| DeepInfra | `models/deepinfra/` | `extensions/deepinfra` | both |
| HuggingFace | `models/huggingface/` | `extensions/huggingface` | both |
| Ollama | `models/ollama/` | `extensions/ollama` (`ollama` + `ollama-cloud`, own `ollama` api) | both |
| LM Studio | `models/lmstudio/` | `extensions/lmstudio` | both |
| llama.cpp | `models/llama_cpp/` | `extensions/llama-cpp` | both |
| vLLM | `models/vllm/` | `extensions/vllm` | both |
| SGLang | — | `extensions/sglang` | OpenClaw |
| LiteLLM | `models/litellm/` | `extensions/litellm` | both |
| OpenRouter | `models/openrouter/` | `extensions/openrouter` | both |
| Perplexity | `models/perplexity/` | web-search only (`extensions/perplexity` declares `contracts.webSearchProviders`, no `providers`) | **Agno (as LLM)** |
| Cloudflare Workers AI | `models/cloudflare/` | — | Agno |
| Cloudflare AI Gateway | — | `extensions/cloudflare-ai-gateway` | OpenClaw |
| Vercel v0 | `models/vercel/` | — | Agno |
| Vercel AI Gateway | — | `extensions/vercel-ai-gateway` | OpenClaw |
| IBM WatsonX | `models/ibm/` | — | Agno |
| SambaNova | `models/sambanova/` | — | Agno |
| Nebius | `models/nebius/` | — | Agno |
| SiliconFlow | `models/siliconflow/` | — | Agno |
| InternLM | `models/internlm/` | — | Agno |
| Inception | `models/inception/` | — | Agno |
| AIMLAPI | `models/aimlapi/` | — | Agno |
| CometAPI | `models/cometapi/` | — | Agno |
| LangDB | `models/langdb/` | — | Agno |
| Portkey | `models/portkey/` | — | Agno |
| Requesty | `models/requesty/` | — | Agno |
| TrustedRouter | `models/trustedrouter/` | — | Agno |
| RampRouter | `models/ramp/` | — | Agno |
| Nexus | `models/nexus/` | — | Agno |
| N1N | `models/n1n/` | — | Agno |
| Llmman | `models/llmman/` | — | Agno |
| Neosantara | `models/neosantara/` | — | Agno |
| Synthorai | `models/synthorai/` | — | Agno |
| TokenLab | `models/tokenlab/` | — | Agno |
| Tuning Engines | `models/tuning_engines/` | — | Agno |
| GitHub Copilot | — | `extensions/github-copilot`, `extensions/copilot-proxy` | OpenClaw |
| ClawRouter | — | `extensions/clawrouter` | OpenClaw |
| Baseten | — | `extensions/baseten` | OpenClaw |
| BytePlus | — | `extensions/byteplus` (+ plan tier) | OpenClaw |
| Chutes | — | `extensions/chutes` | OpenClaw |
| Featherless | — | `extensions/featherless` | OpenClaw |
| GMI Cloud | — | `extensions/gmi` | OpenClaw |
| Kilocode | — | `extensions/kilocode` | OpenClaw |
| LongCat | — | `extensions/longcat` | OpenClaw |
| Novita | — | `extensions/novita` | OpenClaw |
| OpenCode / OpenCode-Go | — | `extensions/opencode`, `extensions/opencode-go` | OpenClaw |
| Qianfan (Baidu) | — | `extensions/qianfan` | OpenClaw |
| StepFun | — | `extensions/stepfun` (+ plan tier) | OpenClaw |
| Synthetic | — | `extensions/synthetic` | OpenClaw |
| Tencent (TokenHub/TokenPlan) | — | `extensions/tencent` | OpenClaw |
| Venice | — | `extensions/venice` | OpenClaw |
| Volcengine | — | `extensions/volcengine` (+ plan tier) | OpenClaw |
| Arcee | — | `extensions/arcee` | OpenClaw |

**Who has more:** effectively a wash on raw vendor count (Agno ~52 vendors, OpenClaw
~54 extensions / 73 ids), but the shapes differ. Agno's 24 unique entries are heavily
weighted toward OpenAI-compatible aggregators/routers that are near-duplicate 40-line
subclasses of `OpenAILike` (e.g. `models/tuning_engines/tuning_engines.py` is 45 lines
total). OpenClaw's 22 unique entries include structurally distinct integrations
(CLI-session backends, gateways, plan/subscription tiers) and each ships a *typed model
catalog with prices*, which Agno's rows do not.

## Capability comparison table

| Capability | Agno impl + path | OpenClaw impl + path | Winner | Evidence strength |
|---|---|---|---|---|
| Core interface shape | 4 abstract methods (`invoke`, `ainvoke`, `invoke_stream`, `ainvoke_stream`) + 2 parse hooks on a 3232-line `Model` ABC, `A/libs/agno/agno/models/base.py:547-589`; one subclass per vendor (64 registry rows) | one `StreamFunction` contract per *wire protocol*, `B/packages/llm-core/src/types.ts:225-233`; 8 built-in families registered lazily in `B/packages/ai/src/providers/register-builtins.ts:92-149`; vendors are declarative manifests | OpenClaw | OBSERVED |
| Streaming | `Iterator[ModelResponse]` / `AsyncIterator`, delta parsing per provider; no formal event protocol | typed 12-variant event protocol `AssistantMessageEvent` (`start`/`text_*`/`thinking_*`/`toolcall_*`/`done`/`error`) with a documented contract that errors terminate *in-stream*, `B/packages/llm-core/src/types.ts:466-500` | OpenClaw | OBSERVED |
| Tool calling | `_format_tools` + `run_function_calls` / `arun_function_calls` with `asyncio.gather` and cancel bookkeeping, `A/.../base.py:2411,2618,2816` | normalized `ToolCall` with `async?`, `executionMode: "sequential"\|"parallel"`, `thoughtSignature`, `B/packages/llm-core/src/types.ts:287-297`; `asyncToolExecution` host capability in `StreamOptions:130-134`; per-provider tool projection + schema compat (`openai-tool-schema-compat.ts`, `anthropic-tool-projection.ts`) | OpenClaw | OBSERVED |
| Tool-call repair | **none found** | dedicated `B/packages/tool-call-repair/` (5749 lines): grammar for `[END_TOOL_REQUEST]`, Harmony `<\|channel\|>/<\|message\|>/<\|call\|>` markers, XML-ish tags; `stream-normalizer.ts` (1979 lines) promotes leaked plain-text calls into native tool-call events mid-stream while protecting Markdown code fences | OpenClaw | OBSERVED |
| Structured output | native JSON-schema path on 8 providers (`grep supports_native_structured_outputs: bool = True` → azure, gemini ×2, dashscope, ollama, mistral, openai ×2); Pydantic-model-aware, `A/libs/agno/agno/models/openai/chat.py:228-244` | `StreamOptions.responseFormat` (JSON Schema) in `B/packages/llm-core/src/types.ts:68-72`, gated per model by `compat.supportsJsonSchemaResponseFormat`; mapping + model-id capability detection in `B/packages/ai/src/providers/openai-response-format.ts:6-60` | Agno (breadth of native typed schemas); OpenClaw (per-model gating) | OBSERVED |
| Multimodal input | `Message.audio / images / videos / files` plus `audio_output` / `video_output`, `A/libs/agno/agno/models/message.py:78-86` — audio + video + documents are first-class in the *model* layer | text-model layer is **text + image only** (`UserMessage.content: string \| (TextContent\|ImageContent)[]`, `Model.input: ("text"\|"image")[]`, `B/packages/llm-core/src/types.ts:359,708`); documents/audio/video handled outside llm-core (`packages/media-understanding-common`, `media-generation-core`); catalog does carry per-model image limits (`mediaInput.image.{maxBytes,maxPixels,maxSidePx,tokenMode}`) | **Agno** | OBSERVED |
| Async | full sync/async duality on every method (`response`/`aresponse`, `response_stream`/`aresponse_stream`) | async-only by construction (TS); `stream`/`complete`/`streamSimple`/`completeSimple` in `B/src/llm/stream.ts:76-118` | tie | OBSERVED |
| Cancellation | cooperative `RunCancelledException` checked *between* tool calls (`A/.../base.py:2262,2315,2608,3006`); no signal reaches the HTTP request — an in-flight generation is not aborted | `AbortSignal` threaded through `StreamOptions.signal` (`types.ts:78`), `options?.signal?.throwIfAborted()` before dispatch (`B/src/llm/stream.ts:116`), abort-aware sleeps (`sleepWithAbort`, `B/packages/retry/src/index.ts:20-68`), `stopReason: "aborted"` as a terminal state | OpenClaw | OBSERVED |
| Token accounting | provider-reported usage into `MessageMetrics`; **plus local pre-flight counting** via tiktoken/HF tokenizers with image-tile math, `A/libs/agno/agno/utils/tokens.py:22-60` and `Model.count_tokens`, `A/.../base.py:623-644` | provider-reported only: `Usage {input, output, cacheRead, cacheWrite, cacheWrite1h, cacheTelemetry, contextUsage}` with explicit `available`/`unavailable` states, `B/packages/llm-core/src/types.ts:299-324`. No local tokenizer found | split: OpenClaw for fidelity, **Agno for pre-flight** | OBSERVED |
| Cost accounting | `cost: Optional[float]` only ever populated when a provider hands one back — a single assignment in the whole models tree: `A/libs/agno/agno/models/openai/chat.py:1036` (`metrics.cost = getattr(response_usage, "cost", None)`). No price table, no computation | `calculateUsageCost()` with tiered pricing, per-bucket rates, 1h-cache-write premium, and `totalOrigin: "provider-billed"` provenance, `B/packages/llm-core/src/usage-cost.ts:89-114`; prices live in the catalog per model | OpenClaw | OBSERVED |
| Prompt caching | Anthropic `cache_control` for system prompt / tools / segments, incl. mixed-TTL ordering rule, `A/libs/agno/agno/models/anthropic/claude.py:141,609-642` | protocol-level `cacheRetention: "none"\|"short"\|"long"`, `promptCacheKey`, `sessionId` affinity in `StreamOptions` (`types.ts:50,86-107`), plus per-model compat switches `cacheControlFormat`, `supportsPromptCacheKey`, `supportsLongCacheRetention`, `sendSessionAffinityHeaders` (`types.ts:545-559`, `model-catalog-types.ts:56-63`) | OpenClaw | OBSERVED |
| Response caching (dev) | disk cache with TTL keyed on messages+tools+format+stream, `A/.../base.py:446-545` (`cache_response`, `cache_ttl`, `cache_dir`) | none found in the model layer | **Agno** | OBSERVED |
| Reasoning / thinking | `reasoning_content` + `redacted_reasoning_content` on `Message` (`message.py:90,100`); per-provider knobs | normalized 6-level `ThinkingLevel` + `off`, per-model `thinkingLevelMap`, `ThinkingBudgets`, and 7 wire `thinkingFormat`s (`openai`/`openrouter`/`deepseek`/`together`/`zai`/`qwen`/`qwen-chat-template`), `B/packages/llm-core/src/types.ts:35-48,529-537`; `ThinkingContent.redacted` + replay signatures (`types.ts:257-268`) | OpenClaw | OBSERVED |
| HITL / tool pausing | `requires_confirmation`, `requires_user_input`, `external_execution_required`, `approval_type`, `approval_id` on `ToolExecution` and enforced in the model loop, `A/libs/agno/agno/models/response.py:46-64` and `base.py:847-855,1578-1586,2801-2809` | not in the model layer (policy lives in `B/src/agents/agent-tools.policy.ts`) | **Agno** | OBSERVED |
| Provider replay / continuity | provider passthrough via `response_provider_data` (`base.py:82`) | typed `ProviderReplayState` bound to provider+api+model+baseUrlHash+sessionHash+authProfileHash so state is never replayed onto an incompatible route, `B/packages/llm-core/src/types.ts:270-282`; whole `transports/*-compaction-replay.ts`, `*-continuation.ts` family | OpenClaw | OBSERVED |
| Steering mid-generation | none found | `StreamOptions.onActiveResponse` with `steer(messages)` and `needsContinuation()`, `B/packages/llm-core/src/types.ts:117-127`; `transports/openai-responses-steering.ts` | OpenClaw | OBSERVED |

## Reliability engineering (detail)

| Concern | Agno | OpenClaw | Winner |
|---|---|---|---|
| Retry/backoff | `_invoke_with_retry` etc., `A/.../base.py:227-429`: `retries` (default **0**), `delay_between_retries`, optional `exponential_backoff` → `delay * 2**attempt`, then a blocking `sleep(delay)`. **No jitter, no `Retry-After`.** `grep -rn "retry_after" libs/agno/agno/` hits only `context/web/parallel.py` and `knowledge/reader/page_fetcher.py` — never the model layer | `B/packages/retry/src/index.ts`: `computeBackoff` with jitter, `RetrySupervisor` with abortable pending delays, and `createRetryRunner` that honors server `Retry-After` (`retryAfterMs`), caps it (`retryAfterMaxDelayMs`, default 60s), and picks *positive* jitter for honorable hints vs *downward* spread for over-cap hints to avoid lockstep (`index.ts:213-334`) | OpenClaw |
| Error classification | `ModelProviderError.classify` → 3 classes (rate-limit on 429/529, context-overflow by 13 substring patterns, else generic), `A/libs/agno/agno/exceptions.py:133-192` | 16 frozen reason codes (`auth`, `auth_permanent`, `format`, `rate_limit`, `overloaded`, `billing`, `server_error`, `timeout`, `tls_certificate`, `context_overflow`, `model_not_found`, `session_expired`, `empty_response`, `no_error_details`, `unclassified`, `unknown`) in `B/packages/gateway-protocol/src/failover-reasons.ts`, with an 8631-line `B/src/agents/failover/` classifier incl. a regression corpus (`failover-classification.*.cases.ts`) and structured-signal predicates | OpenClaw |
| Fallback chains | `FallbackConfig(on_error, on_rate_limit, on_context_overflow)` — **per-error-class** chains, `A/libs/agno/agno/models/fallback.py:20-110`; deliberately refuses to mask 4xx config bugs (`fallback.py:99-110`); sync + async + streaming variants; `fallback_model_activated` event | `B/src/agents/model-fallback-runner.ts` (781 lines) + `-attempt` (691) + `-candidates` (375) + `-observation` (348): a single ordered candidate chain (`ModelFallbackCandidate` with `routeOrigin`/`routeResolution`, `model-fallback.types.ts:17-20`) driven by classified `FailoverReason`, with per-attempt provenance and auth-profile rotation. Grep for `reason` in `model-fallback-candidates.ts` returns **no hits** — candidate ordering is not error-class-specific | OpenClaw overall; **Agno's per-error-class chain API is better** |
| Rate-limit handling | 429/529 → `ModelRateLimitError` → generic retry or `on_rate_limit` fallback list. Server wait hints ignored | `retryAfterMs` in `FailoverSignal` (`B/src/agents/failover/signal.ts:11`), honored in the retry runner; persisted auth-profile cooldowns with `blockedUntil` / `blockedReason: "subscription_limit"` (`B/src/agents/model-fallback-cooldown.ts:63-70`) | OpenClaw |
| Circuit breaking | **none.** `grep -rn "circuit" libs/agno/agno/` returns only unrelated "short-circuit" comments | `B/src/agents/model-fallback-cooldown.ts`: per-provider cooldown, half-open **probe slots** with `MIN_PROBE_INTERVAL_MS = 30_000`, `PROBE_MARGIN_MS`, 24h probe-state TTL, LRU cap of 256 keys; plus `B/src/agents/fallback-skip-cache.ts` (222 lines) | OpenClaw |
| Timeouts | per-client SDK field only (`timeout: Optional[float]`, `A/.../openai/chat.py:82`, `A/.../anthropic/claude.py:176`); no shared contract | `StreamOptions.timeoutMs` in the shared contract (`B/packages/llm-core/src/types.ts:143-147`), `timeout` is a first-class failover reason, `TimeoutError`/`RequestTimeoutError` recognized in `B/src/provider-runtime/operation-retry.ts:69-72` | OpenClaw |
| Transient network | not handled in the model layer | `B/src/provider-runtime/operation-retry.ts` — staged retry (`read`/`poll`/`download`/`create`, with `create` deliberately non-retried to avoid duplicate side effects), retryable connection codes + a bounded `ENOTFOUND` retry for provider reads but not gateways (`operation-retry.ts:49-104`) | OpenClaw |
| Non-replayable outcomes | not modeled | `PROVIDER_POST_DISPATCH_AMBIGUITY` and `PROVIDER_FAILURE_WITH_OUTPUT` error codes make "we may have already produced output" terminal instead of silently retried, `B/packages/llm-core/src/types.ts:342-343` + `B/src/llm/utils/retry.ts:14-30` | OpenClaw |

## Model catalog / routing / picking

**Agno: no model catalog exists.** `grep -rln "cost_per\|price_per\|pricing\|context_window" libs/agno/agno/`
returns three files, none in `models/` (`exceptions.py`, `tools/shopify.py`,
`tools/finance/providers/financial_datasets.py`). There is no per-model context window,
no price, no capability metadata, no model-id alias table, no dynamic routing. Model
selection is `get_model(str_or_instance)` over the static `_PROVIDERS` table
(`A/libs/agno/agno/models/utils.py`, 239 lines total). The only routing-like feature is
the fallback list in `fallback.py`.

**OpenClaw: a real catalog, three layers deep.**
- **Schema** — `B/packages/model-catalog-core/src/model-catalog-types.ts` (316 lines):
  `ModelCatalogModel` carries `api`, `baseUrl`, `input[]` (text/image/document),
  `reasoning`, `contextWindow`, `contextWindows[]` (bounded to 16 selectable windows,
  e.g. Claude's 200K/1M), `contextWindowDefault`, `contextTokens`, `maxTokens`,
  `thinkingLevelMap`, `cost` (incl. `tieredPricing[]`), `mediaInput`, lifecycle
  (`status: available|preview|deprecated|disabled`, `statusReason`, `replaces`,
  `replacedBy`), `tags`, and a ~40-field `compat` block.
- **Data** — declared in each provider's `openclaw.plugin.json`. Example
  `B/extensions/anthropic/openclaw.plugin.json`:
  `"cost": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }`,
  `"contextWindows": [{"id":"200k",...},{"id":"1m",...}]`, `"thinkingLevelMap"`,
  `"compat": { "codeMode": "preferred" }`, plus a `modelIdNormalization.aliases`
  table (`"opus" -> "claude-opus-5"`) and `"discovery": {"claude-cli":"static","anthropic":"refreshable"}`.
  35 extensions ship static model rows (Anthropic 15, Ollama 24, qwen 22, venice 19,
  github-copilot 18, volcengine 14, deepinfra/nvidia 12 …).
- **Freshness** — `B/src/model-catalog/remote-refresh.ts`: SSRF-guarded remote catalog
  bundle with a 6h TTL, 4MB cap, 15s timeout, version comparison against the bundled
  build stamp, plus a `models.dev` opt-in (`modelCatalog.modelsDev`) and 7 pricing
  sources with authority flags (`B/packages/model-catalog-core/src/model-catalog-pricing.ts:13-48`:
  OpenCode/Venice/Chutes/Cerebras/DeepInfra authoritative; OpenRouter/LiteLLM not).
- **Routing** — request-time provider routing is typed, not just documented:
  `OpenRouterRouting` (`order`/`only`/`ignore`/`sort by price|throughput|latency`/
  `max_price`/`preferred_min_throughput` p50–p99/`zdr`/`data_collection`,
  `B/packages/llm-core/src/types.ts:614-681`) and `VercelGatewayRouting`
  (`types.ts:688-693`), both mirrored in the catalog schema so they are per-model
  configurable. Gateway providers (`clawrouter`, `cloudflare-ai-gateway`,
  `vercel-ai-gateway`, `openrouter`, `litellm`) are first-class extensions with
  `discovery: "runtime"`.
- Note: `B/src/model-picker/` is only ~2 files about *channel presentation*
  capabilities, not model selection — model selection lives in
  `B/src/agents/model-fallback-candidates.ts` and `model-selection-resolve.ts`.

**Depth verdict: OpenClaw by default — Agno has nothing to compare.**

## Salvage list

Port these from Agno (the loser) into the OpenClaw model layer:

1. `A/libs/agno/agno/utils/tokens.py` (637 lines) — local pre-flight token counting via
   tiktoken / HF tokenizers with per-family selection and image-tile estimation.
   OpenClaw has no local counter; `Usage.contextUsage` can be `{state:"unavailable"}`,
   which leaves compaction/budgeting blind before a request is sent.
2. `A/libs/agno/agno/models/base.py:623-644` (`count_tokens` / `acount_tokens` on the
   model interface) — the *contract* that a model can be asked "how big is this
   request?" before dispatch. Add as an optional `countTokens` on the OpenClaw model
   contract, backed by (1).
3. `A/libs/agno/agno/models/fallback.py:20-110` (`FallbackConfig` with `on_error` /
   `on_rate_limit` / `on_context_overflow` + `callback`) — per-error-class fallback
   chains. OpenClaw classifies 16 reasons but funnels them all into one ordered
   candidate list; this is the one place Agno's design is strictly better.
4. `A/libs/agno/agno/models/fallback.py:99-110` — the explicit rule that non-retryable
   4xx client errors are *never* masked by a generic fallback. Worth porting as a
   policy assertion into `B/src/agents/model-fallback-runner.ts`.
5. `A/libs/agno/agno/models/message.py:78-86` — audio / video / file as first-class
   message content plus `audio_output` / `video_output`. OpenClaw's llm-core is
   text+image only; folding native audio/document blocks into `UserMessage` avoids
   routing every non-image modality through the separate media packages.
6. `A/libs/agno/agno/models/response.py:46-64` + `base.py:1578-1586` — HITL tool-call
   semantics (`requires_confirmation`, `requires_user_input`,
   `external_execution_required`, `approval_type`/`approval_id`) expressed *at the
   model-loop boundary* so a run can pause and resume. OpenClaw's equivalent policy
   sits in the agent layer, not the model loop.
7. `A/libs/agno/agno/models/base.py:446-545` — the deterministic on-disk response
   cache (`cache_response`/`cache_ttl`/`cache_dir`, key = messages+tools+format+stream).
   Cheap, and useful for deterministic tests and local development replay.
8. `A/libs/agno/agno/models/base.py:264-270` — `retry_with_guidance`: on a
   `RetryableModelProviderError`, append a temporary guidance user message and retry.
   A genuinely different repair axis from OpenClaw's syntactic tool-call repair.
9. `A/libs/agno/agno/models/utils.py:15-79` — the single-row-per-provider registry
   table as a *documentation and drift-test* pattern (Agno has a registry-drift test
   against it). Useful as a lint over OpenClaw's 54 plugin manifests.

## DROP list

Delete from the merged repo (strictly inferior duplicates of OpenClaw equivalents):

1. `A/libs/agno/agno/models/base.py:227-429` (`_invoke_with_retry`,
   `_ainvoke_with_retry`, `_invoke_stream_with_retry`, `_ainvoke_stream_with_retry`) —
   blocking `sleep()`, no jitter, no `Retry-After`, `retries` defaults to 0. Superseded
   by `B/packages/retry/src/index.ts`.
2. `A/libs/agno/agno/exceptions.py:133-192` (`ModelProviderError.classify` and its
   13-substring `CONTEXT_WINDOW_PATTERNS`) — a 3-class heuristic superseded by the
   16-reason classifier and its regression corpus in `B/src/agents/failover/`.
3. All ~30 OpenAI-compatible passthrough provider classes that add only a base URL and
   an API key: `A/libs/agno/agno/models/{aimlapi,cometapi,langdb,llmman,n1n,nebius,
   neosantara,nexus,portkey,ramp,requesty,sambanova,siliconflow,synthorai,tokenlab,
   trustedrouter,tuning_engines,vercel}/` — each is a subclass of `OpenAILike`
   (`tuning_engines.py` is 45 lines including docstring). Replace each with one
   `openclaw.plugin.json` manifest declaring `api: "openai-completions"`, a baseUrl,
   auth env vars, and priced models. Deleting them removes ~30 code paths and *adds*
   cost/capability metadata those providers currently lack.
4. `A/libs/agno/agno/models/{deepinfra,deepseek,fireworks,groq,together,xai,minimax,
   moonshot,internlm,inception,dashscope,xiaomi}/` — same argument, and OpenClaw
   already ships priced manifests for every one of these.
5. `A/libs/agno/agno/models/openai/like.py` (`OpenAILike`) as an extension point —
   superseded by `OpenAICompletionsCompat` (`B/packages/llm-core/src/types.ts:505-559`),
   which expresses the same variance *as data* (30+ flags) instead of subclassing.
6. `A/libs/agno/agno/models/litellm/` — LiteLLM as a Python-side abstraction layer is
   redundant once the merged system routes through OpenClaw's protocol adapters;
   keep only `B/extensions/litellm` (the gateway integration). Note LiteLLM's *pricing
   JSON* is already consumed by `B/packages/model-catalog-core/src/model-catalog-pricing.ts:14`.
7. `A/libs/agno/agno/models/base.py:446-545`'s cache-key builder **if** salvage item 7
   is taken — port the behavior, drop the Python implementation.
8. `A/libs/agno/agno/models/tuning_engines/` — 45 lines, one vendor, zero unique
   mechanism; a manifest row at most.

Do **not** drop: `A/libs/agno/agno/models/fallback.py`, `message.py`, `response.py`,
`utils/tokens.py`, `metrics.py`, or the Google/Bedrock/Anthropic provider bodies until
their salvaged behaviors above are actually ported and executed against tests.

## Bridge requirements

The surviving model layer is OpenClaw's (TypeScript). To make it callable from both
runtimes:

1. **Freeze `llm-core` as the wire contract.** `B/packages/llm-core/src/types.ts` is
   already dependency-light (only `typebox`). Emit a JSON-Schema / protobuf projection
   of `Model`, `Context`, `Message`, `Tool`, `StreamOptions`, `Usage`,
   `AssistantMessageEvent`, `StopReason`, `FailoverReason` and generate Python
   dataclasses from it. `B/packages/gateway-protocol/src/failover-reasons.ts` already
   states the reason spellings are frozen — treat the whole contract that way.
2. **Expose the runtime over the existing gateway, not over FFI.** OpenClaw already has
   `B/packages/gateway-protocol` and `B/packages/gateway-client`; add a
   `stream`/`complete` RPC that mirrors `B/src/llm/stream.ts:76-118` and streams the
   12 `AssistantMessageEvent` variants verbatim (SSE or websocket). Python then gets
   streaming, thinking blocks, tool-call deltas, replay state and usage for free.
3. **Ship the model catalog as data to both sides.** `B/src/model-catalog/remote-refresh.ts`
   already produces a validated `RemoteModelCatalogBundle`. Publish the same bundle to
   the Python runtime so `Model` construction, pricing, context windows and
   `compat` flags are single-sourced. Python must never re-declare a provider.
4. **Cancellation bridge.** `AbortSignal` must map onto Agno's `RunCancelledException`
   /`run/cancel.py:69` in both directions: a Python `cancel_run(run_id)` has to abort
   the in-flight TS request (which OpenClaw supports and Agno currently cannot), and a
   TS abort must surface as `RunCancelledException` in the Python tool loop.
5. **Tool-call bridge with repair on the TS side.** Tools declared in Python must
   serialize to `Tool { name, description, parameters: JSON Schema }`
   (`types.ts:437-441`), and repaired plain-text tool calls
   (`B/packages/tool-call-repair/`) must be promoted *before* crossing back, so Python
   only ever sees normalized `ToolCall` objects.
6. **HITL/pause round-trip.** Salvage item 6 requires the bridge to carry a
   "tool call requires approval / user input / external execution" state and to resume
   a run from it — i.e. the RPC must be resumable, not a single request/response.
7. **Token counting port.** Salvage item 1 is Python-native (tiktoken). Either expose
   it as a small Python service the TS side can call for pre-flight budgeting, or
   reimplement with a WASM tokenizer in TS. Decide once; do not fork the estimate —
   a divergent count between runtimes silently corrupts compaction decisions.
8. **Single usage/cost ledger.** All cost computation must stay in
   `B/packages/llm-core/src/usage-cost.ts`; Agno's `ModelMetrics.cost`
   (`A/libs/agno/agno/metrics.py:47`) becomes a passthrough of the TS-computed
   `Usage.cost`, never an independent calculation.

**UNVERIFIED / not checked this session:** runtime behavior of either layer (no tests
or builds were executed); OpenClaw's per-provider auth/OAuth flows beyond file listings;
Agno's `google/gemini.py` (2179 lines) and `aws/bedrock.py` (904 lines) internals beyond
line counts and grep; whether OpenClaw has any response-level dev cache outside the
model layer; whether `extensions/{arcee,vydra,openshell}` are text-LLM or other-modality
providers beyond their manifest `providers` field.

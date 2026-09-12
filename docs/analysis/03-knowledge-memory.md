# 03 — Knowledge / RAG / Memory / Vector Stores / Persistence

Scope: knowledge ingestion, vector stores, retrieval, memory, DB persistence only.
A = `_src/agno-main` (Python). B = `_src/openclaw-main` (TypeScript).
All paths below are relative to those two roots. Every claim is backed by a file read this
session; anything not read is marked **UNVERIFIED**.

---

## Verdict

**Vector stores — Agno wins, decisively.** Agno ships 20 concrete backends under
`libs/agno/agno/vectordb/` (cassandra, chroma, clickhouse, couchbase, lancedb, langchaindb,
lightrag, llamaindex, milvus, mongodb, opensearch, pgvector, pineconedb, qdrant, redis,
singlestore, surrealdb, upstashdb, valkey, weaviate) behind one abstract contract
(`vectordb/base.py:95-303`) that mandates `insert/upsert/search/content_hash_exists/
delete_by_content_id/get_supported_search_types`. OpenClaw has exactly two: the builtin
sqlite-vec index (`packages/memory-host-sdk/src/host/memory-schema-base.ts:19`
`MEMORY_INDEX_VECTOR_TABLE = "memory_index_chunks_vec"`, loaded by
`host/sqlite-vec.ts:58 loadSqliteVecExtension`) and an optional LanceDB plugin
(`extensions/memory-lancedb/lancedb-store.ts:176-189`, `.vectorSearch(vector).limit(limit)`).
Not close.

**Ingestion — Agno wins.** Agno has 23 reader classes (`knowledge/reader/*.py`: PDF, PDFImage,
Docling, Docx, Excel, PPTX, CSV, FieldLabeledCSV, JSON, Markdown, Text, Arxiv, Wikipedia,
YouTube, Website, Sitemap, Firecrawl, Tavily, WebSearch, LLMsTxt, S3, …), 8 chunking strategies
(`knowledge/chunking/`: fixed, recursive, document, markdown, semantic, agentic, code, row), 18
embedder classes, and 5 remote loaders (S3/GCS/AzureBlob/SharePoint/GitHub under
`knowledge/loaders/` + `knowledge/remote_content/`). OpenClaw ingests exactly three things:
markdown memory files, session transcripts, and image/audio files
(`memory-tool-contract.ts:53-56` "MEMORY.md, USER.md, Markdown files recursively under memory/";
`host/multimodal.ts:6-14` image/audio extension lists), through one line-window chunker
(`host/internal.ts:563 chunkMarkdown`). OpenClaw's incremental story is *better* (hash+mtime+size
per source row, `memory-schema-base.ts:59-67`), but breadth is not comparable.

**Retrieval quality — OpenClaw wins.** Agno's ranking is whatever the backend does: `SearchType`
is a 3-value enum (`vectordb/search.py:4-7`) and the fusion happens inside each adapter (e.g.
`pgvector.py:1193 hybrid_search`, `to_tsvector`/`ts_rank_cd` at 1234-1247). There is no
cross-backend re-ranking pipeline beyond an optional cross-encoder call
(`pgvector.py:1052-1053`). OpenClaw runs a real ranking pipeline on top of vector+FTS:
`extensions/memory-core/src/memory/hybrid.ts:87 mergeHybridResults` → weighted fusion (`:213`) →
temporal decay (`:253`, exponential half-life, `temporal-decay.ts:17-27`) → importance multiplier
→ project ranking → exact-path specificity tiers (`:302-312`) → MMR diversity re-rank (`:315`,
`mmr.ts:51`) → threshold+lexical-fallback selection (`:338-378`). It also emits citations
(`tools.citations.ts:32-38`, `path#L12-L40`), staleness flags, and per-corpus outcomes. Agno's
`FilterExpr` DSL (`filters.py`) and 4 reranker providers are the two things it does better.

**Memory — OpenClaw wins, decisively.** Agno's user memory has **no vector retrieval at all**:
`memory/manager.py:597-642` offers only `last_n`, `first_n`, and `agentic` — and `agentic`
(`:660-667`) loads *every* memory for the user and asks an LLM to return matching ids.
Consolidation is one strategy, "summarize everything into one blob"
(`memory/strategies/summarize.py`). OpenClaw models memory as a durable markdown corpus plus a
rebuildable index, with recall telemetry (`memory_index_chunk_recall_metadata`,
`memory-schema-recall.ts:7-15`, importance 1-10 + triggers + project_key), short-term recall
promotion scored on frequency/relevance/diversity/recency/consolidation/conceptual weights
(`short-term-promotion-types.ts:12-42`), a three-phase "dreaming" consolidation sweep
(light/REM/deep, `memory-core/openclaw.plugin.json` `dreaming.phases`, with
`maxPriorEntryLossFraction` guarding destructive rewrites), standing intents
(`standing-intents.ts:22-38`), provenance and session tombstones, and a pre-reply auto-recall
extension (`extensions/active-memory/`) with cache, circuit breaker and deadline.

**Persistence — Agno wins.** `libs/agno/agno/db/` provides 14 distinct backends
(postgres, mysql, sqlite, mongo — each with an async twin — plus clickhouse, dynamo, firestore,
redis, valkey, singlestore, surrealdb, gcs_json, json, in_memory) behind `BaseDb`/`AsyncBaseDb`
(`db/base.py:295`, `:2100`) covering sessions, runs, memories, metrics, knowledge contents,
evals, traces, spans, components, configs, approvals, jobs, scheduler, service accounts, plus a
versioned migration manager (`db/migrations/versions/v2_3_0…v3_0_0.py`). OpenClaw is
SQLite-only (`node:sqlite` + Kysely; `src/state/openclaw-state-db-open.ts`), but far deeper on
that one engine: 122 tables in `openclaw-state-schema.sql`, 39 in `openclaw-agent-schema.sql`,
plus leases, WAL maintenance, integrity preflight, permission enforcement and corruption
recovery. Comparable in richness, not in portability — and portability is what a merged OS needs.

---

## Vector store coverage table

| Backend | Agno | OpenClaw | Unique to |
|---|---|---|---|
| PgVector (Postgres) | ✅ `vectordb/pgvector/pgvector.py` (vector+keyword+hybrid, `:1760`) | ❌ | Agno |
| Qdrant | ✅ `vectordb/qdrant/qdrant.py` (v/k/h, `:1276`) | ❌ | Agno |
| Weaviate | ✅ `vectordb/weaviate/weaviate.py` (v/k/h, `:1260`) | ❌ | Agno |
| LanceDB | ✅ `vectordb/lancedb/lance_db.py` (v/k/h, `:1210`) | ✅ `extensions/memory-lancedb/lancedb-store.ts` (vector only) | both |
| Chroma | ✅ `vectordb/chroma/chromadb.py` (v/k/h, `:1774`) | ❌ | Agno |
| Milvus | ✅ `vectordb/milvus/milvus.py` (vector+hybrid, `:1532`) | ❌ | Agno |
| MongoDB Atlas | ✅ `vectordb/mongodb/mongodb.py` (vector+hybrid, `:1569`) | ❌ | Agno |
| OpenSearch | ✅ `vectordb/opensearch/opensearch.py` (v/k/h, `:2448`) | ❌ | Agno |
| Redis | ✅ `vectordb/redis/redisdb.py` (v/k/h, `:953`) | ❌ | Agno |
| Valkey | ✅ `vectordb/valkey/valkeydb.py` (vector+keyword, `:1001`) | ❌ | Agno |
| Pinecone | ✅ `vectordb/pineconedb/pineconedb.py` (hybrid if `use_hybrid_search`, `:878`) | ❌ | Agno |
| ClickHouse | ✅ `vectordb/clickhouse/clickhousedb.py` (vector, `:1023`) | ❌ | Agno |
| Cassandra | ✅ `vectordb/cassandra/cassandra.py` | ❌ | Agno |
| Couchbase | ✅ `vectordb/couchbase/couchbase.py` | ❌ | Agno |
| SingleStore | ✅ `vectordb/singlestore/singlestore.py` | ❌ | Agno |
| SurrealDB | ✅ `vectordb/surrealdb/surrealdb.py` | ❌ | Agno |
| Upstash Vector | ✅ `vectordb/upstashdb/upstashdb.py` | ❌ | Agno |
| LightRAG (graph RAG) | ✅ `vectordb/lightrag/lightrag.py` | ❌ | Agno |
| LlamaIndex adapter | ✅ `vectordb/llamaindex/llamaindexdb.py` | ❌ | Agno |
| LangChain adapter | ✅ `vectordb/langchaindb/langchaindb.py` | ❌ | Agno |
| sqlite-vec (embedded) | ❌ | ✅ `memory-schema-base.ts:19` + `host/sqlite-vec.ts:58` | **OpenClaw** |
| SQLite FTS5 (lexical half) | ❌ | ✅ `memory-schema-fts.ts:4-7` (`memory_index_chunks_fts`, `memory_index_paths_fts`) | **OpenClaw** |

Counts: Agno 20 backends; OpenClaw 2 (+FTS5 companion). Only LanceDB overlaps.

---

## Capability comparison table

| Capability | Agno impl + path | OpenClaw impl + path | Winner | Evidence strength |
|---|---|---|---|---|
| Vector backend breadth | 20 adapters, `libs/agno/agno/vectordb/` | sqlite-vec + LanceDB plugin | **Agno** | OBSERVED (dir listing + per-file `get_supported_search_types`) |
| Search-type contract | `vectordb/search.py:4-7` enum + `base.py:302` | implicit; hybrid always on when vectors exist, `hybrid.ts:87` | **Agno** (explicit contract) | OBSERVED |
| Hybrid fusion & re-ranking pipeline | per-backend SQL only (`pgvector.py:1193-1247`) | `hybrid.ts:87-378` weighted fusion + decay + importance + project + exact-path tiers + MMR | **OpenClaw** | OBSERVED (full file read) |
| MMR / diversity | none found | `memory/mmr.ts:51 mmrRerank`, λ default 0.7 | **OpenClaw** | OBSERVED |
| Temporal decay | none found | `memory/temporal-decay.ts:17-27`, `exp(-ln2/halfLife * ageDays)` | **OpenClaw** | OBSERVED |
| Cross-encoder rerankers | 4: Cohere, AWS Bedrock (+CohereBedrock/Amazon), SentenceTransformer, Infinity — `knowledge/reranker/` | none (MMR is lexical Jaccard, `mmr.ts` → `tokenize.ts`) | **Agno** | OBSERVED |
| Filter DSL | `filters.py` EQ/NEQ/GT/GTE/LT/LTE/IN/CONTAINS/STARTSWITH/AND/OR/NOT, depth-capped at 10; `db/filter_converter.py` → SQLAlchemy | corpus enum only (`memory-tool-contract.ts:23-31`: memory/wiki/all/sessions) + source/project filters | **Agno** | OBSERVED |
| Citations | `Document.meta_data` only (`knowledge/document/base.py:14`); no citation formatter found | `tools.citations.ts:18-51` → `path#L12-L40` appended to snippet, mode on/off/auto | **OpenClaw** | OBSERVED |
| Readers / doc types | 23 readers incl. PDF, PDFImage, Docling, Docx, Excel, PPTX, CSV, JSON, MD, Arxiv, Wikipedia, YouTube, Sitemap, Firecrawl, Tavily | markdown + transcripts + image/audio (`host/multimodal.ts:6-14`); PDF only via separate `extensions/document-extract` (clawpdf) | **Agno** | OBSERVED |
| Chunking strategies | 8 (`knowledge/chunking/`), incl. semantic + agentic (LLM-chosen breakpoints, `agentic.py:55`) | 1 line-window chunker with overlap + per-entry mode (`host/internal.ts:563`), plus provider byte-budget splitter (`embedding-chunk-limits.ts:19`) | **Agno** | OBSERVED |
| Embedding providers | 18 classes (`knowledge/embedder/`) incl. local (fastembed, sentence_transformer, vllm, ollama) | 10 plugin-registered (`openai, gemini, bedrock, mistral, voyage, deepinfra, ollama, lmstudio, github-copilot, local`) + llama.cpp GGUF default (`embedding-defaults.ts:4`) | **Agno** | OBSERVED (plugin.json `contracts.embeddingProviders`) |
| Incremental / upsert | content-hash gate: `knowledge.py:1539-1545 content_hash_exists(...) and skip_if_exists`; `base.py:193 upsert_available()`; embed-before-delete `base.py:32-62` | per-source `hash/mtime/size` row + revision counter (`memory-schema-base.ts:59-85`), unchanged-file metadata-only update (`manager-source-sync-ops.ts:154-161`), embedding cache table keyed `(provider,model,provider_key,hash)` | **OpenClaw** | OBSERVED |
| Ingestion status tracking | `KnowledgeRow.status/status_message` (`db/schemas/knowledge.py:19-20`), `get_content_status` (`knowledge.py:774`) | `memory_index_state.revision` + staleness surfaced to the model | **Agno** | OBSERVED |
| User/long-term memory retrieval | `last_n` / `first_n` / `agentic` LLM-over-all-memories (`memory/manager.py:597-667`) — no vectors | vector+FTS hybrid recall over memory corpus, `memory_search` tool (`memory-tool-contract.ts:84-92`) | **OpenClaw** | OBSERVED |
| Memory consolidation | one strategy: summarize-all (`memory/strategies/summarize.py`) | 3-phase dreaming (light/REM/deep) with dedupe similarity, min recall count / unique queries / score gates, prior-entry-loss guard (`memory-core/openclaw.plugin.json` dreaming schema; `src/dreaming-phases.ts`) | **OpenClaw** | OBSERVED |
| Recall telemetry → promotion | none | `memory_index_chunk_recall_metadata` (importance 1-10, triggers, project_key) + `ShortTermRecallEntry{recallCount, queryHashes, recallDays, conceptTags, groundedCount}` (`short-term-promotion-types.ts:21-42`) | **OpenClaw** | OBSERVED |
| Proactive/auto recall | none found | `extensions/active-memory/` pre-reply subagent recall, modes escalate/always/off, cache TTL, circuit breaker (`types.ts:16-29`) | **OpenClaw** | OBSERVED |
| Tool-result compression | `compression/manager.py` LLM tool-output compressor | `src/context-engine/compaction-watchdog.ts` (**UNVERIFIED** — file listed, not read) | **Agno** | OBSERVED (A) / UNVERIFIED (B) |
| Session summarisation | `session/summary.py SessionSummaryManager` (LLM) | `src/transcripts/summary.ts` heuristic regex + `summary-model.ts` model-backed | tie-break: **Agno** for agent sessions | OBSERVED |
| DB backend breadth | 14 backends, `db/` | SQLite only (`openclaw-state-db-open.ts`, `node:sqlite`) | **Agno** | OBSERVED |
| DB migrations | `db/migrations/manager.py` + versioned `v2_3_0/v2_5_0/v2_5_6/v3_0_0` + `v1_to_v2` | `openclaw-schema-versions.ts`, `*-migration.ts` per feature, `openclaw-schema-retirements.json` | **Agno** (portable) | OBSERVED |
| DB operational hardening | table cache, FK dependency ordering (`db/base.py:202-416`) | leases, WAL maintenance, integrity assert before mutation (`openclaw-state-db-open.ts:28-50`), permissions, corruption-recovery, verify worker | **OpenClaw** | OBSERVED |
| Persisted scope | sessions, runs, memories, metrics, knowledge, evals, traces, spans, components, configs, approvals, jobs, scheduler | 122 state tables + 39 agent tables incl. transcripts, leases, secrets, approvals, cron, workers, boards, standing intents | **OpenClaw** (breadth of domain) | OBSERVED (schema SQL grep) |

---

## Salvage list

### From OpenClaw (loser on vector stores / ingestion / persistence) — MUST port into the merged repo

| Path | Why (one line) |
|---|---|
| `extensions/memory-core/src/memory/hybrid.ts` | The only real cross-backend fusion+ranking pipeline; port `mergeHybridResults`/`selectHybridSearchResults` as a backend-agnostic re-rank stage above Agno's `VectorDb.search()`. |
| `extensions/memory-core/src/memory/mmr.ts` | Diversity re-ranking Agno has nowhere; cheap, no extra model call. |
| `extensions/memory-core/src/memory/temporal-decay.ts` | Recency half-life scoring — mandatory for memory-shaped corpora, absent in Agno. |
| `extensions/memory-core/src/memory/importance.ts` + `project-ranking.ts` | Per-chunk importance and active-project boost; the signals that make recall feel personal. |
| `packages/memory-host-sdk/src/host/memory-schema-recall.ts` | `memory_index_chunk_recall_metadata` (importance/triggers/project_key) — the schema that feeds promotion. |
| `extensions/memory-core/src/short-term-promotion*.ts` (12 files) | Recall-telemetry → long-term promotion scoring; Agno has no equivalent lifecycle. |
| `extensions/memory-core/src/dreaming*.ts` (17 files) + plugin dreaming config | Light/REM/deep consolidation with a `maxPriorEntryLossFraction` fail-closed guard on destructive rewrites. |
| `extensions/memory-core/src/tools.citations.ts` | Line-range citations (`path#L12-L40`) — Agno returns documents with no provenance string. |
| `extensions/active-memory/` (whole extension) | Pre-reply automatic recall with cache, circuit breaker, deadline and partial-result recovery. |
| `extensions/memory-core/src/standing-intents.ts` | Durable "remind me when X comes up" intents with cooldown/expiry/fire-count — no Agno analogue. |
| `extensions/memory-core/src/memory-entry-origins.ts` + `src/memory/memory-path-provenance.ts` + `memory-schema-provenance.ts` | Chunk→origin provenance and session tombstones; needed for forget/right-to-erasure correctness. |
| `packages/memory-host-sdk/src/host/embedding-chunk-limits.ts` + `embedding-input-limits.ts` + `embedding-model-limits.ts` | Provider byte/token budget enforcement before embedding — Agno drops unembeddable chunks after the fact (`vectordb/base.py:65-81`) instead of preventing it. |
| `packages/memory-host-sdk/src/host/memory-schema-base.ts` (`memory_embedding_cache`) | Embedding cache keyed `(provider, model, provider_key, hash)`; Agno re-embeds. |
| `src/state/openclaw-state-db-open.ts` + `openclaw-database-verify*.ts` + `openclaw-state-lease*.ts` | Integrity-before-mutation, corruption recovery and lease ownership — port as the SQLite backend's hardening in `agno/db/sqlite/`. |
| `packages/memory-host-sdk/src/host/query-expansion.ts` | Keyword/stop-word expansion for the lexical leg; Agno's `buildFtsQuery` equivalent is per-backend and naive. |
| `extensions/memory-core/src/memory/search-deadline.ts` + `tools.ts` cooldown map | Search deadline + 60s failure cooldown so a dead vector store cannot stall every turn. |

### From Agno (loser on retrieval ranking / memory) — MUST port

| Path | Why (one line) |
|---|---|
| `libs/agno/agno/knowledge/reranker/` (4 providers) | Cross-encoder reranking; OpenClaw's MMR is lexical-only and cannot fix a bad embedding recall set. |
| `libs/agno/agno/filters.py` + `libs/agno/agno/db/filter_converter.py` | Typed, depth-capped filter DSL with a SQLAlchemy converter — OpenClaw has only a 4-value corpus enum. |
| `libs/agno/agno/knowledge/chunking/semantic.py` + `agentic.py` + `code.py` + `markdown.py` | Real chunking strategies; OpenClaw ships one line-window splitter. |
| `libs/agno/agno/knowledge/reader/` (PDF/PDFImage/Docling/Docx/Excel/PPTX/CSV/JSON) | Document-type coverage OpenClaw simply does not have in its memory pipeline. |
| `libs/agno/agno/knowledge/remote_content/` + `knowledge/loaders/` | S3/GCS/Azure Blob/SharePoint/GitHub ingestion sources. |
| `libs/agno/agno/vectordb/base.py` | The `VectorDb` ABC is the merge seam — keep it as the single pluggable interface. |
| `libs/agno/agno/db/base.py` + `db/migrations/` | Multi-backend durable persistence + versioned migration manager. |
| `libs/agno/agno/db/schemas/knowledge.py` (`KnowledgeRow.status/status_message`) | Per-content ingestion status; OpenClaw only exposes a global index revision. |
| `libs/agno/agno/compression/manager.py` | LLM tool-result compression with an explicit preserve/remove contract. |
| `libs/agno/agno/session/summary.py` | Model-backed session summarisation for agent sessions. |

---

## DROP list

| Path | Justification |
|---|---|
| `extensions/memory-lancedb/` (whole plugin, B) | Strictly inferior duplicate: vector-only (`lancedb-store.ts:176-189`, no FTS/MMR/decay/citations) with a *third* tool surface (`memory_store`/`memory_recall`/`memory_forget`) that forks active-memory's allow-list (`active-memory/types.ts:30-31`). Agno's `vectordb/lancedb/lance_db.py` already does vector+keyword+hybrid on the same engine. |
| `libs/agno/agno/memory/strategies/` (A) | Summarize-everything-into-one-blob is strictly weaker than dreaming's light/REM/deep phases with loss guards; keeping both gives two conflicting consolidation owners. |
| `libs/agno/agno/memory/manager.py` — `_search_user_memories_agentic` / `_get_first_n_memories` / `_get_last_n_memories` retrieval paths (`:597-790`) (A) | Replaced by hybrid vector+FTS memory recall; an LLM scanning every memory row is O(n) tokens per turn. Keep the rest of `MemoryManager` (extraction/update/delete tools). |
| `libs/agno/agno/knowledge/embedder/fireworks.py`, `nebius.py`, `together.py`, `langdb.py` (A) | 13-22 line `class X(OpenAIEmbedder)` shims differing only in `base_url`/`id`/env var; collapse into `openai_like.py` config. |
| `libs/agno/agno/vectordb/langchaindb/` and `libs/agno/agno/vectordb/llamaindex/` (A) | Pass-through adapters to competing framework abstractions (`get_supported_search_types()` returns `[]` at `langchaindb.py:217`, `llamaindexdb.py:207`), so they cannot participate in the merged hybrid/rerank pipeline. |
| `libs/agno/agno/db/gcs_json/` (A) | JSON-blob-in-a-bucket persistence with no query/index capability; `db/json/` covers dev use and every real deployment should use a real backend. Keep `json/` and `in_memory/` (tests). |
| `src/transcripts/summary.ts` heuristic regex summarizer (B) | Regex keyword-matching for decisions/actions/risks (`:31-34`) is strictly worse than `session/summary.py` once a model is available; keep only `src/transcripts/summary-model.ts`. |

Do **not** drop `src/memory-host-sdk/*` — those are 5-11 line intentional facades re-exporting
`packages/memory-host-sdk`, not duplicates (verified: `src/memory-host-sdk/query.ts` is 5 lines).

---

## Bridge requirements

The merged Agentic-OS keeps **Agno as the knowledge/vector/persistence layer** and **OpenClaw's
ranking + memory-lifecycle layer on top of it**. Two seams, both already have a natural interface.

### Seam 1 — Agno knowledge exposed to the OpenClaw runtime

**API surface:** a `KnowledgeService` over the existing `VectorDb` ABC
(`libs/agno/agno/vectordb/base.py:95-303`), fronted by JSON-RPC/HTTP:

```
search(query, limit, filters: FilterExpr[], user_id, search_type)  -> Document[]
insert(content_hash, documents, filters, user_id)                  -> void
upsert(content_hash, documents, filters, user_id)                  -> void
content_hash_exists(content_hash, user_id)                         -> bool
delete_by_content_id(content_id, user_id)                          -> bool
get_supported_search_types()                                       -> ["vector"|"keyword"|"hybrid"]
```

**Consumed by:** `memory_search` as a new corpus value. `memory-tool-contract.ts:23-31` already has
a closed enum `corpus: ["memory","wiki","all","sessions"]` and a fail-closed validator
(`tools.ts:82-96 readCorpusParam`) — add `"knowledge"` there, nothing else in the tool changes.

**Data-type mapping (required, both directions):**

| Agno `Document` (`knowledge/document/base.py:8-21`) | OpenClaw `MemorySearchResult` / `HybridSearchResult` (`hybrid.ts:15-28`) |
|---|---|
| `content` | `snippet` |
| `name` / `meta_data["path"]` | `path` |
| `meta_data["start_line"|"end_line"]` (new, must be stamped at chunk time) | `startLine` / `endLine` |
| `reranking_score` or backend score | `score` (+ `vectorScore`, `textScore` split; backends that return only one must report the other as `0`) |
| `content_id` / `content_origin` | `provenance` (`MemoryEntryProvenance`) |
| `meta_data["source"]` | `source` |
| — (Agno has none) | `importance`, `triggers`, `projectKey` — supplied by `memory_index_chunk_recall_metadata`, joined on the OpenClaw side after the Agno call |

Because Agno backends return only a single `score`, the fusion stage must receive
`{vectorScore, textScore}` separately or `hybrid.ts` degrades to a pass-through. Concretely:
`VectorDb.search()` gains an optional `return_component_scores: bool` and each hybrid-capable
adapter (`pgvector`, `qdrant`, `weaviate`, `lancedb`, `chroma`, `opensearch`, `redis`, `mongodb`,
`milvus`) surfaces its pre-fusion legs. Adapters that cannot (the 6 returning `[]` from
`get_supported_search_types()`) report `textScore = 0` and are vector-only in the pipeline.

### Seam 2 — OpenClaw memory exposed to the Agno runtime

**API surface:** implement `class OpenClawMemoryDb(VectorDb)` in `agno/vectordb/openclaw/` that
speaks to the memory-core manager. It satisfies the same ABC, so any Agno agent can use recall as
a knowledge base. `get_supported_search_types()` returns `["vector","keyword","hybrid"]`.

**Plus a memory API for the lifecycle Agno lacks:**

```
recall(query, maxResults, minScore, corpus)  -> MemorySearchResult[]   # memory_search
get(path, from, lines, corpus)               -> MemoryReadResult       # memory_get
remember(text, importance?, triggers?, projectKey?)                    # curated write
forget(pathOrClaimHash)                                                # tombstone + reindex
promote()/dream(phase: "light"|"rem"|"deep")                           # consolidation sweep
```

`agno.memory.MemoryManager.search_user_memories()` is re-pointed at `recall()`, replacing the
`last_n`/`first_n`/`agentic` branch (`memory/manager.py:631-642`).

### Seam 3 — persistence ownership (must be settled before either seam is built)

- **Durable owner = Agno `BaseDb`/`AsyncBaseDb`** for sessions, runs, user memories, knowledge
  contents, metrics, evals, traces, components, configs.
- **Local recall index stays SQLite/sqlite-vec** and is explicitly *derived, rebuildable* state —
  `memory-schema-base.ts:23-34` already declares `MEMORY_INDEX_DERIVED_TABLES` in
  child-before-parent drop order, with the comment "Origins, tombstones, and canonical sessions
  are durable owners, not index data." Keep that boundary: the durable owners
  (`memory_entry_origins`, `memory_session_tombstones`, curated markdown files) migrate to
  `BaseDb`; everything in `MEMORY_INDEX_DERIVED_TABLES` can be dropped and rebuilt.
- **Migrations:** one owner only — `agno/db/migrations/manager.py`. OpenClaw's
  `openclaw-schema-versions.ts` + `openclaw-schema-retirements.json` become the SQLite backend's
  version table under that manager, not a second migration system.

**Not verified this session (do not assume):** the `src/context-engine/` compaction path and how
it interacts with memory flush plans (`extensions/memory-core/src/flush-plan.ts`); the
`extensions/memory-wiki/` compiled-wiki/OKF query surface beyond its file list; whether any Agno
vector adapter persists component scores today. Each is marked **UNVERIFIED** above.

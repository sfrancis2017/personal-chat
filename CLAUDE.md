# Context for Claude Code

## About this repo
Personal RAG chat at https://chat.sajivfrancis.com — grounded in Sajiv's
Nextcloud documents, architecture notes, and published writing.

## Architecture

```
Browser (chat.sajivfrancis.com)
   │   public/{index.html, chat.js, styles.css}  ← Cloudflare Pages
   │   • marked + DOMPurify + mermaid (jsdelivr ESM)
   │   • topic chips above composer (multi-select)
   │   • Markdown render on stream completion; mermaid → SVG
   │
   ▼  fetch /chat (SSE) + /topics
Cloudflare Worker (chat-worker.sfrancis2017.workers.dev)
   │   worker/src/index.ts
   │   • Auth: Bearer CHAT_TOKEN (constant-time compare)
   │   • CORS: chat.sajivfrancis.com, sajivfrancis.com, www.sajivfrancis.com
   │   • Routes: /health, /topics (GET), /chat (POST, SSE)
   │   • max_tokens: 4096 ; model: claude-sonnet-4-6
   │
   │  3 subrequests / chat turn:
   │    1. OpenAI text-embedding-3-small (1536-dim)
   │    2. POST /retrieve on droplet (top-K chunks, optional topic[] filter)
   │    3. Anthropic /v1/messages stream
   │
   ▼
Droplet (CentOS — host details in gitignored RAG_SETUP.md)
   │   /root/ingest/retrieve.py  (systemd: retrieve.service, port 8081)
   │   • Tiny http.server shim around pgvector
   │   • Auth: Bearer RETRIEVE_TOKEN
   │   • Routes: /health, /topics (GET), /retrieve (POST)
   │   • Cloudflare Tunnel (cloudflared, quick mode) gives public hostname
   │
   ▼
Postgres 16 + pgvector (same droplet, port 5432 local)
   • DB: chat_db    table: chunks
   • cols: source_url, source_path, text, embedding (vector(1536)),
           topic, metadata (jsonb)
   • Index: <=> ivfflat on embedding
```

## Ingestion pipeline
- `scripts/nextcloud_ingest.py` — runs on droplet against the Nextcloud files
  directory (path from `NEXTCLOUD_ROOT` env var, set in `/root/ingest/retrieve.env`)
- Walks Nextcloud, extracts text from md/pdf/docx/pptx/xlsx/ipynb/xml-like
- Token-chunks via tiktoken (≤1000 tokens, 100 overlap)
- Embeds via OpenAI text-embedding-3-small
- Inserts to `chunks`, idempotent per `source_path` (DELETE then INSERT)
- Topic = top-level folder name (slugified)
- Also writes `nextcloud-audit.md` with author + publish-worthiness classifier

## Local layout
- `worker/`        Cloudflare Worker (typescript, wrangler)
- `public/`        Cloudflare Pages (chat.sajivfrancis.com)
- `scripts/`       Droplet-only ingestion + retrieve API (code committed; secrets/audits gitignored)
- `RAG_SETUP.md`   Runbook with droplet host details + recovery procedures (gitignored)

## Deploy artefacts (live on droplet, not in repo)
- Deployed retrieve.py path: `/root/ingest/retrieve.py` (per `retrieve.service`)
- Secrets file: `/root/ingest/retrieve.env` (contains DATABASE_URL, RETRIEVE_TOKEN,
  OPENAI_API_KEY, NEXTCLOUD_ROOT, AUTHOR_SIGNALS, OWNER_PREFIXES — never committed)
- See `scripts/README.md` for the deploy workflow (host details in gitignored
  `RAG_SETUP.md`).

## Deploy workflow
- **Pages** (`public/`): push to `main`, GitHub Actions deploys.
- **Worker** (`worker/`): `cd worker && npx wrangler deploy` (no auto-deploy).
- **Droplet retrieve.py**: scp + `systemctl restart retrieve`.
- Secrets: `wrangler secret put CHAT_TOKEN | OPENAI_API_KEY | ANTHROPIC_API_KEY | RETRIEVE_TOKEN | RETRIEVE_URL`.

## Shipped capabilities
- RAG chat: real pgvector retrieval, OpenAI embedding, streamed Claude responses.
- E1: topic chips (multi-select OR-filter; populated from `GET /topics`).
- F-bonus: Markdown rendering (marked + DOMPurify), Mermaid diagrams (jsdelivr
  ESM build, `securityLevel: 'loose'`, `useMaxWidth: true`), Copy source +
  Download SVG buttons (foreignObject → native text on download), classDef
  theming guide in system prompt (data-pipeline / ArchiMate / Azure palettes).
- Worker: `max_tokens: 4096` (was 1024, would truncate big diagrams).

## Roadmap (not yet built)
| ID | Item | Effort | Why |
|----|------|--------|-----|
| E2 | Query rewriting before embedding (Haiku) | ~30 min | Conversational follow-ups embed badly |
| E3 | Claude rerank of top-K | ~30 min | pgvector recall good, precision weak |
| F5 | Extended thinking opt-in toggle | ~30 min | Visible reasoning for arch questions |
| —  | Domain diagram models (ArchiMate, BPMN, C4) | TBD | Pure prompt-engineering or post-process |
| —  | Site embed: floating launcher on sajivfrancis.com → iframe to chat | ~1 hr | See "Cross-repo" below |
| —  | docs.sajivfrancis.com: expand/zoom-on-click for rendered Mermaid diagrams (parity with chat-side diagram modal) | ~1 hr | Architecture diagrams are dense; readers need a full-screen view. Mermaid client-side render landed 2026-05-15; modal not yet ported. Lives in `sfrancis2017/docs` astro.config.mjs head script. |
| —  | Whitepaper "no-link" policy — synthesis prompt rule + post-process strip | ~45 min | Reference material is multi-year old; SAP URLs like `rapid.sap.com/bp/...` rot fast. Replace with durable identifiers (scope item codes, transaction codes, IMG paths, SAP Note numbers). (1) Add "do not include URLs in body" rule to whitepaper system prompt. (2) Add `stripBodyLinks(md)` post-process in worker's publish pipeline that converts `[text](url)` → `text` and drops bare URLs. Apply on docs publish only, not chat preview. Real example surfaced 2026-05-15 from CFIN: "available at https://rapid.sap.com/bp/#/browse/scopeitems/1W4" — keep "scope item 1W4", drop the URL. |

## Next session — handoff from May 12, 2026

Three workstreams parked, in priority order.

### 1. Wire up the SEC benchmark feature (backend already drafted)

**Status as of handoff:**
- Migration `scripts/migrations/002_benchmark.sql` applied to `chat_db` on droplet ✅
  (benchmark_jobs table + sec_competitor_chunks view + expire_sec_competitor_cache() function;
  grants mirror the chunks table pattern: chat_user=arwd/postgres)
- `scripts/benchmark_job.py` orchestrator drafted (539 LOC) — passes syntax check, NOT deployed
- `scripts/retrieve.py` extended with 3 new routes (+189 LOC) — passes syntax check, NOT deployed
- Locked design decisions: progress card in chat thread, MAX_CONCURRENT_JOBS=2, owner-only

**Still to ship:**

| Layer | Work | ~LOC |
|---|---|---|
| Droplet env | Add `ANTHROPIC_API_KEY` and confirm `SEC_USER_AGENT` in `/opt/retrieve/retrieve.env` | — |
| Droplet deploy | `scp scripts/benchmark_job.py scripts/retrieve.py root@droplet:/opt/retrieve/ && systemctl restart retrieve` | — |
| Droplet smoke test | `python3 -m benchmark_job <pdf>`, then curl `/benchmark/start` + status + report endpoints | — |
| Worker | 3 passthrough routes in `worker/src/index.ts`: `POST /benchmark/start`, `GET /benchmark/status/:id`, `GET /benchmark/report/:id` — same pattern as existing `/benchmark/peers` | ~120 |
| Frontend HTML | Mode radio in upload modal: "Add to corpus" (default) vs "Benchmark this filing" | ~10 |
| Frontend JS | Branch in `submitUpload` for benchmark mode, new `submitBenchmark` + `pollBenchmarkStatus`, chat-thread progress card, reuse the existing preview modal for report display | ~80 |

**Caveat to plan for (v2 cleanup):** daemon thread dies on `systemctl restart`. In-flight jobs at restart time stay in non-terminal status forever. Nightly cron should sweep:

```sql
UPDATE benchmark_jobs SET status='failed', error_message='service restart — job abandoned'
WHERE status = ANY(ARRAY['pending','identifying','fetching_peers','extracting','reporting'])
  AND created_at < NOW() - INTERVAL '30 minutes';
```

### 2. Whitepaper rendering upgrade — one template, two callers

Benchmark report and existing `synthesize-whitepaper` export share a target format. Single rendering pipeline upgrade serves both.

| Element | Wanted | Notes |
|---|---|---|
| Title page banner | Use `og-default.svg` from main site as starting point; higher-fidelity local asset can replace if available | If banner SVG uses webfonts (Inter etc.), PDF pipeline may not render them. Test early; fallback may be PNG rasterization |
| Title page metadata (benchmark) | Auto-populated from `benchmark_jobs` row: company name, period, peers, ticker | Structured data, no manual editing needed |
| Title page metadata (general synthesis) | Pre-render pass: hand chat transcript to Claude, get `{title, subtitle, summary, date}` as JSON, pre-fill preview | Existing markdown preview stays editable — user accepts or tweaks before PDF gen. The change is first-draft quality, not the affordance |
| Table of contents | Standalone page, H1 + H2 + H3 depth, clickable anchors. HTML preview AND PDF (PDFs support internal links) | Numbered headings improve scannability for the depth requested |
| Section back-links | "↑ Back to contents" link below each H1/H2 in rendered output | |
| Mermaid sizing | Fit-to-window by default in chat AND PDF; expand modal already exists | Fix: strip `width`/`height` SVG attrs after Mermaid renders, let CSS govern. Two-line fix in the renderer post-process step |

### 3. NEW: "Publish analysis to docs.sajivfrancis.com"

Pattern Sajiv hit repeatedly: deep chat analysis on a topic → multiple grounding rounds → synthesized whitepaper → wants to persist as a docs page, not a blog post. Distinct from voice/editorial writing.

**Loop closure:** docs.sajivfrancis.com is already ingested into chat (`docs` topic, ~160 chunks). Published analyses become future chat-grounding material on the next docs re-index. Chat → docs → chat.

**Architecture sketch:**

```
Preview modal "Publish to docs" button
  → small form: title (pre-filled), slug (auto), section (dropdown), summary (Claude-filled)
  → POST /publish-to-docs on worker
  → worker uses GitHub API with DOCS_GITHUB_TOKEN secret
  → commits markdown to sfrancis2017/docs at src/content/docs/<section>/<slug>.md
  → Starlight CI redeploys
```

**Frontmatter convention:**

```yaml
---
title: ...
description: ...
chat-published: true
published-at: 2026-05-12
chat-corpus-snapshot: <date-or-sha>
---
```

**Open decisions for next session:**

| Decision | Lean |
|---|---|
| PR vs direct commit | Direct commit (preview modal is the review gate) |
| Section placement | Dedicated `/analysis/` keeps chat-derived content separate from canonical docs |
| GitHub auth | Fine-grained PAT scoped to docs repo, stored as Worker secret `DOCS_GITHUB_TOKEN` |
| Re-ingestion trigger | Leave on existing schedule — don't add orchestration complexity for immediate availability |
| Provenance | Recorded in frontmatter only, not surfaced in rendered UI |

### Loose ends from tonight's droplet diagnostic (lower priority)

1. **`/root/ingest/ingest_core.py` has a stale hard-delete**, `/opt/retrieve/ingest_core.py` has the correct soft-delete (canonical, matches `personal-chat/scripts/ingest_core.py`). Active correctness bug for Nextcloud re-ingests. Fix: `cp /opt/retrieve/ingest_core.py /root/ingest/ingest_core.py` on droplet. Then decide if `/root/ingest/` stays as a staging area or gets collapsed.
2. **`/opt/retrieve/` is the live install** (systemd `WorkingDirectory`, runs as root). `/root/ingest/` is a sandbox where Nextcloud-specific scripts live (`nextcloud_ingest.py` is only there, log file proves it's actively running). Never sync `/root/ingest/` → `/opt/retrieve/` — that direction would clobber production with stale code (hybrid retrieval, library endpoint, public-mode filtering, soft-delete all live only in `/opt/retrieve/retrieve.py`).
3. **`/opt/retrieve/` has no git backing** — one `rm` from being unrecoverable. `personal-chat/scripts/` is the canonical Mac-side source. Long-term: explicit deploy script that rsyncs `personal-chat/scripts/` → droplet `/opt/retrieve/` and `systemctl restart retrieve`. Add to a `scripts/deploy.sh` next time the cleanup-tax feels worth paying.
4. **`DATABASE_URL` lives in `/opt/retrieve/retrieve.env`** (not `/root/ingest/retrieve.env`). Sourcing that file enables `psql "$DATABASE_URL" -f migrations/NNN.sql` for future migrations — sidesteps the `sudo -u postgres` workaround.

## Cross-repo: chat embed on main site
Main site repo is in `~/Documents/sajivfrancis.github.io-master/` (Jekyll → Astro
migration in progress). Worker CORS already whitelists the main site domain, so
backend is ready.

Open decisions:
1. Inject in Jekyll `_includes/footer.html` (live now) or wait for Astro cutover.
2. Icon, label, mobile behavior, which pages.
3. **Auth model**: chat is currently CHAT_TOKEN-gated. Embedding it on a public
   site means visitors hit the access prompt. Either accept that (gated chat),
   or add a public read-only mode to the Worker (rate-limited, possibly with
   different system prompt or smaller chunk count). This decision blocks public
   launch of the embed.

## Constraints
- Never name Sajiv's employer in any public-facing surface (system prompt
  already enforces "Fortune 50 technology company").
- `scripts/` stays untracked for now — droplet ops are local concern.

## Pre-publish state — git push is intentionally deferred
The repo has uncommitted local commits as of this writing. The plan is to
hold publication of the GitHub history until the entire pipeline is built
out (public mode + iframe embed + Google Drive ingestion + the documents
upload widget already in place), so that the first public commit reflects
a coherent, complete system rather than mid-build state.

Local-only commits to be pushed at completion:
- `72142b1` — Upload doc feature: drag-drop UI + Worker /ingest passthrough,
  token-gated visibility
- (more to follow as public mode + GDrive land)

Working-tree changes also held back: `.gitignore`, `README.md`, `CLAUDE.md`
(this file), `scripts/` directory.

When the build is complete, the order will be:
1. Stabilize all features locally
2. Generate the publishable narrative (see below)
3. Squash or curate commits as needed
4. `git push` once, with a clean history that maps to the published artifact
5. Trim this file to the operational subset (how to run the code) — the
   architectural and decision-narrative content belongs in the published
   write-up, not in CLAUDE.md long-term

## Publishing roadmap (to ship after pipeline is complete)

A two-piece deliverable on `sajivfrancis.com` + `docs.sajivfrancis.com`:

### Blog post (essay-form, narrative)
**Working title**: "Building a personal RAG: cloud, hybrid, or on-prem"
~1500–2500 words. Stratechery / Dan Luu register. Audience: technical
readers evaluating where to start with RAG. Should:
- Lead with the actual decision: which architecture archetype fits which
  use case, with honest tradeoffs
- Include real cost numbers from the pipeline that's been running
- Surface the operational realities (Worker subrequest cap, prompt-cache
  break-even math, mermaid foreignObject quirks, Anthropic's "must end
  with user message", visibility tagging on chunks)
- Have an honest "when NOT to build this" section — RAG is overkill for
  most cases; Anthropic Projects or OpenAI Assistants do the job for
  many
- Link to the docs page for the exhaustive reference

### Docs page (reference-form, exhaustive)
On `docs.sajivfrancis.com`. Components-with-alternatives reference:

| Layer | Current pick | Alternatives to evaluate |
|---|---|---|
| Frontend hosting | Cloudflare Pages | Vercel, Netlify, GitHub Pages, S3+CloudFront, self-hosted nginx |
| Edge orchestration | Cloudflare Workers | AWS Lambda, Vercel Edge, fly.io, Cloud Run, self-hosted FastAPI |
| Vector DB | Postgres + pgvector | Pinecone, Weaviate, Qdrant, Chroma, Milvus, Redis Vector |
| Embeddings | OpenAI text-embedding-3-small | Cohere, voyage-ai, BGE, instructor, all-MiniLM (local) |
| LLM | Anthropic Claude Sonnet 4.6 | OpenAI GPT-4 family, Google Gemini, local: Llama, Mistral |
| Document storage | Self-hosted Nextcloud | Google Drive, Dropbox, S3, Notion, on-prem NAS |
| Chunking | tiktoken token-based, 1000 tokens / 100 overlap | LangChain RecursiveCharacterTextSplitter, semantic chunking, parent-document |
| Retrieval | pgvector cosine top-K | BM25, hybrid (vector + keyword), MMR, Claude rerank |
| Auth | Bearer token (CHAT_TOKEN), public-mode visibility filter | OAuth2, magic links, session cookies |

### Three deployment archetypes to compare
1. **Cloud-native serverless** (the current build) — Cloudflare Pages +
   Workers + DigitalOcean droplet (Postgres + pgvector via Cloudflare
   Tunnel) + Anthropic + OpenAI APIs. Low ops burden, pay-per-use, ~$X/mo.
2. **Hybrid** — cloud frontend + cloud orchestration + on-prem GPU server
   running local Llama and pgvector. Privacy-conscious, predictable cost,
   higher ops effort. Right for regulated industries where data must
   stay in-house but the front door can be public.
3. **Pure on-prem** — Docker compose with nginx + FastAPI + Postgres +
   ollama (local LLM). Air-gapped enterprise scenarios. Highest ops
   burden, lowest variable cost, full sovereignty.

For each: cost (concrete $/mo), latency (p50 ms), privacy posture, scaling
ceiling, ops burden score.

### What to use for drafting
The synthesis pipeline already built — chat with this corpus *about its
own architecture*, then "Synthesize as Whitepaper" → preview → edit →
export. Eat your own dog food. The output IS the proof-of-craft.

### Strategic alignment
Per the main site CLAUDE.md, all publishing positions toward the O-1
evidence package and Gravitite credibility. A real shipped RAG with
public/private auth, ingestion pipeline, and synthesis exports is
distinctive evidence — most peers haven't built end-to-end. Leverage.

## Companion documents
- `RAG_SETUP.md` (gitignored): full droplet runbook with IPs, ports, recovery.
- `~/Documents/sajivfrancis.github.io-master/CLAUDE.md`: main site context.
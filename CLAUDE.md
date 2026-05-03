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

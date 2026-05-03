# scripts/ — Ingestion + retrieval ops

Server-side Python that runs on the droplet (CentOS — host details in the
gitignored `RAG_SETUP.md`).
This directory is **code only** — no secrets, no personal content. See
`.gitignore` for what's deliberately excluded.

## Files

| File | Role | Deployed location |
|---|---|---|
| `retrieve.py` | Tiny HTTP server that fronts pgvector for the Worker. Routes: `/health`, `/topics` (GET), `/retrieve` (POST). | `/root/ingest/retrieve.py` (per `retrieve.service`) |
| `nextcloud_ingest.py` | Walks the Nextcloud files directory (path from `NEXTCLOUD_ROOT` env), extracts text from md/pdf/docx/pptx/xlsx/ipynb/xml-like, chunks via tiktoken, embeds via OpenAI, inserts into `chunks` table. Writes a per-run `nextcloud-audit.md` (gitignored — lists personal file titles). | Run on droplet from `/root/ingest/` |
| `retrieve.service` | systemd unit. `EnvironmentFile=/root/ingest/retrieve.env` for secrets. | `/etc/systemd/system/retrieve.service` |

## Required environment variables

Set in `/root/ingest/retrieve.env` on the droplet (NOT in this repo):

```bash
RETRIEVE_TOKEN=<bearer secret used by Worker → retrieve API>
DATABASE_URL=postgresql://chat_user:<password>@127.0.0.1:5432/chat_db?sslmode=require
OPENAI_API_KEY=sk-...
RETRIEVE_PORT=8081           # optional, default 8081
RETRIEVE_TOP_K=6             # optional, default 6
NEXTCLOUD_ROOT=/absolute/path/to/your/nextcloud/files     # required for nextcloud_ingest.py
AUTHOR_SIGNALS=Name|handle|email-prefix|project-A|project-B  # author-detection regex
OWNER_PREFIXES=owner_,mine_                               # filename prefixes for owner content
```

## Database

Postgres 16 + pgvector on the same droplet, port 5432 local.
- DB: `chat_db`
- Table: `chunks`
- Columns: `source_url`, `source_path`, `text`, `embedding vector(1536)`, `topic`, `metadata jsonb`
- Index: ivfflat on `embedding` using cosine distance

## Deploy workflow

Edit locally → scp to droplet → restart:

```bash
scp scripts/retrieve.py root@$DROPLET_HOST:/root/ingest/retrieve.py
ssh root@$DROPLET_HOST 'systemctl restart retrieve'
ssh root@$DROPLET_HOST 'systemctl status retrieve --no-pager | head'
```

For ingestion (one-shot, not a service):

```bash
scp scripts/nextcloud_ingest.py root@$DROPLET_HOST:/root/ingest/
ssh root@$DROPLET_HOST 'cd /root/ingest && python3 nextcloud_ingest.py'
```

## What's deliberately NOT in this directory

- Secret values (in `/root/ingest/retrieve.env` on droplet, never committed)
- Generated `nextcloud-audit.md` (lists personal file names — gitignored)
- Service account JSONs for Google APIs (gitignored as `google-creds*.json` etc.)
- Any actual ingested document content

## Companion docs

- `RAG_SETUP.md` (gitignored, repo root) — full droplet runbook with IPs and recovery procedures
- `CLAUDE.md` (repo root) — architecture overview for future sessions

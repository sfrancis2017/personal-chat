"""
Shared chunking + embedding + DB insert. Used by both nextcloud_ingest.py
(filesystem walker) and retrieve.py's /ingest endpoint (upload-from-browser).

Idempotent per source_path: re-ingesting the same path replaces its prior
chunks. visibility is stashed in the metadata jsonb (no schema migration
needed); the future public/private filter will read from there.
"""
from __future__ import annotations

import json
import os
from typing import Any

import tiktoken
from openai import OpenAI

# Same tokenizer + sizing as the original nextcloud_ingest.py.
ENC = tiktoken.get_encoding("cl100k_base")
CHUNK_TOKENS = 1000      # ~750 words; well under the 8192-token embed cap
CHUNK_OVERLAP_TOK = 100
MAX_EMBED_TOKENS = 8000  # conservative ceiling (limit is 8192)

_openai_client: OpenAI | None = None


def get_openai_client() -> OpenAI:
    """Lazy singleton — only instantiate when actually called."""
    global _openai_client
    if _openai_client is None:
        _openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    return _openai_client


def clean_text(text: str) -> str:
    """Strip NUL bytes (Postgres rejects them) and normalize line endings."""
    if not text:
        return ""
    text = text.replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text


def chunk_text(text: str) -> list[str]:
    """Token-based chunking. Each chunk stays under the embed API limit."""
    text = clean_text(text)
    if not text:
        return []
    tokens = ENC.encode(text, disallowed_special=())
    out: list[str] = []
    i = 0
    step = max(1, CHUNK_TOKENS - CHUNK_OVERLAP_TOK)
    while i < len(tokens):
        slice_tokens = tokens[i:i + CHUNK_TOKENS]
        chunk = ENC.decode(slice_tokens)
        # Defensive truncation if decode somehow produced too-long text
        if len(ENC.encode(chunk, disallowed_special=())) > MAX_EMBED_TOKENS:
            chunk = ENC.decode(slice_tokens[:MAX_EMBED_TOKENS])
        chunk = chunk.strip()
        if chunk:
            out.append(chunk)
        i += step
    return out


def embed(text: str) -> list[float]:
    client = get_openai_client()
    r = client.embeddings.create(model="text-embedding-3-small", input=text)
    return r.data[0].embedding


def ingest_text(
    conn,
    text: str,
    *,
    source_path: str,
    title: str,
    topic: str,
    visibility: str = "private",
    origin: str = "upload",
    extra_metadata: dict[str, Any] | None = None,
) -> tuple[int, int]:
    """
    Chunk, embed, and insert a document's text. Idempotent per source_path.

    Returns (inserted_chunks, total_chunks). inserted may be less than total
    if some embeddings failed.

    `visibility` is stashed in metadata jsonb. When the public/private
    retrieval filter is wired up, it'll read from there.
    """
    chunks = chunk_text(text)
    if not chunks:
        return (0, 0)

    cur = conn.cursor()
    # Soft-delete: mark prior versions superseded rather than destroying them.
    # Keeps history + supports rollback. Retrieval filters WHERE valid_until IS NULL.
    cur.execute(
        "UPDATE chunks SET valid_until = NOW() "
        "WHERE source_path = %s AND valid_until IS NULL",
        (source_path,),
    )

    metadata = {
        "origin": origin,
        "title": title,
        "visibility": visibility,
        **(extra_metadata or {}),
    }

    inserted = 0
    for ch in chunks:
        try:
            emb = embed(ch)
        except Exception:
            continue
        cur.execute(
            "INSERT INTO chunks (source_url, source_path, text, embedding, metadata, topic) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (None, source_path, ch, emb, json.dumps(metadata), topic),
        )
        inserted += 1
    conn.commit()
    return (inserted, len(chunks))

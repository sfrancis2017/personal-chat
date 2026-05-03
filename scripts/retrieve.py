#!/usr/bin/env python3
"""
Tiny HTTP retrieval + ingestion API for the chat Worker.

POST /retrieve
  body: { "embedding": [..1536 floats..], "topic"|"topics": ... }
  -> { "chunks": [{ source_url, source_path, text, topic, metadata }, ...] }

GET /topics
  -> { "topics": [{ "topic": "ai-and-llms", "count": 312 }, ...] }
  Used by the frontend to populate the topic chips.

POST /ingest
  body: {
    "filename": "doc.pdf",
    "content_base64": "...",           # raw file bytes, base64-encoded
    "topic": "ai-and-llms",            # required
    "visibility": "private"|"public",  # default "private"
    "title": "optional display title"  # default = filename
  }
  -> { "ok": true, "chunks": <int>, "filename": "..." }

Auth (all routes except /health): Authorization: Bearer <RETRIEVE_TOKEN>

Runs on the droplet (next to pgvector); the Worker calls this with one
HTTP fetch per chat turn so we stay well under CF Workers' subrequest cap.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg2
import psycopg2.pool
from pgvector.psycopg2 import register_vector

import extractors
import ingest_core

PORT = int(os.environ.get("RETRIEVE_PORT", "8081"))
TOKEN = os.environ["RETRIEVE_TOKEN"]
DB_URL = os.environ["DATABASE_URL"]
TOP_K = int(os.environ.get("RETRIEVE_TOP_K", "6"))
# Hybrid retrieval: pull more candidates, fuse via RRF, MMR-diversify, top-K to LLM
HYBRID_CANDIDATES = int(os.environ.get("RETRIEVE_HYBRID_CANDIDATES", "20"))
RRF_K = int(os.environ.get("RETRIEVE_RRF_K", "60"))  # standard RRF damping
MMR_LAMBDA = float(os.environ.get("RETRIEVE_MMR_LAMBDA", "0.7"))
# Hard cap on uploaded file size (bytes after base64 decode). 25 MB by default.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
# Read cap on raw request body — base64 inflates ~33%, plus JSON overhead.
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES * 2

# Connection pool — reused across requests
POOL = psycopg2.pool.ThreadedConnectionPool(1, 5, dsn=DB_URL)


def _get_conn():
    conn = POOL.getconn()
    register_vector(conn)
    return conn


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # quieter logs — only errors via stderr
        pass

    def _json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _check_auth(self) -> bool:
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != TOKEN:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
            return

        # /topics and /library both accept an optional ?visibility=public param
        # so the same endpoint serves owner mode (full) and public mode (filtered).
        path_only, _, qs = self.path.partition("?")
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p) if qs else {}
        vis_param = params.get("visibility", "")
        vis_filter = ["public"] if vis_param == "public" else None

        if path_only == "/topics":
            if not self._check_auth():
                return
            self._handle_topics(vis_filter)
            return
        if path_only == "/library":
            if not self._check_auth():
                return
            self._handle_library(vis_filter)
            return
        self._json(404, {"error": "not found"})

    def _handle_topics(self, vis_filter):
        conn = _get_conn()
        try:
            cur = conn.cursor()
            where = ["topic IS NOT NULL", "valid_until IS NULL"]
            params: list = []
            if vis_filter:
                where.append("metadata->>'visibility' = ANY(%s)")
                params.append(vis_filter)
            cur.execute(
                f"SELECT topic, COUNT(*) AS n FROM chunks "
                f"WHERE {' AND '.join(where)} "
                f"GROUP BY topic ORDER BY n DESC",
                tuple(params),
            )
            rows = cur.fetchall()
            self._json(
                200,
                {"topics": [{"topic": r[0], "count": r[1]} for r in rows]},
            )
        except Exception as e:
            self._json(500, {"error": f"db: {e}"})
        finally:
            POOL.putconn(conn)

    def _handle_library(self, vis_filter):
        """Aggregated catalog: topic → sources within. Used by sidebar Library panel."""
        conn = _get_conn()
        try:
            cur = conn.cursor()
            where = ["valid_until IS NULL", "topic IS NOT NULL"]
            params: list = []
            if vis_filter:
                where.append("metadata->>'visibility' = ANY(%s)")
                params.append(vis_filter)
            cur.execute(
                f"""
                SELECT topic,
                       source_path,
                       COALESCE(metadata->>'title', source_path) AS title,
                       metadata->>'visibility' AS visibility,
                       COUNT(*) AS chunk_count
                FROM chunks
                WHERE {' AND '.join(where)}
                GROUP BY topic, source_path, metadata->>'title', metadata->>'visibility'
                ORDER BY topic, chunk_count DESC
                """,
                tuple(params),
            )
            rows = cur.fetchall()
            # Group into nested topic -> sources
            by_topic: dict[str, dict] = {}
            for topic, source_path, title, visibility, count in rows:
                t = by_topic.setdefault(topic, {"topic": topic, "count": 0, "sources": []})
                t["count"] += count
                t["sources"].append({
                    "source_path": source_path,
                    "title": title,
                    "visibility": visibility,
                    "chunks": count,
                })
            topics_list = sorted(by_topic.values(), key=lambda t: t["count"], reverse=True)
            total_chunks = sum(t["count"] for t in topics_list)
            self._json(200, {"topics": topics_list, "total_chunks": total_chunks})
        except Exception as e:
            self._json(500, {"error": f"db: {e}"})
        finally:
            POOL.putconn(conn)

    def do_POST(self):
        if self.path == "/ingest":
            self._handle_ingest()
            return
        if self.path != "/retrieve":
            self._json(404, {"error": "not found"})
            return

        if not self._check_auth():
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw)
        except Exception:
            self._json(400, {"error": "invalid json"})
            return

        embedding = body.get("embedding")
        if not isinstance(embedding, list) or len(embedding) != 1536:
            self._json(400, {"error": "embedding must be 1536 floats"})
            return

        # Topic filter (multi-OR). Legacy single-string "topic" still accepted.
        raw_topics = body.get("topics")
        topic_filter: list[str] = []
        if isinstance(raw_topics, list):
            topic_filter = [t for t in raw_topics if isinstance(t, str) and t.strip()]
        elif isinstance(body.get("topic"), str) and body["topic"].strip():
            topic_filter = [body["topic"].strip()]

        # Visibility filter — public mode passes ['public']; owner mode passes None (no filter).
        raw_vis = body.get("visibility")
        vis_filter: list[str] | None = None
        if isinstance(raw_vis, list):
            vis_filter = [v for v in raw_vis if isinstance(v, str) and v in ("public", "private")]
            if not vis_filter:
                vis_filter = None

        # Optional hint: the original query text (for sparse retrieval + log)
        query_text: str = body.get("query") if isinstance(body.get("query"), str) else ""
        hyde_text: str = body.get("hyde_text") if isinstance(body.get("hyde_text"), str) else ""
        # Mode + client_hash are passed through for logging; opaque to the retrieve API itself
        mode: str = body.get("mode") if isinstance(body.get("mode"), str) else "owner"
        client_hash: str | None = body.get("client_hash") if isinstance(body.get("client_hash"), str) else None

        t_start = time.time()
        conn = _get_conn()
        try:
            chunks, score_map = _hybrid_retrieve(
                conn, embedding, query_text, topic_filter, vis_filter
            )
            # MMR diversification on the fused candidate set
            chunks = _mmr_select(chunks, embedding, k=TOP_K, lam=MMR_LAMBDA)
            payload_chunks = [
                {
                    "source_url": c["source_url"],
                    "source_path": c["source_path"],
                    "text": c["text"],
                    "topic": c["topic"],
                    "metadata": c["metadata"],
                }
                for c in chunks
            ]
            self._json(200, {"chunks": payload_chunks})

            # Fire-and-forget query log (don't fail the response if logging fails)
            try:
                _log_query(
                    conn,
                    query=query_text,
                    hyde_text=hyde_text,
                    chunks=chunks,
                    score_map=score_map,
                    latency_ms=int((time.time() - t_start) * 1000),
                    mode=mode,
                    visibility=vis_filter,
                    topics=topic_filter or None,
                    client_hash=client_hash,
                )
            except Exception as e:
                print(f"[query log] {e}", flush=True)
        except Exception as e:
            self._json(500, {"error": f"db: {e}"})
        finally:
            POOL.putconn(conn)


def _vec_literal(embedding: list[float]) -> str:
    return "[" + ",".join(str(float(x)) for x in embedding) + "]"


def _hybrid_retrieve(
    conn,
    embedding: list[float],
    query_text: str,
    topic_filter: list[str],
    vis_filter: list[str] | None,
) -> tuple[list[dict], dict]:
    """
    Hybrid retrieval: dense (pgvector cosine) ∪ sparse (Postgres FTS),
    fused via Reciprocal Rank Fusion (RRF).

    Returns (candidates, score_map) where:
      candidates: list of dict rows (source_url, source_path, text, topic,
                  metadata, embedding) up to HYBRID_CANDIDATES, ordered by
                  fused score descending
      score_map:  source_path -> {fused, dense_rank, sparse_rank} for logging
    """
    cur = conn.cursor()
    vec = _vec_literal(embedding)

    # WHERE clause shared by both halves: active chunks, topic filter, visibility filter
    base_where = ["valid_until IS NULL"]
    base_params: list = []
    if topic_filter:
        base_where.append("topic = ANY(%s)")
        base_params.append(topic_filter)
    if vis_filter:
        base_where.append("metadata->>'visibility' = ANY(%s)")
        base_params.append(vis_filter)
    where_sql = " AND ".join(base_where)

    # Dense half — vector cosine similarity
    cur.execute(
        f"""
        SELECT source_url, source_path, text, topic, metadata, embedding
        FROM chunks
        WHERE {where_sql}
        ORDER BY embedding <=> %s::vector
        LIMIT %s
        """,
        (*base_params, vec, HYBRID_CANDIDATES),
    )
    dense_rows = cur.fetchall()

    # Sparse half — Postgres FTS on the generated text_tsv column.
    # plainto_tsquery handles the user query string defensively (strips operators).
    sparse_rows: list[tuple] = []
    if query_text and query_text.strip():
        cur.execute(
            f"""
            SELECT source_url, source_path, text, topic, metadata, embedding
            FROM chunks
            WHERE {where_sql}
              AND text_tsv @@ plainto_tsquery('english', %s)
            ORDER BY ts_rank(text_tsv, plainto_tsquery('english', %s)) DESC
            LIMIT %s
            """,
            (*base_params, query_text, query_text, HYBRID_CANDIDATES),
        )
        sparse_rows = cur.fetchall()

    # Reciprocal Rank Fusion: score(doc) = Σ over each list of 1 / (k + rank)
    fused: dict[str, float] = {}
    dense_rank: dict[str, int] = {}
    sparse_rank: dict[str, int] = {}
    by_path: dict[str, dict] = {}

    def _ingest_list(rows, rank_dict):
        for rank, r in enumerate(rows, start=1):
            path = r[1]  # source_path is unique enough as a key (per-source ranking)
            rank_dict.setdefault(path, rank)
            fused[path] = fused.get(path, 0.0) + 1.0 / (RRF_K + rank)
            if path not in by_path:
                by_path[path] = {
                    "source_url": r[0],
                    "source_path": r[1],
                    "text": r[2],
                    "topic": r[3],
                    "metadata": r[4],
                    "embedding": r[5],
                }

    _ingest_list(dense_rows, dense_rank)
    _ingest_list(sparse_rows, sparse_rank)

    # Score map for logging — small, JSON-friendly
    score_map = {
        path: {
            "fused": round(fused[path], 6),
            "dense_rank": dense_rank.get(path),
            "sparse_rank": sparse_rank.get(path),
        }
        for path in fused
    }

    # Sort by fused score, return top HYBRID_CANDIDATES
    ordered_paths = sorted(fused, key=lambda p: fused[p], reverse=True)[:HYBRID_CANDIDATES]
    candidates = [by_path[p] for p in ordered_paths]
    return candidates, score_map


def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity between two equal-length vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _mmr_select(
    candidates: list[dict],
    query_embedding: list[float],
    k: int,
    lam: float,
) -> list[dict]:
    """
    Maximal Marginal Relevance: pick k items balancing relevance to query
    and diversity from already-picked items.
        score(c) = λ · sim(c, q) − (1−λ) · max_sim(c, picked)
    """
    if not candidates:
        return []
    if k >= len(candidates):
        return candidates

    # Pre-compute relevance to query for each candidate
    rel = [_cosine(c.get("embedding") or [], query_embedding) for c in candidates]
    selected_idx: list[int] = []
    remaining = set(range(len(candidates)))

    # Greedy: first pick is the most relevant
    first = max(remaining, key=lambda i: rel[i])
    selected_idx.append(first)
    remaining.discard(first)

    while len(selected_idx) < k and remaining:
        def mmr_score(i: int) -> float:
            max_sim_to_picked = max(
                _cosine(candidates[i].get("embedding") or [],
                        candidates[j].get("embedding") or [])
                for j in selected_idx
            )
            return lam * rel[i] - (1 - lam) * max_sim_to_picked

        nxt = max(remaining, key=mmr_score)
        selected_idx.append(nxt)
        remaining.discard(nxt)

    return [candidates[i] for i in selected_idx]


def _log_query(
    conn,
    *,
    query: str,
    hyde_text: str,
    chunks: list[dict],
    score_map: dict,
    latency_ms: int,
    mode: str,
    visibility: list[str] | None,
    topics: list[str] | None,
    client_hash: str | None,
) -> None:
    """Insert into rag_query_log. Failures swallowed by the caller."""
    retrieved_audit = [
        {
            "source_path": c["source_path"],
            "topic": c["topic"],
            **score_map.get(c["source_path"], {}),
        }
        for c in chunks
    ]
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO rag_query_log
          (query, hyde_text, retrieved, latency_ms, mode, visibility, topics, client_hash)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            query[:2000] if query else None,
            hyde_text[:2000] if hyde_text else None,
            json.dumps(retrieved_audit),
            latency_ms,
            mode,
            visibility,
            topics,
            client_hash,
        ),
    )
    conn.commit()


def _safe_basename(name: str) -> str:
    """Strip path components and dangerous characters from an upload filename."""
    name = Path(name).name  # drops any directory components
    # Keep alphanumerics, dot, dash, underscore, space; replace the rest with _
    name = re.sub(r"[^A-Za-z0-9._\- ]", "_", name)
    return name.strip() or "upload"


# Patch ingest handler onto Handler (defined after class so we can reference module-level helpers cleanly)
def _handle_ingest(self) -> None:
    if not self._check_auth():
        return
    try:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            self._json(400, {"error": "empty body"})
            return
        if length > MAX_REQUEST_BYTES:
            self._json(413, {"error": f"request too large (limit {MAX_REQUEST_BYTES} bytes)"})
            return
        raw = self.rfile.read(length)
        body = json.loads(raw)
    except Exception:
        self._json(400, {"error": "invalid json"})
        return

    filename = body.get("filename")
    content_b64 = body.get("content_base64")
    topic = body.get("topic")
    visibility = body.get("visibility", "private")
    title = body.get("title")

    if not isinstance(filename, str) or not filename.strip():
        self._json(400, {"error": "filename required"})
        return
    if not isinstance(content_b64, str) or not content_b64:
        self._json(400, {"error": "content_base64 required"})
        return
    if not isinstance(topic, str) or not topic.strip():
        self._json(400, {"error": "topic required"})
        return
    if visibility not in ("private", "public"):
        self._json(400, {"error": "visibility must be 'private' or 'public'"})
        return

    safe_name = _safe_basename(filename)
    ext = Path(safe_name).suffix.lower()
    if ext not in extractors.EXTRACTABLE:
        self._json(400, {"error": f"unsupported file type: {ext or '(none)'}"})
        return

    try:
        content = base64.b64decode(content_b64, validate=True)
    except Exception:
        self._json(400, {"error": "content_base64 is not valid base64"})
        return
    if len(content) > MAX_UPLOAD_BYTES:
        self._json(413, {"error": f"file too large: {len(content)} bytes (limit {MAX_UPLOAD_BYTES})"})
        return
    if len(content) < 50:
        self._json(400, {"error": "file too small / empty"})
        return

    try:
        text = extractors.extract(content, safe_name)
    except Exception as e:
        self._json(500, {"error": f"extract failed: {e}"})
        return
    if not text or len(text) < 50:
        self._json(400, {"error": "no extractable text in file"})
        return

    # source_path tagged with the upload origin so it doesn't collide with
    # filesystem-walked paths from nextcloud_ingest.
    source_path = f"upload/{safe_name}"
    display_title = title.strip() if isinstance(title, str) and title.strip() else safe_name
    topic_clean = re.sub(r"[^a-zA-Z0-9]+", "-", topic).strip("-").lower() or "uploads"

    conn = _get_conn()
    try:
        inserted, total = ingest_core.ingest_text(
            conn,
            text,
            source_path=source_path,
            title=display_title,
            topic=topic_clean,
            visibility=visibility,
            origin="upload",
        )
    except Exception as e:
        self._json(500, {"error": f"ingest failed: {e}"})
        return
    finally:
        POOL.putconn(conn)

    self._json(
        200,
        {
            "ok": True,
            "filename": safe_name,
            "topic": topic_clean,
            "visibility": visibility,
            "chunks": inserted,
            "chunks_attempted": total,
        },
    )


# Bind the handler method to the class
Handler._handle_ingest = _handle_ingest  # type: ignore[attr-defined]


def main():
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"retrieve API listening on 0.0.0.0:{PORT}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

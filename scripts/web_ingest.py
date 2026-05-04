#!/usr/bin/env python3
"""
Ingest a public website (sitemap or URL list) into the chunks table.
Tags chunks with visibility='public' so they're served by public-mode chat.

Usage:
    # docs.sajivfrancis.com via sitemap
    python3 web_ingest.py --sitemap https://docs.sajivfrancis.com/sitemap-index.xml --topic docs

    # sajivfrancis.com (main blog) via sitemap
    python3 web_ingest.py --sitemap https://sajivfrancis.com/sitemap.xml --topic writing

    # Curated URL list (one per line, blank lines + # comments OK)
    python3 web_ingest.py --urls blog_urls.txt --topic writing

    # Sanity-test with a small slice first
    python3 web_ingest.py --sitemap https://sajivfrancis.com/sitemap.xml --topic writing --limit 5

Idempotent per URL — re-running replaces prior chunks (soft-delete via
ingest_core.ingest_text). Source paths use the full URL as the canonical
key so web-ingested chunks don't collide with Nextcloud filesystem paths.

Required env vars (already in /opt/retrieve/retrieve.env on droplet):
    OPENAI_API_KEY
    DATABASE_URL
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from urllib.parse import urlparse

import psycopg2
import requests
from bs4 import BeautifulSoup
from pgvector.psycopg2 import register_vector

import ingest_core


# ---- URL discovery -------------------------------------------------------


def urls_from_sitemap(sitemap_url: str, _depth: int = 0) -> list[str]:
    """Recursively walk sitemap-index files down to actual page URLs."""
    if _depth > 3:
        print(f"  sitemap recursion depth limit at {sitemap_url}", file=sys.stderr)
        return []
    r = requests.get(sitemap_url, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "xml")
    # sitemap-index points at child sitemaps; sitemap points at urls
    if soup.find_all("sitemap"):
        urls: list[str] = []
        for sm in soup.find_all("sitemap"):
            loc = sm.find("loc")
            if loc and loc.text:
                urls.extend(urls_from_sitemap(loc.text.strip(), _depth + 1))
        return urls
    return [
        u.find("loc").text.strip()
        for u in soup.find_all("url")
        if u.find("loc") and u.find("loc").text
    ]


def urls_from_file(path: str) -> list[str]:
    """One URL per line. Blank lines and lines starting with # are ignored."""
    with open(path) as f:
        return [
            line.strip()
            for line in f
            if line.strip() and not line.lstrip().startswith("#")
        ]


# ---- Page fetch + extract -----------------------------------------------


def fetch_page(url: str) -> tuple[str, str]:
    """
    Return (title, text). Strips nav, footer, scripts, etc. so only the
    meaningful page content gets indexed.
    Returns ('', '') on any failure.
    """
    try:
        r = requests.get(url, timeout=15, headers={
            "User-Agent": "sajivfrancis-rag-ingest/1.0",
        })
        r.raise_for_status()
    except Exception as e:
        print(f"  fetch failed: {e}", file=sys.stderr)
        return "", ""

    soup = BeautifulSoup(r.text, "html.parser")
    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    if not title:
        title = url

    # Prefer the main article/main element; fall back to body.
    main = soup.find("article") or soup.find("main") or soup.find("body")
    if not main:
        return title, ""

    # Strip chrome that doesn't belong in the index
    for tag in main.find_all([
        "script", "style", "nav", "header", "footer", "aside",
        "noscript", "iframe", "form",
    ]):
        tag.decompose()

    text = main.get_text(separator="\n", strip=True)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return title, text


# ---- Main ----------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest a public website into pgvector.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--sitemap", help="Sitemap or sitemap-index URL")
    src.add_argument("--urls", help="File with one URL per line")
    ap.add_argument("--topic", required=True, help="Topic slug, e.g. 'docs' or 'writing'")
    ap.add_argument(
        "--visibility",
        default="public",
        choices=["public", "private"],
        help="Defaults to public. Override only with reason.",
    )
    ap.add_argument("--limit", type=int, help="Cap on URLs processed (debug)")
    ap.add_argument("--dry-run", action="store_true", help="List URLs, don't ingest")
    args = ap.parse_args()

    # Discover URLs
    if args.sitemap:
        print(f"Walking sitemap {args.sitemap} ...")
        urls = urls_from_sitemap(args.sitemap)
    else:
        urls = urls_from_file(args.urls)

    if args.limit:
        urls = urls[: args.limit]

    if not urls:
        print("No URLs discovered. Nothing to do.", file=sys.stderr)
        return 1

    print(f"Found {len(urls)} URLs. topic={args.topic} visibility={args.visibility}")
    if args.dry_run:
        for u in urls:
            print(f"  {u}")
        return 0

    # DB connection (same env vars as retrieve.py)
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    register_vector(conn)

    successes = 0
    failures = 0
    skipped = 0
    total_chunks = 0

    for i, url in enumerate(urls, 1):
        try:
            title, text = fetch_page(url)
            if not text or len(text) < 100:
                print(f"[{i}/{len(urls)}] {url}  skip (text too short or empty)")
                skipped += 1
                continue
            host = urlparse(url).netloc or "web"
            inserted, total = ingest_core.ingest_text(
                conn,
                text,
                source_path=url,            # full URL as canonical key
                title=title,
                topic=args.topic,
                visibility=args.visibility,
                origin="web",
                extra_metadata={"source_host": host},
            )
            total_chunks += inserted
            print(f"[{i}/{len(urls)}] {url}  {inserted}/{total} chunks  [{title[:60]}]")
            successes += 1
        except Exception as e:
            print(f"[{i}/{len(urls)}] {url}  ERROR: {e}", file=sys.stderr)
            failures += 1
        # Gentle rate limit on the source site + OpenAI
        time.sleep(0.1)

    conn.close()
    print()
    print(
        f"Done. ingested={successes} skipped={skipped} failed={failures}  "
        f"chunks={total_chunks}  topic={args.topic}  visibility={args.visibility}"
    )
    return 0 if failures == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

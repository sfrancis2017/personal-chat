# About this chat

This is a personal RAG (retrieval-augmented generation) chat assistant for
Sajiv Francis's published work. Ask questions about his writing, his
architecture documentation, or his thinking on enterprise AI — and the
assistant answers from the actual source material, with citations.

## What's in the corpus

Public mode (no access token — anyone can use this) draws from two sources:

- **Writing** — blog posts and essays from
  [sajivfrancis.com/blog](https://sajivfrancis.com/blog/). Topics include AI,
  retrieval-augmented generation, document intelligence, SAP product
  experience, BPMN modeling, project showcases, and architecture commentary.
- **Docs** — the structured knowledge base at
  [docs.sajivfrancis.com](https://docs.sajivfrancis.com/), organized into
  hierarchical reference categories: AI (agents and tools, document
  intelligence, foundation models, prompt engineering, RAG and retrieval),
  architecture (cloud architecture, decisions, enterprise architecture,
  solution architecture), reference (SAP accounting standards, SAP central
  finance, SAP ERP/S4HANA modules including ABAP, asset accounting,
  banking, controlling, CO-PA, data migration, finance, integration,
  inventory, materials management, product costing, production planning,
  SD, taxation, testing, SAP Fiori, SAP FSCM treasury and risk, SAP
  installation across cloud providers, SAP notes, and SAP S/4 CDS views),
  and software engineering (backend, devops, frontend, testing).

Owner mode (token-gated, Sajiv's own use) additionally draws from a
private corpus of reference books, internal notes, drafts, and work
materials. Public visitors do not see this content.

## What kinds of questions get good answers

Specific, technical, source-grounded questions work best. Examples:

- "What does Sajiv argue went right and wrong with Optey?"
- "How does CO-PA reconcile with the General Ledger in S/4HANA?"
- "What's in his BPMN modeling notes on naming conventions?"
- "Compare account-based and costing-based CO-PA from his docs."
- "What does he say about RAG architecture decisions?"
- "Generate a Mermaid diagram for SAP product costing flow grounded in his
  notes."

Broad meta questions — "tell me everything about X" — get partial answers
because retrieval surfaces the few most relevant chunks per query, not the
whole topic. Use the topic chips above the composer to scope retrieval to
a specific area, or ask follow-ups to drill in.

## How to use the topic chips

The chips above the composer let you constrain retrieval to specific
topics: select `docs` to query only the structured documentation, `writing`
for blog posts, or combine multiple. With no chips selected, retrieval
spans the entire public corpus.

## How to use this chat

Anyone can ask questions — no sign-in required for public mode. Owner
features (corpus upload, response synthesis exports, multi-skill modes,
chat history sidebar) are gated behind an access token and remain hidden
to public visitors. Public mode is rate-limited to a small number of
messages per minute to keep the surface stable for everyone.

## What this chat is not

It is not a generic assistant — questions outside Sajiv's published work
get redirected. It does not browse the web in real time; answers reflect
content as of the last ingestion. It does not store identifying
information about visitors beyond a hashed rate-limit counter.

## Where to read more

The source surfaces are linked above. For an overview of how the chat
itself is built, see Sajiv's blog post on building a personal RAG (when
that publishes). For everything else, the writing and docs are the
authoritative reference — this chat is a search and synthesis tool over
them, not a replacement.

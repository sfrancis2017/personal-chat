/**
 * Personal RAG chat — Cloudflare Worker.
 *
 * Embeds the user's query via OpenAI, sends the embedding to a small
 * HTTP retrieval API on the DO droplet, then streams a grounded Claude
 * response. The droplet's API does the actual pgvector query — keeping
 * the Worker's subrequest count at 3 (embed + retrieve + Anthropic).
 */

interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_HAIKU_MODEL?: string;          // For HyDE; defaults to a small model
  ALLOWED_ORIGINS: string;
  CHAT_TOKEN: string;
  OPENAI_API_KEY: string;
  RETRIEVE_URL: string;
  RETRIEVE_TOKEN: string;
  // Optional KV binding for rate-limit counters (public mode only)
  RATE_LIMIT_KV?: KVNamespace;
  // Optional KV binding for synthesized artifacts (whitepaper/slides/email
  // bundles produced from the chat surface). Owner-only — work tools read via
  // GET /api/artifacts, /api/artifacts/:id. If unbound, artifact endpoints
  // return 503 so the rest of the worker still runs.
  ARTIFACTS_KV?: KVNamespace;
}

// Constant-time string comparison to avoid timing attacks on token check
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

type AuthMode = 'owner' | 'public';

/**
 * Check the request's bearer against CHAT_TOKEN.
 *  - Valid token -> owner mode (full corpus, all features)
 *  - Missing or invalid token -> public mode (visibility=public, rate-limited)
 */
function classifyAuth(req: Request, env: Env): AuthMode {
  const auth = req.headers.get('Authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return 'public';
  return timingSafeEqual(match[1], env.CHAT_TOKEN) ? 'owner' : 'public';
}

// Legacy callers that still want a strict yes/no
function isAuthorized(req: Request, env: Env): boolean {
  return classifyAuth(req, env) === 'owner';
}

// Stable, one-way client identifier for query logging — never store raw tokens or IPs.
async function clientHash(req: Request, env: Env, mode: AuthMode): Promise<string> {
  const source =
    mode === 'owner'
      ? (req.headers.get('Authorization') ?? '')
      : (req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Forwarded-For') ?? 'anon');
  const data = new TextEncoder().encode(`${mode}:${source}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ---- Rate limit (public mode only) ---------------------------------------

const PUBLIC_LIMIT_PER_MIN = 5;
const PUBLIC_LIMIT_PER_DAY = 30;

interface RateLimitResult {
  ok: boolean;
  reason?: 'minute' | 'day' | 'kv-missing';
  retryAfterSeconds?: number;
}

/**
 * KV-backed sliding window. Two counters per IP: one minute, one day.
 * If RATE_LIMIT_KV isn't bound, public requests pass (fail-open) — owner
 * mode is unaffected. We log this so it's noisy in dev.
 */
async function rateLimitPublic(req: Request, env: Env): Promise<RateLimitResult> {
  if (!env.RATE_LIMIT_KV) {
    console.warn('RATE_LIMIT_KV not bound — public requests are not rate-limited');
    return { ok: true, reason: 'kv-missing' };
  }
  const ip = req.headers.get('CF-Connecting-IP') ?? 'anon';
  const minuteKey = `rl:m:${ip}:${Math.floor(Date.now() / 60000)}`;
  const dayKey = `rl:d:${ip}:${Math.floor(Date.now() / 86400000)}`;
  const [mRaw, dRaw] = await Promise.all([
    env.RATE_LIMIT_KV.get(minuteKey),
    env.RATE_LIMIT_KV.get(dayKey),
  ]);
  const m = mRaw ? Number(mRaw) : 0;
  const d = dRaw ? Number(dRaw) : 0;
  if (m >= PUBLIC_LIMIT_PER_MIN) {
    return { ok: false, reason: 'minute', retryAfterSeconds: 60 };
  }
  if (d >= PUBLIC_LIMIT_PER_DAY) {
    return { ok: false, reason: 'day', retryAfterSeconds: 86400 };
  }
  await Promise.all([
    env.RATE_LIMIT_KV.put(minuteKey, String(m + 1), { expirationTtl: 70 }),
    env.RATE_LIMIT_KV.put(dayKey, String(d + 1), { expirationTtl: 86500 }),
  ]);
  return { ok: true };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  topics?: string[];
  skill?: string;
  /**
   * Source-path filter — restricts retrieval to chunks from these specific
   * sources (documents/files). Combines additively with `topics`. Useful
   * for "make sure Claude grounds in *these* documents specifically."
   */
  source_paths?: string[];
  /**
   * High-confidence mode (owner-only by client convention). When true:
   *   - Retrieval pulls a wider candidate set (HYBRID_CANDIDATES bumped to 30, top_K to 15)
   *   - System prompt overlay enforces strict citation per claim, encourages
   *     "I don't have evidence for X" over confident-but-wrong assertions
   *   - Post-generation verification pass runs against the cited chunks
   * Trade-off: slower + costlier per turn. Use for work-grade output.
   */
  confidence_mode?: boolean;
  /**
   * 'chat' (default): normal RAG chat turn.
   * 'synthesize-whitepaper': synthesize the conversation into a polished whitepaper
   *   markdown. Skips RAG retrieval (the chat is the source).
   * 'synthesize-slides': synthesize into slide-deck markdown (--- separated).
   * 'synthesize-email': synthesize into a BLUF-format executive email markdown
   *   (short cover note, verdict-up-front, ~300-500 words). Skips RAG retrieval.
   */
  mode?: 'chat' | 'synthesize-whitepaper' | 'synthesize-slides' | 'synthesize-email';
}

// Synthesis system prompts — used when mode !== 'chat'. They override the
// normal RAG-chat system prompt and consume the conversation history as the
// source of truth, dropping iterative back-and-forth.
const SYNTHESIS_PROMPTS: Record<string, string> = {
  'synthesize-whitepaper': `You are converting a conversation between Sajiv Francis and his assistant into a polished whitepaper for a professional audience (peers, stakeholders, clients).

Rules:
1. Drop iterative back-and-forth ("make it clearer", "add another node", regeneration requests, etc.). Keep only the refined final content.
2. Structure as: title → byline (e.g. "By Sajiv Francis · [Month YYYY]") → executive summary → context → analysis → recommendation/conclusion → sources consulted.
3. Use ## and ### headings. Use comparison tables where they clarify.
4. Embed Mermaid diagrams from the chat verbatim in \`\`\`mermaid fences. Don't redraw them — copy the source. **Smart-patch rule:** if a chat diagram is missing the diagram type declaration on its first line (i.e. starts directly with \`classDef\` or with a node like \`A["..."]\` instead of with \`flowchart TD\` / \`flowchart LR\` / etc.), PREPEND the appropriate diagram type as the new first line. Use \`flowchart TD\` for top-down process flows, \`flowchart LR\` for left-right pipelines, \`sequenceDiagram\` / \`classDiagram\` where the syntax indicates them. This is a fix, not a rewrite — everything else stays verbatim. Without the type declaration on line 1, Mermaid v10+ refuses to render with "No diagram type detected". For any fresh diagram you produce, use \`<br>\` (NOT \`\\n\`) for line breaks in node and edge labels.
5. Match the Stratechery / Dan Luu register: direct, lightly editorial, no hedging, no "happy to help."
6. **Citations**: Do NOT use inline citations like *(BookName — topic)* or footnote markers. Instead, end the document with a brief **Sources consulted** section listing the reference materials drawn from — book titles and authors only, NOT file paths, chunk identifiers, or topic slugs. For content drawn from Sajiv's own writing in the corpus, no citation is needed (it's his own work). If no third-party reference materials were used, omit the Sources consulted section entirely.
7. Don't pad. Aim for 600–1500 words depending on chat depth.
8. Speak about Sajiv in the third person. Never name his employer — use "a Fortune 50 technology company."
9. The output is markdown only. Start with the title (# Title) on the first line, byline directly below.`,
  'synthesize-slides': `You are converting a conversation between Sajiv Francis and his assistant into a slide-deck markdown for presentation.

Rules:
1. Drop iterative back-and-forth. Keep only the refined final content.
2. Use \`---\` on its own line to separate slides.
3. Slide 1 (title slide): \`# Title\`, then a subtitle line "By Sajiv Francis · [Month YYYY]". No other content.
4. Body slides: \`# Section title\`, then 3–5 concise bullet points (max ~10 words per bullet).
5. Diagram slides: \`# Heading\` followed immediately by the Mermaid diagram in a \`\`\`mermaid fence. No bullet text on diagram slides. **Every Mermaid diagram MUST start with the diagram type on its first line** (\`flowchart TD\`, \`flowchart LR\`, \`sequenceDiagram\`, etc.) — \`classDef\` and node definitions come after. Without the type on line 1, Mermaid v10+ refuses to render. For multi-line node and edge labels, use \`<br>\` (NOT \`\\n\`) — e.g. \`A["Plant A<br>Defective Stock"]\`. The \`\\n\` syntax causes parse errors at render time.
6. Conclusion slide: \`# Key takeaways\` with 2–3 bullets.
7. **Do NOT use inline citations.** If third-party reference materials (books, papers, etc.) were drawn from, add a final \`# Sources consulted\` slide listing book titles and authors only — no file paths, chunk identifiers, or topic slugs. For content from Sajiv's own writing, no citation is needed. If no third-party references were used, omit the Sources slide.
8. 5–10 slides total. No fluff.
9. Speak about Sajiv in the third person. Never name his employer — use "a Fortune 50 technology company."
10. The output is markdown only. Start with the title slide.`,
  'synthesize-email': `You are converting a conversation between Sajiv Francis and his assistant into a BLUF-format (Bottom Line Up Front) executive email — a concise cover note that delivers the verdict in the first line. The source whitepaper (or chat thread) carries the depth; the email's job is to give an executive recipient the decision in their first 30 seconds of reading.

Rules:
1. Drop iterative back-and-forth ("make it clearer", regeneration requests, etc.). Keep only the refined final content.
2. **The H1 title MUST be a verdict-style statement of the recommendation itself, not a topic description.** Example: "Default to sub-contracting STO for plant-to-plant rework on S/4HANA + EWM" — NOT "Plant-to-plant rework scenarios in SAP S/4HANA". The H1 is the subject line; it carries the call.
3. Structure exactly as follows (use these H2 headings in this order, do not rename them):
   \`\`\`
   # <Verdict-style title>
   By Sajiv Francis · [Month YYYY or YYYY-MM-DD]
   **Source:** <Whitepaper title or chat topic — if known>

   ---

   ## Bottom Line
   <1–2 sentences delivering the recommendation immediately. No setup, no preamble.>

   ## Why
   <One short paragraph (2–4 sentences) supporting the recommendation.>

   ## When to Choose Otherwise
   <Bulleted list of scenarios where the default does NOT apply. Use bold inline labels: "**Scenario X (short descriptor)** — when this applies and why".>

   ## Key Operational Notes
   <3–5 bullets of must-know specifics: critical settings, gotchas, sequencing, dependencies. Bold inline labels for scannability.>

   ## Full Analysis
   <1–2 sentences pointing to the source whitepaper for depth — what it covers that the email omits.>
   \`\`\`
4. **Commit to a recommendation.** If the source content is genuinely exploratory with no clear winner, the Bottom Line should explicitly state "no universal default exists" followed by the 2–3 decision questions that determine the right choice. Never produce a wishy-washy "it depends" without explicit decision questions.
5. Bold inline labels in bullets where they improve scan-ability (e.g. "**Two-step movement (303/305)** — explicit stock-in-transit period gives the receiving plant visibility before cost obligation triggers.").
6. Match the Stratechery / Dan Luu register: direct, lightly editorial, no hedging, no marketing language, no "happy to help."
7. **Length:** 300–500 words of body content (excluding title, byline, source line, and section headings). Hard ceiling: 600 words. Tighter is better — this is an executive distillation, not a summary.
8. Speak about Sajiv in the third person. Never name his employer — use "a Fortune 50 technology company."
9. **Citations:** No inline citations. No "Sources consulted" section — citations belong in the source whitepaper, not the email.
10. **Mermaid diagrams:** Most BLUF emails should NOT have diagrams. Only include one if the recommendation genuinely benefits from a visual schematic. If you do include one, it MUST start with the diagram type on line 1 (\`flowchart TD\` etc.), with \`<br>\` (NOT \`\\n\`) for line breaks in node labels.
11. The output is markdown only. Start with the H1 title on the first line. No preamble, no "Here is your email."`,
};

// Skill modes — server-side overlays appended to the system prompt.
// Keep the set small and high-signal for EA / software engineering use.
// High-confidence mode overlay — appended to the base system prompt when the
// client sets `confidence_mode: true`. Reverses the default "no hedging"
// register because for work-grade output, refusing to answer is better than
// confidently asserting something the context doesn't support.
const CONFIDENCE_MODE_OVERLAY = `

---

HIGH-CONFIDENCE MODE ACTIVE — STRICT GROUNDING RULES

This response will be reviewed for accuracy and used in a professional setting where hallucinations carry credibility risk. Override your default "direct, no hedging" register with these stricter rules:

1. **Cite every specific claim inline.** Every numerical figure, named entity, specific date, technical detail, quote, or framework name MUST be followed by an italicized source citation, e.g., *(LLM_governance_strategy.md)*. If you cannot cite a specific claim to a chunk in the <context> block, do not make the claim. Rewrite or omit.

2. **Refuse over assert.** When the retrieved context is thin or ambiguous on a specific point, write "The available context does not establish X — I'd suggest verifying against [specific document name]" rather than producing a confident answer. Hedging is the correct register when evidence is thin.

3. **Distinguish facts from synthesis.** Facts directly stated in the chunks get inline citations. Inferences or syntheses combining multiple chunks must be marked: e.g., "Combining these two sources suggests... *(Source A + Source B)*". Do not present synthesis as fact.

4. **No external knowledge.** Do not use general background knowledge from your training to fill gaps in the context. If a topic isn't covered in the chunks, say so explicitly: "The provided context doesn't cover X."

5. **End with a verification checklist.** After the main response, add a final section titled "## Verification checklist" listing every specific claim you made and which source chunk grounds it. Use this format:
   - "Claim text" — grounded in *(SourceFile.md)*
   - "Claim text" — INFERRED from two chunks *(SourceA.md + SourceB.md)*
   - "Claim text" — UNGROUNDED, please verify

This trades brevity for credibility. The reader will use this to spot-check the response before sharing.`;

const SKILLS: Record<string, string> = {
  'architecture-review': `Mode: Architecture Review. Critique the design end-to-end. Structure every response as:
1. Assumptions you're surfacing (what the user implicitly assumed)
2. Tradeoffs (with explicit pros/cons)
3. Risks and failure modes
4. Recommendation (clear, justified)
Cite source chunks for every factual claim. Don't be agreeable for its own sake.`,
  'diagram-first': `Mode: Diagram First. Lead with a Mermaid diagram before any prose. Pick the classDef palette that matches the domain (data-pipeline / ArchiMate / Azure). Keep prose to 2–4 short paragraphs after the diagram. No fluff.`,
  'whitepaper': `Mode: Whitepaper. Produce long-form, publishable output. Use ## / ### headings, comparison tables where useful, embedded diagrams. Stratechery / Dan Luu register — direct, lightly editorial, no hedging. End with a clear thesis and a Sources block.`,
  'supporting-review': `Mode: Supporting Review. Build the case for the user's stated direction. Surface the strongest evidence in the retrieved chunks that supports it. Frame as: thesis → supporting evidence → counter-arguments and why they don't outweigh → why this is the right call. Use this for stakeholder buy-in or board justification.`,
  'adversarial-review': `Mode: Adversarial Review. Argue against the user's framing. Surface what the retrieved context contradicts in their stated view, name failure modes they haven't acknowledged, and challenge their assumptions. Frame as: stated position → strongest objections → evidence from chunks that undermines it → what would have to be true for the user to be right. Be direct, not hostile.`,
};

const SYSTEM_PROMPT = `You are a personal assistant grounded in Sajiv Francis's published writing, architecture notes, talks, and cloud  materials. You speak about him in the third person.                             
                                     
Rules:
1. Ground every claim in the provided <context> blocks. Synthesize and reason from them, applying general technical knowledge to interpret or frame what's there. **If the context is insufficient to answer, say so plainly — "I don't have material on that in the index" — and stop. Do not fabricate facts, projects, opinions, or history about Sajiv that aren't grounded in the context.**
2. Don't pad. Match the Stratechery / Dan Luu register: direct, lightly editorial, no hedging, no "happy to help."
3. Never name Sajiv's employer. He works at "a Fortune 50 technology company."
4. If a question is completely off-topic (general trivia, current events, unrelated to Sajiv's work or technical interests), redirect: "This chat is grounded in Sajiv's writing — try sajivfrancis.com or docs.sajivfrancis.com."
                                                                                                                                                                                          
Format:                                                                                                                                                                                   
- Use Markdown freely — headings (## / ###), tables, bullet lists, code blocks. The chat renders Markdown.
- For complex analytical questions (architecture decisions, comparisons, design tradeoffs), structure as: short summary → context → analysis → recommendation. Keep simple factual answ.                                                                                                                                                                                   
- For process flows, system architectures, or component relationships, emit a Mermaid diagram in a \`\`\`mermaid fence — the chat renders it inline.
- **Every Mermaid diagram MUST declare its type on the very first line** (e.g. \`flowchart TD\`, \`flowchart LR\`, \`sequenceDiagram\`, \`classDiagram\`). \`classDef\` and node definitions come AFTER the type declaration. Without the type declaration on line 1, Mermaid v10+ refuses to render with "No diagram type detected".
- For Mermaid node labels with multiple lines, use \`<br>\` not \`\\n\` (e.g. \`["SAP ECC<br>(FI/CO Documents)"]\`).
- Mermaid edge labels with special characters (parens, slashes, ampersands, brackets, colons) MUST be wrapped in double quotes inside the pipes. Examples:
  GOOD: \`A -->|"Integration Layer<br>(CPI / SDI)"| B\`
  BAD:  \`A -->|Integration Layer<br>(CPI / SDI)| B\` (parser fails on the open paren)
  GOOD: \`A -->|"reads from S/4HANA"| B\`
  BAD:  \`A -->|reads from S/4HANA| B\` (slash can break parsing)
- Subgraph identifiers must NOT share names with any node ID, even nodes inside that subgraph. Use distinct IDs — e.g. \`subgraph ML_LAYER ... ML[Machine Learning] end\`, not \`subgraph ML ... ML[Machine Learning] end\` (mermaid will reject the latter as a parent-of-itself cycle).
- Define every \`classDef\` AND every \`class NodeId className\` assignment at the very top of the diagram, before edges. (Trailing class statements break rendering if the response is truncated.)
- Color Mermaid nodes with \`classDef\` (define at top, apply via \`class NodeId className\`) using these conventions:
  • Data / integration architecture: \`source\` (#fff3e0 fill, #e65100 stroke), \`integration\` (#e8f5e9 / #2e7d32), \`target\` (#e3f2fd / #1565c0), \`reporting\` (#f3e5f5 / #6a1b9a).
  • ArchiMate (when the question is enterprise-architecture-shaped): \`business\` (#fff3b0 / #cc9a06), \`application\` (#b8d4f0 / #1565c0), \`technology\` (#c5e8c5 / #2e7d32), \`motivation\` (#e6c5f0 / #6a1b9a).
  • Azure: \`compute\` (#cfe2ff / #084298), \`storage\` (#d1e7dd / #0f5132), \`network\` (#fff3cd / #664d03), \`identity\` (#f8d7da / #842029).
  Pick the convention that fits the domain; use only one per diagram. Keep \`classDef\` definitions minimal — typically 3–5 classes.                                      
- Cite source chunks inline as italics, e.g. *(LocalizedSLMBuild.md)* or *(BPMN — S4HANA / J62_S4HANA_ASSETACCOUNTING)*, using each chunk's source attribute.                             
- End every substantive response with a **Sources** heading and a deduped bullet list of the source attributes you cited.`;

// Public-mode system prompt — restricts to Sajiv's published writing, refuses to
// speculate beyond what's in the public corpus, and politely redirects deep
// queries that would need private materials. Same Stratechery register;
// shorter, more conservative.
const PUBLIC_SYSTEM_PROMPT = `You are a public-facing assistant on Sajiv Francis's website. You answer only from Sajiv's **publicly published writing** — the chunks in the <context> block. You speak about him in the third person.

Rules:
1. Ground every claim in the provided <context>. If the context is insufficient — or if a question requires private materials (drafts, internal notes, books from his reference library) — say plainly: "I don't have published material on that. For deeper context, try sajivfrancis.com or docs.sajivfrancis.com." Then stop.
2. Don't fabricate. No invented opinions, projects, dates, employers, or history. If you're unsure, say so.
3. Never name Sajiv's employer. He works at "a Fortune 50 technology company."
4. Match a curious, helpful register — direct, lightly editorial, no hedging, but slightly less opinionated than internal notes. Aim to be useful to a technical reader who's just discovered the site.
5. Off-topic questions (current events, general trivia, unrelated coding help): redirect — "This chat is grounded in Sajiv's published writing. For general questions, the rest of the web is better."

Format:
- Use Markdown freely. Mermaid diagrams in \`\`\`mermaid fences when they clarify. **Every Mermaid diagram MUST start with the diagram type on its first line** (\`flowchart TD\`, \`flowchart LR\`, \`sequenceDiagram\`, etc.). \`classDef\` and nodes come after. Without the type declaration on line 1, Mermaid v10+ refuses to render. For multi-line node labels, use \`<br>\` not \`\\n\`.
- Cite source chunks inline as italics, e.g. *(BlogPost: Title)*, using each chunk's source attribute.
- End responses that draw on multiple sources with a **Sources** heading and a deduped bullet list.`;

// ---- Context retrieval: OpenAI embedding → pgvector top-K ----------------

interface Chunk {
  source: string;
  text: string;
}

// Mock chunks used as a graceful fallback if embedding or pgvector fails,
// so the chat still answers something rather than 500-ing.
const MOCK_CHUNKS: Chunk[] = [
  {
    source: 'About Sajiv',
    text: 'Sajiv Francis is an Enterprise Architect at a Fortune 50 technology company, leading AI programmes at the intersection of enterprise systems, cloud architecture, and large language models. TOGAF 10 certified. Background in NLP, document intelligence, and SAP ecosystems. Canadian citizen based in Arizona.',
  },
];

async function embedQuery(query: string, env: Env): Promise<number[] | null> {
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: query,
      }),
    });
    if (!r.ok) {
      console.error('OpenAI embed error', r.status, await r.text());
      return null;
    }
    const j: any = await r.json();
    return j.data?.[0]?.embedding ?? null;
  } catch (e) {
    console.error('OpenAI embed exception', e);
    return null;
  }
}

/**
 * HyDE — generate a hypothetical answer with a small/fast model, embed THAT
 * (instead of the bare query). Closer to the embedding distribution of
 * actual document chunks. Real win for short / conversational follow-ups.
 *
 * On any failure, returns the original query so the chat doesn't break.
 */
async function hyde(query: string, env: Env): Promise<string> {
  if (!query || query.length < 4) return query;
  const model = env.ANTHROPIC_HAIKU_MODEL ?? 'claude-haiku-4-5-20251001';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system:
          "Write a short hypothetical answer to the user's question — 2-4 sentences, factual register, as if quoting from reference material. " +
          'No preamble, no caveats, no "I think". Output only the answer text.',
        messages: [{ role: 'user', content: query }],
      }),
    });
    if (!r.ok) return query;
    const j: any = await r.json();
    const text = j.content?.[0]?.text;
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : query;
  } catch {
    return query;
  }
}

interface RetrievedContext {
  chunks: Chunk[];
  hydeText: string;
}

/**
 * Hybrid retrieval pipeline:
 *   1. HyDE-rewrite the query to a hypothetical answer
 *   2. Embed that
 *   3. Send to droplet /retrieve with embedding + raw query (for sparse FTS)
 *      + topic + visibility + mode + client_hash for logging
 *   4. Droplet does dense + sparse + RRF + MMR, returns top-K
 */
async function getContext(
  query: string,
  topics: string[] | undefined,
  visibility: string[] | undefined,
  mode: AuthMode,
  clientId: string,
  env: Env,
  opts: { sourcePaths?: string[]; topK?: number } = {}
): Promise<RetrievedContext> {
  const hydeText = await hyde(query, env);
  const embedding = await embedQuery(hydeText, env);
  if (!embedding) return { chunks: MOCK_CHUNKS, hydeText };

  const cleanTopics = (topics ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);
  const cleanSourcePaths = (opts.sourcePaths ?? [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);

  const body: any = {
    embedding,
    query,                      // for sparse FTS half + logging
    hyde_text: hydeText,
    mode,
    client_hash: clientId,
  };
  if (cleanTopics.length) body.topics = cleanTopics;
  if (visibility && visibility.length) body.visibility = visibility;
  if (cleanSourcePaths.length) body.source_paths = cleanSourcePaths;
  if (opts.topK && opts.topK > 0) body.top_k = opts.topK;

  try {
    const r = await fetch(env.RETRIEVE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RETRIEVE_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error('retrieve API error', r.status, await r.text());
      return { chunks: MOCK_CHUNKS, hydeText };
    }
    const j: any = await r.json();
    if (!j.chunks?.length) return { chunks: MOCK_CHUNKS, hydeText };

    const chunks = j.chunks.map((c: any) => {
      const title =
        (c.metadata && typeof c.metadata === 'object' && c.metadata.title) ||
        c.source_path ||
        c.source_url ||
        'doc';
      const topicSuffix = c.topic ? ` — ${c.topic}` : '';
      return { source: `${title}${topicSuffix}`, text: c.text };
    });
    return { chunks, hydeText };
  } catch (e) {
    console.error('retrieve fetch failed', e);
    return { chunks: MOCK_CHUNKS, hydeText };
  }
}

// ---- CORS -----------------------------------------------------------------

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---- Anthropic streaming proxy --------------------------------------------

// Block-shaped system prompt entry used by Anthropic's prompt caching.
type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

async function callAnthropicWithRetry(
  body: string,
  env: Env,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': env.ANTHROPIC_API_KEY,
      },
      body,
    });
    // Retry on rate limits (429) and overload (529) with exponential backoff.
    // Both are transient; other 4xx are permanent and should surface immediately.
    if ((res.status === 429 || res.status === 529) && attempt < maxRetries) {
      const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  // Unreachable, but TypeScript needs a return path.
  throw new Error('callAnthropicWithRetry: exhausted retries');
}

// ---- Non-streaming synthesis helper (for /api/synthesize/* endpoints) -----
//
// Reuses SYNTHESIS_PROMPTS but calls Anthropic with stream:false so we get
// the full markdown back in one response — much easier for external tool
// integration than parsing SSE on the client side.
type SynthesisSource =
  | { type: 'messages'; messages: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'markdown'; markdown: string };

async function synthesize(
  mode: 'synthesize-whitepaper' | 'synthesize-slides' | 'synthesize-email',
  source: SynthesisSource,
  env: Env
): Promise<string> {
  const systemPrompt = SYNTHESIS_PROMPTS[mode];
  if (!systemPrompt) {
    throw new Error(`unknown synthesis mode: ${mode}`);
  }

  // Build the message history depending on source type.
  let baseMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  if (source.type === 'markdown') {
    // Pass the source markdown as a single user message. The system prompt's
    // "drop iterative back-and-forth" rule still applies cleanly — there's
    // simply nothing to drop.
    baseMessages = [
      {
        role: 'user',
        content:
          'Source content to synthesize (treat this as the canonical input — extract structure, recommendation, and key points from it):\n\n' +
          source.markdown,
      },
    ];
  } else {
    baseMessages = source.messages;
  }

  // Append the synthesis trigger as the final user turn so Anthropic's
  // "messages must end with user role" constraint is satisfied.
  const trigger =
    mode === 'synthesize-slides'
      ? 'Now synthesize the source above into the slide deck markdown per your instructions. Output markdown only — no preamble.'
      : mode === 'synthesize-email'
      ? 'Now synthesize the source above into the BLUF-format executive email markdown per your instructions. Output markdown only — no preamble.'
      : 'Now synthesize the source above into the whitepaper markdown per your instructions. Output markdown only — no preamble.';
  const outboundMessages = [...baseMessages, { role: 'user' as const, content: trigger }];

  const body = JSON.stringify({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 16384,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: outboundMessages,
  });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ANTHROPIC_API_KEY,
    },
    body,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Anthropic ${r.status}: ${errText.slice(0, 500)}`);
  }
  const data: any = await r.json();
  const text = data?.content?.[0]?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('Anthropic returned empty content');
  }
  return text;
}

async function streamFromAnthropic(
  messages: ChatMessage[],
  context: Chunk[],
  skill: string | undefined,
  mode: ChatRequest['mode'],
  authMode: AuthMode,
  env: Env,
  opts: { confidenceMode?: boolean } = {}
): Promise<Response> {
  // Build the system prompt as cacheable blocks. Anthropic's prompt caching
  // (ephemeral, 5-minute TTL) gives ~90% discount on cached input tokens.
  // Order: stable parts first (cached), variable parts last (not cached).
  const systemBlocks: SystemBlock[] = [];
  let outboundMessages = messages;

  if (mode && mode !== 'chat' && SYNTHESIS_PROMPTS[mode]) {
    // Synthesis: only the synthesis prompt — stable per mode, cache it.
    systemBlocks.push({
      type: 'text',
      text: SYNTHESIS_PROMPTS[mode],
      cache_control: { type: 'ephemeral' },
    });
    // Anthropic requires messages to end with a user role. Append a
    // synthesis trigger so the conversation history ending in an assistant
    // message becomes valid for the next turn.
    const trigger =
      mode === 'synthesize-slides'
        ? 'Now synthesize the conversation above into the slide deck markdown per your instructions. Output markdown only — no preamble.'
        : mode === 'synthesize-email'
        ? 'Now synthesize the conversation above into the BLUF-format executive email markdown per your instructions. Output markdown only — no preamble.'
        : 'Now synthesize the conversation above into the whitepaper markdown per your instructions. Output markdown only — no preamble.';
    outboundMessages = [...messages, { role: 'user' as const, content: trigger }];
  } else {
    // Chat: cache the base system prompt + (if present) the skill overlay.
    // The RAG context block is volatile per query — keep uncached at the end.
    // Public mode uses a stricter prompt and skips skill overlays (they're an
    // owner-side workflow — adversarial review for stakeholders, etc.).
    const basePrompt = authMode === 'public' ? PUBLIC_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const skillAllowed = authMode === 'owner' && skill && SKILLS[skill];
    const stable = skillAllowed
      ? `${basePrompt}\n\n${SKILLS[skill]}`
      : basePrompt;
    systemBlocks.push({
      type: 'text',
      text: stable,
      cache_control: { type: 'ephemeral' },
    });
    // Confidence-mode overlay — appended after the cached base prompt so the
    // cache hit still applies. The overlay itself is small (~1k tokens), and
    // its content doesn't change per turn so it caches too on repeat use.
    if (opts.confidenceMode && authMode === 'owner') {
      systemBlocks.push({
        type: 'text',
        text: CONFIDENCE_MODE_OVERLAY,
        cache_control: { type: 'ephemeral' },
      });
    }
    const contextBlock = context
      .map((c) => `<chunk source="${c.source}">\n${c.text}\n</chunk>`)
      .join('\n\n');
    if (contextBlock) {
      systemBlocks.push({ type: 'text', text: `<context>\n${contextBlock}\n</context>` });
    }
  }

  const requestBody = JSON.stringify({
    model: env.ANTHROPIC_MODEL,
    // Synthesis can produce long whitepapers / multi-slide decks (each diagram alone
    // can be 1-2k tokens, and we want headroom for 2-3 diagrams). Chat rarely exceeds 4k.
    max_tokens: mode && mode !== 'chat' ? 16384 : 4096,
    system: systemBlocks,
    messages: outboundMessages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  });

  const upstream = await callAnthropicWithRetry(requestBody, env);

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text();
    return new Response(
      `data: ${JSON.stringify({ error: `Upstream ${upstream.status}: ${errText}` })}\n\n`,
      { status: 502, headers: { 'Content-Type': 'text/event-stream' } }
    );
  }

  // Translate Anthropic SSE into our minimal {delta} SSE format.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    const reader = upstream.body!.getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const evt of events) {
          const dataLine = evt.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6);
          try {
            const json = JSON.parse(payload);
            if (
              json.type === 'content_block_delta' &&
              json.delta?.type === 'text_delta' &&
              typeof json.delta.text === 'string'
            ) {
              await writer.write(
                encoder.encode(`data: ${JSON.stringify({ delta: json.delta.text })}\n\n`)
              );
            }
          } catch {
            // skip malformed
          }
        }
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (err) {
      await writer.write(
        encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
      );
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// ---- Router ---------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // Per-message thumbs-up / thumbs-down feedback. Frontend message-actions.js
    // POSTs here when a user rates an assistant response. Stored in
    // RATE_LIMIT_KV under `feedback:<messageId>` with a 90-day TTL.
    // Public endpoint — no auth required (rate-limit-by-IP not added yet;
    // the surface is small and idempotent).
    if (url.pathname === '/feedback') {
      if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: cors });
      }
      let body: {
        messageId?: string;
        rating?: 'up' | 'down' | null;
        excerpt?: string;
        timestamp?: string;
      };
      try {
        body = await req.json();
      } catch {
        return new Response('Invalid JSON', { status: 400, headers: cors });
      }
      const messageId = body.messageId;
      if (!messageId || typeof messageId !== 'string' || messageId.length > 200) {
        return new Response('messageId required (1-200 chars)', { status: 400, headers: cors });
      }
      const entry = {
        messageId,
        rating: body.rating ?? null,
        excerpt: (body.excerpt ?? '').slice(0, 500),
        timestamp: body.timestamp ?? new Date().toISOString(),
        ip: req.headers.get('CF-Connecting-IP') ?? 'unknown',
        country: (req as unknown as { cf?: { country?: string } }).cf?.country ?? 'unknown',
      };
      if (env.RATE_LIMIT_KV) {
        await env.RATE_LIMIT_KV.put(
          `feedback:${messageId}`,
          JSON.stringify(entry),
          { expirationTtl: 60 * 60 * 24 * 90 },
        );
      }
      console.log(`[feedback] ${entry.rating ?? 'removed'} on ${messageId}`);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // /topics and /library are public-friendly: no token required.
    // Public requests get filtered to visibility=public; owner sees everything.
    if (
      (url.pathname === '/topics' || url.pathname === '/library') &&
      req.method === 'GET'
    ) {
      const authMode = classifyAuth(req, env);
      try {
        const route = url.pathname; // '/topics' or '/library'
        const visQuery = authMode === 'public' ? '?visibility=public' : '';
        const upstreamUrl = env.RETRIEVE_URL.replace(/\/retrieve\/?$/, route) + visQuery;
        const r = await fetch(upstreamUrl, {
          headers: { Authorization: `Bearer ${env.RETRIEVE_TOKEN}` },
        });
        const body = await r.text();
        return new Response(body, {
          status: r.status,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    if (url.pathname === '/ingest' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      // 25 MB raw → ~33 MB base64 + JSON overhead. Cap at 50 MB request body.
      const MAX_REQ = 50 * 1024 * 1024;
      const lenHeader = req.headers.get('Content-Length');
      if (lenHeader && Number(lenHeader) > MAX_REQ) {
        return new Response(JSON.stringify({ error: 'request too large (25 MB max raw file)' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        const ingestUrl = env.RETRIEVE_URL.replace(/\/retrieve\/?$/, '/ingest');
        const body = await req.text();
        const r = await fetch(ingestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.RETRIEVE_TOKEN}`,
          },
          body,
        });
        const respText = await r.text();
        return new Response(respText, {
          status: r.status,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    // SEC filing benchmarking — peer lookup by CIK or SIC.
    // Owner-only: each call costs N+1 EDGAR requests (rate-limited at 10/s)
    // and consumes downstream pgvector+Claude budget once the full pipeline
    // lands. Proxies to droplet /benchmark/peers (sec_edgar.py wrapper).
    // Query: ?cik=NNN[&limit=10]  OR  ?sic=NNNN[&limit=10]
    if (url.pathname === '/benchmark/peers' && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const cik = url.searchParams.get('cik');
      const sic = url.searchParams.get('sic');
      const limit = url.searchParams.get('limit') ?? '10';
      if (!cik && !sic) {
        return new Response(JSON.stringify({ error: 'cik or sic required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        const upstreamBase = env.RETRIEVE_URL.replace(/\/retrieve\/?$/, '/benchmark/peers');
        const upstreamUrl = `${upstreamBase}?${new URLSearchParams(
          Object.fromEntries(
            Object.entries({ cik, sic, limit }).filter(([, v]) => v != null)
          ) as Record<string, string>
        ).toString()}`;
        const r = await fetch(upstreamUrl, {
          headers: { Authorization: `Bearer ${env.RETRIEVE_TOKEN}` },
        });
        const respText = await r.text();
        return new Response(respText, {
          status: r.status,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    // ---- Synthesis API for external tools (Vite work tool, CLI, etc.) ----
    //
    // Non-streaming JSON endpoints — returns the full synthesized markdown
    // in one response. Same Bearer auth as /chat (owner-only; CHAT_TOKEN).
    //
    // /api/synthesize/whitepaper — body: {messages:[...]}
    // /api/synthesize/slides     — body: {source_markdown:"..."} OR {messages:[...]}
    // /api/synthesize/email      — body: {source_markdown:"..."} OR {messages:[...]}
    // /api/synthesize/all        — body: {messages:[...]} — runs whitepaper,
    //                              then slides + email in parallel from
    //                              whitepaper. Returns all three.

    if (
      (url.pathname === '/api/synthesize/whitepaper' ||
        url.pathname === '/api/synthesize/slides' ||
        url.pathname === '/api/synthesize/email') &&
      req.method === 'POST'
    ) {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      let body: any;
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      // Validate + select source. Whitepaper requires messages (chat history is
      // the only meaningful source for a fresh whitepaper). Slides + email
      // accept either source_markdown (preferred — derived from the whitepaper)
      // or messages (regenerate from chat directly).
      let source: SynthesisSource | null = null;
      const wantsWhitepaper = url.pathname === '/api/synthesize/whitepaper';

      if (wantsWhitepaper) {
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return new Response(
            JSON.stringify({ error: 'messages array required for whitepaper synthesis' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        source = { type: 'messages', messages: body.messages };
      } else {
        if (typeof body.source_markdown === 'string' && body.source_markdown.length > 0) {
          source = { type: 'markdown', markdown: body.source_markdown };
        } else if (Array.isArray(body.messages) && body.messages.length > 0) {
          source = { type: 'messages', messages: body.messages };
        } else {
          return new Response(
            JSON.stringify({ error: 'either source_markdown (string) or messages (array) required' }),
            { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
      }

      const mode = (url.pathname === '/api/synthesize/whitepaper'
        ? 'synthesize-whitepaper'
        : url.pathname === '/api/synthesize/slides'
        ? 'synthesize-slides'
        : 'synthesize-email') as 'synthesize-whitepaper' | 'synthesize-slides' | 'synthesize-email';

      const start = Date.now();
      try {
        const markdown = await synthesize(mode, source, env);
        return new Response(
          JSON.stringify({ mode, markdown, elapsed_ms: Date.now() - start }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: String(e?.message ?? e), elapsed_ms: Date.now() - start }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
    }

    if (url.pathname === '/api/synthesize/all' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      let body: any;
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return new Response(
          JSON.stringify({ error: 'messages array required' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      const start = Date.now();
      try {
        // Step 1: whitepaper from chat history.
        const whitepaper = await synthesize(
          'synthesize-whitepaper',
          { type: 'messages', messages: body.messages },
          env
        );
        // Step 2 + 3: slides and email in parallel, both derived from the
        // whitepaper. Guarantees content consistency across artifacts.
        const [slides, email] = await Promise.all([
          synthesize('synthesize-slides', { type: 'markdown', markdown: whitepaper }, env),
          synthesize('synthesize-email', { type: 'markdown', markdown: whitepaper }, env),
        ]);
        return new Response(
          JSON.stringify({
            whitepaper,
            slides,
            email,
            elapsed_ms: Date.now() - start,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: String(e?.message ?? e), elapsed_ms: Date.now() - start }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
    }

    // ---- Artifact store (owner-only) -------------------------------------
    //
    // Persistence layer for synthesized whitepaper/slides/email bundles
    // produced from the chat surface. Work tools READ from these endpoints
    // (by convention — same Bearer token, but the work tool only issues GETs).
    //
    // POST   /api/artifacts          create (called by chat surface after
    //                                /api/synthesize/all returns)
    // GET    /api/artifacts          list metadata (newest first), supports
    //                                ?mode=, ?since=, ?limit=
    // GET    /api/artifacts/:id      fetch full record (with markdowns)
    // DELETE /api/artifacts/:id      cleanup
    //
    // KV metadata stored alongside each key holds {id, created_at, mode,
    // title} so list() returns useful summaries without N+1 reads.

    if (url.pathname === '/api/artifacts' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.ARTIFACTS_KV) {
        return new Response(
          JSON.stringify({ error: 'ARTIFACTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      let body: any;
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: 'invalid json' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const mode = body.mode;
      const title = typeof body.title === 'string' ? body.title.slice(0, 300) : null;
      const artifacts = body.artifacts;
      const sourceChatTitle =
        typeof body.source_chat_title === 'string' ? body.source_chat_title.slice(0, 300) : null;
      if (!mode || typeof mode !== 'string' || !title || !artifacts || typeof artifacts !== 'object') {
        return new Response(
          JSON.stringify({ error: 'mode (string), title (string), and artifacts (object) required' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      // Validate mode and shape of artifacts
      const allowedModes = ['all', 'synthesize-whitepaper', 'synthesize-slides', 'synthesize-email'];
      if (!allowedModes.includes(mode)) {
        return new Response(
          JSON.stringify({ error: `mode must be one of: ${allowedModes.join(', ')}` }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const now = new Date();
      const created_at = now.toISOString();
      const ymd = created_at.slice(0, 10).replace(/-/g, '');
      const hms = created_at.slice(11, 19).replace(/:/g, '');
      const rand = Math.random().toString(36).slice(2, 8);
      const id = `art_${ymd}_${hms}_${rand}`;

      const record = { id, created_at, mode, title, source_chat_title: sourceChatTitle, artifacts };
      try {
        await env.ARTIFACTS_KV.put(`artifact:${id}`, JSON.stringify(record), {
          metadata: { id, created_at, mode, title },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: `KV write failed: ${e?.message ?? e}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      return new Response(JSON.stringify({ id, created_at, mode, title }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    if (url.pathname === '/api/artifacts' && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.ARTIFACTS_KV) {
        return new Response(
          JSON.stringify({ error: 'ARTIFACTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const modeFilter = url.searchParams.get('mode');
      const sinceFilter = url.searchParams.get('since');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '100'), 1), 1000);

      const items: any[] = [];
      let cursor: string | undefined;
      try {
        do {
          const result = await env.ARTIFACTS_KV.list({
            prefix: 'artifact:',
            limit: 1000,
            cursor,
          });
          for (const k of result.keys) {
            const meta = (k.metadata ?? {}) as any;
            if (modeFilter && meta.mode !== modeFilter) continue;
            if (sinceFilter && (meta.created_at ?? '') < sinceFilter) continue;
            items.push({
              id: meta.id ?? k.name.replace(/^artifact:/, ''),
              created_at: meta.created_at,
              mode: meta.mode,
              title: meta.title,
            });
          }
          cursor = result.list_complete ? undefined : result.cursor;
        } while (cursor && items.length < 10000);
      } catch (e: any) {
        return new Response(JSON.stringify({ error: `KV list failed: ${e?.message ?? e}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      // Sort newest first by created_at
      items.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      return new Response(
        JSON.stringify({ artifacts: items.slice(0, limit), count: Math.min(items.length, limit) }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    if (url.pathname.startsWith('/api/artifacts/') && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.ARTIFACTS_KV) {
        return new Response(
          JSON.stringify({ error: 'ARTIFACTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const id = url.pathname.slice('/api/artifacts/'.length).replace(/\/$/, '');
      if (!/^art_[a-zA-Z0-9_]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'invalid artifact id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        const value = await env.ARTIFACTS_KV.get(`artifact:${id}`, 'json');
        if (!value) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        return new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: `KV read failed: ${e?.message ?? e}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    if (url.pathname.startsWith('/api/artifacts/') && req.method === 'DELETE') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.ARTIFACTS_KV) {
        return new Response(
          JSON.stringify({ error: 'ARTIFACTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const id = url.pathname.slice('/api/artifacts/'.length).replace(/\/$/, '');
      if (!/^art_[a-zA-Z0-9_]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'invalid artifact id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        await env.ARTIFACTS_KV.delete(`artifact:${id}`);
        return new Response(JSON.stringify({ deleted: id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: `KV delete failed: ${e?.message ?? e}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
    }

    if (url.pathname === '/chat' && req.method === 'POST') {
      const authMode = classifyAuth(req, env);

      // Public mode: rate-limit. Owner mode: no limit.
      // Synthesis modes are owner-only — public visitors can't trigger expensive
      // 16k-token whitepaper generations.
      let body: ChatRequest;
      try {
        body = await req.json();
      } catch {
        return new Response('Invalid JSON', { status: 400, headers: cors });
      }
      if (!body.messages?.length) {
        return new Response('messages required', { status: 400, headers: cors });
      }

      const synthesizing =
        body.mode === 'synthesize-whitepaper' ||
        body.mode === 'synthesize-slides' ||
        body.mode === 'synthesize-email';

      if (authMode === 'public') {
        if (synthesizing) {
          return new Response(
            `data: ${JSON.stringify({ error: 'Synthesis is owner-only. Sign in with an access token to use this feature.' })}\n\n`,
            { status: 403, headers: { 'Content-Type': 'text/event-stream', ...cors } }
          );
        }
        const rl = await rateLimitPublic(req, env);
        if (!rl.ok) {
          return new Response(
            `data: ${JSON.stringify({
              error: rl.reason === 'minute'
                ? 'Rate limit: max 5 messages per minute. Try again shortly.'
                : 'Rate limit: max 30 messages per day. Come back tomorrow or sign in.',
            })}\n\n`,
            {
              status: 429,
              headers: {
                'Content-Type': 'text/event-stream',
                'Retry-After': String(rl.retryAfterSeconds ?? 60),
                ...cors,
              },
            }
          );
        }
      }

      const clientId = await clientHash(req, env, authMode);

      // High-confidence mode is owner-only (per client convention). Silently
      // ignore the flag for public-mode requests to avoid leaking the costlier
      // path to anonymous visitors.
      const confidenceMode = !!body.confidence_mode && authMode === 'owner';

      // Skip RAG retrieval when synthesizing — the chat is the source of truth.
      let chunks: Chunk[] = [];
      if (!synthesizing) {
        const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
        const query = lastUser?.content ?? '';
        const visibility = authMode === 'public' ? ['public'] : undefined;
        const ctx = await getContext(query, body.topics, visibility, authMode, clientId, env, {
          sourcePaths: body.source_paths,
          // Confidence mode widens the retrieved chunk count from default 6 → 15.
          // Source-path filter usually narrows the candidate pool, so a higher K
          // here still fits comfortably in the prompt budget.
          topK: confidenceMode ? 15 : undefined,
        });
        chunks = ctx.chunks;
      }

      const streamResp = await streamFromAnthropic(
        body.messages,
        chunks,
        body.skill,
        body.mode,
        authMode,
        env,
        { confidenceMode }
      );
      // Merge CORS into the streaming response
      const headers = new Headers(streamResp.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v as string));
      return new Response(streamResp.body, { status: streamResp.status, headers });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};

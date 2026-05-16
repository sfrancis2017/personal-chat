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
  // Optional KV binding for blog post drafts authored in the /admin/write
  // editor on sajivfrancis.com. Owner-only. Each draft is a JSON blob with
  // frontmatter + markdown body. If unbound, /api/drafts endpoints return 503.
  DRAFTS_KV?: KVNamespace;
  // Optional KV binding for caching fetched GitHub repo content used as
  // grounding context for draft reviews. Keyed by `{repo}:{branch}:{sha}`
  // with a 1-hour TTL. Cache miss falls through to a live fetch.
  REPO_CACHE_KV?: KVNamespace;
  // Comma-separated list of `owner/repo` slugs available for grounding in
  // the draft review pipeline. Pre-registered so the editor UI can render a
  // dropdown rather than asking for free-form URLs. Defaults to the four
  // active sfrancis2017 repos if unset.
  GROUNDING_REPOS?: string;
  // Target repo/branch for the /admin/write editor's "publish" action.
  // Drafts land as .mdx files under src/content/blog/ on this repo.
  // DOCS_GITHUB_TOKEN must have contents:write on this repo too.
  BLOG_REPO?: string;          // default: "sfrancis2017/sajivfrancis.github.io-master"
  BLOG_BRANCH?: string;        // default: "master"
  BLOG_CONTENT_ROOT?: string;  // default: "src/content/blog"
  // Anthropic beta header value for the 1M-context tier (e.g.,
  // "context-1m-2025-08-07"). When set, the worker enables 1M-context
  // requests for High-confidence + direct-injection turns whose estimated
  // input exceeds 175k tokens. Leave unset to cap at 200k context (current
  // behavior). Pricing tier: ~2× standard input for prompts > 200k tokens.
  ANTHROPIC_BETA_1M?: string;
  // GitHub PAT with contents:write on sfrancis2017/docs (fine-grained, single-repo).
  // Used by POST /publish-to-docs to commit synthesized whitepapers (refs stripped,
  // rewritten to first-person) into the docs site's /analysis/ section.
  // If unset, /publish-to-docs returns 503.
  DOCS_GITHUB_TOKEN?: string;
  // Optional overrides for the docs repo layout — set in wrangler.toml [vars]
  // if your docs site doesn't match Starlight's default `src/content/docs/`
  // structure (e.g. Astro vanilla uses `src/pages/docs`, MkDocs uses `docs`).
  DOCS_REPO?: string;          // default: "sfrancis2017/docs"
  DOCS_BRANCH?: string;        // default: "main"
  DOCS_CONTENT_ROOT?: string;  // default: "src/content/docs"
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

// ---- Draft validation helpers --------------------------------------------
//
// Used by /api/drafts POST + PUT to validate and normalise blog post
// drafts authored in the /admin/write editor. Drafts have a frontmatter
// object (Astro content collection schema) + markdown body. The
// grounding_repos array is optional — pins GitHub repos to fetch as
// review-time grounding context.

const ALLOWED_PUBLISH_MODES = ['blog-first', 'venue-first'] as const;

type DraftFrontmatter = {
  title: string;
  subtitle?: string;
  description: string;
  pubDate: string; // ISO date (YYYY-MM-DD)
  tags: string[];
  draft: boolean;
  publishMode: 'blog-first' | 'venue-first';
  slug?: string;
};

type DraftValidationResult =
  | { ok: true; frontmatter: DraftFrontmatter; body: string; grounding_repos: string[] }
  | { ok: false; error: string };

function validateDraftPayload(input: any): DraftValidationResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const fm = input.frontmatter;
  if (!fm || typeof fm !== 'object') {
    return { ok: false, error: 'frontmatter (object) required' };
  }
  if (typeof fm.title !== 'string' || fm.title.trim().length === 0) {
    return { ok: false, error: 'frontmatter.title (non-empty string) required' };
  }
  if (fm.title.length > 300) {
    return { ok: false, error: 'frontmatter.title must be 300 characters or less' };
  }
  if (typeof fm.description !== 'string' || fm.description.trim().length === 0) {
    return { ok: false, error: 'frontmatter.description (non-empty string) required' };
  }
  if (typeof fm.pubDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fm.pubDate)) {
    return { ok: false, error: 'frontmatter.pubDate must be an ISO date (YYYY-MM-DD)' };
  }
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  if (tags.length > 20 || tags.some((t: any) => typeof t !== 'string')) {
    return { ok: false, error: 'frontmatter.tags must be an array of up to 20 strings' };
  }
  const publishMode = fm.publishMode ?? 'blog-first';
  if (!ALLOWED_PUBLISH_MODES.includes(publishMode)) {
    return {
      ok: false,
      error: `frontmatter.publishMode must be one of: ${ALLOWED_PUBLISH_MODES.join(', ')}`,
    };
  }
  if (typeof input.body !== 'string') {
    return { ok: false, error: 'body (string) required' };
  }
  if (input.body.length > 500_000) {
    return { ok: false, error: 'body must be 500,000 characters or less' };
  }
  const grounding_repos = Array.isArray(input.grounding_repos) ? input.grounding_repos : [];
  if (
    grounding_repos.length > 3 ||
    grounding_repos.some((r: any) => typeof r !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r))
  ) {
    return {
      ok: false,
      error: 'grounding_repos must be an array of up to 3 "owner/repo" strings',
    };
  }
  if (fm.slug !== undefined && (typeof fm.slug !== 'string' || !/^[a-z0-9][-a-z0-9]{0,79}$/.test(fm.slug))) {
    return {
      ok: false,
      error: 'frontmatter.slug must be a URL-safe slug (lowercase, hyphens, max 80 chars)',
    };
  }
  return {
    ok: true,
    frontmatter: {
      title: fm.title.trim(),
      subtitle: typeof fm.subtitle === 'string' ? fm.subtitle.trim().slice(0, 300) : undefined,
      description: fm.description.trim(),
      pubDate: fm.pubDate,
      tags: tags.map((t: string) => t.trim()).filter(Boolean),
      draft: fm.draft === true,
      publishMode,
      slug: fm.slug,
    },
    body: input.body,
    grounding_repos,
  };
}

// Slugify a title into a URL-safe identifier. Mirrors the regex enforced
// in validateDraftPayload so the output is always valid for the slug field.
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
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
   * Direct-injection request. When true AND confidence_mode is true AND
   * source_paths is non-empty AND the client's estimated total token count
   * fits the worker's budget cap (150k tokens), the worker tells the droplet
   * to return ALL chunks from the pinned sources (no top-K, no MMR).
   * Claude then sees the whole pinned material as grounding — eliminates
   * retrieval sampling for work-grade precision.
   */
  inject_full?: boolean;
  /**
   * Client-computed upper-bound token estimate for the pinned sources
   * (chunks × ~1000 tokens). Used by the worker's budget check before
   * honoring inject_full. The client should be conservative.
   */
  inject_full_estimate?: number;
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
7. Don't pad — but DO complete the document. Length should match chat depth: 600 words for shallow conversations, 3000+ words for deeply-grounded multi-source whitepapers. **CRITICAL: every section from executive summary through conclusion/recommendation must have substantive content. Never truncate the conclusion to hit a word target. If the conversation has 6 scenarios, every scenario gets full treatment; if it has 2, don't pad to fake length. Always reach the final section (Recommendation / Conclusion / Outlook) with full content — readers will notice a missing ending more than a slightly long body.**
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

// System prompt for /api/drafts/:id/review — editorial pass for blog
// drafts authored in /admin/write. Returns structured JSON suggestions.
// Combines a voice-preserving editorial pass with technical grounding
// against GitHub repos (TECHNICAL_GROUNDING) and visual augmentation
// of described systems (TECHNICAL_AUGMENTATION).
const DRAFT_REVIEW_SYSTEM_PROMPT = `You are an editorial reviewer for Sajiv Francis — an Enterprise Architect who writes about AI, cloud, SAP, and enterprise architecture. He is your only client. You know his work and his voice.

# Your mission

Read his draft. Suggest targeted improvements that PRESERVE his voice and his ideas. You are an editor, not a co-author. Every suggestion must make the writing sharper without making it sound like someone else wrote it.

You operate in two registers at once:

1. PROSE EDITOR — flow, clarity, sentence-level polish
2. TECHNICAL REVIEWER — when he describes systems, components, processes, or architectures, both (a) GROUND loose technical claims against the GitHub repo grounding provided, and (b) AUGMENT prose-only descriptions with visual structures (Mermaid diagrams, component tables, labeled lists).

# Voice you must preserve

Sajiv writes like an engineer who has shipped real systems and is genuinely curious. Specifically:

- British/Commonwealth spellings ("organisation", "programmes")
- Em-dashes — he uses them often, on purpose
- Direct, declarative sentences. Subject-verb-object.
- Occasional dry asides. Light, never sarcastic.
- First person. "I built", "I shipped", "what I got wrong".
- Specific numbers and names over abstractions ("47 custom ABAP objects" not "many custom objects")
- Mentions of his work at "a Fortune 50 technology company" — NEVER name the employer directly. If you see "Intel" or any named employer, that is a CRITICAL_CONFIDENTIAL finding.
- Does NOT use: "excited to share", "thrilled to announce", "in this post I will explore", "leverage", "synergy", "unlock", "empower", "game-changer".

Preserve all of the above EXACTLY.

# Categories

Every suggestion must specify one category:

## 1. FLOW
Sentence-level edits where prose stumbles. Suggest a minimal rewrite that sounds like him.

## 2. STRUCTURE
Paragraph- or section-level issues. Repetition, missing transitions, missing headings, conclusion that restates without resolving.

## 3. TECHNICAL_GROUNDING
When the draft references a real build for which you have grounding context (see the <grounding> block), correct prose that contradicts the actual implementation. Examples: "I used Python" when wrangler.toml says TypeScript; "I used MCP" when worker/index.ts is a REST polling loop; "we used Redis for state" when the stack is Cloudflare KV.

Grounding rules:
  - ONLY make corrections backed by the <grounding> block. Never correct based on general knowledge of "how things are usually built".
  - If the prose contradicts grounding, grounding wins — but preserve the author's framing, swap only the technical specifics.
  - If the draft mentions a system NOT in the grounding block, leave it alone.

## 4. TECHNICAL_AUGMENTATION
When the draft describes systems/processes in prose, propose a visual augmentation that mirrors what's already in the text + grounding:

  - mermaid_diagram (preferred): a flowchart/sequence/state diagram capturing flow already described
  - component_table: a 2-3 column table when he lists similar items with attributes
  - labeled_list: bolded-lead bullets when he describes a sequence in prose

Mermaid rules:
  - Diagram type on line 1 ("flowchart TD", not "graph TD")
  - Use <br> for line breaks inside node labels, never \\n
  - Node labels short (3-5 words max)
  - Match what's in prose + grounding. Don't invent components.

## 5. POLISH
Typos, punctuation, inconsistent capitalisation, clichés. Low-stakes.

## 6. CRITICAL_CONFIDENTIAL
Flag-only category (no fix suggested). Use when the draft contains:
  - Named employer (Intel, etc.) outside the "Fortune 50 technology company" phrasing
  - Internal project/system/team names that look confidential
  - Anything that should not be public

# Hard rules — NEVER

- Never rewrite a paragraph wholesale. Suggest the SMALLEST change that fixes the issue.
- Never add new ideas, arguments, or examples. You can AUGMENT (visualise what's described) and GROUND (correct against the grounding block), but you cannot extend the author's thinking.
- Never suggest filler ("a stronger introduction would help" without specifics).
- Never use hedge words in your rationale ("perhaps consider", "you might want to"). State directly.
- Never suggest changes that match a Generic Blog Post Template.

# Output format

Return ONLY valid JSON matching this schema. No preamble, no markdown fences, no commentary.

{
  "overall": "1-2 sentence summary of the draft's current state",
  "suggestions": [
    {
      "id": "s1",
      "category": "FLOW" | "STRUCTURE" | "TECHNICAL_GROUNDING" | "TECHNICAL_AUGMENTATION" | "POLISH" | "CRITICAL_CONFIDENTIAL",
      "location": "paragraph N" | "section: <heading>" | "after paragraph N" | "line containing: <short quote>",
      "original": "<exact text from draft, or null if this is an insertion>",
      "suggested": "<replacement or insertion content, or null if CRITICAL_CONFIDENTIAL>",
      "rationale": "<one sentence — why this change>"
    }
  ],
  "voice_check": {
    "matches_voice": true | false,
    "notes": "<if false, what is drifting>"
  }
}
`;

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
  opts: { sourcePaths?: string[]; topK?: number; injectFull?: boolean } = {}
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
  // Direct injection — droplet returns ALL chunks from source_paths, no top-K,
  // ordered by document position. Only honored when source_paths is also set.
  if (opts.injectFull && cleanSourcePaths.length) body.inject_full = true;

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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
  extraHeaders: Record<string, string> = {},
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': env.ANTHROPIC_API_KEY,
        ...extraHeaders,
      },
      body,
    });
    // Retry on transient upstream errors with exponential backoff.
    //   - 429: rate limit
    //   - 502/503/504: upstream gateway / service unavailable / gateway timeout
    //   - 524: Cloudflare origin timeout (Anthropic's edge took too long to
    //     reply — common on long synthesis calls in the 1M-context tier)
    //   - 529: site overloaded
    // Other 4xx (e.g. 400 invalid request, 401 bad key) are permanent and
    // surface immediately so we don't hide real problems behind retries.
    const TRANSIENT_STATUSES = new Set([429, 502, 503, 504, 524, 529]);
    if (TRANSIENT_STATUSES.has(res.status) && attempt < maxRetries) {
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
    // 32k output for synthesis — long cross-module whitepapers with 4-6
    // diagrams + tables can blow through 16k mid-conclusion. Sonnet 4.6
    // supports up to 64k output; 32k leaves cost headroom but doesn't
    // truncate realistic whitepaper bodies.
    max_tokens: 32768,
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

// ---- Publish-to-docs helpers ---------------------------------------------
//
// docs.sajivfrancis.com gets a clean "Sajiv's own analysis" view of
// synthesized whitepapers. The artifact store retains the full version
// (with references) for work-tool consumption — these helpers transform
// only on the publish path.

// Docs repo config — defaults assume Starlight on sfrancis2017/docs at main.
// Override via wrangler.toml [vars] if your repo uses a different layout
// (e.g. Astro vanilla 'src/pages/docs', MkDocs 'docs', etc.) without
// needing a code redeploy.
const DOCS_REPO_DEFAULT = 'sfrancis2017/docs';
const DOCS_BRANCH_DEFAULT = 'main';
const DOCS_CONTENT_ROOT_DEFAULT = 'src/content/docs';

function docsRepo(env: Env): string {
  return env.DOCS_REPO?.trim() || DOCS_REPO_DEFAULT;
}
function docsBranch(env: Env): string {
  return env.DOCS_BRANCH?.trim() || DOCS_BRANCH_DEFAULT;
}
function docsContentRoot(env: Env): string {
  return env.DOCS_CONTENT_ROOT?.trim() || DOCS_CONTENT_ROOT_DEFAULT;
}

const BLOG_REPO_DEFAULT = 'sfrancis2017/sajivfrancis.github.io-master';
const BLOG_BRANCH_DEFAULT = 'master';
const BLOG_CONTENT_ROOT_DEFAULT = 'src/content/blog';

function blogRepo(env: Env): string {
  return env.BLOG_REPO?.trim() || BLOG_REPO_DEFAULT;
}
function blogBranch(env: Env): string {
  return env.BLOG_BRANCH?.trim() || BLOG_BRANCH_DEFAULT;
}
function blogContentRoot(env: Env): string {
  return env.BLOG_CONTENT_ROOT?.trim() || BLOG_CONTENT_ROOT_DEFAULT;
}

// Render a draft's frontmatter object as a YAML block suitable for the
// top of an .mdx file. Mirrors the schema in
// sajivfrancis.github.io-master/src/content/config.ts so the post passes
// Astro's content collection validation. Only emits keys with non-empty
// values; tags is always emitted (possibly as an empty list).
function renderBlogFrontmatter(fm: DraftFrontmatter): string {
  const lines: string[] = ['---'];
  const escape = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  lines.push(`title: ${escape(fm.title)}`);
  if (fm.subtitle) lines.push(`subtitle: ${escape(fm.subtitle)}`);
  lines.push(`description: ${escape(fm.description)}`);
  lines.push(`pubDate: ${fm.pubDate}`);
  if (fm.tags.length) {
    lines.push('tags:');
    for (const t of fm.tags) lines.push(`  - ${escape(t)}`);
  } else {
    lines.push('tags: []');
  }
  lines.push(`draft: ${fm.draft ? 'true' : 'false'}`);
  lines.push(`publishMode: ${fm.publishMode}`);
  lines.push('---');
  return lines.join('\n');
}

// 1. Strip references — inline citations + Sources Consulted + Verification
// checklist sections. Leave diagram contents alone (citations inside Mermaid
// node labels are rare and removing them risks breaking diagram syntax).
// Strip the leading H1 + byline from a whitepaper body before publishing
// to docs.sajivfrancis.com. Starlight renders the frontmatter `title` as
// the page H1, so a `# Title` line inside the body produces a duplicate
// title. The synthesis pipeline also emits a "By Sajiv Francis · DATE"
// byline below the H1, which the Haiku voice rewrite mangles into
// "By Me · DATE" — neither version belongs on the docs page (frontmatter
// already carries `published-at`). Drop both, plus any leading blank lines.
function stripDocsHeader(md: string): string {
  const lines = md.split('\n');
  let i = 0;
  // Skip leading blank lines
  while (i < lines.length && lines[i].trim() === '') i++;
  // Drop a single leading H1 if present
  if (i < lines.length && /^#\s+\S/.test(lines[i])) i++;
  // Skip blank lines between H1 and byline
  while (i < lines.length && lines[i].trim() === '') i++;
  // Drop a byline of the form "By <something>" — covers "By Sajiv Francis · July 2025",
  // "By Me · July 2025", "*By Sajiv Francis*", etc. Match italicized or plain.
  if (i < lines.length && /^\*?By\s+\S/i.test(lines[i].trim())) i++;
  // Skip blank lines after byline
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

function stripReferences(md: string): string {
  let out = md;
  // Inline citations like *(Book — chapter)* or *(SourceFile.md)*. The
  // pattern is italicized parenthetical: asterisk, paren, content, paren,
  // asterisk. Strip with any leading whitespace so periods sit clean.
  out = out.replace(/\s*\*\([^)]*\)\*/g, '');
  // ## Sources Consulted (or ## Sources) — everything until the next H2/H1 or EOF
  out = out.replace(
    /\n##\s+Sources(?:\s+Consulted)?\b[\s\S]*?(?=\n##\s|\n#\s|$)/gi,
    '\n'
  );
  // ## Verification checklist — internal review aid, not public
  out = out.replace(
    /\n##\s+Verification\s+checklist\b[\s\S]*?(?=\n##\s|\n#\s|$)/gi,
    '\n'
  );
  // Normalize: collapse 3+ blank lines to 2, trim trailing whitespace
  out = out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return out;
}

// 2. Rewrite from third-person ("Sajiv argues") to first-person ("I argue").
// Uses Haiku — this is a mechanical voice transformation, doesn't need Sonnet.
// One Anthropic call. Preserves all content, structure, diagrams, citations.
async function rewriteToFirstPerson(md: string, env: Env): Promise<string> {
  const haikuModel = env.ANTHROPIC_HAIKU_MODEL ?? 'claude-haiku-4-5-20251001';
  const system = `You are rewriting a markdown whitepaper from third-person to first-person voice.

The original was written ABOUT Sajiv Francis (the author). You are rewriting it as if Sajiv is publishing it himself on his personal site.

Rules:
1. Change "Sajiv" → "I" (and "Sajiv's" → "my", "him" → "me", "his" → "my", "he" → "I" when referring to Sajiv).
2. Adjust verb conjugation accordingly ("Sajiv argues" → "I argue", "Sajiv has worked" → "I have worked").
3. Preserve ALL other content EXACTLY: headings, bold/italic emphasis, paragraph structure, bullet points, numbered lists, tables, code blocks, Mermaid diagrams (inside \`\`\`mermaid fences), images, links, frontmatter.
4. Do NOT add new content, do NOT change meaning, do NOT summarize or shorten.
5. If a sentence does not refer to Sajiv, leave it EXACTLY as-is.
6. Output the rewritten markdown ONLY — no preamble, no commentary, no "Here is the rewritten version:".`;

  const body = JSON.stringify({
    model: haikuModel,
    // 32k matches the synthesis output cap — voice rewrite preserves input
    // length, so a 20k-token whitepaper needs 20k+ output capacity, otherwise
    // the rewrite gets truncated mid-document. Haiku 4.5 supports up to 64k.
    max_tokens: 32768,
    system,
    messages: [{ role: 'user', content: md }],
  });
  // Use streaming + collect instead of non-streaming retry. For very long
  // whitepapers, Haiku can take 2-5 minutes to generate the full rewrite,
  // which exceeds Cloudflare's idle-connection timeout (~100s) on
  // non-streaming responses. Streaming keeps the connection alive
  // token-by-token, so we can wait as long as Haiku needs to finish.
  // Retries don't help here — each non-streaming attempt hits the same
  // timeout. Streaming fixes the underlying issue.
  return await callAnthropicStreamCollect(body, env);
}

// Stream-and-collect helper: call Anthropic with stream:true, accumulate
// the text content into a single string, return when done. Used for
// long-running generations where the non-streaming variant hits
// Cloudflare's idle timeout. Parses Anthropic's SSE event format
// (`event: content_block_delta` lines with `data: {...}` payload) and
// extracts the `delta.text` from text_delta events.
async function callAnthropicStreamCollect(
  body: string,
  env: Env,
  extraHeaders: Record<string, string> = {}
): Promise<string> {
  // Force stream:true in the body — caller doesn't need to know.
  const parsed: any = JSON.parse(body);
  parsed.stream = true;
  const streamingBody = JSON.stringify(parsed);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ANTHROPIC_API_KEY,
      ...extraHeaders,
    },
    body: streamingBody,
  });
  if (!r.ok || !r.body) {
    const errText = r.body ? (await r.text()).slice(0, 500) : '(no body)';
    throw new Error(`Voice rewrite failed: HTTP ${r.status} ${errText}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Process complete lines. Anthropic SSE uses \n\n between events, but
    // each event has multiple \n-separated lines (event:, data:, etc.).
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          text += event.delta.text;
        }
      } catch {
        // Skip malformed event lines silently
      }
    }
  }
  if (!text) {
    throw new Error('Voice rewrite returned empty content');
  }
  return text;
}

// List top-level + nested section directories under the docs content root
// (e.g. `src/content/docs/`). Used by the publish modal's section dropdown.
//
// Uses GitHub's git/trees API with recursive=1 — one call returns every
// path in the repo, which we filter to directories under the content root
// up to 2 levels deep (top-level + one nested level).
//
// Output is a flat list of relative paths like:
//   ["ai", "ai/agents-and-tools", "ai/rag-and-retrieval",
//    "architecture", "architecture/solution-architecture", ...]
//
// The frontend renders these grouped by top-level in optgroups.
async function listDocsSections(env: Env): Promise<string[]> {
  if (!env.DOCS_GITHUB_TOKEN) {
    throw new Error('DOCS_GITHUB_TOKEN not configured');
  }
  const url = `https://api.github.com/repos/${docsRepo(env)}/git/trees/${docsBranch(env)}?recursive=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.DOCS_GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'chat-worker-publish/1.0',
    },
  });
  if (!res.ok) {
    throw new Error(`List sections failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json();
  const tree: any[] = Array.isArray(data?.tree) ? data.tree : [];
  // Cap depth = 2 (top-level + one nested) to keep the dropdown manageable.
  // Path segment validation prevents path-injection AND filters out any
  // unusual dirs (with spaces, uppercase, dots) that aren't valid docs slugs.
  const root = docsContentRoot(env);
  const prefix = root.endsWith('/') ? root : root + '/';
  const sections = new Set<string>();
  const segmentRx = /^[a-z0-9][a-z0-9-]*$/;
  for (const item of tree) {
    if (item?.type !== 'tree') continue;
    if (typeof item.path !== 'string') continue;
    if (!item.path.startsWith(prefix)) continue;
    const rel = item.path.slice(prefix.length);
    if (!rel) continue;
    const parts = rel.split('/');
    if (parts.length > 2) continue;        // too deep, skip
    if (!parts.every((p: string) => segmentRx.test(p))) continue;
    sections.add(rel);
  }
  return [...sections].sort();
}

// ---- Repo grounding fetcher ----------------------------------------------
//
// Fetches a curated set of high-signal files from a GitHub repo and returns
// them as a single grounding context block. Used by /api/drafts/:id/review
// to ground technical claims in the draft against actual repo contents.
//
// File selection: always try README/CLAUDE.md/configs; opportunistically
// try common entry points. Missing files (404) are skipped silently. Each
// file is capped at ~30k chars; total aggregate is capped at ~80k chars
// per repo (~20k tokens). Cached in REPO_CACHE_KV keyed by repo+SHA so
// successive reviews on the same commit don't re-fetch.

const GROUNDING_CANDIDATE_FILES = [
  // Project documentation (highest signal)
  'README.md',
  'CLAUDE.md',
  'LICENSE',
  // Package + infrastructure manifests (declare the actual stack)
  'package.json',
  'wrangler.toml',
  'docker-compose.yml',
  'Dockerfile',
  'astro.config.mjs',
  'astro.config.ts',
  'next.config.js',
  'vite.config.ts',
  'tsconfig.json',
  '.env.example',
  '.env.full.example',
  // Common Astro / content schema locations
  'src/content/config.ts',
  'src/layouts/BaseLayout.astro',
  // Worker / API entry points
  'worker/wrangler.toml',
  'worker/src/index.ts',
  'worker/index.js',
  'api/index.js',
  'api/Dockerfile',
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
];

const GROUNDING_PER_FILE_CAP = 30_000;
const GROUNDING_PER_REPO_CAP = 80_000;

type RepoGrounding = {
  repo: string;
  branch: string;
  sha: string;
  files: Array<{ path: string; content: string; truncated: boolean }>;
  total_chars: number;
};

// Format a grounding object into the <grounding> XML block consumed by
// the review prompt. Each file is fenced with its path on a marker line.
function formatGroundingForPrompt(groundings: RepoGrounding[]): string {
  if (!groundings.length) return '';
  const parts: string[] = ['<grounding>'];
  for (const g of groundings) {
    parts.push(`<repo name="${g.repo}" branch="${g.branch}" sha="${g.sha.slice(0, 7)}">`);
    for (const f of g.files) {
      parts.push(`<file path="${f.path}"${f.truncated ? ' truncated="true"' : ''}>`);
      parts.push(f.content);
      parts.push('</file>');
    }
    parts.push('</repo>');
  }
  parts.push('</grounding>');
  return parts.join('\n');
}

async function fetchRepoGrounding(repo: string, env: Env): Promise<RepoGrounding | null> {
  if (!env.DOCS_GITHUB_TOKEN) {
    console.warn(`fetchRepoGrounding: no DOCS_GITHUB_TOKEN, skipping ${repo}`);
    return null;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.warn(`fetchRepoGrounding: invalid repo slug "${repo}"`);
    return null;
  }
  const ghHeaders: HeadersInit = {
    Authorization: `Bearer ${env.DOCS_GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sajivfrancis-chat-worker',
  };

  // Step 1: get default branch + latest commit SHA
  let branch = 'main';
  let sha = '';
  try {
    const repoMeta = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders });
    if (!repoMeta.ok) {
      console.warn(`fetchRepoGrounding: repo metadata fetch failed for ${repo}: HTTP ${repoMeta.status}`);
      return null;
    }
    const meta: any = await repoMeta.json();
    branch = meta.default_branch ?? 'main';
    const branchInfo = await fetch(
      `https://api.github.com/repos/${repo}/branches/${branch}`,
      { headers: ghHeaders }
    );
    if (!branchInfo.ok) {
      console.warn(`fetchRepoGrounding: branch fetch failed for ${repo}@${branch}: HTTP ${branchInfo.status}`);
      return null;
    }
    const bi: any = await branchInfo.json();
    sha = bi?.commit?.sha ?? '';
    if (!sha) return null;
  } catch (e: any) {
    console.warn(`fetchRepoGrounding: metadata error for ${repo}: ${e?.message ?? e}`);
    return null;
  }

  // Step 2: check cache
  const cacheKey = `grounding:${repo}:${sha}`;
  if (env.REPO_CACHE_KV) {
    try {
      const cached = (await env.REPO_CACHE_KV.get(cacheKey, 'json')) as RepoGrounding | null;
      if (cached) return cached;
    } catch {
      // Cache miss or read error — fall through to live fetch
    }
  }

  // Step 3: fetch candidate files in parallel (best-effort, skip 404s)
  const fetches = GROUNDING_CANDIDATE_FILES.map(async (path) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}?ref=${sha}`,
        { headers: ghHeaders }
      );
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data?.content || typeof data.content !== 'string') return null;
      // GitHub returns base64 with newlines
      const raw = atob(data.content.replace(/\n/g, ''));
      let content = raw;
      let truncated = false;
      if (content.length > GROUNDING_PER_FILE_CAP) {
        // Keep the head (most signal — imports, exports, types, top of logic)
        // plus a small tail marker.
        content =
          content.slice(0, GROUNDING_PER_FILE_CAP - 2_000) +
          '\n\n... [truncated for grounding budget] ...\n\n' +
          content.slice(-1_500);
        truncated = true;
      }
      return { path, content, truncated };
    } catch {
      return null;
    }
  });
  const results = (await Promise.all(fetches)).filter(
    (f): f is { path: string; content: string; truncated: boolean } => f !== null
  );

  // Step 4: enforce per-repo char cap (in candidate order — high-signal first)
  const kept: Array<{ path: string; content: string; truncated: boolean }> = [];
  let totalChars = 0;
  for (const f of results) {
    const fitChars = Math.min(f.content.length, GROUNDING_PER_REPO_CAP - totalChars);
    if (fitChars <= 0) break;
    if (fitChars < f.content.length) {
      kept.push({
        path: f.path,
        content: f.content.slice(0, fitChars) + '\n\n... [truncated for repo budget] ...',
        truncated: true,
      });
      totalChars = GROUNDING_PER_REPO_CAP;
      break;
    }
    kept.push(f);
    totalChars += f.content.length;
  }

  const grounding: RepoGrounding = {
    repo,
    branch,
    sha,
    files: kept,
    total_chars: totalChars,
  };

  // Step 5: cache for 1 hour
  if (env.REPO_CACHE_KV) {
    try {
      await env.REPO_CACHE_KV.put(cacheKey, JSON.stringify(grounding), {
        expirationTtl: 3600,
      });
    } catch (e: any) {
      console.warn(`fetchRepoGrounding: cache write failed for ${repo}: ${e?.message ?? e}`);
    }
  }
  return grounding;
}

// 3. Commit a file to the docs repo. Uses GitHub's Contents API — supports
// both create (no sha) and update (with sha of existing file). Returns the
// resulting commit + html URL so the caller can show the user where it landed.
async function publishToGithub(
  filePath: string,
  content: string,
  commitMessage: string,
  env: Env,
  opts: { repo?: string; branch?: string } = {}
): Promise<{ html_url: string; commit_sha: string; path: string }> {
  if (!env.DOCS_GITHUB_TOKEN) {
    throw new Error('DOCS_GITHUB_TOKEN not configured on worker');
  }
  const targetRepo = opts.repo ?? docsRepo(env);
  const targetBranch = opts.branch ?? docsBranch(env);
  const apiUrl = `https://api.github.com/repos/${targetRepo}/contents/${filePath}`;
  const ghHeaders: HeadersInit = {
    Authorization: `Bearer ${env.DOCS_GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub requires a User-Agent on all requests
    'User-Agent': 'chat-worker-publish/1.0',
  };

  // GET first to find existing SHA (required for update; absent for create)
  let existingSha: string | undefined;
  try {
    const getRes = await fetch(`${apiUrl}?ref=${targetBranch}`, { headers: ghHeaders });
    if (getRes.ok) {
      const existing: any = await getRes.json();
      existingSha = existing.sha;
    }
    // 404 here is expected for a new file — fall through to PUT
  } catch {
    // Network blip — fall through to PUT; if file exists we'll get a 422
    // and the caller can retry.
  }

  // Base64-encode the markdown body. Use a Latin1-safe roundtrip so
  // non-ASCII chars (em-dashes, smart quotes, accented names) survive.
  const contentB64 = btoa(unescape(encodeURIComponent(content)));
  const body: Record<string, any> = {
    message: commitMessage,
    content: contentB64,
    branch: targetBranch,
  };
  if (existingSha) body.sha = existingSha;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub commit failed: HTTP ${putRes.status} ${errText.slice(0, 400)}`);
  }
  const result: any = await putRes.json();
  return {
    html_url: result.content?.html_url ?? '',
    commit_sha: result.commit?.sha ?? '',
    path: filePath,
  };
}

async function streamFromAnthropic(
  messages: ChatMessage[],
  context: Chunk[],
  skill: string | undefined,
  mode: ChatRequest['mode'],
  authMode: AuthMode,
  env: Env,
  opts: { confidenceMode?: boolean; use1MContext?: boolean } = {}
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
    // Synthesis can produce long whitepapers / multi-slide decks (each diagram
    // alone is 800-1500 tokens, and cross-module whitepapers can have 4-6
    // diagrams + tables + extensive prose). 16k was hitting the cap mid-conclusion
    // on dense outputs. 32k gives substantial headroom while still well under
    // Sonnet 4.6's 64k output ceiling. Chat rarely exceeds 4k.
    max_tokens: mode && mode !== 'chat' ? 32768 : 4096,
    system: systemBlocks,
    messages: outboundMessages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  });

  // Add the 1M-context beta header when needed for direct-injection requests
  // whose total content estimate exceeds the standard 200k context window.
  // Server-side decision: client opts in via inject_full_estimate, worker
  // applies the beta header only when env.ANTHROPIC_BETA_1M is configured.
  const extraHeaders: Record<string, string> = {};
  if (opts.use1MContext && env.ANTHROPIC_BETA_1M) {
    extraHeaders['anthropic-beta'] = env.ANTHROPIC_BETA_1M;
  }
  const upstream = await callAnthropicWithRetry(requestBody, env, extraHeaders);

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

    // Library visibility toggle (owner-only). Used by the chat surface to
    // move chunks between public-eligible and owner-only visibility. Same
    // Bearer auth as /ingest. Body: { source_path, visibility: 'public'|'private' }
    if (url.pathname === '/update_visibility' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        const upstreamUrl = env.RETRIEVE_URL.replace(/\/retrieve\/?$/, '/update_visibility');
        const body = await req.text();
        const r = await fetch(upstreamUrl, {
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

    // ---- Publish to docs.sajivfrancis.com (owner-only) -------------------
    //
    // Single source of truth: synthesized whitepapers are stored in the
    // artifact store WITH references (inline citations + Sources section)
    // for work-tool verification. The publish endpoint transforms on the
    // way out — strips references, rewrites third-person to first-person
    // via Haiku, commits to sfrancis2017/docs at src/content/docs/analysis/
    // <slug>.md so the docs site reads as Sajiv's own analysis.
    //
    // Body: { title, slug, summary, markdown }
    //   - markdown: the current preview content (respects any edits)
    //   - slug: lowercase-hyphenated, validated server-side
    //
    // Returns the GitHub commit info so the UI can link to the result.

    // List the top-level section directories under src/content/docs in the
    // docs repo. Used by the publish-to-docs modal to populate its section
    // dropdown dynamically — no hardcoded section list to maintain.
    if (url.pathname === '/publish-to-docs/sections' && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DOCS_GITHUB_TOKEN) {
        return new Response(
          JSON.stringify({
            error: 'DOCS_GITHUB_TOKEN not configured on worker',
            sections: ['analysis'],
          }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      try {
        const sections = await listDocsSections(env);
        return new Response(JSON.stringify({ sections }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: String(e?.message ?? e), sections: ['analysis'] }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
    }

    if (url.pathname === '/publish-to-docs' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DOCS_GITHUB_TOKEN) {
        return new Response(
          JSON.stringify({
            error: 'DOCS_GITHUB_TOKEN not configured on worker — set via `wrangler secret put DOCS_GITHUB_TOKEN`',
          }),
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

      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
      const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
      const summary = typeof body.summary === 'string' ? body.summary.trim().slice(0, 500) : '';
      const markdown = typeof body.markdown === 'string' ? body.markdown : '';
      // Section: which top-level folder under src/content/docs/ to publish under.
      // Defaults to "analysis" for backwards-compatible callers; can be set to
      // any existing directory name (e.g. "solution-architecture", "frameworks").
      // Frontend populates a dropdown from GET /publish-to-docs/sections.
      const section = typeof body.section === 'string' ? body.section.trim() : 'analysis';
      if (!title) {
        return new Response(JSON.stringify({ error: 'title required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!slug || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) {
        return new Response(
          JSON.stringify({
            error: 'slug must be lowercase, alphanumeric + hyphens, 2-81 chars',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      // Allow either a top-level section ("architecture") or one nested level
      // ("architecture/solution-architecture"). Same char set as slug for
      // each segment so path-injection (.., absolute paths, special chars)
      // is still impossible.
      if (!/^[a-z0-9][a-z0-9-]{0,60}(\/[a-z0-9][a-z0-9-]{0,60})?$/.test(section)) {
        return new Response(
          JSON.stringify({
            error: 'section must be lowercase alphanumeric + hyphens, optionally one "/<subsection>"',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      if (!markdown || markdown.length < 100) {
        return new Response(
          JSON.stringify({ error: 'markdown body required (min 100 chars)' }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }

      const start = Date.now();
      try {
        // 1. Strip references (inline citations + Sources/Verification sections)
        const stripped = stripReferences(markdown);
        // 2. Rewrite third-person → first-person (Haiku, ~$0.02 per call)
        const firstPerson = await rewriteToFirstPerson(stripped, env);
        // 2b. Drop the duplicate H1 + byline. Starlight renders the
        // frontmatter `title` as the page H1, and `published-at` carries
        // the date — neither needs to repeat inside the body.
        const trimmed = stripDocsHeader(firstPerson);
        // 3. Build frontmatter
        const now = new Date();
        const frontmatter =
          '---\n' +
          `title: ${JSON.stringify(title)}\n` +
          `description: ${JSON.stringify(summary || title)}\n` +
          'chat-published: true\n' +
          `published-at: ${now.toISOString()}\n` +
          `chat-corpus-snapshot: ${now.toISOString().slice(0, 10)}\n` +
          '---\n\n';
        const final = frontmatter + trimmed;
        // 4. Commit to GitHub — path is <content-root>/<section>/<slug>.md
        const filePath = `${docsContentRoot(env)}/${section}/${slug}.md`;
        const result = await publishToGithub(
          filePath,
          final,
          `Add ${section}: ${title}`,
          env
        );
        return new Response(
          JSON.stringify({
            ok: true,
            section,
            slug,
            path: result.path,
            github_url: result.html_url,
            commit_sha: result.commit_sha,
            docs_url: `https://docs.sajivfrancis.com/${section}/${slug}`,
            elapsed_ms: Date.now() - start,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      } catch (e: any) {
        return new Response(
          JSON.stringify({
            error: String(e?.message ?? e),
            elapsed_ms: Date.now() - start,
          }),
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

    // ---- Drafts store (owner-only) ---------------------------------------
    //
    // Persistence layer for blog post drafts authored in the /admin/write
    // editor on sajivfrancis.com. Each draft is a JSON record with
    // frontmatter (title, tags, pubDate, etc.) + markdown body. Optional
    // grounding_repos array pins GitHub repos to use as grounding context
    // when the draft is sent through /api/drafts/:id/review.
    //
    // POST   /api/drafts          create — returns { id, created_at, ... }
    // GET    /api/drafts          list metadata (newest first)
    // GET    /api/drafts/:id      fetch full record (frontmatter + body)
    // PUT    /api/drafts/:id      update (full replace of frontmatter + body)
    // DELETE /api/drafts/:id      delete
    //
    // KV metadata holds {id, created_at, updated_at, title, slug} so list()
    // returns useful summaries without N+1 reads.

    if (url.pathname === '/api/drafts' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DRAFTS_KV) {
        return new Response(
          JSON.stringify({ error: 'DRAFTS_KV not configured' }),
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
      const validation = validateDraftPayload(body);
      if (!validation.ok) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const now = new Date();
      const created_at = now.toISOString();
      const ymd = created_at.slice(0, 10).replace(/-/g, '');
      const hms = created_at.slice(11, 19).replace(/:/g, '');
      const rand = Math.random().toString(36).slice(2, 8);
      const id = `dft_${ymd}_${hms}_${rand}`;

      const record = {
        id,
        created_at,
        updated_at: created_at,
        frontmatter: validation.frontmatter,
        body: validation.body,
        grounding_repos: validation.grounding_repos,
      };
      const slug = validation.frontmatter.slug ?? slugify(validation.frontmatter.title);
      try {
        await env.DRAFTS_KV.put(`draft:${id}`, JSON.stringify(record), {
          metadata: {
            id,
            created_at,
            updated_at: created_at,
            title: validation.frontmatter.title,
            slug,
          },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: `KV write failed: ${e?.message ?? e}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      return new Response(
        JSON.stringify({ id, created_at, updated_at: created_at, title: validation.frontmatter.title, slug }),
        { status: 201, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    if (url.pathname === '/api/drafts' && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DRAFTS_KV) {
        return new Response(
          JSON.stringify({ error: 'DRAFTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '100'), 1), 1000);
      const items: any[] = [];
      let cursor: string | undefined;
      try {
        do {
          const result = await env.DRAFTS_KV.list({ prefix: 'draft:', limit: 1000, cursor });
          for (const k of result.keys) {
            const meta = (k.metadata ?? {}) as any;
            items.push({
              id: meta.id ?? k.name.replace(/^draft:/, ''),
              created_at: meta.created_at,
              updated_at: meta.updated_at,
              title: meta.title,
              slug: meta.slug,
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
      items.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
      return new Response(
        JSON.stringify({ drafts: items.slice(0, limit), count: Math.min(items.length, limit) }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    if (url.pathname.startsWith('/api/drafts/') && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DRAFTS_KV) {
        return new Response(
          JSON.stringify({ error: 'DRAFTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const id = url.pathname.slice('/api/drafts/'.length).replace(/\/$/, '');
      if (!/^dft_[a-zA-Z0-9_]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'invalid draft id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        const value = await env.DRAFTS_KV.get(`draft:${id}`, 'json');
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

    if (url.pathname.startsWith('/api/drafts/') && req.method === 'PUT') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DRAFTS_KV) {
        return new Response(
          JSON.stringify({ error: 'DRAFTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const id = url.pathname.slice('/api/drafts/'.length).replace(/\/$/, '');
      if (!/^dft_[a-zA-Z0-9_]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'invalid draft id' }), {
          status: 400,
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
      const validation = validateDraftPayload(body);
      if (!validation.ok) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const existing = (await env.DRAFTS_KV.get(`draft:${id}`, 'json')) as any;
      if (!existing) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      const updated_at = new Date().toISOString();
      const record = {
        id,
        created_at: existing.created_at,
        updated_at,
        frontmatter: validation.frontmatter,
        body: validation.body,
        grounding_repos: validation.grounding_repos,
      };
      const slug = validation.frontmatter.slug ?? slugify(validation.frontmatter.title);
      try {
        await env.DRAFTS_KV.put(`draft:${id}`, JSON.stringify(record), {
          metadata: {
            id,
            created_at: existing.created_at,
            updated_at,
            title: validation.frontmatter.title,
            slug,
          },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: `KV write failed: ${e?.message ?? e}` }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      return new Response(
        JSON.stringify({ id, created_at: existing.created_at, updated_at, title: validation.frontmatter.title, slug }),
        { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    // POST /api/drafts/:id/review — combined-grounding editorial pass.
    // Fetches the draft, fetches GitHub repo grounding (from grounding_repos)
    // and pgvector corpus grounding (from RETRIEVE_URL), then asks Sonnet
    // to return structured suggestions JSON. Preserves voice. See the
    // DRAFT_REVIEW_SYSTEM_PROMPT below for the full rubric.
    {
      const reviewMatch = url.pathname.match(/^\/api\/drafts\/(dft_[a-zA-Z0-9_]+)\/review$/);
      if (reviewMatch && req.method === 'POST') {
        if (!isAuthorized(req, env)) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        if (!env.DRAFTS_KV) {
          return new Response(
            JSON.stringify({ error: 'DRAFTS_KV not configured' }),
            { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        const id = reviewMatch[1];
        const draft = (await env.DRAFTS_KV.get(`draft:${id}`, 'json')) as any;
        if (!draft) {
          return new Response(JSON.stringify({ error: 'draft not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }

        const start = Date.now();
        try {
          // Fetch GitHub grounding from all tagged repos in parallel
          const groundingRepos: string[] = Array.isArray(draft.grounding_repos)
            ? draft.grounding_repos
            : [];
          const ghGroundings = (
            await Promise.all(groundingRepos.map((r) => fetchRepoGrounding(r, env)))
          ).filter((g): g is RepoGrounding => g !== null);

          // pgvector corpus grounding — use draft title + body lead as the
          // retrieval query. Owner mode so all visibility scopes are in play.
          let corpusChunks: Array<{ source: string; text: string }> = [];
          const retrievalQuery = `${draft.frontmatter.title}\n\n${draft.body.slice(0, 800)}`;
          try {
            const clientId = await clientHash(req, env, 'owner');
            const ctx = await getContext(
              retrievalQuery,
              ['docs', 'writing', 'meta'],
              undefined, // owner mode → no visibility filter
              'owner',
              clientId,
              env,
              { topK: 6 }
            );
            corpusChunks = ctx.chunks ?? [];
          } catch (e: any) {
            console.warn(`review: pgvector retrieval failed: ${e?.message ?? e}`);
            // Non-fatal — continue with GitHub grounding only
          }

          // Build the user content block
          const userBlocks: string[] = [];
          if (ghGroundings.length) {
            userBlocks.push(formatGroundingForPrompt(ghGroundings));
          }
          if (corpusChunks.length) {
            userBlocks.push('<corpus_grounding>');
            for (const c of corpusChunks) {
              userBlocks.push(`<chunk source="${c.source.replace(/"/g, '&quot;')}">`);
              userBlocks.push(c.text);
              userBlocks.push('</chunk>');
            }
            userBlocks.push('</corpus_grounding>');
          }
          userBlocks.push('<draft>');
          userBlocks.push(`# ${draft.frontmatter.title}`);
          if (draft.frontmatter.subtitle) {
            userBlocks.push(`*${draft.frontmatter.subtitle}*`);
          }
          userBlocks.push('');
          userBlocks.push(draft.body);
          userBlocks.push('</draft>');
          userBlocks.push('');
          userBlocks.push('Review this draft per your system instructions. Return JSON only.');

          const messageBody = JSON.stringify({
            model: env.ANTHROPIC_MODEL,
            max_tokens: 8192,
            system: DRAFT_REVIEW_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userBlocks.join('\n') }],
          });
          const r = await callAnthropicWithRetry(messageBody, env);
          if (!r.ok) {
            const errText = (await r.text()).slice(0, 500);
            return new Response(
              JSON.stringify({
                error: `Anthropic call failed: HTTP ${r.status} ${errText}`,
                elapsed_ms: Date.now() - start,
              }),
              { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
            );
          }
          const apiResp: any = await r.json();
          const rawText: string =
            (apiResp?.content ?? [])
              .filter((b: any) => b?.type === 'text')
              .map((b: any) => b.text)
              .join('') ?? '';

          // Parse JSON. Be lenient with stray fences (some prompts leak ```json).
          let review: any;
          try {
            const cleaned = rawText
              .trim()
              .replace(/^```(?:json)?\s*/i, '')
              .replace(/\s*```$/i, '');
            review = JSON.parse(cleaned);
          } catch (e: any) {
            return new Response(
              JSON.stringify({
                error: `failed to parse review JSON: ${e?.message ?? e}`,
                raw: rawText.slice(0, 2000),
                elapsed_ms: Date.now() - start,
              }),
              { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
            );
          }

          return new Response(
            JSON.stringify({
              draft_id: id,
              review,
              grounding_meta: {
                github_repos: ghGroundings.map((g) => ({
                  repo: g.repo,
                  branch: g.branch,
                  sha: g.sha.slice(0, 7),
                  file_count: g.files.length,
                  total_chars: g.total_chars,
                })),
                corpus_chunks: corpusChunks.length,
              },
              elapsed_ms: Date.now() - start,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        } catch (e: any) {
          return new Response(
            JSON.stringify({
              error: String(e?.message ?? e),
              elapsed_ms: Date.now() - start,
            }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
      }
    }

    // POST /api/drafts/:id/upload-image — commits an image to the blog repo
    // under public/img/blog/<slug>/<filename> so it can be referenced from
    // the draft markdown. Returns the public URL the editor can paste.
    // Body: multipart/form-data with `file` (image blob) and optional `name`.
    // Max file size: 5 MB. Allowed types: image/png, image/jpeg, image/webp,
    // image/gif, image/svg+xml.
    {
      const imageMatch = url.pathname.match(/^\/api\/drafts\/(dft_[a-zA-Z0-9_]+)\/upload-image$/);
      if (imageMatch && req.method === 'POST') {
        if (!isAuthorized(req, env)) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        if (!env.DRAFTS_KV) {
          return new Response(
            JSON.stringify({ error: 'DRAFTS_KV not configured' }),
            { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        if (!env.DOCS_GITHUB_TOKEN) {
          return new Response(
            JSON.stringify({ error: 'DOCS_GITHUB_TOKEN not configured on worker' }),
            { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        const id = imageMatch[1];
        const draft = (await env.DRAFTS_KV.get(`draft:${id}`, 'json')) as any;
        if (!draft) {
          return new Response(JSON.stringify({ error: 'draft not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          return new Response(JSON.stringify({ error: 'expected multipart/form-data' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        const fileEntry = form.get('file');
        if (!fileEntry || typeof fileEntry === 'string') {
          return new Response(JSON.stringify({ error: 'file (image blob) required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        // Workers types expose form blobs as Blob, not File. Cast to a
        // shape that has the File-like `name` field for downstream use.
        const file = fileEntry as Blob & { name?: string };
        const ALLOWED_TYPES = new Set([
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/gif',
          'image/svg+xml',
        ]);
        if (!ALLOWED_TYPES.has(file.type)) {
          return new Response(
            JSON.stringify({ error: `unsupported image type: ${file.type}` }),
            { status: 415, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        const MAX_SIZE = 5 * 1024 * 1024;
        if (file.size > MAX_SIZE) {
          return new Response(
            JSON.stringify({ error: `image too large (${file.size} bytes, max ${MAX_SIZE})` }),
            { status: 413, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        // Sanitise filename: keep extension, slugify the stem, dedupe with timestamp.
        const rawName = (form.get('name')?.toString() ?? file.name ?? 'image').trim();
        const dotIdx = rawName.lastIndexOf('.');
        const stem = dotIdx > 0 ? rawName.slice(0, dotIdx) : rawName;
        const ext = dotIdx > 0 ? rawName.slice(dotIdx + 1).toLowerCase() : '';
        const safeExt = /^(png|jpg|jpeg|webp|gif|svg)$/i.test(ext) ? ext : 'png';
        const slug = draft.frontmatter.slug ?? slugify(draft.frontmatter.title);
        const stamp = Date.now().toString(36);
        const fileName = `${slugify(stem)}-${stamp}.${safeExt}`;
        const filePath = `public/img/blog/${slug}/${fileName}`;

        // Encode the binary as base64 for the GitHub Contents API.
        const buf = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
        const contentB64 = btoa(binary);

        // Direct Contents API call — publishToGithub re-encodes as UTF-8
        // text, which would corrupt binary uploads. Call the API inline.
        const apiUrl = `https://api.github.com/repos/${blogRepo(env)}/contents/${filePath}`;
        const ghHeaders: HeadersInit = {
          Authorization: `Bearer ${env.DOCS_GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'chat-worker-publish/1.0',
        };
        try {
          const putRes = await fetch(apiUrl, {
            method: 'PUT',
            headers: { ...ghHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `Add image for ${slug}: ${fileName}`,
              content: contentB64,
              branch: blogBranch(env),
            }),
          });
          if (!putRes.ok) {
            const errText = (await putRes.text()).slice(0, 400);
            return new Response(
              JSON.stringify({ error: `GitHub image commit failed: HTTP ${putRes.status} ${errText}` }),
              { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
            );
          }
          // Image is committed; return the public URL the editor can drop
          // into the markdown body. Image lives at /img/blog/<slug>/<file>
          // after the next Astro build pushes to GitHub Pages.
          const publicUrl = `/img/blog/${slug}/${fileName}`;
          return new Response(
            JSON.stringify({
              ok: true,
              path: filePath,
              public_url: publicUrl,
              markdown_snippet: `![${stem}](${publicUrl})`,
              size: file.size,
              type: file.type,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        } catch (e: any) {
          return new Response(
            JSON.stringify({ error: String(e?.message ?? e) }),
            { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
      }
    }

    // POST /api/drafts/:id/publish — commits the draft as an .mdx file
    // to sajivfrancis.github.io-master under src/content/blog/. Uses the
    // shared publishToGithub helper with the blog repo/branch overrides.
    // Marks the draft as published in KV metadata but does NOT auto-delete,
    // so you can re-publish (overwrite) if needed.
    {
      const publishMatch = url.pathname.match(/^\/api\/drafts\/(dft_[a-zA-Z0-9_]+)\/publish$/);
      if (publishMatch && req.method === 'POST') {
        if (!isAuthorized(req, env)) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        if (!env.DRAFTS_KV) {
          return new Response(
            JSON.stringify({ error: 'DRAFTS_KV not configured' }),
            { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        if (!env.DOCS_GITHUB_TOKEN) {
          return new Response(
            JSON.stringify({ error: 'DOCS_GITHUB_TOKEN not configured on worker' }),
            { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
        const id = publishMatch[1];
        const draft = (await env.DRAFTS_KV.get(`draft:${id}`, 'json')) as any;
        if (!draft) {
          return new Response(JSON.stringify({ error: 'draft not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }
        const fm: DraftFrontmatter = draft.frontmatter;
        const slug = fm.slug ?? slugify(fm.title);
        const fileName = `${fm.pubDate}-${slug}.mdx`;
        const filePath = `${blogContentRoot(env)}/${fileName}`;
        const frontmatterBlock = renderBlogFrontmatter({ ...fm, slug });
        const fileContent = `${frontmatterBlock}\n\n${draft.body.trim()}\n`;
        const commitMessage = fm.draft
          ? `Draft post: ${fm.title}`
          : `Add post: ${fm.title}`;
        const start = Date.now();
        try {
          const result = await publishToGithub(filePath, fileContent, commitMessage, env, {
            repo: blogRepo(env),
            branch: blogBranch(env),
          });
          // Update draft metadata with published markers so the list view
          // can show "Published" status. Keep the draft body intact for
          // easy republish/edit.
          const published_at = new Date().toISOString();
          const updated = {
            ...draft,
            published_at,
            published_path: result.path,
            published_commit_sha: result.commit_sha,
          };
          try {
            await env.DRAFTS_KV.put(`draft:${id}`, JSON.stringify(updated), {
              metadata: {
                id,
                created_at: draft.created_at,
                updated_at: draft.updated_at,
                title: fm.title,
                slug,
                published_at,
              },
            });
          } catch {
            // Non-fatal: the post is already committed; metadata sync can be retried.
          }
          return new Response(
            JSON.stringify({
              ok: true,
              draft_id: id,
              path: result.path,
              github_url: result.html_url,
              commit_sha: result.commit_sha,
              blog_url: `https://sajivfrancis.com/blog/${slug}/`,
              published_at,
              elapsed_ms: Date.now() - start,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        } catch (e: any) {
          return new Response(
            JSON.stringify({
              error: String(e?.message ?? e),
              elapsed_ms: Date.now() - start,
            }),
            { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
          );
        }
      }
    }

    if (url.pathname.startsWith('/api/drafts/') && req.method === 'DELETE') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      if (!env.DRAFTS_KV) {
        return new Response(
          JSON.stringify({ error: 'DRAFTS_KV not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...cors } }
        );
      }
      const id = url.pathname.slice('/api/drafts/'.length).replace(/\/$/, '');
      if (!/^dft_[a-zA-Z0-9_]+$/.test(id)) {
        return new Response(JSON.stringify({ error: 'invalid draft id' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        await env.DRAFTS_KV.delete(`draft:${id}`);
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

      // Direct-injection decision with two budget tiers:
      //   - Standard tier (≤175k tokens): always allowed when client opts in.
      //     200k context − ~15-25k for system prompt + chat history +
      //     response budget leaves ~175k usable for pinned source content.
      //   - 1M tier (175k–800k tokens): only allowed when env.ANTHROPIC_BETA_1M
      //     is set (Anthropic API account must support the long-context beta).
      //     Prompts over 200k get billed at ~2× standard input rate.
      //   - Beyond 800k: never inject; fall back to top-K=15 within source filter.
      const STANDARD_TIER_TOKENS = 175_000;
      const LONG_CONTEXT_TIER_TOKENS = 800_000;
      const has1MTierAvailable = !!env.ANTHROPIC_BETA_1M;
      const reqInjectFull =
        !!body.inject_full &&
        confidenceMode &&
        Array.isArray(body.source_paths) &&
        body.source_paths.length > 0;
      const clientEstimate = typeof body.inject_full_estimate === 'number'
        ? body.inject_full_estimate
        : 0;

      let injectFull = false;
      let use1MContext = false;
      if (reqInjectFull) {
        if (clientEstimate <= STANDARD_TIER_TOKENS) {
          injectFull = true;
        } else if (
          clientEstimate <= LONG_CONTEXT_TIER_TOKENS &&
          has1MTierAvailable
        ) {
          injectFull = true;
          use1MContext = true;
        }
        // else: injectFull stays false → falls back to top-K within source filter
      }

      // Skip RAG retrieval when synthesizing — the chat is the source of truth.
      let chunks: Chunk[] = [];
      if (!synthesizing) {
        const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
        const query = lastUser?.content ?? '';
        const visibility = authMode === 'public' ? ['public'] : undefined;
        const ctx = await getContext(query, body.topics, visibility, authMode, clientId, env, {
          sourcePaths: body.source_paths,
          // Confidence mode without direct injection widens top-K to 15 within
          // the source-path filter. With direct injection, top-K is irrelevant
          // (droplet returns all chunks from the pinned sources).
          topK: confidenceMode && !injectFull ? 15 : undefined,
          injectFull,
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
        { confidenceMode, use1MContext }
      );
      // Merge CORS into the streaming response
      const headers = new Headers(streamResp.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v as string));
      return new Response(streamResp.body, { status: streamResp.status, headers });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};

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
   * 'chat' (default): normal RAG chat turn.
   * 'synthesize-whitepaper': synthesize the conversation into a polished whitepaper
   *   markdown. Skips RAG retrieval (the chat is the source).
   * 'synthesize-slides': synthesize into slide-deck markdown (--- separated).
   */
  mode?: 'chat' | 'synthesize-whitepaper' | 'synthesize-slides';
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
4. Embed Mermaid diagrams from the chat verbatim in \`\`\`mermaid fences. Don't redraw them — copy the source.
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
5. Diagram slides: \`# Heading\` followed immediately by the Mermaid diagram in a \`\`\`mermaid fence. No bullet text on diagram slides.
6. Conclusion slide: \`# Key takeaways\` with 2–3 bullets.
7. **Do NOT use inline citations.** If third-party reference materials (books, papers, etc.) were drawn from, add a final \`# Sources consulted\` slide listing book titles and authors only — no file paths, chunk identifiers, or topic slugs. For content from Sajiv's own writing, no citation is needed. If no third-party references were used, omit the Sources slide.
8. 5–10 slides total. No fluff.
9. Speak about Sajiv in the third person. Never name his employer — use "a Fortune 50 technology company."
10. The output is markdown only. Start with the title slide.`,
};

// Skill modes — server-side overlays appended to the system prompt.
// Keep the set small and high-signal for EA / software engineering use.
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
- Use Markdown freely. Mermaid diagrams in \`\`\`mermaid fences when they clarify.
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
  env: Env
): Promise<RetrievedContext> {
  const hydeText = await hyde(query, env);
  const embedding = await embedQuery(hydeText, env);
  if (!embedding) return { chunks: MOCK_CHUNKS, hydeText };

  const cleanTopics = (topics ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

async function streamFromAnthropic(
  messages: ChatMessage[],
  context: Chunk[],
  skill: string | undefined,
  mode: ChatRequest['mode'],
  authMode: AuthMode,
  env: Env
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
        body.mode === 'synthesize-whitepaper' || body.mode === 'synthesize-slides';

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

      // Skip RAG retrieval when synthesizing — the chat is the source of truth.
      let chunks: Chunk[] = [];
      if (!synthesizing) {
        const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
        const query = lastUser?.content ?? '';
        const visibility = authMode === 'public' ? ['public'] : undefined;
        const ctx = await getContext(query, body.topics, visibility, authMode, clientId, env);
        chunks = ctx.chunks;
      }

      const streamResp = await streamFromAnthropic(
        body.messages,
        chunks,
        body.skill,
        body.mode,
        authMode,
        env
      );
      // Merge CORS into the streaming response
      const headers = new Headers(streamResp.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v as string));
      return new Response(streamResp.body, { status: streamResp.status, headers });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};

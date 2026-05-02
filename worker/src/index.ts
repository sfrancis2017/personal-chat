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
  ALLOWED_ORIGINS: string;
  CHAT_TOKEN: string;
  OPENAI_API_KEY: string;
  RETRIEVE_URL: string;
  RETRIEVE_TOKEN: string;
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

function isAuthorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return timingSafeEqual(match[1], env.CHAT_TOKEN);
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
2. Reorganize into a clear narrative: title → executive summary → context → analysis → recommendation/conclusion → sources.
3. Use ## and ### headings. Use comparison tables where they clarify.
4. Embed Mermaid diagrams from the chat verbatim in \`\`\`mermaid fences. Don't redraw them — copy the source.
5. Match the Stratechery / Dan Luu register: direct, lightly editorial, no hedging, no "happy to help."
6. Cite sources at the end with a **Sources** section, deduplicated.
7. Don't pad. Aim for 600–1500 words depending on chat depth.
8. Speak about Sajiv in the third person. Never name his employer — use "a Fortune 50 technology company."
9. The output is markdown only. Start with the title (# Title) on the first line.`,
  'synthesize-slides': `You are converting a conversation between Sajiv Francis and his assistant into a slide-deck markdown for presentation.

Rules:
1. Drop iterative back-and-forth. Keep only the refined final content.
2. Use \`---\` on its own line to separate slides.
3. Slide 1 (title slide): just \`# Title\` and an optional subtitle (one short line).
4. Body slides: \`# Section title\`, then 3–5 concise bullet points (max ~10 words per bullet).
5. Diagram slides: \`# Heading\` followed immediately by the Mermaid diagram in a \`\`\`mermaid fence. No bullet text on diagram slides.
6. Conclusion slide: \`# Key takeaways\` with 2–3 bullets.
7. Sources slide: \`# Sources\` with a deduplicated list of citations.
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
1. Ground your answers in the provided <context> blocks. Synthesize and reason from them, applying general technical knowledge to interpret what's there or fill gaps in framing. Don't invent specific facts about Sajiv personally (his projects, opinions, history) that aren't in the context — for those, say plainly what's missing.
2. Don't pad. Match the Stratechery / Dan Luu register: direct, lightly editorial, no hedging, no "happy to help."                                                                        
3. Never name Sajiv's employer. He works at "a Fortune 50 technology company."                                                                                                            
4. If a question is completely off-topic (general trivia, current events, unrelated to Sajiv's work or technical interests), redirect: "This chat is grounded in Sajiv's writing — try sajivfrancis.com or docs.sajivfrancis.com."                                                                                                                                               
                                                                                                                                                                                          
Format:                                                                                                                                                                                   
- Use Markdown freely — headings (## / ###), tables, bullet lists, code blocks. The chat renders Markdown.
- For complex analytical questions (architecture decisions, comparisons, design tradeoffs), structure as: short summary → context → analysis → recommendation. Keep simple factual answ.                                                                                                                                                                                   
- For process flows, system architectures, or component relationships, emit a Mermaid diagram in a \`\`\`mermaid fence — the chat renders it inline.
- For Mermaid node labels with multiple lines, use \`<br>\` not \`\\n\` (e.g. \`["SAP ECC<br>(FI/CO Documents)"]\`).
- Subgraph identifiers must NOT share names with any node ID, even nodes inside that subgraph. Use distinct IDs — e.g. \`subgraph ML_LAYER ... ML[Machine Learning] end\`, not \`subgraph ML ... ML[Machine Learning] end\` (mermaid will reject the latter as a parent-of-itself cycle).
- Define every \`classDef\` AND every \`class NodeId className\` assignment at the very top of the diagram, before edges. (Trailing class statements break rendering if the response is truncated.)
- Color Mermaid nodes with \`classDef\` (define at top, apply via \`class NodeId className\`) using these conventions:
  • Data / integration architecture: \`source\` (#fff3e0 fill, #e65100 stroke), \`integration\` (#e8f5e9 / #2e7d32), \`target\` (#e3f2fd / #1565c0), \`reporting\` (#f3e5f5 / #6a1b9a).
  • ArchiMate (when the question is enterprise-architecture-shaped): \`business\` (#fff3b0 / #cc9a06), \`application\` (#b8d4f0 / #1565c0), \`technology\` (#c5e8c5 / #2e7d32), \`motivation\` (#e6c5f0 / #6a1b9a).
  • Azure: \`compute\` (#cfe2ff / #084298), \`storage\` (#d1e7dd / #0f5132), \`network\` (#fff3cd / #664d03), \`identity\` (#f8d7da / #842029).
  Pick the convention that fits the domain; use only one per diagram. Keep \`classDef\` definitions minimal — typically 3–5 classes.                                      
- Cite source chunks inline as italics, e.g. *(LocalizedSLMBuild.md)* or *(BPMN — S4HANA / J62_S4HANA_ASSETACCOUNTING)*, using each chunk's source attribute.                             
- End every substantive response with a **Sources** heading and a deduped bullet list of the source attributes you cited.`;  

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

async function getContext(
  query: string,
  topics: string[] | undefined,
  env: Env
): Promise<Chunk[]> {
  const embedding = await embedQuery(query, env);
  if (!embedding) return MOCK_CHUNKS;

  const cleanTopics = (topics ?? [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean);

  try {
    const r = await fetch(env.RETRIEVE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RETRIEVE_TOKEN}`,
      },
      body: JSON.stringify(
        cleanTopics.length ? { embedding, topics: cleanTopics } : { embedding }
      ),
    });
    if (!r.ok) {
      console.error('retrieve API error', r.status, await r.text());
      return MOCK_CHUNKS;
    }
    const j: any = await r.json();
    if (!j.chunks?.length) return MOCK_CHUNKS;

    return j.chunks.map((c: any) => {
      const title =
        (c.metadata && typeof c.metadata === 'object' && c.metadata.title) ||
        c.source_path ||
        c.source_url ||
        'doc';
      const topicSuffix = c.topic ? ` — ${c.topic}` : '';
      return { source: `${title}${topicSuffix}`, text: c.text };
    });
  } catch (e) {
    console.error('retrieve fetch failed', e);
    return MOCK_CHUNKS;
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

async function streamFromAnthropic(
  messages: ChatMessage[],
  context: Chunk[],
  skill: string | undefined,
  mode: ChatRequest['mode'],
  env: Env
): Promise<Response> {
  let systemWithContext: string;

  if (mode && mode !== 'chat' && SYNTHESIS_PROMPTS[mode]) {
    // Synthesis mode: ignore RAG context, use the dedicated prompt.
    // The conversation history IS the source for synthesis.
    systemWithContext = SYNTHESIS_PROMPTS[mode];
  } else {
    const contextBlock = context
      .map((c) => `<chunk source="${c.source}">\n${c.text}\n</chunk>`)
      .join('\n\n');
    const skillOverlay = skill && SKILLS[skill] ? `\n\n${SKILLS[skill]}` : '';
    systemWithContext = `${SYSTEM_PROMPT}${skillOverlay}\n\n<context>\n${contextBlock}\n</context>`;
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      // Synthesis can produce long whitepapers / multi-slide decks; chat turns rarely exceed 4k.
      max_tokens: mode && mode !== 'chat' ? 8192 : 4096,
      system: systemWithContext,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }),
  });

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

    if (url.pathname === '/topics' && req.method === 'GET') {
      if (!isAuthorized(req, env)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }
      try {
        // Derive the /topics URL from RETRIEVE_URL (which points at /retrieve)
        const topicsUrl = env.RETRIEVE_URL.replace(/\/retrieve\/?$/, '/topics');
        const r = await fetch(topicsUrl, {
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

    if (url.pathname === '/chat' && req.method === 'POST') {
      if (!isAuthorized(req, env)) {
        return new Response(
          `data: ${JSON.stringify({ error: 'Unauthorized: invalid or missing access token.' })}\n\n`,
          {
            status: 401,
            headers: { 'Content-Type': 'text/event-stream', ...cors },
          }
        );
      }

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

      // Skip RAG retrieval when synthesizing — the chat is the source of truth.
      let context: Chunk[] = [];
      if (!synthesizing) {
        const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
        const query = lastUser?.content ?? '';
        context = await getContext(query, body.topics, env);
      }

      const streamResp = await streamFromAnthropic(
        body.messages,
        context,
        body.skill,
        body.mode,
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

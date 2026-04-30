/**
 * Personal RAG chat — Cloudflare Worker.
 *
 * Tonight: mock context (hardcoded chunks) → Claude with streaming.
 * Saturday: replace getContext() with pgvector query against DO Postgres.
 */

interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ALLOWED_ORIGINS: string;
  // Saturday additions:
  // OPENAI_API_KEY: string;
  // DATABASE_URL: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
}

const SYSTEM_PROMPT = `You are a personal assistant grounded in Sajiv Francis's published writing, architecture notes, and talks. You speak about him in the third person ("Sajiv has written…", "his view is…").

Rules:
1. Answer ONLY from the provided <context> blocks. If the context does not cover the question, say so plainly — do not invent facts about Sajiv.
2. Quote or paraphrase tightly. Don't pad.
3. Never name Sajiv's employer. He works at "a Fortune 50 technology company."
4. If a question is off-topic from his work (general trivia, current events, code help), redirect: "This chat is grounded in Sajiv's writing — try sajivfrancis.com or docs.sajivfrancis.com for that."
5. Voice: direct, lightly editorial. Match Stratechery / Dan Luu register. No hedging, no "I'd be happy to help."`;

// ---- Mock context retrieval (Saturday: replace with pgvector query) -------

const MOCK_CHUNKS = [
  {
    source: 'About Sajiv',
    text: 'Sajiv Francis is an Enterprise Architect at a Fortune 50 technology company, leading AI programmes at the intersection of enterprise systems, cloud architecture, and large language models. TOGAF 10 certified. Background in NLP, document intelligence, and SAP ecosystems. Canadian citizen based in Arizona.',
  },
  {
    source: 'Optey retrospective (2026 blog post)',
    text: "In 2018, Sajiv built Optey — a document-ingestion pipeline with NLP parsing, restructured output, and an adaptive-learning UI. In 2026 terms it was a RAG-based adaptive-learning SaaS, before RAG had a name. The architectural pattern (ingest → structure → personalize) and the cognitive-science framing (the Interactive Learning Model — ILM) hold up. What he missed: the scale of foundation models, embedding-based retrieval, and the fact that the AI layer itself would commoditize while the workflow and UX layer would matter most. His one-line thesis: capable models force complex architectures because they make ambitious products possible.",
  },
  {
    source: 'Gravitite',
    text: 'Gravitite is an AI-native Enterprise Architecture platform Sajiv is building separately from his day job. Distinct from his Fortune 50 role and the personal portfolio site.',
  },
  {
    source: '5-post publishing sequence',
    text: 'Sajiv is executing a 5-post blog sequence over 2026 as part of a 90-day O-1 evidence sprint: (1) the Optey origin story / NLP-before-RAG (published 2026-04-27); (2) BPMN-2018 → AI-2026 bridge; (3) why architects don\'t use the tools built for them; (4) universal IR for multi-notation diagrams; (5) agentic AI for enterprise architecture practice. Tier-1 venue targets: The Open Group, Journal of Enterprise Architecture, IEEE Software, IEEE IT Professional.',
  },
  {
    source: 'Public surfaces',
    text: 'sajivfrancis.com is the personal portfolio + blog (Astro + MDX, deployed via GitHub Pages). docs.sajivfrancis.com is the architecture knowledge base. Both serve the EA + AI thought-leadership track.',
  },
];

async function getContext(_query: string, _env: Env): Promise<typeof MOCK_CHUNKS> {
  // TODO Saturday: embed query via OpenAI, query pgvector, return top-K chunks.
  return MOCK_CHUNKS;
}

// ---- CORS -----------------------------------------------------------------

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ---- Anthropic streaming proxy --------------------------------------------

async function streamFromAnthropic(
  messages: ChatMessage[],
  context: typeof MOCK_CHUNKS,
  env: Env
): Promise<Response> {
  const contextBlock = context
    .map((c) => `<chunk source="${c.source}">\n${c.text}\n</chunk>`)
    .join('\n\n');

  const systemWithContext = `${SYSTEM_PROMPT}\n\n<context>\n${contextBlock}\n</context>`;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
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

    if (url.pathname === '/chat' && req.method === 'POST') {
      let body: ChatRequest;
      try {
        body = await req.json();
      } catch {
        return new Response('Invalid JSON', { status: 400, headers: cors });
      }
      if (!body.messages?.length) {
        return new Response('messages required', { status: 400, headers: cors });
      }

      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const query = lastUser?.content ?? '';
      const context = await getContext(query, env);

      const streamResp = await streamFromAnthropic(body.messages, context, env);
      // Merge CORS into the streaming response
      const headers = new Headers(streamResp.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v as string));
      return new Response(streamResp.body, { status: streamResp.status, headers });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};

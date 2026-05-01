/**
 * Personal RAG chat — Cloudflare Worker.
 *
 * Embeds the user's query via OpenAI text-embedding-3-small, retrieves
 * top-K chunks from pgvector on the DO droplet, then streams a grounded
 * Claude response.
 */

import postgres from 'postgres';

interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ALLOWED_ORIGINS: string;
  CHAT_TOKEN: string;
  OPENAI_API_KEY: string;
  DATABASE_URL: string;
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
}

const SYSTEM_PROMPT = `You are a personal assistant grounded in Sajiv Francis's published writing, architecture notes, and talks. You speak about him in the third person ("Sajiv has written…", "his view is…").

Rules:
1. Answer ONLY from the provided <context> blocks. If the context does not cover the question, say so plainly — do not invent facts about Sajiv.
2. Quote or paraphrase tightly. Don't pad.
3. Never name Sajiv's employer. He works at "a Fortune 50 technology company."
4. If a question is off-topic from his work (general trivia, current events, code help), redirect: "This chat is grounded in Sajiv's writing — try sajivfrancis.com or docs.sajivfrancis.com for that."
5. Voice: direct, lightly editorial. Match Stratechery / Dan Luu register. No hedging, no "I'd be happy to help."`;

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

async function getContext(query: string, env: Env): Promise<Chunk[]> {
  const embedding = await embedQuery(query, env);
  if (!embedding) return MOCK_CHUNKS;

  const sql = postgres(env.DATABASE_URL, {
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
  });

  try {
    const vec = '[' + embedding.join(',') + ']';
    const rows = await sql<
      Array<{
        source_url: string | null;
        source_path: string | null;
        text: string;
        topic: string | null;
        metadata: any;
      }>
    >`
      SELECT source_url, source_path, text, topic, metadata
      FROM chunks
      ORDER BY embedding <=> ${vec}::vector
      LIMIT 6
    `;
    if (!rows.length) return MOCK_CHUNKS;

    return rows.map((r) => {
      const title =
        (r.metadata && typeof r.metadata === 'object' && (r.metadata as any).title) ||
        r.source_path ||
        r.source_url ||
        'doc';
      const topicSuffix = r.topic ? ` — ${r.topic}` : '';
      return { source: `${title}${topicSuffix}`, text: r.text };
    });
  } catch (e) {
    console.error('pgvector query failed', e);
    return MOCK_CHUNKS;
  } finally {
    await sql.end({ timeout: 5 });
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

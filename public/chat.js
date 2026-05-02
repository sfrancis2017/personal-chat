import { marked } from 'https://esm.sh/marked@13.0.3';
import DOMPurify from 'https://esm.sh/dompurify@3.1.7';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';

marked.setOptions({ gfm: true, breaks: false });
mermaid.initialize({
  startOnLoad: false,
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
  securityLevel: 'loose',
  fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
  flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true },
  themeVariables: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: '14px',
  },
});

// Worker endpoint. Override via ?api=https://your-worker.dev for local testing.
const params = new URLSearchParams(window.location.search);
const API_URL =
  params.get('api') ??
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8787/chat'
    : 'https://chat-worker.sfrancis2017.workers.dev/chat');

const TOPICS_URL = API_URL.replace(/\/chat\/?$/, '/topics');

const TOKEN_KEY = 'chat-access-token';

function getToken() {
  let t = localStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = window.prompt(
      'Enter your access token to use this chat.\n(Set as CHAT_TOKEN in the Worker; saved to this device only.)'
    );
    if (t) {
      t = t.trim();
      localStorage.setItem(TOKEN_KEY, t);
    }
  }
  return t;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

const conversation = document.getElementById('conversation');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendButton = document.getElementById('send');
const themeToggle = document.getElementById('theme-toggle');
const welcome = document.querySelector('.welcome');
const topicChips = document.getElementById('topic-chips');
const topicChipsRow = document.getElementById('topic-chips-row');
const sidebar = document.getElementById('sidebar');
const sidebarList = document.getElementById('sidebar-list');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const newChatBtn = document.getElementById('new-chat');

// ---- Chat history storage ------------------------------------------------
// Each chat: {id, title, createdAt, updatedAt, messages: [{role,content}], topics: [string]}
const HISTORY_KEY = 'chat-history-v1';
const ACTIVE_KEY = 'chat-history-active';

let chats = [];
let activeChatId = null;
const selectedTopics = new Set();

function loadChatsFromStorage() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(chats));
    if (activeChatId) localStorage.setItem(ACTIVE_KEY, activeChatId);
  } catch {
    // Silent — likely quota; chat still works in-memory
  }
}

function makeId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newChat() {
  const c = {
    id: makeId(),
    title: 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    topics: [],
  };
  chats.unshift(c);
  return c;
}

function getActiveChat() {
  return chats.find((c) => c.id === activeChatId);
}

function deriveTitle(text) {
  const first = text.trim().split('\n')[0];
  return first.length > 40 ? first.slice(0, 40).trim() + '…' : first;
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function prettifyTopic(slug) {
  return slug
    .split('-')
    .map((w) =>
      w.length <= 3 && w.toUpperCase() === w.toUpperCase()
        ? w.toUpperCase().replace(/[^A-Z0-9]/g, '')
        : w.charAt(0).toUpperCase() + w.slice(1)
    )
    .join(' ');
}

async function loadTopics() {
  const token = localStorage.getItem(TOKEN_KEY);
  // Don't trigger an auth prompt just to load chips — wait for first message.
  if (!token) return;
  try {
    const r = await fetch(TOPICS_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const j = await r.json();
    const topics = Array.isArray(j.topics) ? j.topics : [];
    if (!topics.length) return;
    renderTopics(topics);
  } catch {
    // silent — chips are optional
  }
}

function renderTopics(topics) {
  topicChipsRow.replaceChildren();
  for (const { topic, count } of topics) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topic-chip';
    btn.dataset.topic = topic;
    btn.setAttribute('aria-pressed', selectedTopics.has(topic) ? 'true' : 'false');
    btn.title = `${count} chunk${count === 1 ? '' : 's'} indexed`;
    btn.innerHTML = `${prettifyTopic(topic)}<span class="topic-chip-count">${count}</span>`;
    btn.addEventListener('click', () => {
      if (selectedTopics.has(topic)) {
        selectedTopics.delete(topic);
        btn.setAttribute('aria-pressed', 'false');
      } else {
        selectedTopics.add(topic);
        btn.setAttribute('aria-pressed', 'true');
      }
      const chat = getActiveChat();
      if (chat) {
        chat.topics = [...selectedTopics];
        saveChats();
      }
    });
    topicChipsRow.appendChild(btn);
  }
  topicChips.hidden = false;
}

function refreshChipPressedState() {
  if (!topicChipsRow) return;
  topicChipsRow.querySelectorAll('.topic-chip').forEach((btn) => {
    const t = btn.dataset.topic;
    btn.setAttribute('aria-pressed', selectedTopics.has(t) ? 'true' : 'false');
  });
}

// ---- Sidebar + active-chat orchestration ---------------------------------

function renderSidebar() {
  sidebarList.replaceChildren();
  for (const chat of chats) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.setAttribute('role', 'listitem');
    row.dataset.chatId = chat.id;
    if (chat.id === activeChatId) row.setAttribute('aria-current', 'true');

    const content = document.createElement('div');
    content.className = 'chat-row-content';

    const title = document.createElement('div');
    title.className = 'chat-row-title';
    title.textContent = chat.title;
    title.title = 'Double-click to rename';

    const meta = document.createElement('div');
    meta.className = 'chat-row-meta';
    const preview = chat.messages[chat.messages.length - 1]?.content?.slice(0, 60) ?? '';
    meta.textContent = preview ? `${relativeTime(chat.updatedAt)} · ${preview}` : relativeTime(chat.updatedAt);

    content.append(title, meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-row-delete';
    del.setAttribute('aria-label', 'Delete chat');
    del.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const empty = chat.messages.length === 0;
      if (empty || confirm(`Delete "${chat.title}"?`)) deleteChat(chat.id);
    });

    row.append(content, del);

    row.addEventListener('click', () => {
      if (chat.id !== activeChatId) {
        setActiveChat(chat.id);
      }
      closeMobileSidebar();
    });

    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      title.contentEditable = 'true';
      title.focus();
      const range = document.createRange();
      range.selectNodeContents(title);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    title.addEventListener('blur', () => {
      title.contentEditable = 'false';
      const v = title.textContent.trim() || 'Untitled';
      chat.title = v;
      title.textContent = v;
      saveChats();
    });

    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        title.blur();
      } else if (e.key === 'Escape') {
        title.textContent = chat.title;
        title.blur();
      }
    });

    sidebarList.appendChild(row);
  }
}

function setActiveChat(id) {
  activeChatId = id;
  selectedTopics.clear();
  const chat = getActiveChat();
  if (chat) for (const t of chat.topics) selectedTopics.add(t);
  refreshChipPressedState();
  renderConversation();
  renderSidebar();
  saveChats();
}

function deleteChat(id) {
  const idx = chats.findIndex((c) => c.id === id);
  if (idx < 0) return;
  chats.splice(idx, 1);
  if (chats.length === 0) {
    const c = newChat();
    activeChatId = c.id;
  } else if (activeChatId === id) {
    activeChatId = chats[0].id;
  }
  saveChats();
  setActiveChat(activeChatId);
}

async function renderConversation() {
  conversation.replaceChildren();
  if (welcome) {
    delete welcome.dataset.dismissed;
    welcome.style.display = '';
    conversation.appendChild(welcome);
  }
  const chat = getActiveChat();
  if (!chat || chat.messages.length === 0) return;
  for (const m of chat.messages) {
    const body = appendMessage(m.role, '');
    if (m.role === 'assistant') {
      // Fire-and-forget markdown render; await isn't necessary since each appends to its own node.
      renderMarkdown(body, m.content).catch(() => {
        body.textContent = m.content;
      });
    } else {
      body.textContent = m.content;
    }
  }
}

function openMobileSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.hidden = false;
  sidebarToggle.setAttribute('aria-expanded', 'true');
}
function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.hidden = true;
  sidebarToggle.setAttribute('aria-expanded', 'false');
}

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
}

let mermaidIdCounter = 0;

async function renderMarkdown(container, source) {
  // Render markdown → HTML, sanitize, then promote any ```mermaid fences to SVG.
  const html = marked.parse(source);
  const clean = DOMPurify.sanitize(html);
  container.innerHTML = clean;

  const blocks = container.querySelectorAll('pre > code.language-mermaid');
  for (const code of blocks) {
    const def = code.textContent ?? '';
    const id = `mermaid-${Date.now()}-${++mermaidIdCounter}`;
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-block';
    try {
      const { svg } = await mermaid.render(id, def);
      wrap.innerHTML = svg;
      wrap.appendChild(buildDiagramActions(wrap, def));
    } catch (e) {
      wrap.classList.add('mermaid-error');
      wrap.innerHTML = `<pre><code>${escapeHtml(def)}</code></pre>`;
      const note = document.createElement('div');
      note.className = 'mermaid-error-note';
      note.textContent = `Diagram render failed: ${e?.message ?? e}`;
      wrap.prepend(note);
    }
    code.parentElement.replaceWith(wrap);
  }
  scrollToBottom();
}

function buildDiagramActions(wrap, source) {
  const actions = document.createElement('div');
  actions.className = 'mermaid-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'mermaid-action';
  copyBtn.textContent = 'Copy source';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(source);
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
    setTimeout(() => (copyBtn.textContent = 'Copy source'), 1500);
  });

  const dlBtn = document.createElement('button');
  dlBtn.type = 'button';
  dlBtn.className = 'mermaid-action';
  dlBtn.textContent = 'Download SVG';
  dlBtn.addEventListener('click', () => {
    const svgEl = wrap.querySelector('svg');
    if (!svgEl) return;
    const clone = svgEl.cloneNode(true);
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('xmlns:xlink'))
      clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    inlineForeignObjectsAsText(clone);
    const xml = new XMLSerializer().serializeToString(clone);
    const doc = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
    const blob = new Blob([doc], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagram-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  actions.append(copyBtn, dlBtn);
  return actions;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Convert mermaid's foreignObject-based labels to native <text> elements so the
// downloaded SVG renders in viewers that don't process foreignObject (Illustrator,
// draw.io, many SVG previewers).
function inlineForeignObjectsAsText(svg) {
  const fos = Array.from(svg.querySelectorAll('foreignObject'));
  for (const fo of fos) {
    const lines = [];
    fo.querySelectorAll('div, p, span').forEach((el) => {
      // Only leaf text-bearing nodes; skip wrappers
      if (el.children.length > 0) return;
      const t = (el.textContent ?? '').trim();
      if (t) lines.push(t);
    });
    if (lines.length === 0) {
      const t = (fo.textContent ?? '').trim();
      if (t) lines.push(t);
    }
    if (lines.length === 0) {
      fo.remove();
      continue;
    }

    const x = parseFloat(fo.getAttribute('x') ?? '0') || 0;
    const y = parseFloat(fo.getAttribute('y') ?? '0') || 0;
    const w = parseFloat(fo.getAttribute('width') ?? '0') || 0;
    const h = parseFloat(fo.getAttribute('height') ?? '0') || 0;

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-family', 'Inter, ui-sans-serif, system-ui, sans-serif');
    text.setAttribute('font-size', '13');
    text.setAttribute('fill', 'currentColor');

    const cx = x + w / 2;
    const lineHeight = 16;
    const startY = y + h / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => {
      const ts = document.createElementNS(SVG_NS, 'tspan');
      ts.setAttribute('x', String(cx));
      ts.setAttribute('y', String(startY + i * lineHeight));
      ts.textContent = line;
      text.appendChild(ts);
    });

    fo.replaceWith(text);
  }

  // Inject a default text color so currentColor resolves in standalone viewers
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = 'svg { color: #1a1a1a; }';
  svg.insertBefore(style, svg.firstChild);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendMessage(role, text = '') {
  if (welcome && !welcome.dataset.dismissed) {
    welcome.dataset.dismissed = 'true';
    welcome.style.display = 'none';
  }
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;
  wrapper.innerHTML = `
    <div class="role">${role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Sajiv'}</div>
    <div class="body"></div>
  `;
  const body = wrapper.querySelector('.body');
  body.textContent = text;
  conversation.appendChild(wrapper);
  scrollToBottom();
  return body;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

input.addEventListener('input', autosize);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  // Re-init mermaid with the new theme; existing diagrams stay as-is until next render.
  mermaid.initialize({
    startOnLoad: false,
    theme: next === 'dark' ? 'dark' : 'default',
    securityLevel: 'loose',
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: true },
  themeVariables: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    fontSize: '14px',
  },
  });
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  let chat = getActiveChat();
  if (!chat) {
    chat = newChat();
    activeChatId = chat.id;
  }

  appendMessage('user', text);
  chat.messages.push({ role: 'user', content: text });
  if (chat.messages.length === 1) chat.title = deriveTitle(text);
  chat.updatedAt = Date.now();
  saveChats();
  renderSidebar();

  input.value = '';
  autosize();
  sendButton.disabled = true;

  const assistantBody = appendMessage('assistant', '');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  assistantBody.appendChild(cursor);

  let assistantText = '';

  try {
    const token = getToken();
    if (!token) throw new Error('Access token required.');
    // Lazy-load chips after first token entry (initial loadTopics() bails if no token).
    if (topicChips.hidden) loadTopics();

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: chat.messages,
        topics: [...selectedTopics],
      }),
    });

    if (res.status === 401) {
      clearToken();
      throw new Error('Access token rejected. Refresh and try again.');
    }
    if (!res.body) {
      throw new Error(`HTTP ${res.status} (no body)`);
    }
    if (!res.ok) {
      // Worker errors come back as SSE; read the first event for the real message.
      const text = await res.text();
      const match = text.match(/data: (\{[^\n]+\})/);
      if (match) {
        try {
          const json = JSON.parse(match[1]);
          throw new Error(json.error ?? `HTTP ${res.status}`);
        } catch (e) {
          if (e.message?.startsWith('HTTP') || e.message?.startsWith('Upstream')) throw e;
        }
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: lines starting with "data: ", separated by blank lines
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';

      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          if (json.delta) {
            assistantText += json.delta;
            // re-render text + keep cursor at end
            assistantBody.textContent = assistantText;
            assistantBody.appendChild(cursor);
            scrollToBottom();
          }
          if (json.error) throw new Error(json.error);
        } catch (err) {
          // ignore malformed chunks
        }
      }
    }

    cursor.remove();
    await renderMarkdown(assistantBody, assistantText);
    chat.messages.push({ role: 'assistant', content: assistantText });
    chat.updatedAt = Date.now();
    saveChats();
    renderSidebar();
  } catch (err) {
    cursor.remove();
    assistantBody.parentElement.classList.remove('assistant');
    assistantBody.parentElement.classList.add('error');
    assistantBody.parentElement.querySelector('.role').textContent = 'Error';
    assistantBody.textContent = err.message ?? 'Something went wrong.';
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
});

// ---- Init ----------------------------------------------------------------

newChatBtn.addEventListener('click', () => {
  // Don't pile up empty "New chat" rows — if one exists, jump to it.
  const empty = chats.find((c) => c.messages.length === 0);
  if (empty) {
    setActiveChat(empty.id);
  } else {
    const c = newChat();
    setActiveChat(c.id);
  }
  closeMobileSidebar();
  input.focus();
});

sidebarToggle.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) closeMobileSidebar();
  else openMobileSidebar();
});
sidebarBackdrop.addEventListener('click', closeMobileSidebar);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('open')) closeMobileSidebar();
});

(function init() {
  chats = loadChatsFromStorage();
  const storedActive = localStorage.getItem(ACTIVE_KEY);
  if (chats.length === 0) {
    const c = newChat();
    activeChatId = c.id;
  } else {
    activeChatId = chats.some((c) => c.id === storedActive) ? storedActive : chats[0].id;
  }
  renderSidebar();
  // setActiveChat re-renders the conversation and applies any saved topics
  setActiveChat(activeChatId);
  loadTopics();
  input.focus();
})();

import { marked } from 'https://esm.sh/marked@13.0.3';
import DOMPurify from 'https://esm.sh/dompurify@3.1.7';
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';
// pptxgenjs lazy-loaded only when the user clicks Save as PPT (~150KB)
let pptxgen = null;
async function getPptxgen() {
  if (pptxgen) return pptxgen;
  const mod = await import('https://esm.sh/pptxgenjs@3.12.0');
  pptxgen = mod.default ?? mod;
  return pptxgen;
}

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
const promptsList = document.getElementById('sidebar-prompts-list');
const skillSelect = document.getElementById('skill-select');
const exportTriggerBtn = document.getElementById('export-trigger');
const exportMenuEl = document.getElementById('export-menu');
const printHeaderEl = document.getElementById('print-header');
const printTitleEl = document.getElementById('print-title');
const printDateEl = document.getElementById('print-date');

// Quick prompts — small set tuned for EA / software engineering use of the corpus.
const QUICK_PROMPTS = [
  'Generate a Mermaid diagram for [topic] using ArchiMate colors, grounded in my notes.',
  'Compare [A] vs [B] from my published work as a table — strengths, tradeoffs, when to use which.',
  'What have I written about [topic]? Summarize the through-line in 3 bullets.',
  'Turn the SAP Press / BPMN content on [topic] into a process flow diagram.',
  'Draft a whitepaper intro section on [topic], citing the relevant chunks from my corpus.',
];

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
  if (chat) {
    for (const t of chat.topics) selectedTopics.add(t);
    if (skillSelect) skillSelect.value = chat.skill ?? '';
  }
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

function renderQuickPrompts() {
  if (!promptsList) return;
  promptsList.replaceChildren();
  for (const text of QUICK_PROMPTS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar-prompt';
    btn.textContent = text;
    btn.addEventListener('click', () => {
      input.value = text;
      autosize();
      // Place cursor at first [placeholder] for quick edit
      const m = text.match(/\[([^\]]+)\]/);
      if (m) {
        const start = text.indexOf(m[0]);
        const end = start + m[0].length;
        input.focus();
        input.setSelectionRange(start, end);
      } else {
        input.focus();
      }
      closeMobileSidebar();
    });
    promptsList.appendChild(btn);
  }
}

const SIDEBAR_COLLAPSED_KEY = 'chat-sidebar-collapsed';

function isMobileViewport() {
  return window.matchMedia('(max-width: 800px)').matches;
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

function setDesktopCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore quota */
  }
}

function toggleSidebar() {
  if (isMobileViewport()) {
    if (sidebar.classList.contains('open')) closeMobileSidebar();
    else openMobileSidebar();
  } else {
    setDesktopCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  }
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
      wrap.innerHTML = expandViewBox(svg, 12);
      // Strip mermaid's width="100%" attr and inline style="max-width: <px>".
      // Without these, only our CSS controls sizing — eliminates the
      // attribute-vs-CSS interaction that lets the SVG push parent containers wider.
      const svgEl = wrap.querySelector('svg');
      if (svgEl) {
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
        svgEl.removeAttribute('style');
      }
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

  // Add a Copy button to every remaining code block (non-mermaid)
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const code = pre.querySelector('code');
    if (!code) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent ?? '');
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Failed';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    });
    pre.appendChild(btn);
  });

  scrollToBottom();
}

function prefillComposer(text) {
  input.value = text;
  autosize();
  input.focus();
  // Cursor at end so user can keep typing
  input.setSelectionRange(text.length, text.length);
}

function buildDiagramActions(wrap, source) {
  const actions = document.createElement('div');
  actions.className = 'mermaid-actions';

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'mermaid-action';
  expandBtn.textContent = 'Expand';
  expandBtn.addEventListener('click', () => {
    const svg = wrap.querySelector('svg');
    if (svg) openDiagramModal(svg);
  });

  const explainBtn = document.createElement('button');
  explainBtn.type = 'button';
  explainBtn.className = 'mermaid-action';
  explainBtn.textContent = 'Explain';
  explainBtn.addEventListener('click', () =>
    prefillComposer(
      'Walk me through that diagram step by step — explain each section, key flows, and any technical details. Cite sources where relevant.'
    )
  );

  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'mermaid-action';
  regenBtn.textContent = 'Regenerate';
  regenBtn.addEventListener('click', () =>
    prefillComposer(
      'Regenerate that diagram with a cleaner layout, clearer labels, and the same technical accuracy.'
    )
  );

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

  actions.append(expandBtn, explainBtn, regenBtn, copyBtn, dlBtn);
  return actions;
}

const diagramModal = document.getElementById('diagram-modal');
const diagramModalContent = document.getElementById('diagram-modal-content');
const diagramModalClose = document.getElementById('diagram-modal-close');

function openDiagramModal(svg) {
  if (!diagramModal || !diagramModalContent) return;
  // Clone so we don't detach the in-page SVG
  const clone = svg.cloneNode(true);
  // Strip any constraining inline styles so the clone renders at natural size
  clone.removeAttribute('style');
  clone.style.maxWidth = 'none';
  diagramModalContent.replaceChildren(clone);
  diagramModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDiagramModal() {
  if (!diagramModal) return;
  diagramModal.hidden = true;
  diagramModalContent.replaceChildren();
  document.body.style.overflow = '';
}

if (diagramModal) {
  diagramModalClose?.addEventListener('click', closeDiagramModal);
  diagramModal.addEventListener('click', (e) => {
    if (e.target === diagramModal) closeDiagramModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !diagramModal.hidden) closeDiagramModal();
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Expand mermaid's viewBox by `margin` on each side so node strokes at the
// edges aren't clipped by sub-pixel rounding when the SVG scales to fit a
// narrow chat column.
function expandViewBox(svgString, margin = 12) {
  return svgString.replace(/viewBox="([^"]+)"/, (_, vb) => {
    const parts = vb.split(/\s+/).map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) return `viewBox="${vb}"`;
    const [x, y, w, h] = parts;
    return `viewBox="${x - margin} ${y - margin} ${w + margin * 2} ${h + margin * 2}"`;
  });
}

// Convert mermaid's foreignObject-based labels to native <text> elements so the
// downloaded SVG renders in viewers that don't process foreignObject (Illustrator,
// draw.io, many SVG previewers).
function inlineForeignObjectsAsText(svg) {
  const fos = Array.from(svg.querySelectorAll('foreignObject'));
  for (const fo of fos) {
    // Mermaid puts label content in a span.nodeLabel (or a div fallback) inside
    // the foreignObject, with <br> for line breaks. textContent flattens those
    // away — use innerHTML and split on <br> so each line becomes its own tspan.
    const label = fo.querySelector('span.nodeLabel') || fo.querySelector('div') || fo;
    const html = label.innerHTML || '';
    let lines = html
      .split(/<br\s*\/?>/i)
      .map((l) => l.replace(/<[^>]+>/g, '').trim())
      .map((l) =>
        l
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
      )
      .filter(Boolean);
    if (lines.length === 0) {
      const t = (fo.textContent ?? '').trim();
      if (t) lines = [t];
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
        skill: chat.skill ?? '',
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

if (skillSelect) {
  skillSelect.addEventListener('change', () => {
    const chat = getActiveChat();
    if (!chat) return;
    chat.skill = skillSelect.value || undefined;
    saveChats();
  });
}

function exportRawPdf() {
  const chat = getActiveChat();
  if (!chat || chat.messages.length === 0) {
    alert('Nothing to export — start a conversation first.');
    return;
  }
  if (printTitleEl) printTitleEl.textContent = chat.title || 'Chat';
  if (printDateEl) {
    printDateEl.textContent = new Date(chat.updatedAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }
  if (printHeaderEl) printHeaderEl.hidden = false;
  setTimeout(() => {
    window.print();
    if (printHeaderEl) printHeaderEl.hidden = true;
  }, 50);
}

// ---- Synthesis preview pane ----------------------------------------------

const previewModal = document.getElementById('preview-modal');
const previewTitle = document.getElementById('preview-title');
const previewSubtitle = document.getElementById('preview-subtitle');
const previewContent = document.getElementById('preview-content');
const previewEdit = document.getElementById('preview-edit');
const previewStatus = document.getElementById('preview-status');
const previewCloseBtn = document.getElementById('preview-close');
const previewRegenBtn = document.getElementById('preview-regenerate');
const previewEditToggleBtn = document.getElementById('preview-edit-toggle');
const previewSavePdfBtn = document.getElementById('preview-save-pdf');
const previewSavePptBtn = document.getElementById('preview-save-ppt');

let previewMarkdown = '';
let previewMode = null; // 'synthesize-whitepaper' | 'synthesize-slides'
let previewEditing = false;

function setPreviewActionsEnabled(enabled) {
  [previewRegenBtn, previewEditToggleBtn, previewSavePdfBtn, previewSavePptBtn].forEach((b) => {
    if (b) b.disabled = !enabled;
  });
  // PPT only makes sense for slides mode
  if (previewSavePptBtn) {
    previewSavePptBtn.disabled = !enabled || previewMode !== 'synthesize-slides';
  }
}

function openPreview(mode) {
  previewMode = mode;
  previewMarkdown = '';
  previewEditing = false;
  previewEdit.hidden = true;
  previewEdit.value = '';
  previewContent.hidden = false;
  previewContent.replaceChildren();
  previewModal.hidden = false;
  // Mode class drives slides-vs-whitepaper print behavior (page breaks).
  previewModal.classList.toggle('mode-slides', mode === 'synthesize-slides');
  previewModal.classList.toggle('mode-whitepaper', mode === 'synthesize-whitepaper');
  document.body.style.overflow = 'hidden';
  previewTitle.textContent = mode === 'synthesize-slides' ? 'Slide deck preview' : 'Whitepaper preview';
  previewSubtitle.textContent = '';
  previewStatus.textContent = 'Synthesizing — this may take 10–30 seconds.';
  setPreviewActionsEnabled(false);
}

function closePreview() {
  previewModal.hidden = true;
  document.body.style.overflow = '';
  previewMode = null;
  previewMarkdown = '';
}

async function exportSynthesize(mode) {
  const chat = getActiveChat();
  if (!chat || chat.messages.length === 0) {
    alert('Nothing to synthesize — start a conversation first.');
    return;
  }

  openPreview(mode);

  try {
    const token = getToken();
    if (!token) throw new Error('Access token required.');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messages: chat.messages,
        mode,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let received = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
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
            received += json.delta;
            // Show streaming text as plain (rendered properly on stream complete)
            previewContent.textContent = received;
          }
          if (json.error) throw new Error(json.error);
        } catch {
          // skip malformed
        }
      }
    }

    previewMarkdown = received;
    await renderMarkdown(previewContent, previewMarkdown);
    previewStatus.textContent = `Done — ${received.split(/\s+/).length} words.`;
    setPreviewActionsEnabled(true);
  } catch (err) {
    previewContent.textContent = `Synthesis failed: ${err?.message ?? err}`;
    previewStatus.textContent = 'Error.';
  }
}

if (previewCloseBtn) previewCloseBtn.addEventListener('click', closePreview);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewModal && !previewModal.hidden) closePreview();
});

if (previewRegenBtn) {
  previewRegenBtn.addEventListener('click', () => {
    if (previewMode) exportSynthesize(previewMode);
  });
}

if (previewEditToggleBtn) {
  previewEditToggleBtn.addEventListener('click', async () => {
    if (!previewEditing) {
      // Switch to edit mode
      previewEdit.value = previewMarkdown;
      previewEdit.hidden = false;
      previewContent.hidden = true;
      previewEditToggleBtn.textContent = 'Update preview';
      previewEditing = true;
      previewEdit.focus();
    } else {
      // Apply edits and switch back to rendered preview
      previewMarkdown = previewEdit.value;
      previewEdit.hidden = true;
      previewContent.hidden = false;
      previewContent.replaceChildren();
      await renderMarkdown(previewContent, previewMarkdown);
      previewEditToggleBtn.textContent = 'Edit markdown';
      previewEditing = false;
    }
  });
}

if (previewSavePdfBtn) {
  previewSavePdfBtn.addEventListener('click', () => {
    if (!previewMarkdown) return;
    document.body.classList.add('printing-preview');
    setTimeout(() => {
      window.print();
      // Removed after print dialog (blocking call returns when dismissed)
      document.body.classList.remove('printing-preview');
    }, 50);
  });
}
// ---- SVG → PNG (for embedding mermaid diagrams in PPT) ------------------

async function svgToPngDataUrl(svgEl, scale = 2) {
  // Clone + normalize foreignObjects to native text so canvas can rasterize.
  const clone = svgEl.cloneNode(true);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  inlineForeignObjectsAsText(clone);
  const xml = new XMLSerializer().serializeToString(clone);
  // unescape + encodeURIComponent handles non-Latin1 chars cleanly
  const svg64 = btoa(unescape(encodeURIComponent(xml)));
  const dataUrl = 'data:image/svg+xml;base64,' + svg64;

  const bbox = svgEl.getBoundingClientRect();
  const w = Math.max(bbox.width, 200);
  const h = Math.max(bbox.height, 200);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = (e) => reject(new Error('SVG load failed: ' + e));
    img.src = dataUrl;
  });
}

// ---- PPT export from preview ---------------------------------------------

async function savePreviewAsPpt() {
  if (!previewMarkdown) return;
  previewSavePptBtn.disabled = true;
  previewStatus.textContent = 'Building slide deck…';

  try {
    const Pptx = await getPptxgen();
    const pres = new Pptx();
    pres.layout = 'LAYOUT_WIDE'; // 13.333" x 7.5" (16:9)

    // Walk preview content, splitting on <hr> for slide boundaries.
    const slides = [[]];
    for (const el of previewContent.children) {
      if (el.tagName === 'HR') {
        slides.push([]);
      } else {
        slides[slides.length - 1].push(el);
      }
    }

    const PAGE_W = 13.333;
    const PAGE_H = 7.5;
    const MARGIN = 0.5;
    const CONTENT_W = PAGE_W - MARGIN * 2;

    for (const slideEls of slides) {
      if (slideEls.length === 0) continue;
      const pSlide = pres.addSlide();
      let y = MARGIN;

      for (const el of slideEls) {
        const tag = el.tagName;
        if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
          const fontSize = tag === 'H1' ? 32 : tag === 'H2' ? 24 : 20;
          pSlide.addText(el.textContent.trim(), {
            x: MARGIN, y, w: CONTENT_W, h: 0.9,
            fontSize, bold: true, fontFace: 'Inter, Arial',
            color: '1A1A1A',
          });
          y += 1.0;
        } else if (el.classList?.contains('mermaid-block')) {
          const svg = el.querySelector('svg');
          if (svg) {
            try {
              const { dataUrl, width, height } = await svgToPngDataUrl(svg, 2);
              const remaining = PAGE_H - y - MARGIN;
              const fitH = Math.min(remaining, 5);
              const aspect = width / height;
              let imgW = fitH * aspect;
              let imgH = fitH;
              if (imgW > CONTENT_W) {
                imgW = CONTENT_W;
                imgH = imgW / aspect;
              }
              const xCentered = (PAGE_W - imgW) / 2;
              pSlide.addImage({ data: dataUrl, x: xCentered, y, w: imgW, h: imgH });
              y += imgH + 0.2;
            } catch (e) {
              console.warn('Diagram → PNG failed', e);
            }
          }
        } else if (tag === 'UL' || tag === 'OL') {
          const items = [...el.querySelectorAll(':scope > li')].map((li) => ({
            text: li.textContent.trim(),
            options: { bullet: true },
          }));
          if (items.length) {
            const blockH = Math.min(PAGE_H - y - MARGIN, 0.4 * items.length + 0.2);
            pSlide.addText(items, {
              x: MARGIN + 0.2, y, w: CONTENT_W - 0.4, h: blockH,
              fontSize: 16, fontFace: 'Inter, Arial',
              color: '333333',
              valign: 'top',
            });
            y += blockH + 0.1;
          }
        } else if (tag === 'P' || tag === 'BLOCKQUOTE') {
          const text = el.textContent.trim();
          if (text) {
            const blockH = 0.5;
            pSlide.addText(text, {
              x: MARGIN, y, w: CONTENT_W, h: blockH,
              fontSize: 14, fontFace: 'Inter, Arial',
              color: '333333',
              valign: 'top',
            });
            y += blockH + 0.1;
          }
        } else if (tag === 'TABLE') {
          const rows = [...el.querySelectorAll('tr')].map((tr) =>
            [...tr.children].map((cell) => ({
              text: cell.textContent.trim(),
              options: cell.tagName === 'TH' ? { bold: true, fill: { color: 'EEEEEE' } } : {},
            }))
          );
          if (rows.length) {
            const tableH = Math.min(PAGE_H - y - MARGIN, 0.4 * rows.length + 0.2);
            pSlide.addTable(rows, {
              x: MARGIN, y, w: CONTENT_W, h: tableH,
              fontSize: 12, fontFace: 'Inter, Arial', border: { type: 'solid', pt: 1, color: 'CCCCCC' },
            });
            y += tableH + 0.1;
          }
        }
        if (y > PAGE_H - MARGIN) break; // overflow guard
      }
    }

    const chat = getActiveChat();
    const fname = `${(chat?.title ?? 'Chat').replace(/[^A-Za-z0-9-_ ]/g, '_').slice(0, 60)}.pptx`;
    await pres.writeFile({ fileName: fname });
    previewStatus.textContent = `Saved ${fname}.`;
  } catch (e) {
    console.error(e);
    previewStatus.textContent = `PPT export failed: ${e?.message ?? e}`;
  } finally {
    previewSavePptBtn.disabled = previewMode !== 'synthesize-slides';
  }
}

if (previewSavePptBtn) {
  previewSavePptBtn.addEventListener('click', savePreviewAsPpt);
}

function toggleExportMenu(open) {
  if (!exportMenuEl || !exportTriggerBtn) return;
  const willOpen = open ?? exportMenuEl.hidden;
  exportMenuEl.hidden = !willOpen;
  exportTriggerBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

if (exportTriggerBtn && exportMenuEl) {
  exportTriggerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExportMenu();
  });
  exportMenuEl.addEventListener('click', (e) => {
    const target = e.target.closest('.export-menu-item');
    if (!target) return;
    const action = target.dataset.export;
    toggleExportMenu(false);
    if (action === 'raw-pdf') exportRawPdf();
    else if (action === 'synthesize-whitepaper') exportSynthesize('synthesize-whitepaper');
    else if (action === 'synthesize-slides') exportSynthesize('synthesize-slides');
  });
  document.addEventListener('click', (e) => {
    if (!exportMenuEl.hidden && !exportMenuEl.contains(e.target) && e.target !== exportTriggerBtn) {
      toggleExportMenu(false);
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !exportMenuEl.hidden) toggleExportMenu(false);
  });
}

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarBackdrop.addEventListener('click', closeMobileSidebar);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('open')) closeMobileSidebar();
});

(function init() {
  // Restore desktop collapsed state (mobile uses drawer pattern, not this class)
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
      document.body.classList.add('sidebar-collapsed');
      sidebarToggle.setAttribute('aria-expanded', 'false');
    }
  } catch {
    /* ignore */
  }

  chats = loadChatsFromStorage();
  const storedActive = localStorage.getItem(ACTIVE_KEY);
  if (chats.length === 0) {
    const c = newChat();
    activeChatId = c.id;
  } else {
    activeChatId = chats.some((c) => c.id === storedActive) ? storedActive : chats[0].id;
  }
  renderSidebar();
  renderQuickPrompts();
  // setActiveChat re-renders the conversation and applies any saved topics
  setActiveChat(activeChatId);
  loadTopics();
  input.focus();
})();

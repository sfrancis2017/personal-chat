// Worker endpoint. Override via ?api=https://your-worker.dev for local testing.
const params = new URLSearchParams(window.location.search);
const API_URL =
  params.get('api') ??
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8787/chat'
    : 'https://chat-worker.sfrancis2017.workers.dev/chat');

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

const history = [];

function scrollToBottom() {
  conversation.scrollTop = conversation.scrollHeight;
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
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  appendMessage('user', text);
  history.push({ role: 'user', content: text });

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

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages: history }),
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
    history.push({ role: 'assistant', content: assistantText });
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

input.focus();

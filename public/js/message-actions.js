/**
 * message-actions.js
 * Per-message Copy / Share / Thumbs Up / Thumbs Down for assistant messages.
 *
 * Usage:
 *   1. Set MessageActions.workerUrl to the chat worker base URL (optional).
 *   2. Call MessageActions.attach(messageEl, { content, messageId, title })
 *      after each assistant message is rendered into the DOM.
 *
 * Persistence: ratings live in localStorage under `chat_feedback`.
 * If workerUrl is set, ratings also POST to {workerUrl}/feedback.
 * No external dependencies.
 */
const MessageActions = (() => {
  let workerUrl = '';

  const STORAGE_KEY = 'chat_feedback';

  function loadFeedback() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }
  function saveFeedback(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage full — fail silently */
    }
  }
  function getRating(messageId) {
    return loadFeedback()[messageId] ?? null;
  }
  function setRating(messageId, rating) {
    const data = loadFeedback();
    if (data[messageId] === rating) {
      delete data[messageId];
      saveFeedback(data);
      return null;
    }
    data[messageId] = rating;
    saveFeedback(data);
    return rating;
  }

  async function postFeedback(messageId, rating, content) {
    if (!workerUrl) return;
    try {
      await fetch(`${workerUrl}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId,
          rating,
          excerpt: content?.slice(0, 300) ?? '',
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.warn('[message-actions] Feedback POST failed:', err);
    }
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  async function shareResponse(content, title) {
    const shareData = {
      title: title ?? 'Chat response',
      text: (content?.slice(0, 300) ?? '') + (content?.length > 300 ? '…' : ''),
      url: window.location.href,
    };
    if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
      await navigator.share(shareData);
      return 'shared';
    }
    await copyToClipboard(window.location.href);
    return 'url_copied';
  }

  function flashButton(btn, label, ms = 1500) {
    const original = btn.innerHTML;
    btn.innerHTML = label;
    btn.classList.add('ma-btn--flashed');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('ma-btn--flashed');
    }, ms);
  }

  const ICONS = {
    copy: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
    copied: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    share: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`,
    thumbUp: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"></path><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>`,
    thumbDown: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"></path><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>`,
  };

  function buildActionBar({ content, messageId, title }) {
    const bar = document.createElement('div');
    bar.className = 'ma-bar';
    bar.dataset.messageId = messageId;

    // Copy
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'ma-btn ma-btn--copy';
    copyBtn.innerHTML = ICONS.copy;
    copyBtn.title = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy response');
    copyBtn.addEventListener('click', async () => {
      try {
        await copyToClipboard(content);
        flashButton(copyBtn, ICONS.copied + '<span class="ma-btn-label">Copied</span>');
      } catch {
        flashButton(copyBtn, '<span class="ma-btn-label">Failed</span>');
      }
    });

    // Share
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'ma-btn ma-btn--share';
    shareBtn.innerHTML = ICONS.share;
    shareBtn.title = 'Share';
    shareBtn.setAttribute('aria-label', 'Share response');
    shareBtn.addEventListener('click', async () => {
      try {
        const result = await shareResponse(content, title);
        if (result === 'url_copied') {
          flashButton(shareBtn, ICONS.copied + '<span class="ma-btn-label">Link copied</span>');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          flashButton(shareBtn, '<span class="ma-btn-label">Failed</span>');
        }
      }
    });

    // Thumbs Up / Down
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'ma-btn ma-btn--up';
    upBtn.innerHTML = ICONS.thumbUp;
    upBtn.title = 'Good response';
    upBtn.setAttribute('aria-label', 'Good response');

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'ma-btn ma-btn--down';
    downBtn.innerHTML = ICONS.thumbDown;
    downBtn.title = 'Bad response';
    downBtn.setAttribute('aria-label', 'Bad response');

    const saved = getRating(messageId);
    if (saved === 'up') upBtn.classList.add('ma-btn--active');
    if (saved === 'down') downBtn.classList.add('ma-btn--active');

    function applyRating(rating) {
      const newRating = setRating(messageId, rating);
      upBtn.classList.toggle('ma-btn--active', newRating === 'up');
      downBtn.classList.toggle('ma-btn--active', newRating === 'down');
      postFeedback(messageId, newRating, content);
    }

    upBtn.addEventListener('click', () => applyRating('up'));
    downBtn.addEventListener('click', () => applyRating('down'));

    const sep = document.createElement('span');
    sep.className = 'ma-sep';
    sep.setAttribute('aria-hidden', 'true');

    bar.append(sep, copyBtn, shareBtn, upBtn, downBtn);
    return bar;
  }

  function attach(messageEl, { content, messageId, title, appendTo } = {}) {
    if (!messageEl) return;
    if (messageEl.querySelector('.ma-bar')) return; // avoid double-attach
    const id =
      messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const bar = buildActionBar({ content, messageId: id, title });
    (appendTo ?? messageEl).appendChild(bar);
  }

  return {
    attach,
    set workerUrl(url) {
      workerUrl = url;
    },
    get workerUrl() {
      return workerUrl;
    },
  };
})();

window.MessageActions = MessageActions;

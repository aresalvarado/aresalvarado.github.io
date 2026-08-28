/**
 * Signal RSS Reader — frontend.
 *
 * Loads normalized articles from the Cloudflare Worker, then filters and renders
 * them. Modern mode and ASCII mode share one DOM; only presentation differs.
 */

// Set this to your deployed Worker origin, with no trailing slash.
const WORKER_URL = 'https://rss-proxy.aresronaldoalvarado.workers.dev';

const MODE_KEY = 'signal-reader-mode';

const state = {
  articles: [],
  visible: [],
  mode: localStorage.getItem(MODE_KEY) === 'ascii' ? 'ascii' : 'modern',
  selectedIndex: -1
};

const els = {
  body: document.body,
  list: document.querySelector('#article-list'),
  feedback: document.querySelector('#feedback'),
  search: document.querySelector('#search-input'),
  source: document.querySelector('#source-filter'),
  count: document.querySelector('#result-count'),
  updated: document.querySelector('#last-updated'),
  status: document.querySelector('#sync-status'),
  modeToggle: document.querySelector('#mode-toggle'),
  modeLabel: document.querySelector('#mode-label'),
  refresh: document.querySelector('#refresh-button'),
  clock: document.querySelector('#footer-clock'),
  keyHelp: document.querySelector('#key-help'),
  health: document.querySelector('#source-health')
};

/* --------------------------------------------------------------- Helpers */

const escapeHtml = (value = '') =>
  String(value).replace(/[&<>'"]/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])
  );

// The Worker already drops non-http(s) links; this is the second line of defence
// because the value is interpolated straight into an href.
function safeHref(link) {
  try {
    const url = new URL(link);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch {
    return '#';
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'DATE UNKNOWN';
  return date
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    .toUpperCase();
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `UPDATED ${formatDate(value)} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/* -------------------------------------------------------------- Feedback */

// The three states are mutually exclusive, so each render decides exactly one.
function showFeedback(html, variant = '') {
  els.feedback.className = `feedback${variant ? ` ${variant}` : ''}`;
  els.feedback.innerHTML = html;
  els.feedback.hidden = false;
}

function showLoading(message) {
  showFeedback(`<span class="loader" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`);
}

function showError(message) {
  showFeedback(`<strong>CONNECTION ERROR</strong><br>${escapeHtml(message)}`, 'error');
}

function showEmpty(message) {
  showFeedback(escapeHtml(message), 'empty');
}

/* ------------------------------------------------------------- Rendering */

function matchesFilters(article, term, source) {
  if (source !== 'all' && article.source !== source) return false;
  if (!term) return true;
  return `${article.title} ${article.summary || ''} ${article.source}`.toLowerCase().includes(term);
}

function articleMarkup(article, index) {
  return `<article class="article-card" data-index="${index}" tabindex="-1">
    <div class="article-top">
      <span class="source-badge">${escapeHtml(article.source)}</span>
      <time class="article-date" datetime="${escapeHtml(article.publishedAt)}">${formatDate(article.publishedAt)}</time>
    </div>
    <h2>${escapeHtml(article.title)}</h2>
    <p class="article-summary">${escapeHtml(article.summary || 'No summary available.')}</p>
    <a class="article-link" href="${escapeHtml(safeHref(article.link))}" target="_blank" rel="noopener noreferrer">OPEN ARTICLE ↗</a>
  </article>`;
}

function render() {
  const term = els.search.value.trim().toLowerCase();
  const source = els.source.value;

  state.visible = state.articles.filter(article => matchesFilters(article, term, source));
  state.selectedIndex = -1;

  els.list.innerHTML = state.visible.map(articleMarkup).join('');
  els.list.hidden = state.visible.length === 0;

  els.count.textContent = state.visible.length
    ? `${state.visible.length} ${state.visible.length === 1 ? 'STORY' : 'STORIES'} DISPLAYED`
    : 'NO STORIES';

  if (state.visible.length) {
    els.feedback.hidden = true;
  } else if (state.articles.length) {
    showEmpty('No stories match this filter.');
  } else {
    // A successful fetch that returned nothing is an empty state, not a hang.
    showEmpty('No stories available right now. Every feed came back empty — try Refresh in a moment.');
  }
}

function populateSources() {
  const sources = [...new Set(state.articles.map(article => article.source))].sort();
  els.source.innerHTML = '<option value="all">All sources</option>';
  for (const source of sources) {
    els.source.insertAdjacentHTML(
      'beforeend',
      `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`
    );
  }
}

/**
 * A partial outage is not an error: the reader still works, but silently showing
 * nine of ten sources hides the gap. Named here so it is visible without opening
 * the Worker logs. Older Worker builds returned plain strings, so both shapes
 * are accepted.
 */
function renderSourceHealth(failed, total) {
  if (!Array.isArray(failed) || !failed.length) {
    els.health.hidden = true;
    return;
  }

  const names = failed.map(entry => (typeof entry === 'string' ? entry : entry.name)).filter(Boolean);
  els.health.textContent =
    `${total - names.length}/${total} SOURCES LIVE — UNAVAILABLE: ${names.join(', ').toUpperCase()}`;
  els.health.hidden = false;
}

/* --------------------------------------------------------------- Loading */

async function loadArticles() {
  showLoading('Connecting to the signal...');
  els.status.textContent = 'SYNCING';
  els.refresh.disabled = true;

  try {
    if (WORKER_URL.includes('YOUR-WORKER')) {
      throw new Error('Set WORKER_URL in app.js to your deployed Cloudflare Worker URL.');
    }

    const response = await fetch(`${WORKER_URL}/api/news`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Worker returned HTTP ${response.status}.`);

    const payload = await response.json();
    state.articles = Array.isArray(payload.articles) ? payload.articles : [];

    populateSources();
    renderSourceHealth(payload.failedFeeds, payload.sources?.length ?? 0);
    els.updated.textContent = payload.generatedAt ? formatDateTime(payload.generatedAt) : '';
    els.status.textContent = 'LIVE';
    render();
  } catch (error) {
    state.articles = [];
    state.visible = [];
    els.list.hidden = true;
    els.health.hidden = true;
    els.status.textContent = 'OFFLINE';
    els.count.textContent = 'NO STORIES';
    showError(error.message);
  } finally {
    els.refresh.disabled = false;
  }
}

/* ------------------------------------------------------------------ Mode */

function applyMode() {
  const ascii = state.mode === 'ascii';
  els.body.classList.toggle('ascii-mode', ascii);
  els.modeToggle.setAttribute('aria-pressed', String(ascii));
  els.modeLabel.textContent = ascii ? 'MODERN MODE' : 'ASCII MODE';
  els.keyHelp.hidden = !ascii;
}

function toggleMode() {
  state.mode = state.mode === 'ascii' ? 'modern' : 'ascii';
  localStorage.setItem(MODE_KEY, state.mode);
  applyMode();
}

/* ---------------------------------------------------- Keyboard navigation */

function selectArticle(index) {
  const cards = els.list.querySelectorAll('.article-card');
  if (!cards.length) return;

  const clamped = Math.max(0, Math.min(index, cards.length - 1));
  cards.forEach(card => card.classList.remove('is-selected'));

  const card = cards[clamped];
  card.classList.add('is-selected');
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  state.selectedIndex = clamped;
}

function openSelected() {
  const card = els.list.querySelector('.article-card.is-selected a.article-link');
  if (card) window.open(card.href, '_blank', 'noopener,noreferrer');
}

// Terminal-style bindings, active in ASCII mode only, and never while typing.
function handleKeydown(event) {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);

  if (event.key === '/' && !typing) {
    event.preventDefault();
    els.search.focus();
    return;
  }
  if (event.key === 'Escape' && typing) {
    event.target.blur();
    return;
  }
  if (state.mode !== 'ascii' || typing || event.metaKey || event.ctrlKey || event.altKey) return;

  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      selectArticle(state.selectedIndex + 1);
      break;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      selectArticle(state.selectedIndex - 1);
      break;
    case 'g':
      event.preventDefault();
      selectArticle(0);
      break;
    case 'G':
      event.preventDefault();
      selectArticle(state.visible.length - 1);
      break;
    case 'Enter':
    case 'o':
      if (state.selectedIndex >= 0) {
        event.preventDefault();
        openSelected();
      }
      break;
    case 'r':
      event.preventDefault();
      loadArticles();
      break;
    case 'm':
      event.preventDefault();
      toggleMode();
      break;
    default:
      break;
  }
}

/* ----------------------------------------------------------------- Wiring */

function updateClock() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

els.search.addEventListener('input', render);
els.source.addEventListener('change', render);
els.refresh.addEventListener('click', loadArticles);
els.modeToggle.addEventListener('click', toggleMode);
document.addEventListener('keydown', handleKeydown);

updateClock();
setInterval(updateClock, 1000);
applyMode();
loadArticles();

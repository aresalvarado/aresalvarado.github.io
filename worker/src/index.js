/**
 * Signal RSS API — Cloudflare Worker.
 *
 * Fetches every configured feed in parallel, normalizes RSS 2.0 and Atom into a
 * single article shape, and serves the result as JSON with edge caching. All
 * cross-origin feed access happens here so the static frontend never hits CORS.
 */

// Add a source by appending one entry. `id` must be stable, `name` is displayed.
const FEEDS = [
  { id: 'krebs', name: 'Krebs on Security', url: 'https://krebsonsecurity.com/feed/' },
  { id: 'thn', name: 'The Hacker News', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { id: 'bleeping', name: 'BleepingComputer', url: 'https://www.bleepingcomputer.com/feed/' },
  { id: 'securityweek', name: 'SecurityWeek', url: 'https://www.securityweek.com/feed/' },
  { id: 'microsoft', name: 'Microsoft Security', url: 'https://www.microsoft.com/en-us/security/blog/feed/' },
  { id: 'google', name: 'Google Security', url: 'https://security.googleblog.com/feeds/posts/default' },
  { id: 'cloudflare', name: 'Cloudflare Blog', url: 'https://blog.cloudflare.com/rss/' },
  { id: 'aws', name: 'AWS Security', url: 'https://aws.amazon.com/blogs/security/feed/' },
  { id: 'talos', name: 'Cisco Talos', url: 'https://blog.talosintelligence.com/rss/' },
  { id: 'unit42', name: 'Palo Alto Unit 42', url: 'https://unit42.paloaltonetworks.com/feed/' }
];

const CACHE_TTL = 300;        // Seconds the edge holds a built response.
const FEED_TIMEOUT = 8000;    // Per-feed cap so one slow vendor cannot stall the request.
const MAX_ARTICLES = 80;      // Upper bound on the returned list.
const RESERVED_PER_FEED = 3;  // Slots each healthy feed keeps regardless of recency.
const SUMMARY_LENGTH = 280;

/* ------------------------------------------------------------------ CORS */

function corsHeaders(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
  const origin = request.headers.get('Origin');
  if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// Cached bodies are stored without CORS headers, so they are re-attached per request.
function withCors(response, request, env) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: { ...Object.fromEntries(response.headers), ...corsHeaders(request, env) }
  });
}

/* ---------------------------------------------------------------- Parsing */

const NAMED_ENTITIES = {
  nbsp: ' ', quot: '"', apos: "'", lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', mdash: '—',
  ndash: '–', lt: '<', gt: '>'
};

/**
 * Feeds deliver entity-encoded text. Decoding here means the frontend can escape
 * once for the DOM without users seeing raw `&#8217;` sequences on the page.
 * `&amp;` is decoded last so `&amp;#8217;` does not turn into a second entity.
 */
function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/&amp;/gi, '&');
}

// CDATA markers are removed before tag stripping so wrapped markup is handled once.
function clean(value) {
  return decodeEntities(
    String(value || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<[^>]*>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function field(xml, names) {
  for (const name of names) {
    const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match) return clean(match[1]);
  }
  return '';
}

/**
 * Atom uses self-closing `<link rel="alternate" href="..."/>` while RSS uses
 * `<link>url</link>`. Both are checked, and rel="alternate" wins because Atom
 * entries also carry replies and edit links that are not the article itself.
 */
function extractLink(entry) {
  const alternate = entry.match(/<link\b(?=[^>]*\brel=["']alternate["'])[^>]*\bhref=["']([^"']+)["']/i);
  if (alternate) return clean(alternate[1]);

  const anyHref = entry.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
  if (anyHref) return clean(anyHref[1]);

  const textual = entry.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (textual) return clean(textual[1]);

  return '';
}

// Only http(s) links are kept. Feeds are third-party input and must not be able
// to hand the frontend a javascript: or data: URL to place in an href.
function isSafeLink(link) {
  try {
    return ['http:', 'https:'].includes(new URL(link).protocol);
  } catch {
    return false;
  }
}

function parseItems(xml) {
  return xml
    .split(/<item\b|<entry\b/i)
    .slice(1)
    .map(entry => ({
      title: field(entry, ['title']),
      link: extractLink(entry),
      summary: field(entry, ['description', 'summary', 'content:encoded']).slice(0, SUMMARY_LENGTH),
      publishedAt: field(entry, ['pubDate', 'published', 'updated', 'dc:date'])
    }))
    .filter(item => item.title && isSafeLink(item.link));
}

/* --------------------------------------------------------------- Fetching */

// Some publishers sit behind a WAF that scores bare API user-agents as bot
// traffic and answers a subrequest from Cloudflare's network with a challenge
// page rather than XML. Presenting as an ordinary browser avoids that.
const FEED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Resolves to { feed, articles, ok, reason } so a failure never rejects the
// batch, and the reason travels in the response instead of only the Worker log
// — a challenge page returns HTTP 200, so "why" is not obvious from the status.
async function fetchFeed(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: FEED_HEADERS,
      signal: AbortSignal.timeout(FEED_TIMEOUT)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = await response.text();
    const articles = parseItems(body).map(article => ({ ...article, source: feed.name, sourceId: feed.id }));

    if (!articles.length) {
      const type = response.headers.get('Content-Type') || 'unknown';
      throw new Error(`no items (HTTP 200, ${type.split(';')[0]}, ${body.length}b)`);
    }

    return { feed, articles, ok: true };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `timeout after ${FEED_TIMEOUT}ms` : error.message;
    console.warn(`Feed failed: ${feed.name} — ${reason}`);
    return { feed, articles: [], ok: false, reason };
  }
}

// Undated or unparseable items sort last rather than scrambling the order.
function publishedTime(article) {
  const time = new Date(article.publishedAt).getTime();
  return Number.isNaN(time) ? -Infinity : time;
}

const byNewest = (a, b) => publishedTime(b) - publishedTime(a);

/**
 * A pure recency sort silently erases slow-publishing sources: a blog that posts
 * monthly never reaches the top MAX_ARTICLES, so it vanishes from the list and
 * from the source filter built off it. Each healthy feed therefore keeps its
 * newest RESERVED_PER_FEED items, and the remaining slots go to whatever is most
 * recent overall. The final list is still ordered newest first.
 */
function selectArticles(results) {
  const reserved = [];
  const remainder = [];

  for (const result of results) {
    const ordered = [...result.articles].sort(byNewest);
    reserved.push(...ordered.slice(0, RESERVED_PER_FEED));
    remainder.push(...ordered.slice(RESERVED_PER_FEED));
  }

  const fill = remainder.sort(byNewest).slice(0, Math.max(0, MAX_ARTICLES - reserved.length));
  return [...reserved, ...fill].sort(byNewest);
}

async function buildNews() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const articles = selectArticles(results);

  return {
    articles,
    generatedAt: new Date().toISOString(),
    sources: FEEDS.map(({ id, name }) => ({ id, name })),
    failedFeeds: results
      .filter(result => !result.ok)
      .map(result => ({ id: result.feed.id, name: result.feed.name, reason: result.reason }))
  };
}

async function handleNews(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/news', request.url).toString());

  const cached = await cache.match(cacheKey);
  if (cached) return withCors(cached, request, env);

  const response = Response.json(await buildNews(), {
    headers: { 'Cache-Control': `public, max-age=${CACHE_TTL}` }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response, request, env);
}

/* ---------------------------------------------------------------- Routing */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/news') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders(request, env) });
      }
      if (request.method === 'GET') {
        return handleNews(request, env, ctx);
      }
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, OPTIONS', ...corsHeaders(request, env) } }
      );
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders(request, env) });
  }
};

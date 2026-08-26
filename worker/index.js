// Cloudflare Worker: RSS/Atom -> JSON proxy with CORS + edge caching.
// NOTE: the Workers runtime has no DOMParser, so parsing is done with regex.

const ALLOW = new Set([
  "https://www.bleepingcomputer.com/feed/",
  "https://feeds.feedburner.com/TheHackersNews",
  "https://krebsonsecurity.com/feed/",
  "https://www.darkreading.com/rss.xml",
  "https://www.securityweek.com/feed/",
  "https://www.schneier.com/feed/atom/",
  "https://www.cisa.gov/cybersecurity-advisories/all.xml",
  "https://www.apple.com/newsroom/rss-feed.rss",
  "https://blogs.nvidia.com/blog/feed/",
  "https://blog.google/rss/",
  "https://netflixtechblog.com/feed",
]);

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const u = new URL(request.url);
    // Tolerate "//feed" from a client that joined a trailing slash with "/feed".
    const path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";

    if (path !== "/feed") {
      return json({ ok: true, usage: "GET /feed?url=<rss_or_atom_url>", allowed: [...ALLOW] }, 200);
    }

    const feedUrl = u.searchParams.get("url");
    if (!feedUrl) return json({ ok: false, error: "Missing ?url=" }, 400);
    if (!ALLOW.has(feedUrl)) return json({ ok: false, error: "URL not allowed", url: feedUrl }, 403);

    const cacheKey = new Request(`https://cache.local/feed?url=${encodeURIComponent(feedUrl)}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached);

    let resp;
    try {
      resp = await fetch(feedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (personal RSS dashboard; Cloudflare Worker)",
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (e) {
      return json({ ok: false, error: "Upstream fetch threw: " + e.message }, 502);
    }

    if (!resp.ok) {
      return json({ ok: false, error: "Upstream fetch failed", status: resp.status }, 502);
    }

    const xml = await resp.text();
    const parsed = parseFeedXml(xml, feedUrl);

    const out = new Response(
      JSON.stringify({ ok: true, source_url: feedUrl, fetched_at: new Date().toISOString(), ...parsed }, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "public, max-age=0, s-maxage=600",
        },
      }
    );

    // Only cache successful parses, so a transient failure doesn't stick for 10 min.
    if (!parsed.parse_error) ctx.waitUntil(cache.put(cacheKey, out.clone()));

    return withCors(out);
  },
};

function withCors(response) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=UTF-8" },
  });
}

/* ---------------- parsing ---------------- */

const ENTITIES = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'", nbsp:" ", "#39":"'", "#039":"'", "#34":'"' };

function decode(s) {
  return (s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+|#0?39|#34);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// Grab the text of the first <tag>...</tag>, ignoring namespace prefixes.
function tag(block, name) {
  const re = new RegExp(`<(?:[\w-]+:)?${name}(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?${name}\s*>`, "i");
  const m = block.match(re);
  return m ? decode(m[1]).trim() : "";
}

function blocks(xml, name) {
  const re = new RegExp(`<(?:[\w-]+:)?${name}(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w-]+:)?${name}\s*>`, "gi");
  return xml.match(re) || [];
}

function stripTags(s) {
  return (s || "").replace(/<[^>]*>/g, " ");
}

function clean(s) {
  s = decode(stripTags(s)).replace(/\s+/g, " ").trim();
  return s.length > 280 ? s.slice(0, 280) + "…" : s;
}

// Atom: <link rel="alternate" href="..."/> — prefer alternate, else first href.
function atomLink(entry) {
  const links = entry.match(/<(?:[\w-]+:)?link\b[^>]*>/gi) || [];
  const href = (t) => (t.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
  const alt = links.find(t => /\brel\s*=\s*["']alternate["']/i.test(t));
  return decode(href(alt || links.find(href) || "")).trim();
}

function parseFeedXml(xmlText, sourceUrl) {
  if (!xmlText || !/<(rss|feed|rdf:RDF)\b/i.test(xmlText)) {
    return { title: "", items: [], parse_error: "Unknown feed format" };
  }

  const items = blocks(xmlText, "item");
  if (items.length) {
    return {
      format: "rss",
      title: tag(xmlText, "title") || sourceUrl,
      items: items.slice(0, 30).map(it => ({
        title: clean(tag(it, "title")),
        link: tag(it, "link") || atomLink(it) || tag(it, "guid"),
        published: tag(it, "pubDate") || tag(it, "date") || tag(it, "updated"),
        summary: clean(tag(it, "description") || tag(it, "encoded")),
      })),
    };
  }

  const entries = blocks(xmlText, "entry");
  if (entries.length) {
    return {
      format: "atom",
      title: tag(xmlText, "title") || sourceUrl,
      items: entries.slice(0, 30).map(en => ({
        title: clean(tag(en, "title")),
        link: atomLink(en),
        published: tag(en, "published") || tag(en, "updated"),
        summary: clean(tag(en, "summary") || tag(en, "content")),
      })),
    };
  }

  return { title: "", items: [], parse_error: "No items or entries found" };
}

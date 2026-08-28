# SIGNAL RSS Reader

A static cybersecurity and technology RSS reader for GitHub Pages, backed by a Cloudflare Worker that fetches, normalizes, caches, and aggregates feeds.

Published at **https://aresalvarado.github.io/**

## Structure

```text
cyber-rss-reader/
  index.html          # GitHub Pages entry point
  styles.css          # Modern and ASCII themes
  app.js              # Fetching, filtering, rendering, mode persistence
  worker/
    src/index.js      # Cloudflare Worker and feed registry
    wrangler.toml     # Worker deployment config
```

## Deploy the Worker

The live Worker is **https://rss-proxy.aresronaldoalvarado.workers.dev**, already wired into `WORKER_URL` at the top of `app.js`. Either deployment path below updates it. The frontend itself has no build step and no dependencies.

### Via the Cloudflare dashboard (no local tooling)

1. **Workers & Pages → rss-proxy → Edit code**, replace the contents with `worker/src/index.js`, and click **Deploy**. Saving alone does not publish.
2. Under **Settings → Variables and Secrets**, set `ALLOWED_ORIGIN` to `https://aresalvarado.github.io`, then deploy again.

`ALLOWED_ORIGIN` is required. The Worker emits `Access-Control-Allow-Origin` only when a request's `Origin` matches it exactly, so if the variable is missing the header is omitted and every browser request from the site is blocked — while `curl`, which sends no `Origin`, still looks healthy.

### Via Wrangler

Needs **Node.js 20 or newer**. Install Wrangler with `npm install --global wrangler`, run `wrangler login`, then `wrangler deploy` from `worker/`. The `name` and `ALLOWED_ORIGIN` in `worker/wrangler.toml` already match the deployed Worker, so this updates it rather than creating a second one.

### Verify

Open `/api/news` and confirm an `articles` array. Requesting `/` should return `{"error":"Not found"}` with a 404 — a usage blob there means an older Worker is still deployed.

The Worker uses the Cloudflare edge Cache API for five-minute response caching, and gives each feed an eight-second timeout so one slow vendor cannot stall the request. Failed feeds are omitted while healthy feeds continue to appear, and each one is reported in the response's `failedFeeds` as `{ id, name, reason }`. The frontend shows a "N/10 SOURCES LIVE" line when any are missing, so a partial outage is visible on the page instead of only in the Worker logs.

The Worker URL is intentionally public because it is called by browser JavaScript. Do not put API keys, Cloudflare tokens, feed credentials, or other secrets in the frontend repository. `ALLOWED_ORIGIN` restricts browser CORS to the Pages origin; configure Cloudflare rate limiting separately if the endpoint needs abuse protection.

## Deploy GitHub Pages

1. Commit and push to the `main` branch of `aresalvarado/aresalvarado.github.io`.
2. In **Settings > Pages**, choose **Deploy from a branch**.
3. Select `main` and `/ (root)`, then save.
4. Open https://aresalvarado.github.io/ after the deployment completes.

Because this is a `username.github.io` user site, the published origin is the bare domain. All local assets use relative URLs, so the page also works from a subpath if it is ever moved into a project repository. Configure the Worker URL before publishing.

## Keyboard shortcuts

ASCII mode is navigable without a mouse. `/` (focus search) and `Escape` (leave the field) work in both modes.

| Key | Action |
| --- | --- |
| `j` / `ArrowDown` | Next article |
| `k` / `ArrowUp` | Previous article |
| `g` / `G` | First / last article |
| `Enter` or `o` | Open the selected article in a new tab |
| `/` | Focus search |
| `r` | Refresh |
| `m` | Toggle modern and ASCII modes |

## Add a source

Add one object to `FEEDS` in `worker/src/index.js` with a stable `id`, display `name`, and RSS/Atom `url`. The normalizer handles both formats and the frontend source filter is populated from the returned data.

## Design decisions

- Vanilla HTML/CSS/JavaScript keeps the Pages deployment fast, transparent, and dependency-free.
- The Worker owns all cross-origin feed access and returns one predictable JSON contract.
- `Promise.all` over per-feed handlers that resolve rather than reject isolates failures, so one unavailable vendor cannot blank the reader.
- RSS and Atom differ in how they express a link: RSS uses `<link>url</link>`, Atom a self-closing `<link rel="alternate" href="…"/>`. The parser checks both and prefers `rel="alternate"`, since Atom entries also carry edit and reply links that are not the article.
- HTML entities are decoded in the Worker so the frontend can escape exactly once for the DOM; otherwise readers see raw `&#8217;` on the page.
- Feed content is untrusted input. The Worker keeps only `http(s)` links and the frontend re-validates before writing an `href`, so a compromised feed cannot inject a `javascript:` URL.
- Each healthy feed keeps its three newest items before the remaining slots are filled by global recency. A pure date sort silently erases slow-publishing blogs, which then disappear from the source filter too.
- Modern mode and ASCII mode use the same accessible semantic markup, so the toggle changes presentation without duplicating product logic.
- User mode preference is stored in `localStorage`; article links open in a new tab with `noopener noreferrer`.

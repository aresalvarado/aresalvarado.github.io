A static cybersecurity/tech news reader hosted on GitHub Pages, paired with a Cloudflare Worker that does the actual feed work.

cyber-rss-reader/
  index.html          # page skeleton — static shell, all content injected at runtime
  styles.css          # both visual themes in one stylesheet
  app.js              # fetch → filter → render, mode + keyboard handling
  worker/
    src/index.js      # feed registry, fetching, XML normalization, caching, CORS
    wrangler.toml     

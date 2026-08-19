import json
import html
from datetime import datetime, timezone
import feedparser

FEEDS = [
  {"source":"BleepingComputer", "category":"Cyber", "url":"https://www.bleepingcomputer.com/feed/"},
  {"source":"The Hacker News", "category":"Cyber", "url":"https://feeds.feedburner.com/TheHackersNews"},
  {"source":"KrebsOnSecurity", "category":"Cyber", "url":"https://krebsonsecurity.com/feed/"},
  {"source":"Apple Newsroom", "category":"Tech", "url":"https://www.apple.com/newsroom/rss-feed.rss"},
  {"source":"NVIDIA Blog", "category":"Tech", "url":"https://blogs.nvidia.com/blog/feed/"},
  {"source":"Google Blog", "category":"Tech", "url":"https://blog.google/rss/"},
  {"source":"Netflix TechBlog", "category":"Tech", "url":"https://netflixtechblog.com/feed"},
]


LIMIT_PER_FEED = 20

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

def entry_published(e):
    return getattr(e, "published", None) or getattr(e, "updated", None) or ""

def entry_summary(e):
    s = getattr(e, "summary", "") or ""
    s = html.unescape(s)
    s = " ".join(s.split())
    return (s[:240] + "…") if len(s) > 240 else s

def main():
    items = []
    for f in FEEDS:
        d = feedparser.parse(f["url"])
        for e in d.entries[:LIMIT_PER_FEED]:
            items.append({
                "title": (getattr(e, "title", "") or "").strip(),
                "link": (getattr(e, "link", "") or "").strip(),
                "published": entry_published(e),
                "summary": entry_summary(e),
                "source": f["source"],
                "category": f["category"],
            })

    # Best-effort sort (feeds use different date formats)
    items.sort(key=lambda it: it["published"] or "", reverse=True)

    out = {"generated_at": now_iso(), "items": items}

    with open("docs/feeds.json", "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()

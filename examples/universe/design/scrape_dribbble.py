#!/usr/bin/env python3
"""Scrape Dribbble's popular shots into design briefs (title, tags, palette hints).
Gentle: one page, real UA, and a r.jina.ai reader fallback when Cloudflare says no.
Output: briefs.json — the raw material the design students will build UIs from."""
import json, re, sys, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}

def fetch(url, headers=None):
    req = urllib.request.Request(url, headers=headers or UA)
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")

def direct():
    html = fetch("https://dribbble.com/shots/popular")
    # Dribbble embeds shot data as JSON in data attributes / script tags
    titles = re.findall(r'alt="([^"]{8,80})"', html)
    return [{"title": t} for t in dict.fromkeys(titles)][:12]

def via_reader():
    md = fetch("https://r.jina.ai/https://dribbble.com/shots/popular", {"User-Agent": UA["User-Agent"]})
    # reader output: shot links look like [Title](https://dribbble.com/shots/…)
    pairs = re.findall(r"\[([^\]\n]{8,90})\]\(https://dribbble\.com/shots/(\d+)[^)]*\)", md)
    seen, out = set(), []
    for title, sid in pairs:
        t = re.sub(r"\s+", " ", title).strip()
        if t.lower() in seen or t.startswith("!"): continue
        seen.add(t.lower())
        out.append({"title": t, "id": sid})
    return out[:12]

def enrich(briefs):
    # derive tag/style hints from the title words — enough signal for a UI brief
    STYLE = {"dashboard":"data-dense dashboard","app":"mobile app screen","landing":"marketing landing page",
             "logo":"brand identity page","website":"marketing website","ui":"product UI","dark":"dark theme",
             "finance":"fintech","crypto":"crypto/fintech","health":"health & wellness","travel":"travel",
             "food":"food & restaurant","music":"music player","ai":"AI product","saas":"SaaS product",
             "portfolio":"portfolio site","ecommerce":"e-commerce","shop":"e-commerce","bank":"banking"}
    for b in briefs:
        words = re.findall(r"[a-zA-Z]+", b["title"].lower())
        hints = sorted({v for w in words for k, v in STYLE.items() if k in w})
        b["hints"] = hints or ["product UI"]
    return briefs

try:
    briefs = direct()
    src = "dribbble.com direct"
    if len(briefs) < 4: raise RuntimeError("thin результат")
except Exception as e:
    try:
        briefs = via_reader(); src = "r.jina.ai reader"
    except Exception as e2:
        print(f"both paths failed: {e} / {e2}"); sys.exit(1)

briefs = enrich(briefs)
json.dump({"source": src, "briefs": briefs}, open(__file__.rsplit("/",1)[0] + "/briefs.json", "w"), indent=2)
print(f"scraped {len(briefs)} briefs via {src}")
for b in briefs[:8]: print(f"  · {b['title']}  ({', '.join(b['hints'])})")

#!/usr/bin/env python3
"""Scrape specific Dribbble shot pages (URLs as args) into design briefs via their og:/meta tags."""
import json, re, sys, subprocess, os
# Dribbble sits behind an AWS WAF *JavaScript* challenge: no header or TLS trick passes it, only a
# real browser executing JS. So Python orchestrates and parses; headless Chrome (via a tiny Node
# helper) does the fetching. Honest division of labor.
HELPER = os.path.expanduser("~/Desktop/secretless-launch/fetch_html.mjs")
def chrome_get(url):
    return subprocess.run(["node", HELPER, url], capture_output=True, text=True, timeout=120).stdout
def meta(html, prop):
    m = re.search(rf'<meta[^>]+(?:property|name)="{prop}"[^>]+content="([^"]*)"', html) or \
        re.search(rf'<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="{prop}"', html)
    return (m.group(1) if m else "").strip()
briefs = []
for url in sys.argv[1:]:
    try:
        html = chrome_get(url)
        title = meta(html, "og:title") or re.search(r"<title>([^<]+)</title>", html).group(1)
        desc = meta(html, "og:description") or meta(html, "description")
        img = meta(html, "og:image")
        tags = re.findall(r'/tags/([a-z0-9-]+)"', html)[:12]
        colors = list(dict.fromkeys(re.findall(r'/shots\?color=([0-9A-Fa-f]{6})', html)))[:6]
        briefs.append({"url": url, "title": title, "desc": desc, "tags": sorted(set(tags)), "colors": ["#"+c for c in colors], "image": img})
        print(f"✓ {title}\n  tags: {', '.join(sorted(set(tags))) or '—'}\n  colors: {', '.join('#'+c for c in colors) or '—'}\n  desc: {desc[:110]}")
    except Exception as e:
        print(f"✗ {url}: {e}")
json.dump({"source": "dribbble shot pages", "briefs": briefs}, open("briefs.json", "w"), indent=2)
print(f"\n{len(briefs)} brief(s) → briefs.json")

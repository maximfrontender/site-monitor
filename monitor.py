#!/usr/bin/env python3
"""Check the sites listed in sites.txt and publish a status.json. Standard library only."""
import concurrent.futures
import json
import socket
import ssl
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
TIMEOUT = 12

def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")

def probe(url):
    started = time.monotonic()
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; SiteWatch/1.0; +https://github.com/maximfrontender/site-monitor)",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    })
    try:
        with urlopen(req, timeout=TIMEOUT) as response:
            code = response.status
            final_url = response.geturl()
    except HTTPError as exc:
        code = exc.code
        final_url = exc.geturl()
        exc.close()
    except (URLError, TimeoutError, OSError, ssl.SSLError, socket.timeout, ValueError) as exc:
        return {"state": "down", "http_code": None, "url": url, "response_ms": None,
                "detail": str(exc)[:180]}
    state = "up" if 200 <= code < 400 else "limited" if code in (401, 403, 429) else "down"
    return {"state": state, "http_code": code, "url": final_url,
            "response_ms": round((time.monotonic() - started) * 1000), "detail": f"HTTP {code}"}

def check(domain):
    https = probe("https://" + domain)
    # Only try HTTP when HTTPS isn't available.
    if https["state"] == "up":
        chosen = https
    else:
        http = probe("http://" + domain)
        chosen = max((https, http), key=lambda item: {"up": 2, "limited": 1, "down": 0}[item["state"]])
    return {"domain": domain, **chosen, "checked_at": utc_now()}

def main():
    domains = list(dict.fromkeys(
        line.strip().lower() for line in (ROOT / "sites.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ))
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(check, domains))
    payload = {
        "generated_at": utc_now(), "sites": results,
        "counts": {
            "total": len(results),
            "up": sum(s["state"] == "up" for s in results),
            "down": sum(s["state"] == "down" for s in results),
            "limited": sum(s["state"] == "limited" for s in results)
        }
    }
    dest = ROOT / "site" / "status.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(payload["generated_at"], payload["counts"])
    for site in results:
        print(f'{site["domain"]:30s} {site["state"]:8s} {site["http_code"] or "-"}')

if __name__ == "__main__":
    main()

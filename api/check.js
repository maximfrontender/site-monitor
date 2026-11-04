// Vercel serverless function for real-time, token-free website reachability checks.
// Domains are fixed in the source: visitors cannot submit arbitrary target URLs.
const DOMAINS = [
  "profokna.by",
  "remont-televizor.by",
  "maximalizm.by",
  "mpotolki.by",
  "peretiazhka-mebeli.by",
  "remont-holodilnik.by",
  "remont-stiralka.by",
  "shkafykupe.by",
  "kupit-pvh-okna.by",
  "zasteklit-balkon.by",
  "okna-balkon.by",
  "glavokna.by",
  "okna-eko.by",
  "condi.by",
  "mogilevoknapvh.by",
  "balkonmogilev.by",
  "balkon-gomel.by",
  "okna-pvh-gomel.by",
  "plastikovye-okna-gomel.by",
  "potolki-natjazhnye.by",
  "balkonnye-ramy-gomel.by",
  "megaokna.by",
  "ritual-byro.by",
  "prostroy.by",
  "krovprofi.by",
  "ritualnyeuslugi.by",
  "dekorfasad.by",
  "i-herbcom.ru",
  "alyuminievye-okna.by",
  "okna-ramy.by",
  "ritualbyro.by",
  "scorbim.by",
  "blagoustroistvo-mogil.by",
  "kupit-okna-pvh.by",
  "remont-generator.by",
  "remont-mebeli.by"
];
const TIMEOUT_MS = 12000;
const MAX_PARALLEL = 12;

function now() { return new Date().toISOString(); }

async function probe(url) {
  const started = Date.now();
  for (const method of ["HEAD", "GET"]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method,
          redirect: "follow",
          signal: controller.signal,
          headers: { "User-Agent": "SiteWatch/2.0 (+https://github.com/maximfrontender/site-monitor)", "Accept": "text/html,*/*;q=0.8" }
        });
      } finally { clearTimeout(timer); }
      const code = response.status;
      // Some sites explicitly disallow HEAD; retry using GET in this case.
      if (method === "HEAD" && (code === 405 || code === 501)) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      await response.body?.cancel().catch(() => {});
      const state = code >= 200 && code < 400 ? "up" : [401,403,429].includes(code) ? "limited" : "down";
      return {
        state, http_code: code, url: response.url || url,
        response_ms: Date.now() - started, detail: "HTTP " + code
      };
    } catch (error) {
      if (method === "HEAD") continue;
      return { state: "down", http_code: null, url, response_ms: null, detail: String(error?.message || error).slice(0,180) };
    }
  }
  return { state: "down", http_code: null, url, response_ms: null, detail: "Не удалось выполнить запрос" };
}

async function check(domain) {
  const https = await probe("https://" + domain);
  if (https.state === "up") return { domain, ...https, checked_at: now() };
  const http = await probe("http://" + domain);
  const order = { up: 2, limited: 1, down: 0 };
  const chosen = order[http.state] > order[https.state] ? http : https;
  return { domain, ...chosen, checked_at: now() };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to check websites" });
  }
  // Browser requests can only be made from the deployed same-origin dashboard.
  // This prevents casual cross-site use, not sophisticated server-to-server abuse.
  const origin = req.headers.origin;
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && new URL(origin).host === req.headers.host); } catch {}
  if (!sameOrigin) return res.status(403).json({ error: "Only same-origin dashboard requests are allowed" });

  try {
    const results = new Array(DOMAINS.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, DOMAINS.length) }, async () => {
      while (next < DOMAINS.length) {
        const index = next++;
        results[index] = await check(DOMAINS[index]);
      }
    }));
    return res.status(200).json({
      generated_at: now(),
      source: "manual",
      sites: results,
      counts: {
        total: results.length,
        up: results.filter(item => item.state === "up").length,
        down: results.filter(item => item.state === "down").length,
        limited: results.filter(item => item.state === "limited").length
      }
    });
  } catch (error) {
    return res.status(500).json({ error: "Website check failed", detail: String(error?.message || error).slice(0,180) });
  }
}

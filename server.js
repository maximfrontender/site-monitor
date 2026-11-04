import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runChecks } from './api/check.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const STATUS_URL = 'https://maximfrontender.github.io/site-monitor/status.json';
let storedScheduled = null, lastScheduledRead = 0, storedManual = null, lastManual = 0, active = null;

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}
function valid(payload) {
  return payload && Array.isArray(payload.sites) && payload.sites.length === 36 &&
    typeof payload.generated_at === 'string' && Number.isFinite(Date.parse(payload.generated_at));
}
async function scheduled() {
  if (storedScheduled && Date.now() - lastScheduledRead < 20000) return storedScheduled;
  try {
    const response = await fetch(STATUS_URL, {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Upstream HTTP ' + response.status);
    const payload = await response.json();
    if (!valid(payload)) throw new Error('Invalid status data');
    storedScheduled = payload;
    lastScheduledRead = Date.now();
    return payload;
  } catch (error) {
    if (storedScheduled) return storedScheduled;
    if (storedManual) return storedManual;
    throw error;
  }
}
function sameOrigin(req) {
  try {
    const expected = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return Boolean(req.headers.origin && new URL(req.headers.origin).host === expected);
  } catch { return false; }
}
async function manual() {
  if (active) return active;
  // A short cooldown and shared in-flight promise avoid duplicate public checks.
  if (storedManual && Date.now() - lastManual < 10000) return storedManual;
  active = runChecks().then(result => {
    storedManual = result;
    lastManual = Date.now();
    return result;
  }).finally(() => { active = null; });
  return active;
}
async function handle(req, res) {
  const route = new URL(req.url || '/', 'http://localhost').pathname;
  try {
    if (route === '/healthz') return json(res, 200, { ok: true });
    if (route === '/api/check') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Method not allowed' }); }
      if (!sameOrigin(req)) return json(res, 403, { error: 'Only same-origin dashboard requests are allowed' });
      return json(res, 200, await manual());
    }
    if (route === '/status.json' && req.method === 'GET') {
      const current = await scheduled();
      const newest = storedManual && Date.parse(storedManual.generated_at) > Date.parse(current.generated_at) ? storedManual : current;
      return json(res, 200, newest);
    }
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const contents = await readFile(join(ROOT, 'public', 'index.html'));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(contents);
    }
    if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Monitoring request failed:', error);
    if (!res.headersSent) return json(res, 503, { error: 'Monitoring temporarily unavailable' });
    res.end();
  }
}
http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error('Unexpected server error:', error);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
    else res.end();
  });
}).listen(PORT, '0.0.0.0', () => console.log('SiteWatch started on port ' + PORT));

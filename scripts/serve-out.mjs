// Serves out/ for the visual tests with Cloudflare Pages semantics for _headers and _redirects.
//   node scripts/serve-out.mjs --port 4173 [--dir out]
// _headers: a path line (no indent) then indented `Name: value` lines; rules match in file order, a header set by several rules is
// comma-joined, `! Name` detaches a header set by an earlier rule. _redirects: `from to 301` exact-match lines.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.ics': 'text/calendar; charset=utf-8',
};

/** Parse a Pages `_headers` file into [{ pattern, set: [[name, value]], detach: [name] }]. */
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = { pattern: raw.trim(), set: [], detach: [] };
      rules.push(cur);
    } else if (cur) {
      const line = raw.trim();
      if (line.startsWith('!')) cur.detach.push(line.slice(1).trim().toLowerCase());
      else {
        const i = line.indexOf(':');
        if (i > 0) cur.set.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
      }
    }
  }
  return rules;
}

const patternRe = (p) =>
  new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)').replace(/:[A-Za-z]\w*/g, '([^/]+)') + '$');

/** Headers for a path: rules in file order, equal names comma-joined, `! Name` removes what earlier rules set. */
export function headersFor(rules, path) {
  const out = new Map();
  for (const r of rules) {
    if (!patternRe(r.pattern).test(path)) continue;
    for (const d of r.detach) out.delete(d);
    for (const [k, v] of r.set) out.set(k, out.has(k) ? `${out.get(k)}, ${v}` : v);
  }
  return out;
}

export function parseRedirects(text) {
  const map = new Map();
  for (const raw of text.split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p.length >= 2 && !raw.trim().startsWith('#')) map.set(p[0], { to: p[1], status: Number(p[2] ?? 301) });
  }
  return map;
}

function resolveFile(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const base = join(root, clean);
  if (!resolve(base).startsWith(resolve(root))) return null;
  const tries = clean.endsWith('/') ? [join(base, 'index.html')] : [base, `${base}.html`, join(base, 'index.html')];
  return tries.find((f) => existsSync(f) && statSync(f).isFile()) ?? null;
}

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.xml', '.webmanifest', '.ics']);

export function createOutServer(root) {
  const hdrPath = join(root, '_headers');
  const redPath = join(root, '_redirects');
  const rules = existsSync(hdrPath) ? parseHeaders(readFileSync(hdrPath, 'utf8')) : [];
  const redirects = existsSync(redPath) ? parseRedirects(readFileSync(redPath, 'utf8')) : new Map();
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const red = redirects.get(url.pathname);
    if (red) {
      res.writeHead(red.status, { location: red.to });
      return res.end();
    }
    let file = null;
    try {
      file = resolveFile(root, url.pathname);
    } catch {
      file = null;
    }
    let status = 200;
    if (!file) {
      status = 404;
      const nf = join(root, '404.html');
      file = existsSync(nf) ? nf : null;
    }
    const h = Object.fromEntries(headersFor(rules, url.pathname));
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain', ...h });
      return res.end('not found');
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    let body = readFileSync(file);
    const out = { 'content-type': type, ...h };
    // Pages compresses text responses; do the same so Lighthouse and the budget see what a visitor's browser gets.
    if (COMPRESSIBLE.has(extname(file)) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      body = gzipSync(body);
      out['content-encoding'] = 'gzip';
      out.vary = 'Accept-Encoding';
    }
    res.writeHead(status, out);
    res.end(body);
  });
}

const argv = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const port = Number(argv[argv.indexOf('--port') + 1] || 4173);
  const dir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : 'out';
  createOutServer(resolve(dir)).listen(port, '127.0.0.1', () => console.log(`serve-out: ${dir} on http://127.0.0.1:${port}`));
}

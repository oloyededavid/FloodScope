// Record and replay network responses, so an end-to-end run can be repeated offline on fixed inputs.
// FIXTURE=record  : real requests; each response is stored under FIXTURE_DIR
// FIXTURE=replay  : no network; every request must have a stored response, otherwise the run fails
// Requests are keyed by method, URL without its query string for signed blob addresses, the Range header and the body.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

export function installFixtureFetch(dir, mode) {
  mkdirSync(dir, { recursive: true });
  const indexFile = `${dir}/index.json`, index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
  const real = globalThis.fetch;
  const keyOf = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, method = (init.method || 'GET').toUpperCase();
    const u = new URL(url); if (/blob\.core\.windows\.net$/.test(u.hostname) || u.pathname.includes('/sas/')) u.search = '';
    const h = new Headers(init.headers || {}), range = h.get('Range') || '', body = typeof init.body === 'string' ? init.body : '';
    return createHash('sha256').update(`${method} ${u.href} ${range} ${body}`).digest('hex').slice(0, 32);
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return real(input, init);   // the repository's own files
    const key = await keyOf(input, init);
    if (mode === 'replay') {
      const e = index[key]; if (!e) throw new Error(`fixture missing for ${url.slice(0, 120)}`);
      return new Response(readFileSync(`${dir}/${key}.bin`), { status: e.status, headers: e.headers });
    }
    const res = await real(input, init), buf = Buffer.from(await res.arrayBuffer());
    const headers = {}; for (const k of ['content-type', 'content-range', 'content-length']) { const v = res.headers.get(k); if (v) headers[k] = v; }
    writeFileSync(`${dir}/${key}.bin`, buf); index[key] = { status: res.status, headers, url: url.split('?')[0].slice(0, 200), bytes: buf.length };
    writeFileSync(indexFile, JSON.stringify(index, null, 1));
    return new Response(buf, { status: res.status, headers });
  };
}

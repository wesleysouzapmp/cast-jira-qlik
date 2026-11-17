// Cliente HTTP do Jira Cloud: auth Basic, timeout e novas tentativas em 429.
// O token só é usado para montar o header Authorization; nunca é devolvido.

const DEFAULT_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 60;

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const key = k.toLowerCase();
    if (key === 'content-type' || key === 'retry-after' || key.startsWith('x-ratelimit') || key.startsWith('x-arequestid')) {
      out[key] = v;
    }
  }
  return out;
}

function buildUrl(baseUrl, path, query) {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

function retryDelayMs(headerValue) {
  const n = Number(headerValue);
  const seconds = Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETRY_SECONDS;
  return Math.min(seconds, MAX_RETRY_SECONDS) * 1000;
}

export function createJiraClient({
  baseUrl,
  email,
  token,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries = 3,
  timeoutMs = 30000,
}) {
  const authorization = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

  async function call({ method = 'GET', path, query = {}, body = null }) {
    const url = buildUrl(baseUrl, path, query);
    const headers = { Authorization: authorization, Accept: 'application/json' };
    const init = { method, headers };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const started = performance.now();
    let retries = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        return { status: 0, ok: false, ms, headers: {}, data: { error: `Falha de rede/timeout: ${err?.message ?? err}` }, retries };
      }

      if (res.status === 429 && retries < maxRetries) {
        retries++;
        try { await res.body?.cancel(); } catch { /* libera o socket */ }
        await sleep(retryDelayMs(res.headers.get('retry-after')));
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      let text;
      try {
        text = await res.text();
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        return { status: 0, ok: false, ms, headers: pickHeaders(res.headers), data: { error: `Falha ao ler a resposta (rede/timeout): ${err?.message ?? err}` }, retries };
      }
      let data = text;
      if (contentType.includes('json') && text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      const ms = Math.round(performance.now() - started);
      return { status: res.status, ok: res.ok, ms, headers: pickHeaders(res.headers), data, retries };
    }
  }

  return { call };
}

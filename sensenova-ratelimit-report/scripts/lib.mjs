// Shared helpers for the sensenova rate-limit / cache probes.
// Keys live in scripts/keys.json: { "k1": "sk-...", ... }.
// The COMMITTED keys.json is only a redacted SAMPLE (sk-xxxx****xxxx) — replace it
// with real keys (or use env vars) to actually run the probes; it is never committed
// with real values, and no script prints keys.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';

export const BASE = 'https://token.sensenova.cn/v1';

/**
 * keys.json naming: acc<N>key<M> — the acc<N> prefix identifies the account, so
 * scripts can group keys that SHARE a rate bucket (limits are per-account).
 */
export const ACCOUNTS = {
  acc1: ['acc1key1'],
  acc2: ['acc2key1'],
  acc3: ['acc3key1', 'acc3key2'],
};

/** First key name of an account: pickAccount('acc2') -> 'acc2key1'. */
export function pickAccount(account) {
  return ACCOUNTS[account]?.[0];
}

export function loadKeys() {
  let fileKeys = {};
  try {
    fileKeys = JSON.parse(readFileSync(join(import.meta.dirname, 'keys.json'), 'utf8'));
  } catch {
    // no keys.json — env-only mode
  }
  const keys = { ...fileKeys };
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^SENSENOVA_KEY_(.+)$/);
    if (m) keys[m[1].toLowerCase()] = v;
  }
  return keys;
}

/** Throw a clear error if an alias has no key. */
export function requireKey(keys, ...names) {
  for (const name of names) {
    if (!keys[name]) throw new Error(`missing key "${name}" (set SENSENOVA_${name.toUpperCase()}_API_KEY)`);
  }
}

/** One chat completion over the default fetch stack (connection pool rotates). */
export async function chat(key, model, content, { maxTokens = 1 } = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens }),
  });
  const body = await res.text();
  let usage = null;
  try { usage = JSON.parse(body).usage; } catch { /* error body */ }
  return {
    status: res.status,
    ms: Date.now() - t0,
    prompt: usage?.prompt_tokens ?? null,
    cached: usage?.prompt_tokens_details?.cached_tokens ?? null,
    usage,
    body: body.slice(0, 200),
  };
}

/**
 * Chat calls pinned to ONE keep-alive TCP connection (maxSockets=1).
 * Sequential requests reuse the same socket, which sticks to the same
 * inference node — this is the cache-stable mode (6/6 hits in testing).
 * Returns async (content, maxTokens?) => {status, prompt, cached};
 * `.destroy()` releases the socket.
 */
export function makePinnedCaller(key, model = 'sensenova-6.8-flash-lite') {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 1000 });
  const call = (content, maxTokens = 8) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens });
    const req = https.request({
      hostname: 'token.sensenova.cn', path: '/v1/chat/completions', method: 'POST', agent,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let usage = null;
        try { usage = JSON.parse(data).usage; } catch { /* error body */ }
        resolve({ status: res.statusCode, prompt: usage?.prompt_tokens ?? 0, cached: usage?.prompt_tokens_details?.cached_tokens ?? 0 });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  call.destroy = () => agent.destroy();
  return call;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Unique-counter-prefix payload factory: breaks prompt-cache prefix sharing. */
export function makePayloadFactory(poolText) {
  let id = 0;
  return (chars, tag = '') => {
    const start = (id * 7919) % (poolText.length - chars - 100);
    return `#${id++} ${tag} ${poolText.slice(start, start + chars)}`;
  };
}

/** JSONL logger used by the harness phases. */
export function makeJsonlLogger(file) {
  return (rec) => {
    appendFileSync(file, JSON.stringify(rec) + '\n');
    console.log(JSON.stringify(rec));
  };
}

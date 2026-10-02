// Step 0: /v1/models per key + rate-limit-related response header inspection.
// Confirms there are NO x-ratelimit-*/retry-after headers (429 carries no hints).
import { loadKeys, BASE } from './lib.mjs';

const LIMIT_HEADERS = ['x-ratelimit', 'ratelimit', 'retry-after', 'x-quota', 'x-concurrency'];

const keys = loadKeys();
for (const [name, key] of Object.entries(keys).filter(([, v]) => v)) {
  console.log(`=== ${name} ===`);
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  console.log('status:', res.status);
  const interesting = [...res.headers.entries()].filter(([k]) =>
    LIMIT_HEADERS.some((h) => k.toLowerCase().includes(h)));
  console.log('rate-limit headers:', JSON.stringify(interesting));
  console.log('all header names:', [...res.headers.entries()].map(([k]) => k).join(','));
  if (res.ok) {
    const json = await res.json();
    console.log('models:', JSON.stringify((json.data ?? []).map((m) => m.id)));
  }
}

// Same-account key-sharing test: saturate one key's TPM, immediately probe a
// DIFFERENT key of the SAME account. Shared quota => probe 429; independent => 200.
// Usage: node key-share-tpm.mjs   (uses acc3key1/acc3key2; ~30k tokens on glm-5.2)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, requireKey, chat, sleep, makePayloadFactory } from './lib.mjs';

const POOL = readFileSync(join(import.meta.dirname, '..', 'data', 'text-pool.txt'), 'utf8');
const payload = makePayloadFactory(POOL);
const KEYS = loadKeys();
requireKey(KEYS, 'acc3key1', 'acc3key2');

async function call(keyName, chars, tag) {
  const r = await chat(KEYS[keyName], 'glm-5.2', payload(chars, tag));
  console.log(tag, r.status, 'prompt=' + (r.prompt ?? '-'), r.status !== 200 ? r.body.slice(0, 80) : '');
  return r.status;
}

let sum = 0;
for (let i = 0; i < 8; i += 1) {
  const st = await call('acc3key1', 16_000, `acc3key1-${i}`);
  if (st !== 200) { console.log('acc3key1 tripped at', i, `(cumulative ${sum} tokens)`); break; }
  await sleep(3000);
}
const probe = await call('acc3key2', 600, 'probe-acc3key2');
console.log(probe === 429
  ? '=> acc3key2 BLOCKED: same-account keys SHARE the TPM bucket (per-account limiting)'
  : '=> acc3key2 still OK: keys are independent buckets');

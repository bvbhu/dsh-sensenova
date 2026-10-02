// Rate-limit harness, round 2: all models except sensenova-u1.5-*.
// Per model: availability precheck (4 tries, 20s apart) -> RPM phase (12 req,
// 4s apart, small payloads) -> TPM ramp (large payloads, early stop on 429).
// A model that keeps returning 429 in the precheck is judged UNAVAILABLE and
// skipped. Accounts are rotated to spread quota cost; on every TPM 429 a
// different account is probed immediately (independence re-check).
//
// Usage: node rpm-tpm-harness.mjs [resultsFile]
// Cost estimate: ~40-60 min; ~20-36k tokens per AVAILABLE model on its
// account's general pool (flash-lite uses its dedicated pool).
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, requireKey, pickAccount, chat, sleep, makePayloadFactory } from './lib.mjs';

const RESULTS = process.argv[2] ?? join(import.meta.dirname, '..', 'data', 'results-round2.jsonl');
const POOL = readFileSync(join(import.meta.dirname, '..', 'data', 'text-pool.txt'), 'utf8');
const payload = makePayloadFactory(POOL);
const KEYS = loadKeys();
requireKey(KEYS, 'acc1key1', 'acc2key1', 'acc3key1');

// TPM ramp sizes are budget-shaped: 3 x ~9k tokens max. The public-domain
// classics are token-dense (~1.1 chars/token for classical Chinese), so 10k
// chars ≈ 9k tokens — payload chars stay at 10_000.
const TPM_CHARS = 10_000;
const MODELS = [
  { id: 'sensenova-6.8-flash-lite', account: 'acc1', ramp: 4 }, // dedicated pool
  { id: 'deepseek-v4-flash', account: 'acc1', ramp: 3 },
  { id: 'glm-5.2', account: 'acc2', ramp: 3 },
  { id: 'kimi-k3', account: 'acc2', ramp: 3 },
  { id: 'sensenova-u1-fast', account: 'acc1', ramp: 3 },
  { id: 'deepseek-v4-pro', account: 'acc3', ramp: 2 },
  { id: 'deepseek-v4.1-flash', account: 'acc3', ramp: 2 },
  { id: 'deepseek-flash', account: 'acc3', ramp: 2 },
];
const OTHER_ACCOUNT = { acc1: 'acc2key1', acc2: 'acc3key1', acc3: 'acc1key1' };

function log(rec) {
  appendFileSync(RESULTS, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
}
async function call(model, keyName, chars, tag) {
  // Transient network errors (ECONNRESET etc.) must not kill the whole run.
  for (let attempt = 1; ; attempt += 1) {
    try {
      const r = await chat(KEYS[keyName], model, payload(chars, tag));
      log({ at: new Date().toISOString(), phase: tag, model, key: keyName, status: r.status, ms: r.ms, prompt_tokens: r.prompt, cached: r.cached });
      return r;
    } catch (e) {
      if (attempt >= 3) {
        log({ at: new Date().toISOString(), phase: tag, model, key: keyName, status: 'fetch-error', error: e.cause?.code ?? e.message });
        return { status: 'fetch-error', prompt: null, cached: null };
      }
      await sleep(5000);
    }
  }
}

// --- availability precheck: 4 tries / 20s apart ---------------------------------
async function precheck(model) {
  console.log(`=== precheck ${model} ===`);
  for (let i = 0; i < 4; i += 1) {
    const r = await call(model, 'acc1key1', 600, 'precheck');
    if (r.status === 200) return true;
    if (i < 3) await sleep(20_000);
  }
  console.log(`${model}: STILL 429 after 4 tries over ~1min -> UNAVAILABLE, skipping`);
  return false;
}

// --- RPM: 12 requests, 4s apart, ~350 tokens each -------------------------------
async function rpmPhase(model, account) {
  console.log(`=== RPM ${model} (via ${account}) ===`);
  const keyName = pickAccount(account);
  const marks = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await call(model, keyName, 600, 'A-rpm');
    marks.push(r.status);
    if (r.status === 429 && marks.filter((s) => s === 429).length >= 3) break; // clearly tripped
    await sleep(4000);
  }
  return marks;
}

// --- TPM ramp: large distinct payloads, early stop on 429 -----------------------
async function tpmPhase(model, account, maxRequests) {
  console.log(`=== TPM ${model} (via ${account}, <=${maxRequests} x ~9k tokens) ===`);
  const keyName = pickAccount(account);
  let ok = 0; let sum = 0;
  for (let i = 0; i < maxRequests; i += 1) {
    const r = await call(model, keyName, TPM_CHARS, 'C-tpm');
    if (r.status !== 200) {
      const probe = await call(model, OTHER_ACCOUNT[account], 600, 'D-independence');
      console.log(`independence probe on other account: ${probe.status} ${probe.status === 200 ? '(INDEPENDENT)' : '(SHARED?!)'}`);
      break;
    }
    ok += 1; sum += r.prompt ?? 0;
    await sleep(4000);
  }
  console.log(`TPM result ${model}: ok=${ok} promptTokensSum=${sum}`);
}

writeFileSync(RESULTS, '');
const summary = {};
for (const { id, account, ramp } of MODELS) {
  const available = await precheck(id);
  summary[id] = { available, account };
  if (!available) continue;
  summary[id].rpmMarks = await rpmPhase(id, account);
  await sleep(60_000); // let the RPM window drain before the big payloads
  await tpmPhase(id, account, ramp);
  await sleep(90_000); // spacing between models (per user: wait minutes between groups)
}
console.log('\n==== SUMMARY ====');
console.log(JSON.stringify(summary, null, 2));
console.log('ALL DONE');

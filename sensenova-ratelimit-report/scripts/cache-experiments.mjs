// Cache experiments:
//   repeat      — same large payload N times over the default fetch stack
//                 (connection pool): exposes the alternating/random hit patterns.
//   incremental — simulated 5-turn conversation (growing prefix), same key:
//                 measures per-turn hit rate for long-context chat.
//   affinity    — same repeat but over ONE pinned keep-alive socket:
//                 the cache-stable mode (6/6 hits).
// Usage: node cache-experiments.mjs repeat|incremental|affinity [poolOffset]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, requireKey, chat, makePinnedCaller, sleep } from './lib.mjs';

const MODE = process.argv[2] ?? 'repeat';
const REGION = Number(process.argv[3] ?? 300_000);
const POOL = readFileSync(join(import.meta.dirname, '..', 'data', 'text-pool.txt'), 'utf8');
const KEYS = loadKeys(); requireKey(KEYS, "acc3key1");
const keyA = KEYS.acc3key1;

const bigPayload = (offset) => POOL.slice(offset, offset + 24_000); // ~9-14k tokens, no unique counter (cacheable)

if (MODE === 'repeat') {
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await chat(keyA, 'sensenova-6.8-flash-lite', bigPayload(REGION), { maxTokens: 8 });
    out.push(r.cached);
    console.log('try', i, r.status, `prompt=${r.prompt}`, `cached=${r.cached}`);
    if (r.status === 429) break;
    await sleep(2000);
  }
  console.log('pattern:', out.join(','));
} else if (MODE === 'affinity') {
  const call = makePinnedCaller(keyA);
  const out = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await call(bigPayload(REGION));
    out.push(r.cached);
    console.log('try', i, r.status, `prompt=${r.prompt}`, `cached=${r.cached}`);
    if (r.status === 429) break;
    await sleep(2500);
  }
  console.log('pattern:', out.join(','));
  call.destroy();
} else if (MODE === 'incremental') {
  // 5 turns: prefix grows by a new clause each turn; alternating user/assistant.
  const turns = [];
  let prefix = [POOL.slice(REGION, REGION + 7000)];
  for (let i = 0; i < 5; i += 1) {
    turns.push([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: `${prefix.join(' ')} 总结上文` },
      ...(i > 0 ? [{ role: 'assistant', content: POOL.slice(REGION + 7000 + i * 400, REGION + 7400 + i * 400) }] : []),
      ...(i > 0 ? [{ role: 'user', content: `继续，${POOL.slice(REGION + 9000 + i * 300, REGION + 9600 + i * 300)}` }] : []),
    ]);
    prefix.push(POOL.slice(REGION + 9000 + i * 300, REGION + 9600 + i * 300));
  }
  for (let i = 0; i < turns.length; i += 1) {
    const res = await fetch('https://token.sensenova.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sensenova-6.8-flash-lite', messages: turns[i], max_tokens: 8 }),
    });
    const body = await res.text();
    let usage = null;
    try { usage = JSON.parse(body).usage; } catch { /* error body */ }
    console.log('turn', i, res.status, `prompt=${usage?.prompt_tokens ?? '-'}`, `cached=${usage?.prompt_tokens_details?.cached_tokens ?? '-'}`);
    await sleep(2500);
  }
}

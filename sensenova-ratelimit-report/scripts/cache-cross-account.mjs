// Cross-account alternating test: two accounts, EACH with its own pinned
// keep-alive socket. Modes:
//   warm — acc1 warms a payload, acc3 probes it (x2), acc1 re-probes.
//   conv — 6-turn incremental conversation alternating accounts per turn.
// Usage: node cache-cross-account.mjs warm|conv [poolOffset]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadKeys, requireKey, makePinnedCaller, sleep } from './lib.mjs';

const MODE = process.argv[2] ?? 'warm';
const REGION = Number(process.argv[3] ?? 700_000);
const POOL = readFileSync(join(import.meta.dirname, '..', 'data', 'text-pool.txt'), 'utf8');
const KEYS = loadKeys(); requireKey(KEYS, "acc1key1", "acc3key1");

const call = { acc1: makePinnedCaller(KEYS.acc1key1), acc3: makePinnedCaller(KEYS.acc3key1) };
const content = POOL.slice(REGION, REGION + 24_000);

if (MODE === 'warm') {
  const a = await call.acc1(content);
  console.log('A(acc1) warm  :', a.status, `cached=${a.cached}`);
  const b1 = await call.acc3(content);
  console.log('B(acc3) probe :', b1.status, `cached=${b1.cached}`);
  const b2 = await call.acc3(content);
  console.log('B(acc3) probe2:', b2.status, `cached=${b2.cached}`);
  const a2 = await call.acc1(content);
  console.log('A(k1) reprobe:', a2.status, `cached=${a2.cached}`);
} else {
  let len = 24_000;
  const who = ['acc1', 'acc3'];
  for (let i = 0; i < 6; i += 1) {
    const name = who[i % 2];
    const turnContent = `${POOL.slice(REGION, REGION + len)} 第${i}轮补充：${POOL.slice(REGION + 30_000 + i * 600, REGION + 30_900 + i * 600)}`;
    len += 900;
    const r = await call[name](turnContent);
    console.log(`turn ${i} by ${name}:`, r.status, `prompt=${r.prompt}`, `cached=${r.cached}`);
    if (r.status === 429) break;
    await sleep(2500);
  }
}
call.acc1.destroy();
call.acc3.destroy();

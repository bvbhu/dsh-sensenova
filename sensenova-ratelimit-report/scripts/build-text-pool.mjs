// Build a Chinese/English text pool from PUBLIC sources (no dsh data):
//   - Gutenberg public-domain classics (Chinese): 紅樓夢 24264, 三國志演義 23950, 西遊記 23962
//   - MDN translated-content zh-cn (modern technical Chinese, CC BY-SA) via GitHub contents API
//   - English: Pride and Prejudice 1342
// HTML pages are stripped to plain text.
// Output: data/text-pool-gutenberg-mdn.txt (NOT data/text-pool.txt — the tracked
// pool is built externally; this script must not clobber it). To reproduce the
// corpus the probe scripts read, copy/rename the output to data/text-pool.txt
// (see README "复现实测").
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'data', 'text-pool-gutenberg-mdn.txt'); // NOT text-pool.txt (that pool is built externally; don't clobber)
const UA = { 'User-Agent': 'ratelimit-research/0.1 (text pool builder)' };

async function getText(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000), headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function stripPG(t) {
  const s = t.match(/\*\*\* ?START[^*]*\*\*\*/)?.index ?? 0;
  const e = t.indexOf('*** END') > 0 ? t.indexOf('*** END') : t.length;
  return t.slice(t.indexOf('\n', s) + 1, e).replace(/\r\n/g, '\n').trim();
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function ghList(dir) {
  const json = JSON.parse(await getText(`https://api.github.com/repos/mdn/translated-content/contents/files/zh-cn/${dir}`));
  return json.filter((f) => f.type === 'file' && f.name.endsWith('.html') && f.size > 3000);
}

const parts = [];

// --- Chinese classics (Gutenberg) ---
for (const id of [24264, 23950, 23962]) {
  const text = stripPG(await getText(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`));
  console.log(`classic pg${id}:`, text.length, 'chars');
  parts.push(text);
}

// --- Modern technical Chinese (MDN zh-cn, .md files one dir per API) ---
const seen = new Set();
let mdnChars = 0;
for (const dir of ['web/api', 'web/javascript', 'web/css', 'web/html', 'webassembly']) {
  let entries = [];
  try {
    entries = JSON.parse(await getText(`https://api.github.com/repos/mdn/translated-content/contents/files/zh-cn/${dir}`));
    if (!Array.isArray(entries)) throw new Error('bad listing');
  } catch (e) { console.log(`mdn ${dir}: list failed (${e.message})`); continue; }
  const subdirs = entries.filter((f) => f.type === 'dir').slice(0, 60);
  for (const sub of subdirs) {
    if (mdnChars > 400_000) break;
    try {
      const files = JSON.parse(await getText(`https://api.github.com/repos/mdn/translated-content/contents/${sub.path}`));
      const md = files.find((f) => f.name === 'index.md');
      if (!md) continue;
      const raw = await getText(md.download_url);
      // strip front matter and markdown link syntax, keep prose + inline code
      const text = raw
        .replace(/^---[\s\S]*?---\n/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6} /gm, '')
        .trim();
      if (text.length > 2000) {
        parts.push(text);
        mdnChars += text.length;
      }
    } catch { /* skip subdir */ }
  }
  console.log(`mdn ${dir}: cumulative ${mdnChars} chars`);
  if (mdnChars > 400_000) break;
}
console.log('mdn total:', mdnChars);

// --- English (Gutenberg) ---
for (const id of [1342]) {
  const text = stripPG(await getText(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`));
  console.log(`english pg${id}:`, text.length, 'chars');
  parts.push(text);
}

const pool = parts.join('\n\n');
writeFileSync(OUT, pool);
const cjk = (pool.match(/[\u4e00-\u9fff]/g) ?? []).length;
console.log(`POOL -> ${OUT}: ${pool.length} chars (cjk ${cjk}, other ${pool.length - cjk})`);

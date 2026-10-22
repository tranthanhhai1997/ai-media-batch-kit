'use strict';
/**
 * Batch image generation through chatgpt.com, rotating several logged-in Chrome profiles (LRU).
 *
 *   node examples/chatgpt-batch-images.js --prompts prompts.txt --profiles "D:/profiles/gpt1,D:/profiles/gpt2" \
 *        [--out out] [--aspect 16:9] [--concurrency 2] [--cooldown-hours 12] [--show]
 *
 * prompts.txt: one prompt per line (blank lines and lines starting with # are ignored), or a .json array
 * of strings / {prompt, refs:[{path}]} objects.
 *
 * Rules (measured on Free accounts):
 *   - each profile has its own image quota; when ChatGPT says "limit … resets in N hours" the profile is
 *     parked for N hours (default --cooldown-hours) and the prompt goes back to the queue;
 *   - profiles are used least-recently-used first so the quota drains evenly;
 *   - outputs already on disk are skipped → rerun the same command to resume.
 * State (last use / parked until) is kept in <out>/.chatgpt-profiles.json between runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createChatGptImage } = require('../src/providers/chatgpt-image');

function args(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}

function loadPrompts(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.json$/i.test(file)) {
    return JSON.parse(raw).map((x) => (typeof x === 'string' ? { prompt: x } : x));
  }
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((prompt) => ({ prompt }));
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = args(process.argv);
  if (!a.prompts || !a.profiles) {
    console.error('usage: --prompts <file> --profiles "<dir1>,<dir2>" [--out out] [--aspect 16:9] [--concurrency N] [--cooldown-hours 12] [--show]');
    process.exit(2);
  }
  const outDir = path.resolve(a.out || 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const profiles = String(a.profiles).split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
  const concurrency = Math.max(1, Math.min(profiles.length, parseInt(a.concurrency || '2', 10)));
  const cooldownH = parseFloat(a['cooldown-hours'] || '12');
  const aspect = a.aspect || '16:9';
  const maxAttempts = 3;

  // ---- persistent profile state ----
  const stateFile = path.join(outDir, '.chatgpt-profiles.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  const st = (p) => (state[p] = state[p] || { lastUsed: 0, parkedUntil: 0 });
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const busy = new Set();
  const disabled = new Set(); // auth failures: skip for this run only
  const clients = new Map();
  const client = (p) => {
    if (!clients.has(p)) clients.set(p, createChatGptImage({ profileDir: p, show: !!a.show, log: (m) => console.log(`  [${path.basename(p)}] ${m}`) }));
    return clients.get(p);
  };

  /** LRU among profiles that are free, not parked and not disabled. */
  function pickProfile() {
    const now = Date.now();
    const ok = profiles.filter((p) => !busy.has(p) && !disabled.has(p) && st(p).parkedUntil <= now);
    ok.sort((x, y) => st(x).lastUsed - st(y).lastUsed);
    return ok[0] || null;
  }

  // ---- queue ----
  const jobs = loadPrompts(a.prompts).map((j, i) => ({ ...j, idx: i + 1, attempts: 0 }));
  const width = String(jobs.length).length;
  const outBase = (j) => path.join(outDir, String(j.idx).padStart(Math.max(3, width), '0'));
  const existing = (j) => ['png', 'jpg', 'webp'].map((e) => `${outBase(j)}.${e}`).find((f) => fs.existsSync(f));
  const queue = jobs.filter((j) => !existing(j));
  const failed = [];
  console.log(`${jobs.length} prompts, ${jobs.length - queue.length} already done, ${profiles.length} profiles, concurrency ${concurrency}`);

  async function runJob(j, p) {
    busy.add(p);
    st(p).lastUsed = Date.now();
    save();
    const t0 = Date.now();
    try {
      const { buffer, contentType } = await client(p).generateImage({ prompt: j.prompt, refs: j.refs || [], aspect });
      const file = `${outBase(j)}.${EXT[contentType] || 'png'}`;
      fs.writeFileSync(file, buffer);
      console.log(`OK  #${j.idx} ${path.basename(file)} (${Math.round(buffer.length / 1024)} KB, ${Math.round((Date.now() - t0) / 1000)}s, ${path.basename(p)})`);
    } catch (e) {
      const code = e.code || 'ERROR';
      console.log(`ERR #${j.idx} ${code} on ${path.basename(p)}: ${String(e.message).slice(0, 160)}`);
      if (code === 'CHATGPT_RATE_LIMIT') {
        const h = e.resetHours != null ? e.resetHours + 0.1 : cooldownH;
        st(p).parkedUntil = Date.now() + h * 3_600_000;
        save();
        console.log(`    ${path.basename(p)} parked ${h.toFixed(1)} h`);
        queue.unshift(j); // not the prompt's fault → retry elsewhere without counting an attempt
      } else if (code === 'CHATGPT_AUTH' || code === 'CHATGPT_CLOUDFLARE') {
        disabled.add(p);
        queue.unshift(j);
      } else if (code === 'CHATGPT_POLICY' || code === 'CHATGPT_CONFIG') {
        failed.push({ idx: j.idx, code, prompt: j.prompt }); // retrying the same text will not help
      } else if (++j.attempts < maxAttempts) {
        queue.push(j); // TEXT_REPLY / TIMEOUT / TAB_LOST / DOWNLOAD / UI → try again later, maybe on another profile
      } else {
        failed.push({ idx: j.idx, code, prompt: j.prompt });
      }
    } finally {
      busy.delete(p);
    }
  }

  const running = new Set();
  while (queue.length || running.size) {
    while (queue.length && running.size < concurrency) {
      const p = pickProfile();
      if (!p) break;
      const j = queue.shift();
      const r = runJob(j, p).finally(() => running.delete(r));
      running.add(r);
    }
    if (!running.size && queue.length && !pickProfile()) {
      const usable = profiles.filter((p) => !disabled.has(p));
      if (!usable.length) { console.log('All profiles failed auth — log in again (show:true) and rerun.'); break; }
      const next = Math.min(...usable.map((p) => st(p).parkedUntil));
      console.log(`All profiles parked until ${new Date(next).toLocaleString()} — rerun later (outputs are resumable).`);
      break;
    }
    await sleep(1000);
  }

  for (const c of clients.values()) c.close();
  if (failed.length) {
    fs.writeFileSync(path.join(outDir, 'failed.json'), JSON.stringify(failed, null, 2));
    console.log(`${failed.length} failed → ${path.join(outDir, 'failed.json')}`);
  }
  console.log(`done, ${queue.length} left in queue`);
}

main().catch((e) => { console.error(e); process.exit(1); });

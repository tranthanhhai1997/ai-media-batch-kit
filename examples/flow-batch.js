'use strict';
/**
 * Batch images + Veo clips on Google Flow, rotating several logged-in Chrome profiles.
 *
 *   node examples/flow-batch.js --login D:/profiles/flow1          # once per account: sign in by hand
 *   node examples/flow-batch.js --profiles D:/profiles/flow1,D:/profiles/flow2 [--prompts prompts.json] [--out out]
 *
 * prompts.json:
 *   [
 *     { "type": "image", "name": "apple", "prompt": "a red apple on a white table", "aspect": "16:9" },
 *     { "type": "video", "name": "apple_clip", "prompt": "slow push-in, soft light", "startImageFrom": "apple",
 *       "model": "veo3_lite", "aspect": "16:9" },
 *     { "type": "video", "name": "ocean", "prompt": "calm ocean wave at sunset", "model": "veo3_fast" }
 *   ]
 * Images run first (videos may use them via startImageFrom, or startImage: "path/to.png").
 * Each job holds its account from Create to download (one result per tab at a time — see flow-veo3.md);
 * N profiles = N jobs in parallel.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createFlowClient } = require('../src/providers/flow');
const { ensureProfileChrome } = require('../src/core/chrome');
const { runBatch } = require('../src/core/queue');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

// error → what the account pool does. A job that already pressed Create (err.submitted) is NEVER moved to
// another account: Flow may have billed it and may still deliver it.
function classify(err) {
  if (err && err.submitted && err.code !== 'FLOW_RATE_LIMIT') return 'fail';
  switch (err && err.code) {
    case 'FLOW_RATE_LIMIT': return { action: 'cooldown', ms: 60_000 };        // "unusual activity": ~1 min is enough
    case 'FLOW_QUOTA': return { action: 'cooldown', ms: 7 * 24 * 3600_000 };  // out of credits: park until refill
    case 'FLOW_AUTH': return { action: 'cooldown', ms: 24 * 3600_000 };       // needs a human to sign in again
    case 'FLOW_TIMEOUT': case 'FLOW_PROJECT_DEAD': return 'retry';
    case 'FLOW_BAD_RESPONSE': return err.role ? 'retry' : 'fail';              // UI hiccup before Create → another account
    default: return 'fail';
  }
}

// crude neutralizer used once after a policy refusal (production: ask an LLM to rewrite)
const neutral = (p) => 'All people shown are original fictional characters, not real or famous persons. '
  + p.replace(/\b(celebrity|famous|KOL|idol|influencer|star)\b/gi, '').replace(/\s+/g, ' ').trim();

async function main() {
  const login = arg('--login');
  if (login) {
    await ensureProfileChrome({ profileDir: path.resolve(login), url: 'https://flow.google.com/', show: true });
    console.log('Chrome opened. Sign in to Google Flow, open any project once, then close the window.');
    return;
  }
  const profiles = String(arg('--profiles', process.env.FLOW_PROFILES || '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (!profiles.length) throw new Error('pass --profiles dir1,dir2 (Chrome profiles already signed in to flow.google.com)');
  const outDir = path.resolve(arg('--out', 'out'));
  const jobs = JSON.parse(fs.readFileSync(arg('--prompts', 'prompts.json'), 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const clients = profiles.map((p) => createFlowClient({ profileDir: path.resolve(p), show: true, log: (...a) => console.log(path.basename(p), ...a) }));
  for (const c of clients) {
    const st = await c.status();
    const cr = await c.getCredits().catch((e) => ({ credits: `? (${e.code})` }));
    console.log(`${c.profileDir}: signedIn=${st.loggedIn} ${st.email || ''} credits=${cr.credits}`);
  }

  const results = {};
  const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
  const done = (job, files, extra) => { results[job.name] = { ok: true, files, ...extra }; console.log('ok  ', job.name, files.join(', ')); };
  const fail = (job, err) => { results[job.name] = { ok: false, code: err.code, submitted: !!err.submitted, error: err.message }; console.log('FAIL', job.name, err.code, err.message); };

  // ── phase 1: images ──
  await runBatch(jobs.filter((j) => j.type === 'image'), {
    workers: clients, retries: 2, classify,
    run: async (job, flow) => {
      const imgs = await flow.generateImages({ prompt: job.prompt, aspect: job.aspect, count: job.count || 1, model: job.model, refs: job.refs || [] });
      const files = [];
      for (let i = 0; i < imgs.length; i++) files.push((await flow.download(imgs[i], path.join(outDir, `${safe(job.name || 'img')}_${i + 1}.png`))).path);
      return files;
    },
    onDone: (job, files) => done(job, files),
    onFail: fail,
  });

  // ── phase 2: clips (Create → wait → download as one job per account) ──
  const videoJobs = jobs.filter((j) => j.type === 'video').map((j) => ({
    ...j, startImage: j.startImage || (results[j.startImageFrom] && results[j.startImageFrom].files && results[j.startImageFrom].files[0]),
  }));
  await runBatch(videoJobs, {
    workers: clients, retries: 2, classify,
    run: async (job, flow) => {
      const opts = { prompt: job.prompt, aspect: job.aspect, model: job.model || 'veo3_lite', startImage: job.startImage, refs: job.refs || [] };
      const out = path.join(outDir, `${safe(job.name || 'clip')}.mp4`);
      try {
        return await flow.makeVideo(opts, out);
      } catch (err) {
        if (err.code !== 'FLOW_POLICY') throw err;
        console.log(`${job.name}: refused (${err.reason}) → one retry with a neutral prompt on the same account`);
        return flow.makeVideo({ ...opts, prompt: neutral(job.prompt) }, out);
      }
    },
    onDone: (job, r) => done(job, [r.path], { mediaId: r.mediaId, model: r.modelLabel, cost: r.cost }),
    onFail: fail,
  });

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  for (const c of clients) await c.close();
  console.log('done →', path.join(outDir, 'results.json'));
}

main().catch((e) => { console.error(e); process.exit(1); });

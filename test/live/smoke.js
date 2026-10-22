'use strict';
/**
 * LIVE smoke test against a real logged-in profile (spends a little quota/credits).
 *
 *   node test/live/smoke.js <provider> <profileDir> [step...]
 *   provider: flow | muse | chatgpt | chatgpt-api | chatgpt-text | gemini-text | grok
 *   steps (default = all of the provider): status, credits, image, video
 *
 * Writes media + a JSON-lines log to out/live/<provider>/. Never run against an account that another
 * app is using at the same moment (Muse: one live session per account).
 */
const fs = require('node:fs');
const path = require('node:path');

const [provider, profileDir, ...stepsArg] = process.argv.slice(2);
if (!provider || !profileDir) { console.error('usage: node test/live/smoke.js <provider> <profileDir> [steps]'); process.exit(2); }
const outDir = path.resolve(__dirname, '../../out/live', provider);
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, 'smoke.jsonl');
const t0 = Date.now();
function log(ev, data) {
  const line = JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), ev, ...data });
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
}
const debug = (s) => fs.appendFileSync(path.join(outDir, 'debug.log'), new Date().toISOString().slice(11, 19) + ' ' + s + '\n');
const save = (name, r) => { const p = path.join(outDir, name); fs.writeFileSync(p, r.buffer); return { file: p, bytes: r.buffer.length, type: r.contentType }; };

async function step(name, fn) {
  if (stepsArg.length && !stepsArg.includes(name)) return;
  const s = Date.now();
  log('start', { step: name });
  try {
    const r = await fn();
    log('ok', { step: name, sec: Math.round((Date.now() - s) / 1000), result: r });
  } catch (e) {
    log('fail', { step: name, sec: Math.round((Date.now() - s) / 1000), code: e.code, message: String(e.message).slice(0, 600) });
  }
}

const PROMPT_IMG = 'Cinematic photo of a small red paper boat floating on a calm lake at sunrise, soft mist';
const PROMPT_VID = 'A small red paper boat drifts slowly across a calm misty lake at sunrise, gentle ripples, slow camera push-in';

(async () => {
  log('begin', { provider, profileDir });
  if (provider === 'flow') {
    const { createFlowClient } = require('../../src/providers/flow');
    const flow = createFlowClient({ profileDir, show: false, log: debug });
    await step('status', () => flow.status());
    await step('credits', () => flow.getCredits());
    await step('video', async () => {
      const out = path.join(outDir, 'boat.mp4');
      const r = await flow.makeVideo({ prompt: PROMPT_VID, aspect: '16:9', model: process.env.FLOW_MODEL || 'veo3_lite' }, out);
      return { out, size: fs.existsSync(out) ? fs.statSync(out).size : 0, r };
    });
    await step('image', async () => {
      const imgs = await flow.generateImages({ prompt: PROMPT_IMG, aspect: '16:9', count: 1 });
      const out = path.join(outDir, 'boat.png');
      await flow.download(imgs[0], out);
      return { out, size: fs.existsSync(out) ? fs.statSync(out).size : 0 };
    });
    await step('i2v', async () => {
      const src = path.join(outDir, 'boat.png'); const out = path.join(outDir, 'boat_i2v.mp4');
      const r = await flow.makeVideo({ prompt: 'The paper boat drifts forward, ripples spread, mist moves', aspect: '16:9', model: process.env.FLOW_MODEL || 'veo3_lite', startImage: src }, out);
      return { out, size: fs.existsSync(out) ? fs.statSync(out).size : 0, r };
    });
    flow.close();
  } else if (provider === 'muse') {
    const { createMuse } = require('../../src/providers/muse');
    const muse = createMuse({ profileDir, lang: 'en', log: debug });
    await step('status', () => muse.status());
    await step('image', async () => save('boat.webp', await muse.generateImage({ prompt: PROMPT_IMG, aspect: '16:9', newChat: true })));
    await step('video', async () => save('boat.mp4', await muse.generateVideo({ prompt: 'The boat drifts slowly, ripples spread, mist moves' })));
    muse.close();
  } else if (provider === 'chatgpt' || provider === 'chatgpt-api') {
    const { createChatGptImage } = require('../../src/providers/chatgpt-image');
    const cg = createChatGptImage({ profileDir, log: debug, mode: provider === 'chatgpt-api' ? 'api' : 'ui' });
    await step('status', () => cg.status());
    await step('image', async () => save('boat.png', await cg.generateImage({ prompt: PROMPT_IMG, aspect: '16:9' })));
    cg.close();
  } else if (provider === 'chatgpt-text') {
    const { createChatGptText } = require('../../src/providers/chatgpt-text');
    const t = createChatGptText({ profileDir, log: debug });
    await step('status', () => t.status());
    await step('ask', () => t.ask({ prompt: 'Reply with exactly: PONG 42' }));
    t.close();
  } else if (provider === 'gemini-text') {
    const { createGeminiText } = require('../../src/providers/gemini-text');
    const g = createGeminiText({ profileDir, log: debug });
    await step('status', () => g.status());
    await step('ask', () => g.ask({ prompt: 'Reply with exactly: PONG 42' }));
    g.close();
  } else if (provider === 'grok') {
    const { createGrokWeb } = require('../../src/providers/grok-web');
    const g = createGrokWeb({ profileDir, log: debug });
    await step('status', () => g.status());
    await step('video', async () => save('boat.mp4', await g.imageToVideo({ image: { path: path.resolve(__dirname, '../../out/live/flow/boat.png') }, prompt: 'The paper boat drifts slowly, ripples spread', aspect: '16:9', durationSec: 6 })));
    g.close();
  } else throw new Error('unknown provider ' + provider);
  log('end', {});
  setTimeout(() => process.exit(0), 500);
})().catch((e) => { log('crash', { message: e.stack }); process.exit(1); });

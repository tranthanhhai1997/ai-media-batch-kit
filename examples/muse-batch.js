'use strict';
/**
 * Batch: one image + one clip per scene with Muse, spread across several Muse accounts.
 *
 *   node examples/muse-batch.js examples/prompts.sample.json D:/profiles/muse-1 D:/profiles/muse-2
 *
 * prompts.json: { "aspect": "16:9", "video": true, "scenes": [{ "id": "s01", "prompt": "...", "motion": "..." }] }
 * Output: out/<id>.webp and out/<id>.mp4 — already-existing files are skipped (safe to re-run after a crash).
 */
const fs = require('node:fs');
const path = require('node:path');
const { createMuse } = require('../src/providers/muse');
const { runBatch } = require('../src/core/queue');

async function main() {
  const [file, ...profiles] = process.argv.slice(2);
  if (!file || !profiles.length) throw new Error('usage: node examples/muse-batch.js prompts.json <profileDir> [profileDir...]');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const outDir = path.resolve('out');
  fs.mkdirSync(outDir, { recursive: true });

  const workers = profiles.map((p) => createMuse({ profileDir: p, log: (s) => console.log(`[${path.basename(p)}] ${s}`) }));
  for (const [i, w] of workers.entries()) {
    const st = await w.status();
    console.log(profiles[i], st);
    if (!st.connected) console.warn('  ⚠ not connected — log in once: createMuse({profileDir, show:true}).status()');
  }

  const jobs = spec.scenes.filter((s) => !fs.existsSync(path.join(outDir, s.id + (spec.video ? '.mp4' : '.webp'))));
  console.log(`${jobs.length}/${spec.scenes.length} scenes to do`);

  const results = await runBatch(jobs, {
    workers,
    // image + clip of one scene must stay on the SAME account/chat (clip animates the image above)
    run: async (scene, muse) => {
      const img = await muse.generateImage({ prompt: scene.prompt, aspect: spec.aspect || '16:9', newChat: true });
      fs.writeFileSync(path.join(outDir, scene.id + '.webp'), img.buffer);
      if (spec.video) {
        const clip = await muse.generateVideo({ prompt: scene.motion || scene.prompt });
        fs.writeFileSync(path.join(outDir, scene.id + '.mp4'), clip.buffer);
      }
      return true;
    },
    classify: (e) => {
      if (e.code === 'MUSE_NETWORK' || e.code === 'MUSE_NO_MEDIA') return 'retry';
      if (e.code === 'MUSE_SESSION_TAKEN' || e.code === 'MUSE_AUTH') return { action: 'cooldown', ms: 6 * 3600e3 };
      return 'fail';
    },
    onProgress: (s) => process.stdout.write(`\r${s.done}/${s.total} done, ${s.running} running   `),
    onFail: (scene, e) => console.error(`\n✗ ${scene.id}: ${e.code || ''} ${e.message}`),
  });
  console.log(`\nOK ${results.filter((r) => r && r.ok).length}/${jobs.length}`);
  workers.forEach((w) => w.close());
}

main().catch((e) => { console.error(e); process.exit(1); });

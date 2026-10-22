'use strict';
// node test/queue.test.js — offline test of the account-pool batch runner (no network).
const assert = require('node:assert');
const { runBatch, sleep } = require('../src/core/queue');

(async () => {
  const seen = { A: 0, B: 0 };
  let failOnce = true;
  const jobs = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  const res = await runBatch(jobs, {
    workers: ['A', 'B'],
    cooldownMs: 50,
    run: async (job, w) => {
      seen[w]++;
      await sleep(5);
      if (job.id === 3 && failOnce) { failOnce = false; const e = new Error('quota'); e.code = 'QUOTA'; throw e; }
      if (job.id === 7) { const e = new Error('policy'); e.code = 'POLICY'; throw e; }
      return w + job.id;
    },
    classify: (e) => (e.code === 'QUOTA' ? 'cooldown' : 'fail'),
  });
  assert.strictEqual(res.length, 10);
  assert.strictEqual(res.filter((r) => r.ok).length, 9, 'job 3 retried after cooldown, job 7 failed');
  assert.ok(!res[7].ok && res[7].error.code === 'POLICY');
  assert.ok(res[3].ok);
  assert.ok(seen.A > 0 && seen.B > 0, 'load spread across both accounts');
  console.log('queue.test OK', seen);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/**
 * Batch runner with an ACCOUNT POOL: each job is executed by one worker (= one logged-in profile),
 * one job per worker at a time, round-robin (least-recently-used first), with per-worker cooldown
 * when a provider says "quota/rate limit" and bounded retries for transient errors.
 *
 *   const results = await runBatch(jobs, {
 *     workers: [museA, museB],                       // anything; passed to `run`
 *     run: (job, worker) => worker.generateImage(job),
 *     classify: (err) => err.code === 'MUSE_NETWORK' ? 'retry' : err.code === 'QUOTA' ? 'cooldown' : 'fail',
 *     onDone: (job, res) => fs.writeFileSync(job.out, res.buffer),
 *   });
 *
 * Why not Promise.all: every provider here has a hard "one request per account" rule (Muse session,
 * Flow account locks, ChatGPT tab) — parallelism comes from MORE ACCOUNTS, not more requests per account.
 */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @param {Array<object>} jobs
 * @param {object} o
 * @param {Array<any>} o.workers
 * @param {(job:object, worker:any, attempt:number)=>Promise<any>} o.run
 * @param {(err:Error, job:object)=>('retry'|'cooldown'|'fail'|{action:'cooldown', ms:number})} [o.classify]
 * @param {number} [o.retries=2]          retries per job for 'retry' / 'cooldown'
 * @param {number} [o.cooldownMs=15*60e3] default worker rest after a quota/rate-limit error
 * @param {(job, result, worker)=>any} [o.onDone]
 * @param {(job, err)=>any} [o.onFail]
 * @param {(stats)=>any} [o.onProgress]
 * @param {()=>boolean} [o.shouldStop]
 * @returns {Promise<Array<{job, ok:boolean, result?:any, error?:Error}>>}
 */
async function runBatch(jobs, o) {
  const classify = o.classify || (() => 'fail');
  const retries = o.retries == null ? 2 : o.retries;
  const pool = o.workers.map((w, i) => ({ w, i, busy: false, restUntil: 0, lastUsed: 0 }));
  const queue = jobs.map((job, idx) => ({ job, idx, attempt: 0 }));
  const results = new Array(jobs.length);
  let done = 0;
  let running = 0;

  const progress = () => o.onProgress && o.onProgress({ total: jobs.length, done, running, queued: queue.length });

  function pickWorker() {
    const now = Date.now();
    const free = pool.filter((p) => !p.busy && p.restUntil <= now);
    if (!free.length) return null;
    free.sort((a, b) => a.lastUsed - b.lastUsed); // LRU: spread load evenly across accounts
    return free[0];
  }

  return new Promise((resolve) => {
    const tick = async () => {
      if (o.shouldStop && o.shouldStop()) queue.length = 0;
      if (!queue.length && running === 0) return resolve(results);
      if (pool.every((p) => p.restUntil > Date.now() && !p.busy) && queue.length && running === 0) {
        // every account resting → wait for the earliest one instead of failing
        const wake = Math.min(...pool.map((p) => p.restUntil)) - Date.now();
        setTimeout(tick, Math.max(1000, wake));
        return;
      }
      for (let free = pickWorker(); queue.length && free; free = pickWorker()) {
        const p = free; // per-iteration binding: callbacks below must keep THIS worker
        const item = queue.shift();
        p.busy = true; p.lastUsed = Date.now(); running++;
        progress();
        Promise.resolve()
          .then(() => o.run(item.job, p.w, item.attempt))
          .then((result) => {
            results[item.idx] = { job: item.job, ok: true, result };
            done++;
            try { o.onDone && o.onDone(item.job, result, p.w); } catch (_) {}
          }, (err) => {
            const c = classify(err, item.job);
            const action = typeof c === 'object' ? c.action : c;
            if ((action === 'retry' || action === 'cooldown') && item.attempt < retries) {
              if (action === 'cooldown') p.restUntil = Date.now() + ((typeof c === 'object' && c.ms) || o.cooldownMs || 15 * 60e3);
              item.attempt++;
              queue.push(item); // another account will probably take it
            } else {
              results[item.idx] = { job: item.job, ok: false, error: err };
              done++;
              try { o.onFail && o.onFail(item.job, err); } catch (_) {}
            }
          })
          .finally(() => { p.busy = false; running--; progress(); setImmediate(tick); });
      }
      if (queue.length && running === 0) setTimeout(tick, 1000); // all resting
    };
    tick();
  });
}

module.exports = { runBatch, sleep };

'use strict';
/**
 * One AI account = one job — across PROCESSES, not just inside one app.
 *
 * An in-process queue cannot see a second process (another app window, a dev build, a script driving
 * the same account). Measured 05/10/2026: two sessions on one Muse account interleave in its
 * single chat and Muse answers whichever message came last. A lock file in the profile folder is what
 * every process can see.
 *
 *   await withProfileLock(profileDir, 'muse', 'scene 12', () => muse.generateImage(...));
 */
const fs = require('node:fs');
const path = require('node:path');

const STALE_MS = 20 * 60_000; // a job longer than this crashed or was killed: its lock no longer counts

const lockFile = (dir, kind) => path.join(dir, `.mbk-${kind}.lock`);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // EPERM = exists, other user
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

/** Held by a live job of ANOTHER process (our own pid never blocks: the in-process queue handles that). */
function profileLocked(dir, kind) {
  const h = read(lockFile(dir, kind));
  return !!h && h.pid !== process.pid && Date.now() - h.at < STALE_MS && alive(h.pid);
}

/**
 * Run fn holding the account lock; waits while another live process holds it.
 * @param {{shouldAbort?: () => boolean, log?: (s:string)=>void}} [o]
 */
async function withProfileLock(dir, kind, what, fn, o = {}) {
  const file = lockFile(dir, kind);
  let told = false;
  for (;;) {
    if (o.shouldAbort && o.shouldAbort()) { const e = new Error('cancelled while waiting for the account lock'); e.code = 'CANCELLED'; throw e; }
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), what }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') return fn(); // unwritable folder must not stop the job: run unguarded
      const h = read(file);
      if (!h || h.pid === process.pid || Date.now() - h.at > STALE_MS || !alive(h.pid)) { fs.rmSync(file, { force: true }); continue; }
      if (!told && o.log) { told = true; o.log(`account busy with "${h.what}" in process ${h.pid}, waiting`); }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // heartbeat: long jobs (a Muse music video takes ~25 min) must not look stale to other processes
  const beat = setInterval(() => {
    const h = read(file);
    if (h && h.pid === process.pid) { try { fs.writeFileSync(file, JSON.stringify({ ...h, at: Date.now() })); } catch (_) {} }
  }, 60_000);
  try { return await fn(); } finally {
    clearInterval(beat);
    const h = read(file);
    if (h && h.pid === process.pid) fs.rmSync(file, { force: true });
  }
}

module.exports = { withProfileLock, profileLocked };

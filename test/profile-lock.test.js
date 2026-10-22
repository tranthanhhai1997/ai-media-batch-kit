'use strict';
// node test/profile-lock.test.js — cross-process lock basics (single process: serial + stale cleanup).
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withProfileLock, profileLocked } = require('../src/core/profile-lock');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbk-lock-'));
  const r = await withProfileLock(dir, 'x', 'job', async () => { assert.ok(fs.existsSync(path.join(dir, '.mbk-x.lock'))); return 42; });
  assert.strictEqual(r, 42);
  assert.ok(!fs.existsSync(path.join(dir, '.mbk-x.lock')), 'lock released');
  // stale lock of a dead pid is taken over
  fs.writeFileSync(path.join(dir, '.mbk-x.lock'), JSON.stringify({ pid: 999999, at: Date.now(), what: 'dead' }));
  assert.ok(!profileLocked(dir, 'x'));
  assert.strictEqual(await withProfileLock(dir, 'x', 'job2', async () => 'ok'), 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('profile-lock.test OK');
})().catch((e) => { console.error(e); process.exit(1); });

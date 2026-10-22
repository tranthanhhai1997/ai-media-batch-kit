'use strict';
/**
 * Launch / reuse a real Chrome per profile directory with a CDP port.
 *
 * One profile dir = one logged-in Google/OpenAI/Meta account. Log in ONCE by hand
 * (ensureProfileChrome({profileDir, url}) then log in by hand in the window), afterwards automation reuses the cookies.
 *
 *   const { ensureProfileChrome } = require('./chrome');
 *   const port = await ensureProfileChrome({ profileDir: 'D:/profiles/acc1', url: 'https://muse.ai/' });
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { getJson, sleep } = require('./cdp');

const PORT_FILE = '.mbk-cdp-port';

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const c = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      c.push(path.join(base, 'Google/Chrome/Application/chrome.exe'));
      c.push(path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('Chrome not found — set CHROME_PATH');
  return hit;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function portAlive(port) {
  try { const v = await getJson(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500 }); return !!v.webSocketDebuggerUrl; }
  catch (_) { return false; }
}

/**
 * --remote-debugging-port of a running Chrome whose --user-data-dir is this profile, read from the process
 * command lines. Needed because Chrome started with a FIXED port (by the user, another app, a script) does
 * not write DevToolsActivePort (live 22/10/2026) → without this we would try to launch a 2nd Chrome on the
 * same profile, which just hands over to the running one and never opens our port.
 */
function portFromProcesses(profileDir) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | ForEach-Object { $_.CommandLine }"],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true })
      : execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 10_000 });
    const want = path.resolve(profileDir).toLowerCase().replace(/[\\/]+$/, '');
    for (const line of out.split(/\r?\n/)) {
      if (/--type=/.test(line)) continue; // child processes
      const d = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(line);
      const p = /--remote-debugging-port=(\d+)/.exec(line);
      if (d && p && path.resolve(d[1] || d[2]).toLowerCase().replace(/[\\/]+$/, '') === want) return Number(p[1]);
    }
  } catch (_) {}
  return 0;
}

/** Port of a Chrome already running on this profile (port file, DevToolsActivePort, then process scan). */
async function runningPort(profileDir) {
  for (const f of [PORT_FILE, 'DevToolsActivePort']) {
    try {
      const p = parseInt(fs.readFileSync(path.join(profileDir, f), 'utf8').split(/\r?\n/)[0], 10);
      if (p && (await portAlive(p))) return p;
    } catch (_) {}
  }
  const p = portFromProcesses(profileDir);
  if (p && (await portAlive(p))) {
    try { fs.writeFileSync(path.join(profileDir, PORT_FILE), String(p)); } catch (_) {}
    return p;
  }
  return 0;
}

const starting = new Map(); // profileDir -> Promise<port>  (avoid double launch on the same profile)

/**
 * @param {object} o
 * @param {string} o.profileDir  absolute path, created if missing
 * @param {string} [o.url]       first tab
 * @param {boolean} [o.show]      false → same as offscreen:true
 * @param {boolean} [o.offscreen] true → start off-screen at 1440x900 (see core/window.js: NOT minimized, NOT headless —
 *                               Google/Meta/OpenAI block or degrade headless Chrome)
 * @param {string} [o.proxy]     e.g. "http://127.0.0.1:8899" or "socks5://host:port" (no auth — use proxy-relay for auth)
 * @param {string[]} [o.extraArgs]
 * @returns {Promise<number>} CDP port
 */
function ensureProfileChrome(o) {
  // realpath: a --user-data-dir behind a Windows junction makes Chrome's NetworkService fail to
  // mkdir its cache forever (~80k file ops/s, kernel pool leak). Resolve before launching.
  fs.mkdirSync(path.resolve(o.profileDir), { recursive: true });
  const key = fs.realpathSync.native(path.resolve(o.profileDir));
  if (starting.has(key)) return starting.get(key);
  const p = (async () => {
    const existing = await runningPort(key);
    if (existing) return existing;
    const port = await freePort();
    const args = [
      `--user-data-dir=${key}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];
    const offscreen = o.offscreen != null ? o.offscreen : o.show === false; // show:false ⇒ hidden off-screen
    if (offscreen) args.push(...require('./window').hiddenWindowArgs()); // off-screen at desktop size, see window.js
    if (o.proxy) args.push(`--proxy-server=${o.proxy}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    if (o.extraArgs) args.push(...o.extraArgs);
    if (o.url) args.push(o.url);
    const child = spawn(findChrome(), args, { detached: true, stdio: 'ignore' });
    child.unref();
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      if (await portAlive(port)) {
        try { fs.writeFileSync(path.join(key, PORT_FILE), String(port)); } catch (_) {}
        return port;
      }
      await sleep(400);
    }
    throw new Error(`Chrome did not open CDP port within 60s (profile ${key}) — is the profile already open in another Chrome without a debug port?`);
  })();
  starting.set(key, p);
  p.finally(() => starting.delete(key)).catch(() => undefined);
  return p;
}

/** Close the whole Chrome of a profile via CDP Browser.close. */
async function closeProfileChrome(profileDir) {
  const port = await runningPort(path.resolve(profileDir));
  if (!port) return false;
  const { connectBrowser } = require('./cdp');
  const b = await connectBrowser(port);
  await b.send('Browser.close').catch(() => undefined);
  b.close();
  return true;
}

module.exports = { findChrome, ensureProfileChrome, closeProfileChrome, runningPort, freePort };

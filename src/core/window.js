'use strict';
/**
 * Where the automated Chrome window lives.
 *
 * Hide = move OFF-SCREEN at a desktop size, NOT minimize (measured 10/2026):
 *  - a minimized window reports a tiny viewport → Flow switches to its PHONE layout (the ingredient
 *    picker then covers the composer);
 *  - off-screen + keepAlive() (focus/visibility emulation): a hidden Muse tab answered in ~25 s
 *    instead of 216 s.
 * A question only the user can answer (e.g. Flow's rights/consent dialog, a captcha, a login) →
 * showWindow(), then hide again once answered.
 */
const OFF = -32000;
const SIZE = { width: 1440, height: 900 };

/** Chrome flags to START hidden (pair with ensureProfileChrome({ extraArgs })). */
const hiddenWindowArgs = () => [`--window-position=${OFF},${OFF}`, `--window-size=${SIZE.width},${SIZE.height}`];

async function windowOf(client) {
  try { return await client.send('Browser.getWindowForTarget', {}); } catch (_) { return null; }
}

async function hideWindow(client) {
  const w = await windowOf(client);
  if (!w || (w.bounds.left || 0) <= OFF / 2) return;
  try {
    if (w.bounds.windowState !== 'normal') await client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
    await client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: OFF, top: OFF, ...SIZE } });
  } catch (_) { /* a window that will not move still works, just in view */ }
}

async function showWindow(client) {
  const w = await windowOf(client);
  if (w) {
    try {
      if ((w.bounds.left || 0) <= OFF / 2 || w.bounds.windowState === 'minimized') {
        await client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
        await client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: 80, top: 60, ...SIZE } });
      }
      // minimize then restore: what makes Windows actually raise a window over others
      await client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } });
      await new Promise((r) => setTimeout(r, 400));
      await client.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
    } catch (_) {}
  }
  await client.send('Page.bringToFront').catch(() => undefined);
}

module.exports = { hiddenWindowArgs, hideWindow, showWindow, OFF, SIZE };

'use strict';
/**
 * xAI official API client — Grok Imagine video + image generation. Node >= 22 (global fetch), no deps.
 *
 * Source of the contract: docs.x.ai as noted in 09/2026 (NOT re-verified here). Model names,
 * field names and prices change — check https://docs.x.ai before relying on them.
 *
 *   POST /v1/videos/generations  { model, prompt, duration (1-15), aspect_ratio, resolution,
 *                                  image (image->video), reference_images, generate_audio } -> { request_id }
 *   GET  /v1/videos/{request_id} -> { status: pending|done|expired|failed, video: { url } }   (url is temporary)
 *   POST /v1/images/generations  { model, prompt, n, response_format } -> { data: [{ url | b64_json }] }
 *   Auth: "Authorization: Bearer $XAI_API_KEY"
 *   Price noted 09/2026: video ~$0.05/s (grok-imagine-video) – $0.08/s (grok-imagine-video-1.5); image ~$0.02–0.05.
 *
 *   const { createXaiClient } = require('./xai-api');
 *   const xai = createXaiClient();                       // reads XAI_API_KEY
 *   const clip = await xai.imageToVideo({ image: { path: 'scene01.png' }, prompt: 'slow dolly in', duration: 6, aspectRatio: '9:16' });
 *   fs.writeFileSync('scene01.mp4', clip.buffer);
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  baseUrl: 'https://api.x.ai/v1',
  videoModel: 'grok-imagine-video-1.5',
  imageModel: 'grok-imagine-image', // assumption — set explicitly from docs.x.ai
};

class XaiError extends Error {
  /** @param {'XAI_AUTH'|'XAI_QUOTA'|'XAI_BAD_REQUEST'|'XAI_MODERATED'|'XAI_FAILED'|'XAI_EXPIRED'|'XAI_TIMEOUT'|'XAI_NETWORK'} code */
  constructor(code, message, status = 0, body = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
    this.name = 'XaiError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** {path} | {b64, mime} | {url} | Buffer -> URL string accepted by the API (https or data: URI). */
function toImageUrl(img) {
  if (!img) return undefined;
  if (Buffer.isBuffer(img)) return 'data:image/png;base64,' + img.toString('base64');
  if (img.url) return img.url;
  if (img.path) {
    const mime = MIME_BY_EXT[path.extname(img.path).toLowerCase()] || 'image/png';
    return `data:${mime};base64,` + fs.readFileSync(img.path).toString('base64');
  }
  if (img.b64) return `data:${img.mime || 'image/png'};base64,` + img.b64;
  throw new XaiError('XAI_BAD_REQUEST', 'image must be {path} | {b64,mime} | {url} | Buffer');
}

function classify(status, text) {
  if (status === 401 || status === 403) return 'XAI_AUTH';
  if (status === 402 || status === 429) return 'XAI_QUOTA';
  if (/moderat|content policy|safety/i.test(text || '')) return 'XAI_MODERATED';
  if (status >= 400 && status < 500) return 'XAI_BAD_REQUEST';
  return 'XAI_NETWORK';
}

/**
 * @param {object} [o]
 * @param {string} [o.apiKey=process.env.XAI_API_KEY]
 * @param {string} [o.baseUrl]
 * @param {string} [o.videoModel]
 * @param {string} [o.imageModel]
 * @param {'object'|'string'} [o.imageField='object']  how `image` is sent: { url } or a bare string (docs drifted between the two — unverified)
 * @param {(m:string)=>void} [o.log]
 */
function createXaiClient(o = {}) {
  const apiKey = o.apiKey || process.env.XAI_API_KEY;
  if (!apiKey) throw new XaiError('XAI_AUTH', 'XAI_API_KEY missing');
  const baseUrl = (o.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const videoModel = o.videoModel || DEFAULTS.videoModel;
  const imageModel = o.imageModel || DEFAULTS.imageModel;
  const imageField = o.imageField || 'object';
  const log = typeof o.log === 'function' ? (m) => o.log('[xai] ' + m) : () => {};
  const wrapImage = (u) => (u === undefined ? undefined : imageField === 'string' ? u : { url: u });

  async function call(method, route, body, { timeoutMs = 60_000, retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      let res, text;
      try {
        res = await fetch(baseUrl + route, {
          method,
          signal: ctl.signal,
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        text = await res.text();
      } catch (e) {
        clearTimeout(t);
        if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
        throw new XaiError('XAI_NETWORK', `${method} ${route}: ${e.message}`);
      }
      clearTimeout(t);
      // 429 / 5xx: short backoff (respect Retry-After when given), then give up with a typed error.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        await sleep(ra ? ra * 1000 : 3000 * (attempt + 1));
        continue;
      }
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch (_) { json = null; }
      if (!res.ok) {
        const msg = (json && (json.error && (json.error.message || json.error) || json.message)) || text.slice(0, 300);
        throw new XaiError(classify(res.status, String(msg)), `${method} ${route} -> ${res.status}: ${msg}`, res.status, json || text);
      }
      return json || {};
    }
  }

  // ---------------------------------------------------------------- video

  /**
   * Start a video job (text->video, or image->video when `image` is set).
   * @returns {Promise<{requestId:string, raw:object}>}
   */
  async function createVideo(a) {
    if (!a || !a.prompt) throw new XaiError('XAI_BAD_REQUEST', 'prompt required');
    const body = {
      model: a.model || videoModel,
      prompt: String(a.prompt),
      duration: a.duration != null ? Math.max(1, Math.min(15, Math.round(a.duration))) : undefined,
      aspect_ratio: a.aspectRatio,         // e.g. "9:16", "16:9", "1:1"
      resolution: a.resolution,            // "480p" | "720p" | "1080p"
      image: wrapImage(toImageUrl(a.image)),
      reference_images: a.referenceImages ? a.referenceImages.map((r) => wrapImage(toImageUrl(r))) : undefined, // reference-to-video, <=720p
      generate_audio: a.generateAudio,
      ...(a.extra || {}),
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    const r = await call('POST', '/videos/generations', body);
    const requestId = r.request_id || r.id;
    if (!requestId) throw new XaiError('XAI_FAILED', 'no request_id in response', 200, r);
    log('video job ' + requestId);
    return { requestId, raw: r };
  }

  function getVideo(requestId) {
    return call('GET', '/videos/' + encodeURIComponent(requestId));
  }

  /** Poll until done. @returns {Promise<{url:string, raw:object}>} */
  async function waitVideo(requestId, { timeoutMs = 15 * 60_000, intervalMs = 5000, onProgress } = {}) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = await getVideo(requestId);
      const status = String(r.status || '').toLowerCase();
      if (onProgress) onProgress(r);
      const url = (r.video && r.video.url) || r.url || (r.data && r.data[0] && r.data[0].url) || '';
      if ((status === 'done' || status === 'completed' || status === 'succeeded') && url) return { url, raw: r };
      if (status === 'failed') {
        const why = JSON.stringify(r.error || r.reason || r).slice(0, 300);
        throw new XaiError(/moderat|policy|safety/i.test(why) ? 'XAI_MODERATED' : 'XAI_FAILED', 'video failed: ' + why, 200, r);
      }
      if (status === 'expired') throw new XaiError('XAI_EXPIRED', 'video request expired before download', 200, r);
      await sleep(intervalMs);
    }
    throw new XaiError('XAI_TIMEOUT', `video ${requestId} not done in ${Math.round(timeoutMs / 1000)}s`);
  }

  /** Download a (temporary) result URL. No auth header: these are pre-signed CDN links. */
  async function download(url, { timeoutMs = 180_000 } = {}) {
    if (/^data:/.test(url)) {
      const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
      return { buffer: Buffer.from(m[3], m[2] ? 'base64' : 'utf8'), contentType: m[1] || 'application/octet-stream' };
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new XaiError(r.status === 403 || r.status === 404 ? 'XAI_EXPIRED' : 'XAI_NETWORK', `download ${r.status}`, r.status);
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'video/mp4' };
    } catch (e) {
      if (e instanceof XaiError) throw e;
      throw new XaiError('XAI_NETWORK', 'download failed: ' + e.message);
    } finally { clearTimeout(t); }
  }

  /** create + wait + download in one call. */
  async function generateVideo(a, waitOpts) {
    const { requestId } = await createVideo(a);
    const { url, raw } = await waitVideo(requestId, waitOpts);
    const file = await download(url);
    return { ...file, requestId, url, raw };
  }

  const textToVideo = (a, w) => generateVideo({ ...a, image: undefined }, w);
  const imageToVideo = (a, w) => {
    if (!a || !a.image) throw new XaiError('XAI_BAD_REQUEST', 'image required');
    return generateVideo(a, w);
  };

  // ---------------------------------------------------------------- image

  /**
   * @param {object} a
   * @param {string} a.prompt
   * @param {number} [a.n=1]
   * @param {string} [a.model]
   * @param {'b64_json'|'url'} [a.responseFormat='b64_json']
   * @param {object} [a.extra]  extra body fields (e.g. aspect_ratio if the model supports it)
   * @returns {Promise<Array<{buffer:Buffer, contentType:string, revisedPrompt?:string, url?:string}>>}
   */
  async function generateImage(a) {
    if (!a || !a.prompt) throw new XaiError('XAI_BAD_REQUEST', 'prompt required');
    const fmt = a.responseFormat || 'b64_json';
    const r = await call('POST', '/images/generations', {
      model: a.model || imageModel, prompt: String(a.prompt), n: a.n || 1, response_format: fmt, ...(a.extra || {}),
    }, { timeoutMs: 180_000 });
    const items = Array.isArray(r.data) ? r.data : [];
    if (!items.length) throw new XaiError('XAI_FAILED', 'no image in response', 200, r);
    const out = [];
    for (const it of items) {
      if (it.b64_json) out.push({ buffer: Buffer.from(it.b64_json, 'base64'), contentType: it.mime_type || 'image/jpeg', revisedPrompt: it.revised_prompt });
      else if (it.url) out.push({ ...(await download(it.url)), url: it.url, revisedPrompt: it.revised_prompt });
    }
    return out;
  }

  return { createVideo, getVideo, waitVideo, download, generateVideo, textToVideo, imageToVideo, generateImage };
}

module.exports = { createXaiClient, XaiError, DEFAULTS };

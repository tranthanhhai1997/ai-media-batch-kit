'use strict';
// node test/page-scripts.test.js — every JS snippet we inject into pages must at least PARSE (offline).
const assert = require('node:assert');
const { _page: m } = require('../src/providers/muse');

const scripts = [
  m.jsWaitNewAfter('img', 'abc', 'abc\nsecond line', 'landscape'),
  m.jsWaitNewAfter('video', 'abc', 'x', '', 28, 40),
  m.jsLoadBuf('video', 'n', '', 5), m.jsLoadBuf('img', null, 'portrait'), m.jsReadChunk(400000),
  m.jsAttached(['a.png']), m.jsSend('hi "q" `b` ${x}\nline2'), m.jsAttachDataTransfer([{ b64: 'AA==', mime: 'image/png', name: 'a.png' }]),
  m.JS_STATE, m.JS_BUSY, m.JS_ACCOUNT, m.JS_MARK_SEEN, m.JS_NEW_CHAT, m.JS_FILE_INPUT, m.JS_ATTACH_BUTTON, m.JS_UPLOAD_ITEM,
];
for (const s of scripts) assert.doesNotThrow(() => new Function('return ' + s), s.slice(0, 120));
console.log('page-scripts.test OK', scripts.length);

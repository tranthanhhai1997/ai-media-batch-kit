'use strict';
// node scripts/check.js — syntax-check every .js file and require() every module in src/ (no network).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'out') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error('SYNTAX', path.relative(root, f), String(e.stderr).split('\n').slice(0, 4).join('\n')); }
}
for (const f of files.filter((f) => f.includes(path.join('src', '')))) {
  try { require(f); } catch (e) { bad++; console.error('REQUIRE', path.relative(root, f), e.message); }
}
console.log(bad ? `${bad} problem(s)` : `OK — ${files.length} files`);
process.exit(bad ? 1 : 0);

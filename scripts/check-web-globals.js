#!/usr/bin/env node
'use strict';
// CROSS-FILE GLOBAL COLLISION GATE for controller/web/js/.
//
// WHY deploy.sh's EXISTING CHECK CANNOT DO THIS. That gate is `node --check` per file, and it was
// added because "a one-character variable collision in controller/web/js/audit.js reached
// production and took out the whole Audit tab". But per-file checking is blind to the actual
// hazard: these are CLASSIC scripts, so every file's top-level declarations land in ONE shared
// global lexical environment. Two files each declaring `const esc` are individually valid and
// collectively a SyntaxError — and the backend never sees browser JS, so the container starts
// happily and the only symptom is a blank tab.
//
// TWO PASSES, because the two failure modes are different:
//
//   1. let / const / class  -> a genuine redeclaration SyntaxError, which kills the whole page.
//      Caught by concatenating the files in their index.html load order and running one parse over
//      the result. That is a faithful model of the browser's shared global scope and needs no
//      parser dependency.
//
//   2. function NAME()      -> NOT an error. The second declaration silently REPLACES the first,
//      which is worse: the page loads, and whichever feature called the shadowed function quietly
//      gets the other file's implementation. Only a name-by-name comparison finds these.
//
// Run standalone or from deploy.sh:  node scripts/check-web-globals.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// WEB_ROOT is an override so this gate can be tested against a fixture. A checker nobody has seen
// fail is indistinguishable from a checker that always passes.
const ROOT = process.env.WEB_ROOT || path.join(__dirname, '..', 'controller', 'web');
const JS = path.join(ROOT, 'js');

// LOAD ORDER COMES FROM index.html, not from a sorted directory listing — order is load-bearing
// (helpers first, then feature modules, then main.js boots) and a collision report that used a
// different order would point at the wrong file.
function loadOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = [];
  const re = /<script\s+src="js\/([A-Za-z0-9._-]+\.js)"/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

const order = loadOrder();
if (!order.length) {
  console.error('check-web-globals: found no <script src="js/..."> tags in index.html');
  process.exit(1);
}

// Any .js in the directory that index.html does not load is dead weight — flag it rather than
// silently skipping it, since a file nobody loads is usually a rename that half-happened.
const onDisk = fs.readdirSync(JS).filter((f) => f.endsWith('.js')).sort();
const orphans = onDisk.filter((f) => !order.includes(f));

// ---- pass 1: the shared global scope, modelled by concatenation -------------------------------
const parts = order.map((f) => ({ f, src: fs.readFileSync(path.join(JS, f), 'utf8') }));
// Strip each file's own 'use strict' prologue: concatenated, a directive from file 2 onward is
// just a stray expression statement, and one file's strictness must not silently change another's.
const joined = parts
  .map(({ f, src }) => `/* ==== ${f} ==== */\n${src.replace(/^\s*(['"])use strict\1\s*;?/, '')}`)
  .join('\n;\n');

try {
  new vm.Script(joined, { filename: 'controller/web/js/*.js (concatenated in load order)' });
} catch (e) {
  console.error('check-web-globals: the files do NOT coexist in one global scope.');
  console.error(`  ${e.message}`);
  // Bisect to name the offending file: parse a growing prefix and report the first one that breaks.
  let acc = '';
  for (const { f, src } of parts) {
    const next = `${acc}\n;\n${src.replace(/^\s*(['"])use strict\1\s*;?/, '')}`;
    try { new vm.Script(next, { filename: f }); } catch (inner) {
      console.error(`  first failure when ${f} is added: ${inner.message}`);
      break;
    }
    acc = next;
  }
  process.exit(1);
}

// ---- pass 2: silently-overwritten top-level function declarations -----------------------------
// Deliberately a line-anchored scan rather than an AST walk: a top-level declaration in these
// files always starts at column 0, and nested ones are always indented. That keeps this script
// dependency-free, and a false negative here is no worse than the status quo.
const decls = new Map();          // name -> [files]
const DECL = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
for (const { f, src } of parts) {
  for (const line of src.split('\n')) {
    const m = DECL.exec(line);
    if (!m) continue;
    if (!decls.has(m[1])) decls.set(m[1], []);
    decls.get(m[1]).push(f);
  }
}
const dupes = [...decls].filter(([, files]) => new Set(files).size > 1);

if (dupes.length) {
  console.error('check-web-globals: top-level function declared in more than one file.');
  console.error('  These do NOT throw — the later one silently replaces the earlier, so a caller');
  console.error('  gets the wrong implementation and the page still loads.');
  for (const [name, files] of dupes) console.error(`  ${name}()  <-  ${[...new Set(files)].join(', ')}`);
  process.exit(1);
}

if (orphans.length) {
  console.error(`check-web-globals: js/ contains file(s) index.html never loads: ${orphans.join(', ')}`);
  console.error('  Add a <script> tag or delete the file — an unloaded file is usually a half-done rename.');
  process.exit(1);
}

console.log(`check-web-globals: ${order.length} script(s) share one global scope cleanly`
  + ` (${decls.size} top-level functions, no duplicates)`);

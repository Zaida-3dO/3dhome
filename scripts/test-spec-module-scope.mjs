#!/usr/bin/env node
/**
 * test-spec-module-scope.mjs -- a static guard against the exact bug class
 * that made ClockSpec.html render completely blank (item 059873ed, round-2
 * review, code_review 01ba013f HIGH / visual_review 87fbd768 HIGH).
 *
 * WHAT HAPPENED: specs/ClockSpec.html's `<script type="module">` block
 * imports the real builder as `import * as WallClock from '...'`. That
 * import lives in the ES MODULE's own top-level scope, which is completely
 * separate from the page's `<script type="text/babel">` block below it (a
 * classic script, not a module) -- so `WallClock` does not exist there at
 * all. One function in the Babel script, `buildClockScene`, happened to
 * declare its OWN local `const WallClock = window.__wallClock` and so
 * worked by coincidence; a later change added a bare `WallClock.foo`
 * reference inside a DIFFERENT function, `furnitureJSON`, which has no such
 * local declaration -- `ReferenceError: WallClock is not defined`, thrown
 * during React's render, which unmounts the whole page. No Node test or CI
 * job renders these spec pages (they are static HTML + Babel, not modules
 * under test), so nothing caught it before a live browser review did.
 *
 * WHAT THIS CHECKS (deliberately narrow, to avoid false positives -- see
 * the note at the bottom on what this does NOT attempt): for every
 * `import * as <Name>` / `import <Name>` in a spec page's `<script
 * type="module">` block(s), every BARE reference to `<Name>` inside the
 * page's `<script type="text/babel">` block(s) must fall within a
 * top-level function that itself contains a local `const/let/var <Name> =`
 * redeclaration earlier in the same function body. This is exactly the
 * shape the real bug had (a shadowing local in one function, a bare
 * unshadowed reference in another), and is checkable with per-function text
 * scanning rather than a real JS parser or scope graph.
 *
 * WHAT THIS DOES NOT CHECK (stated plainly, not overclaimed): this is a
 * static, regex-based, per-top-level-function check, not a real scope
 * analyzer and not a runtime smoke test. It does not catch every possible
 * ReferenceError (e.g. one inside a nested block scope with its own
 * shadowing rules, or a name mistake unrelated to the module/classic-script
 * split), and it does not render or execute the page at all -- an actual
 * "does this page mount without throwing" check would need a real or
 * headless browser (Playwright/Puppeteer), which is not part of this repo's
 * toolchain (no package.json, no node_modules, no bundler) and was judged
 * out of scope to add for one guard rather than run and reported honestly
 * as infrastructure this repo does not currently have.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specDir = path.join(root, 'specs');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

/** Every <script type="module">...</script> block's raw content. */
function moduleScriptBlocks(html) {
  const out = [];
  const re = /<script\s+type="module"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** Every <script type="text/babel">...</script> block's raw content. */
function babelScriptBlocks(html) {
  const out = [];
  const re = /<script\s+type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** Import aliases: `import * as Foo` / `import Foo from` / `import { a as Foo }`. */
function importAliases(moduleSrc) {
  const names = new Set();
  const starRe = /import\s+\*\s+as\s+(\w+)\s+from/g;
  const defaultRe = /import\s+(\w+)\s*(?:,|\s+from)/g;
  const namedAsRe = /\{\s*[^}]*?\bas\s+(\w+)\b[^}]*?\}/g;
  let m;
  while ((m = starRe.exec(moduleSrc))) names.add(m[1]);
  while ((m = defaultRe.exec(moduleSrc))) names.add(m[1]);
  while ((m = namedAsRe.exec(moduleSrc))) names.add(m[1]);
  return names;
}

/**
 * Split a classic script's source into its TOP-LEVEL function bodies, by
 * brace-counting from each `function NAME(...) {` or `NAME = (...) => {`
 * declaration at column 0 (this file's own convention -- every top-level
 * function/component in a spec page starts at the left margin). Returns
 * [{ name, body }]. Not a real parser: relies on the spec pages' own
 * consistent style (checked against all 18 files below) rather than
 * handling arbitrary JS.
 */
function topLevelFunctionBodies(src) {
  const out = [];
  const startRe = /^function\s+(\w+)\s*\([^)]*\)\s*\{/gm;
  let m;
  while ((m = startRe.exec(src))) {
    const name = m[1];
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    out.push({ name, body: src.slice(start, i - 1) });
  }
  return out;
}

/**
 * Every occurrence of `name` used as a MODULE-STYLE PROPERTY ACCESS --
 * `Name.something` or `Name(` -- word-bounded on both sides and not itself
 * preceded by `.` (so `foo.Name` does not count: that reads a PROPERTY
 * called Name, not the free identifier Name). This is deliberately
 * narrower than "every bare occurrence of the identifier", for two reasons
 * found by running an earlier, broader version of this check against all
 * 18 real spec pages before trusting it:
 *   1. Word-boundary alone still matches inside PLAIN JSX TEXT, which is
 *      indistinguishable from code at the character level without a real
 *      parser -- `<h1>Dining Spec</h1>` matched the import alias `Dining`
 *      in DiningSpec.html, a page that works fine (the text is not a JS
 *      reference at all). Every real module alias in this codebase is used
 *      via `.something` or a call -- `WallClock.DIY_WORDS_DEFAULTS`,
 *      `K.TYPES[...]`, `Dining.TYPES[...]` -- never bare, so requiring a
 *      trailing `.` or `(` keeps the check to shapes that ARE code.
 *   2. This also means the check does not need to special-case an
 *      identifier that legitimately never gets used bare (e.g. only ever
 *      destructured) -- it only ever looks at the exact shape the real bug
 *      had.
 */
function bareReferences(body, name) {
  const re = new RegExp('(?<![.\\w$])' + name + '(?=\\s*[.(])', 'g');
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    const before = body.slice(Math.max(0, m.index - 10), m.index);
    if (/(?:const|let|var)\s+$/.test(before)) continue; // this occurrence IS the declaration
    out.push(m.index);
  }
  return out;
}

/** Does `body` contain a local `const/let/var <name> =` before `beforeIndex` (or anywhere, if beforeIndex is omitted)? */
function hasLocalRedeclaration(body, name, beforeIndex) {
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=');
  const m = re.exec(body);
  if (!m) return false;
  return beforeIndex === undefined || m.index < beforeIndex;
}

/**
 * Does the Babel script declare `const/let/var <name> =` at its OWN TOP
 * LEVEL -- i.e. a line starting at column 0, not inside any function body?
 * If so, every top-level function in the SAME script closes over it via
 * ordinary JS scoping, exactly like KitchenSpec.html's own
 * `const K = window.FurnitureKitchen;` (declared once, used from
 * initialState/buildKitchen/App/etc without any of them redeclaring it) --
 * a second, equally legitimate pattern alongside "redeclare it locally in
 * the one function that uses it" (ClockSpec.html's buildClockScene, and
 * DiningSpec.html's own per-function `const Dining = window.__dining`).
 */
function hasTopLevelRedeclaration(babelSrc, name) {
  const re = new RegExp('^(?:const|let|var)\\s+' + name + '\\s*=', 'm');
  return re.test(babelSrc);
}

const files = fs.readdirSync(specDir).filter(f => f.endsWith('.html'));
check('found spec pages to check', files.length > 0, files.length);

files.forEach(file => {
  const html = fs.readFileSync(path.join(specDir, file), 'utf8');
  const moduleBlocks = moduleScriptBlocks(html);
  const babelBlocks = babelScriptBlocks(html);
  if (!moduleBlocks.length || !babelBlocks.length) return; // not this page's shape -- nothing to check

  const aliases = new Set();
  moduleBlocks.forEach(src => importAliases(src).forEach(n => aliases.add(n)));
  if (!aliases.size) return;

  babelBlocks.forEach(babelSrc => {
    const fns = topLevelFunctionBodies(babelSrc);
    aliases.forEach(name => {
      // Pattern 1 (KitchenSpec.html's own shape): declared ONCE at the
      // Babel script's own top level, covering every function below it via
      // ordinary closure scoping. If so, no per-function check is needed at
      // all for this alias in this file.
      if (hasTopLevelRedeclaration(babelSrc, name)) return;
      fns.forEach(({ name: fnName, body }) => {
        const refs = bareReferences(body, name);
        if (!refs.length) return;
        const firstRefIndex = refs[0];
        // Pattern 2 (ClockSpec.html's buildClockScene, DiningSpec.html's
        // own per-function shape): redeclared locally, inside THIS SAME
        // function, before its first use here.
        const locallyDeclared = hasLocalRedeclaration(body, name, firstRefIndex);
        check(
          file + ': ' + fnName + '() does not use the module-scope import alias "' + name + '" without a redeclaration in scope (its own body, or the script\'s top level)',
          locallyDeclared,
          { file, function: fnName, alias: name, referenceCount: refs.length }
        );
      });
    });
  });
});

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);

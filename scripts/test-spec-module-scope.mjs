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
 * Round-3 review (item 059873ed, optional low): blank out `//` line
 * comments, `/* *\/` block comments, and string/template literals --
 * replacing their CONTENTS with spaces character-for-character (so byte
 * offsets used elsewhere, like `bareReferences`' match index, stay valid)
 * -- so a comment or string that happens to contain e.g. `WallClock.` text
 * cannot be mistaken for a real code reference, and a `const`/`let`/`var`
 * mentioned only in a comment cannot be mistaken for a real redeclaration.
 * Not a real tokenizer: does not handle a `/` that is division rather than
 * the start of a comment (rare in this codebase's own style, and a false
 * NEGATIVE from mishandling it -- treating real code as a comment -- is the
 * safe failure direction, not a false positive), and does not handle an
 * escaped quote inside a string with full generality beyond a single
 * backslash-escape lookback (sufficient for this codebase's own strings).
 *
 * Round-4 review (item b5a00233): a `'`/`"` only OPENS a string when the
 * previous non-whitespace character is an operator-ish one -- one of
 * `( , = : [ { ? ! & | + ;` -- or the preceding word is the `return`
 * keyword. Every real string literal in this codebase's Babel blocks is
 * preceded by one of those (an assignment, an argument list, a property
 * value, a ternary/logical operand, a return statement, ...); a bare `'`
 * or `"` anywhere else is JSX TEXT -- an apostrophe in prose like
 * `<p>Don't</p>` or `the body's own depth` -- and must be left as real
 * text, not treated as the start of a string that blanks everything up to
 * the next matching quote (which silently ate real code in two spec pages,
 * RadiatorSpec.html and BathroomFittingsSpec.html, both of which use a
 * possessive/contraction apostrophe inside JSX text right next to a real
 * template literal or string). A backtick always opens a template literal
 * -- this codebase never uses a bare backtick as JSX text -- but its own
 * `${...}` interpolations are REAL CODE, not literal text, so their
 * contents are copied through unchanged (recursively, so a nested string or
 * backtick inside the interpolation is itself handled correctly) while only
 * the literal text around them is blanked.
 *
 * Round-5 (item b5a00233, optional low): also treat `=>` (an arrow
 * function's own body position, e.g. `onChange={v => 'x'}`) and the `case`
 * keyword (a switch-case value, e.g. `case 'x':`) as operand boundaries --
 * both shapes that can legitimately precede a real string literal in this
 * codebase's arrow-heavy callback style, and neither currently in
 * OPERAND_BOUNDARY. Deliberately NOT adding bare `<`/`>` for "comparison
 * operators": a JSX tag closer is also a bare `>` (`<div className="legend">The
 * module's own origin...`, RadiatorSpec.html's own real text), so treating
 * `>` as an operand boundary would reopen exactly the false positive this
 * round-4 fix eliminated. The safe subset added here is the two-or-more
 * character comparison operators (`===`, `!==`, `==`, `!=`, `<=`, `>=`),
 * which cannot be confused with a JSX tag delimiter.
 */
function stripCommentsAndStrings(src) {
  // Characters after which a `'`/`"` is judged to OPEN a string (an
  // operand position), plus start-of-source / start-of-line, which behave
  // the same way -- a quote at the very start of a script or a line is
  // always the start of a statement/expression, never trailing JSX text.
  const OPERAND_BOUNDARY = new Set(['(', ',', '=', ':', '[', '{', '?', '!', '&', '|', '+', ';', '\n', undefined]);
  const RETURN_RE = /(?:^|[^\w$])return\s*$/;
  const ARROW_RE = /=>\s*$/;
  const CASE_RE = /(?:^|[^\w$])case\s*$/;
  // Multi-char comparison operators only -- bare `<`/`>` are deliberately
  // excluded (see the doc comment above: a JSX tag closer is also a bare
  // `>`, right before real JSX text like RadiatorSpec.html's own
  // `<div className="legend">The module's own origin...`).
  const COMPARISON_RE = /(?:===|!==|==|!=|<=|>=)\s*$/;

  /** The last non-space character appended to `out` so far, or undefined at the very start. */
  function lastNonSpace(out) {
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k] !== ' ' && out[k] !== '\n' && out[k] !== '\t' && out[k] !== '\r') return out[k];
    }
    return undefined;
  }

  /** Does a `'`/`"` at this point in `out` open a real string (vs. being JSX text like an apostrophe)? */
  function quoteOpensString(out) {
    const prev = lastNonSpace(out);
    if (OPERAND_BOUNDARY.has(prev)) return true;
    // Look back over `out` (skipping trailing whitespace) for a `return`
    // keyword, an arrow `=>`, a `case` keyword, or a multi-char comparison
    // operator -- all operand-position boundaries the single-character
    // lastNonSpace() check above cannot express.
    const tail = out.slice(Math.max(0, out.length - 200));
    return RETURN_RE.test(tail) || ARROW_RE.test(tail) || CASE_RE.test(tail) || COMPARISON_RE.test(tail);
  }

  /**
   * Strip one region of source starting at `start` (an index into `src`),
   * appending to a fresh output buffer, until either the end of `src` or --
   * when `stopAtBrace` is true -- an unmatched top-level `}` is reached
   * (used to find the end of a `${...}` interpolation while still handling
   * any comments/strings/nested braces INSIDE it correctly). Returns
   * { out, i } where `i` is the index just past what was consumed (past the
   * closing `}` when `stopAtBrace`, i.e. never included in `out`).
   */
  function stripFrom(start, stopAtBrace) {
    let out = '';
    let i = start;
    let braceDepth = 0;
    while (i < n) {
      const c = src[i], c2 = src[i + 1];
      if (stopAtBrace && c === '}' && braceDepth === 0) {
        i++; // consume the closing brace, do not include it in `out`
        break;
      }
      if (c === '{') { braceDepth++; out += c; i++; }
      else if (c === '}') { braceDepth--; out += c; i++; }
      else if (c === '/' && c2 === '/') {
        let j = i;
        while (j < n && src[j] !== '\n') { out += ' '; j++; }
        i = j;
      } else if (c === '/' && c2 === '*') {
        let j = i;
        while (j < n && !(src[j] === '*' && src[j + 1] === '/')) { out += (src[j] === '\n' ? '\n' : ' '); j++; }
        if (j < n) { out += '  '; j += 2; } // consume the closing */
        i = j;
      } else if (c === '`') {
        // Template literal: blank the literal text, but keep `${...}`
        // interpolation contents live by recursing into stripFrom.
        out += ' ';
        let j = i + 1;
        while (j < n && src[j] !== '`') {
          if (src[j] === '$' && src[j + 1] === '{') {
            const inner = stripFrom(j + 2, true);
            out += '$' + '{' + inner.out + '}';
            j = inner.i;
            continue;
          }
          if (src[j] === '\\') { out += (src[j] === '\n' ? '\n' : ' '); j++; }
          out += (src[j] === '\n' ? '\n' : ' ');
          j++;
        }
        if (j < n) { out += ' '; j++; } // consume the closing backtick
        i = j;
      } else if ((c === '"' || c === '\'') && quoteOpensString(out)) {
        const quote = c;
        out += ' ';
        let j = i + 1;
        while (j < n && src[j] !== quote) {
          if (src[j] === '\\') { out += (src[j] === '\n' ? '\n' : ' '); j++; } // skip the escaped character too
          out += (src[j] === '\n' ? '\n' : ' ');
          j++;
        }
        if (j < n) { out += ' '; j++; } // consume the closing quote
        i = j;
      } else {
        out += c;
        i++;
      }
    }
    return { out, i };
  }

  const n = src.length;
  return stripFrom(0, false).out;
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
  const startRe = /^function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
  let m;
  while ((m = startRe.exec(src))) {
    const name = m[1];
    const params = m[2];
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    // Round-3 review (item 059873ed, optional low): a PARAMETER named the
    // same as a module alias (e.g. `function f(WallClock) { ... }`) also
    // legitimately shadows it, the same as a local `const`/`let`/`var`
    // redeclaration -- prepending the parameter list to `body` here lets
    // hasLocalRedeclaration's own `const|let|var NAME` regex miss it (a
    // parameter isn't declared with any of those keywords), so it is
    // instead checked directly by the caller via `params`.
    out.push({ name, body: src.slice(start, i - 1), params });
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
 * Does `params` (a function's own parameter list, e.g. `"a, WallClock, b"`)
 * declare `name` as one of its parameters? A parameter shadows a
 * module-scope alias exactly like a local redeclaration would -- checked as
 * a whole comma-separated identifier so `WallClockOpts` does not falsely
 * match a search for `WallClock`.
 */
function hasParamShadow(params, name) {
  if (!params) return false;
  return params.split(',').some(p => p.trim().split(/[\s=:{}[\]]/)[0] === name);
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

/**
 * Run the whole scope check against one page's HTML (a real file, or a
 * synthetic in-memory fixture for this script's own self-tests below).
 * `label` is used only in check() names/details.
 */
function checkSpecHtml(label, html) {
  const moduleBlocks = moduleScriptBlocks(html);
  const babelBlocks = babelScriptBlocks(html);
  if (!moduleBlocks.length || !babelBlocks.length) return; // not this page's shape -- nothing to check

  const aliases = new Set();
  moduleBlocks.forEach(src => importAliases(src).forEach(n => aliases.add(n)));
  if (!aliases.size) return;

  babelBlocks.forEach(rawBabelSrc => {
    // Strip comments/strings ONCE, up front, so neither the brace-counting
    // in topLevelFunctionBodies (a `{` inside a string or comment would
    // otherwise miscount) nor the reference/redeclaration regexes below can
    // be confused by one -- see stripCommentsAndStrings' own doc comment.
    const babelSrc = stripCommentsAndStrings(rawBabelSrc);
    const fns = topLevelFunctionBodies(babelSrc);
    aliases.forEach(name => {
      // Pattern 1 (KitchenSpec.html's own shape): declared ONCE at the
      // Babel script's own top level, covering every function below it via
      // ordinary closure scoping. If so, no per-function check is needed at
      // all for this alias in this file.
      if (hasTopLevelRedeclaration(babelSrc, name)) return;
      fns.forEach(({ name: fnName, body, params }) => {
        // Pattern 3 (round-3 review, optional low): a function PARAMETER
        // named the same as the alias shadows it for the whole body,
        // exactly like a local redeclaration -- checked before scanning for
        // references at all, since a shadowed name is never a real
        // free-identifier reference to the module-scope alias.
        if (hasParamShadow(params, name)) return;
        const refs = bareReferences(body, name);
        if (!refs.length) return;
        const firstRefIndex = refs[0];
        // Pattern 2 (ClockSpec.html's buildClockScene, DiningSpec.html's
        // own per-function shape): redeclared locally, inside THIS SAME
        // function, before its first use here.
        const locallyDeclared = hasLocalRedeclaration(body, name, firstRefIndex);
        check(
          label + ': ' + fnName + '() does not use the module-scope import alias "' + name + '" without a redeclaration in scope (its own body, its own parameters, or the script\'s top level)',
          locallyDeclared,
          { label, function: fnName, alias: name, referenceCount: refs.length }
        );
      });
    });
  });
}

const files = fs.readdirSync(specDir).filter(f => f.endsWith('.html'));
check('found spec pages to check', files.length > 0, files.length);
files.forEach(file => checkSpecHtml(file, fs.readFileSync(path.join(specDir, file), 'utf8')));

// ---- Self-test: the round-3 hardening against comments, strings and -----------------
//      parameter shadowing (item 059873ed, optional low) -----------------------------
//      Synthetic fixtures, not real spec pages -- exercises checkSpecHtml()
//      directly against each false-positive shape the round-3 reviewer
//      named, plus the real bug shape, to prove the hardening actually
//      suppresses the false positives WITHOUT also suppressing the real one.
{
  const fixture = `
<script type="module">
  import * as WallClock from '../src/furniture/wall-clock.js';
  window.__wallClock = WallClock;
</script>
<script type="text/babel">
function commentRef() {
  // this comment mentions WallClock.DIY_WORDS_DEFAULTS but is not code
  return 1;
}
function stringRef() {
  const s = "a string with WallClock.build inside it";
  return s;
}
function paramShadow(WallClock) {
  return WallClock.foo;
}
function jsxApostrophe() {
  const label = <p>Don't show the raw value, it's clamped down -- the module's own default applies</p>;
  return WallClock.DIY_WORDS_DEFAULTS;
}
function realBug() {
  return WallClock.DIY_WORDS_DEFAULTS;
}
</script>`;
  // A SEPARATE fixture for the template-literal-interpolation shape: a bare
  // alias reference INSIDE a \`\${...}\` interpolation is real code (just like
  // realBug above), so it must still be CAUGHT, not treated as a 4th
  // false-positive shape alongside comment/string/paramShadow/jsxApostrophe.
  const templateFixture = `
<script type="module">
  import * as WallClock from '../src/furniture/wall-clock.js';
  window.__wallClock = WallClock;
</script>
<script type="text/babel">
function templateInterpolation() {
  const s = \`width \${WallClock.DEFAULTS.width} cm\`;
  return s;
}
</script>`;
  // Intercept check() for the duration of this one call, so the
  // deliberately-triggered failures (proving realBug and jsxApostrophe are
  // still caught) do not leak into this script's own overall pass/fail exit
  // code -- this fixture's outcome is verified and reported here, not left
  // to fail the whole file.
  const seen = [];
  const realCheck = check;
  check = (name, cond, detail) => { seen.push({ name, cond, detail }); }; // eslint-disable-line no-func-assign
  try {
    checkSpecHtml('self-test-fixture', fixture);
  } finally {
    check = realCheck; // eslint-disable-line no-func-assign
  }
  const failedNames = seen.filter(s => !s.cond).map(s => s.name);
  // jsxApostrophe() is EXPECTED to fail too: it has a real, uncaught bare
  // reference to WallClock.DIY_WORDS_DEFAULTS in its return statement, right
  // after a JSX-text apostrophe/contraction ("Don't", "it's", "module's").
  // Before the round-4 fix, that leading apostrophe opened a fake string
  // that blanked the real `return WallClock.DIY_WORDS_DEFAULTS;` below it,
  // so this function's own real bug went UNDETECTED -- exactly the failure
  // mode item b5a00233 named. Asserting it DOES fail here is the regression
  // test: if the apostrophe fix broke, this assertion is what would catch it
  // going back to being silently swallowed.
  const onlyExpectedFailed = failedNames.length === 2 &&
    failedNames.some(n => n.includes('realBug()')) &&
    failedNames.some(n => n.includes('jsxApostrophe()'));
  check('self-test: the hardened guard flags exactly the real bugs (realBug, jsxApostrophe) and none of the 3 known false-positive shapes (comment, string, parameter shadow)',
    onlyExpectedFailed, { failedNames, totalChecksRun: seen.length });

  // The template-literal-interpolation fixture: templateInterpolation()
  // contains a bare `WallClock.DEFAULTS.width` reference INSIDE a
  // `${...}` interpolation -- if stripCommentsAndStrings blanked
  // interpolation contents (rather than keeping them live), this reference
  // would be invisible and the check for it would never even run, which
  // would silently PASS rather than fail. Assert it is caught.
  const seen2 = [];
  const realCheck2 = check;
  check = (name, cond, detail) => { seen2.push({ name, cond, detail }); }; // eslint-disable-line no-func-assign
  try {
    checkSpecHtml('template-fixture', templateFixture);
  } finally {
    check = realCheck2; // eslint-disable-line no-func-assign
  }
  const templateFailedNames = seen2.filter(s => !s.cond).map(s => s.name);
  const templateInterpolationCaught = templateFailedNames.length === 1 && templateFailedNames[0].includes('templateInterpolation()');
  check('self-test: templateInterpolation() -- a bare reference inside a `${...}` interpolation is still visible to the guard and caught (interpolation contents are not blanked)',
    templateInterpolationCaught, { templateFailedNames, totalChecksRun: seen2.length });

  // Round-5 (item b5a00233, optional low) fixture: a real string literal
  // preceded by `=>` (an arrow function's own expression body) or `case`
  // (a switch-case value) must still be recognised and stripped, THE SAME
  // WAY stringRef() above proves it for a plain assignment. BEFORE this
  // round-5 change, neither `=>` nor `case` was in the operand boundary
  // set, so `v => "x"` / `case "x":` wrongly left their string content
  // LIVE -- and a WallClock-shaped mention inside one of those strings
  // would then be misread as a real bare reference and wrongly FLAG a
  // function that has no real bug at all (a false positive, the same
  // failure mode as the pre-round-4 stringRef() case). Neither function
  // below has any OTHER reference to WallClock, so each must PASS if (and
  // only if) its string is correctly stripped.
  const operatorFixture = `
<script type="module">
  import * as WallClock from '../src/furniture/wall-clock.js';
  window.__wallClock = WallClock;
</script>
<script type="text/babel">
function arrowStringRef() {
  const onChange = v => "a string mentioning WallClock.build, not code";
  return onChange;
}
function caseStringRef(mode) {
  switch (mode) {
    case "a string mentioning WallClock.build, not code":
      return 1;
    default:
      return 2;
  }
}
</script>`;
  const seen3 = [];
  const realCheck3 = check;
  check = (name, cond, detail) => { seen3.push({ name, cond, detail }); }; // eslint-disable-line no-func-assign
  try {
    checkSpecHtml('operator-fixture', operatorFixture);
  } finally {
    check = realCheck3; // eslint-disable-line no-func-assign
  }
  const operatorFailedNames = seen3.filter(s => !s.cond).map(s => s.name);
  // Neither function has a real bare reference to WallClock -- both must
  // PASS (zero failures). If `=>`/`case` were missing from the operand
  // boundary set, the string's own "WallClock.build" text would be read as
  // a real reference and one or both would wrongly FAIL here.
  check('self-test: a string literal after `=>` or `case` is correctly recognised as a real string (not JSX text) and stripped -- no false-positive flag on a function with no real reference',
    operatorFailedNames.length === 0, { operatorFailedNames, totalChecksRun: seen3.length });
}

// ---- Self-test: injection probe (item b5a00233 acceptance) ------------------------
//      For every REAL spec page with a namespace alias, inject the exact bug
//      shape from the ClockSpec incident and assert the guard catches it.
//      Two injection SHAPES, not one:
//
//      Shape A -- APPEND a brand-new `function zzProbe() { return
//      <alias>.zzProbe; }` at the end of the Babel block. This proves the
//      guard catches a new top-level function added after everything else.
//
//      Shape B (round-5, item b5a00233's actual acceptance) -- insert a bare
//      `<alias>.zzProbe;` statement just BEFORE the closing brace of the
//      LAST top-level function in the block (on this codebase's pages, that
//      is always `App()`). Shape A alone cannot pin the bug the round-4
//      review found: RadiatorSpec.html and BathroomFittingsSpec.html's own
//      misses were 53 lines INSIDE App()'s existing body (line 342 and
//      368-419 of RadiatorSpec's Babel block, including the line just before
//      App's own closing brace) -- a false string opened by a JSX apostrophe
//      earlier in App() blanked real code ahead of the probe location, and a
//      probe appended in a brand-new function after App() never exercises
//      that blanked span at all. Inserting the probe statement immediately
//      before App's closing brace instead means: if the stripper has
//      silently blanked anything between an earlier JSX apostrophe/template
//      literal and the end of App(), the probe statement itself falls inside
//      that blanked run and disappears too, so the guard sees no reference
//      and wrongly passes -- which is exactly the miss this pins.
//
//      KitchenSpec.html is exempt from both shapes: it declares `const K` at
//      its Babel script's own top level (Pattern 1), so EVERY function in
//      that file, including an injected probe, legitimately closes over it.
{
  const KITCHEN_EXEMPT = new Set(['KitchenSpec.html']);

  /**
   * Find the raw (unstripped) offset of the LAST top-level
   * `function NAME(...) {`...`}`'s own closing brace in `babelSrc`, by
   * brace-counting from its last column-0 `function` declaration -- the
   * same convention topLevelFunctionBodies relies on. Operates on the RAW
   * block text (not the comment/string-stripped copy) so the returned
   * offset can be used directly to splice the original source; a `{`/`}`
   * inside a real string or comment could miscount, but every spec page's
   * own top-level functions in this codebase close with a `}` at column 0,
   * so a mismatched count here would show up immediately as a wrong probe
   * placement rather than silently -- acceptable for a self-test fixture
   * over this repo's own known-shape files. Returns
   * { closeIdx, name, params, body } or null if no top-level function is
   * found in this block at all.
   */
  function lastTopLevelFunctionCloseBrace(babelSrc) {
    const startRe = /^function\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
    let m, last = null;
    while ((m = startRe.exec(babelSrc))) last = m;
    if (!last) return null;
    let depth = 1;
    let start = last.index + last[0].length;
    let i = start;
    while (i < babelSrc.length && depth > 0) {
      if (babelSrc[i] === '{') depth++;
      else if (babelSrc[i] === '}') { depth--; if (depth === 0) return { closeIdx: i, name: last[1], params: last[2], body: babelSrc.slice(start, i) }; }
      i++;
    }
    return null;
  }

  files.forEach(file => {
    const html = fs.readFileSync(path.join(specDir, file), 'utf8');
    const moduleBlocks = moduleScriptBlocks(html);
    const babelBlocks = babelScriptBlocks(html);
    if (!moduleBlocks.length || !babelBlocks.length) return;
    const aliases = new Set();
    moduleBlocks.forEach(src => importAliases(src).forEach(n => aliases.add(n)));
    if (!aliases.size) return;

    const lastBabelBlock = babelBlocks[babelBlocks.length - 1];

    // Shape A always appends to the LAST babel block, matching how a real
    // change would add a new top-level function to the page's own script.
    function runProbe(shapeLabel, targetBlock, injectedBlock, alias, targetFnName) {
      const injectedHtml = html.replace(targetBlock, injectedBlock);

      const seen = [];
      const realCheck = check;
      check = (name, cond, detail) => { seen.push({ name, cond, detail }); }; // eslint-disable-line no-func-assign
      try {
        checkSpecHtml(file, injectedHtml);
      } finally {
        check = realCheck; // eslint-disable-line no-func-assign
      }
      const zzProbeFailed = seen.some(s => !s.cond && s.name.includes(targetFnName + '()') && s.name.includes('"' + alias + '"'));
      if (KITCHEN_EXEMPT.has(file)) {
        check('injection probe (' + shapeLabel + '): ' + file + ' -- zzProbe referencing "' + alias + '" is legitimately NOT flagged (top-level redeclaration exempts the whole file)',
          !zzProbeFailed, { file, alias, seenNames: seen.map(s => s.name) });
      } else {
        check('injection probe (' + shapeLabel + '): ' + file + ' -- injecting a bare "' + alias + '.zzProbe" reference is caught by the guard',
          zzProbeFailed, { file, alias, seenNames: seen.map(s => s.name) });
      }
    }

    // Shape B target: the LAST top-level function found by scanning babel
    // blocks from the end -- NOT necessarily the last block itself. Some
    // pages (SmallItemsSpec.html) end with a final babel block that is pure
    // top-level statements (no `function` declaration at all, e.g. a render
    // call), so the last block containing an actual top-level function can
    // be an earlier one.
    let shapeBTarget = null; // { block, fn: { closeIdx, name, body } }
    for (let bi = babelBlocks.length - 1; bi >= 0; bi--) {
      const fn = lastTopLevelFunctionCloseBrace(babelBlocks[bi]);
      if (fn) { shapeBTarget = { block: babelBlocks[bi], fn }; break; }
    }

    aliases.forEach(alias => {
      // Shape A: append a brand-new function at the end of the Babel block.
      const appendProbe = `\nfunction zzProbe() { return ${alias}.zzProbe; }\n`;
      runProbe('append new function', lastBabelBlock, lastBabelBlock + appendProbe, alias, 'zzProbe');

      // Shape B: insert a bare reference statement just before the LAST
      // top-level function's own closing brace (i.e. inside App()'s
      // existing body on every real page here), so a stripper that has
      // blanked real code earlier in that function -- the actual
      // RadiatorSpec/BathroomFittingsSpec miss -- is pinned. Skipped only if
      // no top-level function was found in ANY babel block on the page.
      if (shapeBTarget === null) {
        check('injection probe (inside last function, before its closing brace): ' + file + ' -- found a top-level function to inject into',
          false, { file, note: 'no top-level function() declaration found in any babel block -- cannot run shape B' });
        return;
      }
      const { block, fn } = shapeBTarget;
      // A function that already has its OWN local redeclaration of this
      // alias (Pattern 2 -- e.g. ModelSpec.html's App() has its own
      // `const M = window.FurnitureModel;`) or a parameter shadowing it
      // (Pattern 3) legitimately closes over a LOCAL M, not the module-scope
      // alias -- a bare reference anywhere in that function's body,
      // including right before its closing brace, is correctly never
      // flagged, the same as KitchenSpec's top-level-redeclaration
      // exemption. Skip shape B for this (file, alias) pair rather than
      // asserting a catch that would never legitimately happen.
      const locallyShadowed = hasLocalRedeclaration(fn.body, alias) || hasParamShadow(fn.params, alias);
      if (locallyShadowed) {
        check('injection probe (inside ' + fn.name + '(), before its closing brace): ' + file + ' -- zzProbe referencing "' + alias + '" is legitimately NOT flagged (' + fn.name + '() has its own local redeclaration/param shadow)',
          true, { file, alias, fn: fn.name });
        return;
      }
      const insideProbe = `\n  void ${alias}.zzProbe;\n`;
      const injected = block.slice(0, fn.closeIdx) + insideProbe + block.slice(fn.closeIdx);
      runProbe('inside ' + fn.name + '(), before its closing brace', block, injected, alias, fn.name);
    });
  });
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);

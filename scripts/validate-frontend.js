/**
 * Build-time validation for the frontend bundle.
 *
 * Run by build-frontend.ps1 before publishing. Refuses to ship a bundle that would
 * fail in the browser.
 *
 * The first check exists because of a real failure: i18n.js declared a top-level
 * `function t()`, app.js declared `const { t } = window.VaioI18n`, and because classic
 * scripts share one global lexical environment the browser threw
 * "Identifier 't' has already been declared" — silently killing the whole of app.js
 * and every event listener in it. Parsing each file on its own cannot see that;
 * only checking them together can.
 *
 * Usage: node scripts/validate-frontend.js [webUiDir]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const webUi = process.argv[2] || path.join(__dirname, '..', 'web-ui');
const SCRIPTS = ['theme.js', 'i18n.js', 'app.js'];

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL ${msg}`);
  failures += 1;
};
const ok = (msg) => console.log(`  ok   ${msg}`);

const read = (name) => fs.readFileSync(path.join(webUi, name), 'utf8');

// ── 1. Each script parses on its own ────────────────────────────────────
console.log('Parsing each script:');
const sources = {};
for (const file of SCRIPTS) {
  sources[file] = read(file);
  try {
    new vm.Script(sources[file], { filename: file });
    ok(`${file} (${sources[file].split('\n').length} lines)`);
  } catch (err) {
    fail(`${file} does not parse: ${err.message}`);
  }
}

// ── 2. The scripts coexist in one global lexical scope ──────────────────
// Classic <script> elements share the global lexical environment, so a top-level
// let/const/class in one file collides with the same name in another. Concatenating
// and parsing reproduces that.
console.log('Checking for global declaration collisions:');
const combined = SCRIPTS.map((f) => `// ===== ${f} =====\n${sources[f]}`).join('\n');
try {
  new vm.Script(combined, { filename: 'combined' });
  ok('theme.js + i18n.js + app.js share the global scope without collisions');
} catch (err) {
  fail(`scripts collide in the global scope: ${err.message}`);
  const nameMatch = err.message.match(/Identifier '([^']+)'/);
  if (nameMatch) {
    const name = nameMatch[1];
    console.error(`       '${name}' is declared at the top level of more than one file.`);
    console.error('       Wrap the offending file in an IIFE and export via window, or rename.');
    for (const file of SCRIPTS) {
      const re = new RegExp(`^(?:const|let|var|class|function)\\s+${name}\\b|^\\s*(?:const|let)\\s*\\{[^}]*\\b${name}\\b`, 'm');
      if (re.test(sources[file])) console.error(`       declared in: ${file}`);
    }
  }
}

// ── 3. Only the intended globals are exported ───────────────────────────
// theme.js and i18n.js must expose exactly one namespace each. Anything else leaking
// is what caused the collision above.
console.log('Checking module encapsulation:');
for (const [file, expected] of [['theme.js', 'window.VaioTheme'], ['i18n.js', 'window.VaioI18n']]) {
  const body = sources[file];
  const wrapped = /\(function \(\) \{/.test(body) && /\}\)\(\);\s*$/.test(body.trimEnd() + '\n');
  if (wrapped) ok(`${file} is wrapped in an IIFE`);
  else fail(`${file} is not wrapped in an IIFE, so its declarations leak to the global scope`);
  if (body.includes(expected)) ok(`${file} exports ${expected}`);
  else fail(`${file} does not assign ${expected}`);
}

// ── 4. i18n dictionary integrity ────────────────────────────────────────
console.log('Checking translations:');
const tableMatch = sources['i18n.js'].match(/const I18N_STRINGS = (\{[\s\S]*?\n\});\n/);
if (!tableMatch) {
  fail('could not locate I18N_STRINGS in i18n.js');
} else {
  const strings = vm.runInNewContext(`(${tableMatch[1]})`);
  const langs = Object.keys(strings);
  const keySets = {};
  for (const lang of langs) keySets[lang] = new Set(Object.keys(strings[lang]));
  ok(`languages: ${langs.map((l) => `${l}=${keySets[l].size}`).join(' ')}`);

  const [base, ...others] = langs;
  for (const lang of others) {
    const missing = [...keySets[base]].filter((k) => !keySets[lang].has(k));
    const extra = [...keySets[lang]].filter((k) => !keySets[base].has(k));
    if (missing.length) fail(`${lang} is missing ${missing.length} key(s): ${missing.slice(0, 8).join(', ')}`);
    if (extra.length) fail(`${lang} has ${extra.length} key(s) absent from ${base}: ${extra.slice(0, 8).join(', ')}`);
    if (!missing.length && !extra.length) ok(`${lang} key set matches ${base}`);

    // A {placeholder} present in one language but not the other renders a literal brace.
    const marks = (text) => (text.match(/\{(\w+)\}/g) || []).sort().join(',');
    const mismatch = [...keySets[base]].filter(
      (k) => keySets[lang].has(k) && marks(strings[base][k]) !== marks(strings[lang][k])
    );
    if (mismatch.length) fail(`${lang} placeholder mismatch: ${mismatch.slice(0, 8).join(', ')}`);
    else ok(`${lang} placeholders match ${base}`);
  }

  // Every key referenced must resolve, or the UI shows a raw key.
  const html = read('index.html');
  const referenced = new Set();
  for (const m of sources['app.js'].matchAll(/\bt\(\s*'([^']+)'/g)) referenced.add(m[1]);
  for (const m of html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria-label)?="([^"]+)"/g)) {
    referenced.add(m[1]);
  }
  const unknown = [...referenced].filter((k) => !keySets[base].has(k));
  if (unknown.length) fail(`unknown keys referenced: ${unknown.join(', ')}`);
  else ok(`all ${referenced.size} referenced keys resolve`);
}

// ── 5. Element IDs referenced from JS actually exist ────────────────────
// A missing id makes getElementById return null, and the first property assignment on it
// throws "Cannot set properties of null", which names neither the id nor the file. IDs
// may come from index.html or from markup app.js injects, so both count. Lazily created
// elements assign their own id, so those count too.
console.log('Checking element ids:');
{
  const html = read('index.html');
  const app = sources['app.js'];
  const defined = new Set();
  for (const m of html.matchAll(/\bid="([^"${}]+)"/g)) defined.add(m[1]);
  for (const m of app.matchAll(/\bid="([^"${}]+)"/g)) defined.add(m[1]);
  for (const m of app.matchAll(/\bid='([^'${}]+)'/g)) defined.add(m[1]);
  // `el.id = 'foo'` creates the node at runtime.
  for (const m of app.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) defined.add(m[1]);

  const referenced = new Map();
  const patterns = [
    [/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g, 'getElementById'],
    [/\bbyId\(\s*['"]([^'"]+)['"]\s*\)/g, 'byId'],
    [/\brequireEl\(\s*['"]([^'"]+)['"]\s*\)/g, 'requireEl'],
    [/\$\(\s*['"]#([^'"\s.,[]+)['"]\s*\)/g, '$'],
  ];
  for (const [re, via] of patterns) {
    for (const m of app.matchAll(re)) {
      const id = m[1];
      if (id.includes('$') || id.includes('{')) continue; // interpolated at runtime
      if (!referenced.has(id)) referenced.set(id, via);
    }
  }

  const missing = [...referenced.entries()].filter(([id]) => !defined.has(id));
  if (missing.length) {
    fail(`${missing.length} element id(s) referenced from app.js but never defined:`);
    for (const [id, via] of missing) {
      const line = app.split('\n').findIndex((l) => l.includes(`'${id}'`) || l.includes(`"${id}"`)) + 1;
      console.error(`       #${id} via ${via} (app.js:${line})`);
    }
  } else {
    ok(`all ${referenced.size} referenced element ids exist`);
  }
}

// ── 6. Theme token integrity ────────────────────────────────────────────
console.log('Checking theme tokens:');
const css = read('styles.css');
const tokensFor = (theme) => {
  const block = css.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  return block ? new Set([...block[1].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])) : null;
};
const dark = tokensFor('dark');
const light = tokensFor('light');
if (!dark || !light) {
  fail('could not read both [data-theme] blocks from styles.css');
} else {
  const onlyDark = [...dark].filter((x) => !light.has(x));
  const onlyLight = [...light].filter((x) => !dark.has(x));
  if (onlyDark.length) fail(`tokens missing from the light theme: ${onlyDark.join(', ')}`);
  if (onlyLight.length) fail(`tokens missing from the dark theme: ${onlyLight.join(', ')}`);
  if (!onlyDark.length && !onlyLight.length) ok(`both themes define the same ${dark.size} tokens`);
}

const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
const declared = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const undeclared = [...used].filter((v) => !declared.has(v));
if (undeclared.length) fail(`undeclared CSS variables referenced: ${undeclared.join(', ')}`);
else ok(`all ${used.size} referenced CSS variables are declared`);

// Colour literals belong in the theme blocks only; anywhere else breaks one theme.
const rules = css
  .replace(/\[data-theme="(?:dark|light)"\]\s*\{[\s\S]*?\n\}/g, '')
  .replace(/:root:not\(\[data-theme\]\)\s*\{[\s\S]*?\n\}/g, '');
const literals = rules.split('\n').filter((l) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l));
if (literals.length) {
  fail(`${literals.length} colour literal(s) outside the theme blocks:`);
  literals.slice(0, 5).forEach((l) => console.error(`       ${l.trim()}`));
} else {
  ok('no colour literals outside the theme blocks');
}

console.log('');
if (failures) {
  console.error(`Frontend validation FAILED with ${failures} problem(s).`);
  process.exit(1);
}
console.log('Frontend validation passed.');

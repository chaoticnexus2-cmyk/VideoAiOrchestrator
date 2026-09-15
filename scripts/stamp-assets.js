/**
 * Append a content hash to local asset URLs in the staged index.html.
 *
 * Cache headers alone cannot fix a browser that is not asking. An asset originally served
 * with no Cache-Control gets cached heuristically, and until that expires the browser
 * never revalidates, so a corrected header is never seen. Because none of these files are
 * content-hashed, index.html and app.js can then drift apart, getElementById returns null
 * for markup that does not exist yet, and the UI fails with "Cannot set properties of
 * null".
 *
 * Stamping each reference with a hash of the file's own bytes makes every deploy produce
 * URLs the browser has never requested, so it must fetch them. Combined with index.html
 * being served no-cache, the HTML and its scripts can no longer be out of step.
 *
 * Only same-origin, relative references are touched; CDN URLs are left alone.
 *
 * Usage: node scripts/stamp-assets.js <distDir>
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2];
if (!distDir) {
  console.error('Usage: node scripts/stamp-assets.js <distDir>');
  process.exit(1);
}

const indexPath = path.join(distDir, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error(`stamp-assets: no index.html in ${distDir}`);
  process.exit(1);
}

const shortHash = (filePath) =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 10);

let html = fs.readFileSync(indexPath, 'utf8');
const stamped = [];
let missing = 0;

// src="foo.js" and href="foo.css", relative paths only. A leading scheme, //, or / means
// it is not one of our staged files.
const pattern = /\b(src|href)="(?!https?:|\/\/|\/|data:|#)([^"?#]+\.(?:js|css))"/g;

html = html.replace(pattern, (whole, attribute, file) => {
  const assetPath = path.join(distDir, file);
  if (!fs.existsSync(assetPath)) {
    console.error(`  WARN ${file} is referenced but not present in the bundle`);
    missing += 1;
    return whole;
  }
  const hash = shortHash(assetPath);
  stamped.push(`${file}?v=${hash}`);
  return `${attribute}="${file}?v=${hash}"`;
});

// A build id that is visible without opening devtools, so "which version am I running"
// is answerable directly. Derived from the stamped set, so it changes when any asset does.
const buildId = crypto
  .createHash('sha256')
  .update(stamped.join('|'))
  .digest('hex')
  .slice(0, 10);

if (/<meta name="vaio-build"/.test(html)) {
  html = html.replace(/<meta name="vaio-build" content="[^"]*">/, `<meta name="vaio-build" content="${buildId}">`);
} else {
  html = html.replace(/<head>/, `<head>\n  <meta name="vaio-build" content="${buildId}">`);
}

fs.writeFileSync(indexPath, html, 'utf8');

console.log(`  build id: ${buildId}`);
for (const entry of stamped) console.log(`  stamped   ${entry}`);
if (missing) {
  console.error(`stamp-assets: ${missing} referenced file(s) missing from the bundle`);
  process.exit(1);
}

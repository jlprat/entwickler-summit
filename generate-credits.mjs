#!/usr/bin/env node
/**
 * generate-credits.mjs
 *
 * Reads this project's installed dependency tree, looks up each package's
 * maintainers on the npm registry, and rewrites the CREDITS array inside the
 * deck's HTML. The number on slide 8 and the names on slide 32 both come from
 * this array, so they stay in sync automatically.
 *
 * Run it before the talk:
 *     npm install          # make sure node_modules matches the lockfile
 *     node generate-credits.mjs sustainability-beyond-funds.html
 *
 * Offline / air-gapped: pass --no-fetch to skip the registry lookups. Packages
 * then roll as "maintainer unlisted", which still makes the point.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv.find(a => a.endsWith('.html')) ?? 'sustainability-beyond-funds.html';
const doFetch = !process.argv.includes('--no-fetch');

// ---- 1. the tree -----------------------------------------------------------
let tree;
try {
  const raw = execFileSync('npm', ['ls', '--all', '--json', '--long=false'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],   // npm ls exits non-zero on peer warnings
  });
  tree = JSON.parse(raw);
} catch (err) {
  if (err.stdout) tree = JSON.parse(err.stdout);
  else {
    console.error('Could not read the dependency tree. Run `npm install` first.');
    process.exit(1);
  }
}

const names = new Set();
(function walk(node) {
  for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
    names.add(name);
    walk(dep);
  }
})(tree);

const packages = [...names].sort((a, b) => a.localeCompare(b));
console.log(`${packages.length} packages in the tree.`);

// ---- 2. the humans ---------------------------------------------------------
async function maintainersOf(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (!res.ok) return '';
  const meta = await res.json();
  const list = (meta.maintainers ?? []).map(m => m.name).filter(Boolean);
  return list.slice(0, 3).join(', ');
}

const credits = [];
for (let i = 0; i < packages.length; i++) {
  const pkg = packages[i];
  let who = '';
  if (doFetch) {
    try { who = await maintainersOf(pkg); } catch { /* roll as unlisted */ }
    if (i % 25 === 0) process.stderr.write(`  ${i}/${packages.length}\r`);
  }
  credits.push([pkg, who]);
}
console.log(`\nResolved maintainers for ${credits.filter(c => c[1]).length} of ${credits.length}.`);

// ---- 3. write it back ------------------------------------------------------
const body = credits
  .map(([pkg, who]) => `  [${JSON.stringify(pkg)}, ${JSON.stringify(who)}],`)
  .join('\n');

const html = readFileSync(target, 'utf8');
const re = /const CREDITS = \[[\s\S]*?\n\];/;
if (!re.test(html)) {
  console.error(`Could not find the CREDITS array in ${target}.`);
  process.exit(1);
}
writeFileSync(target, html.replace(re, `const CREDITS = [\n${body}\n];`));
console.log(`Wrote ${credits.length} credits into ${target}.`);

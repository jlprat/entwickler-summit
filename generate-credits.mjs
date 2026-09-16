#!/usr/bin/env node
/**
 * generate-credits.mjs
 *
 * Builds the credits roll (slide 32) and the dependency count (slide 8) from
 * this project's installed dependency tree, and writes them into the deck.
 *
 *     npm install
 *     node generate-credits.mjs sustainability-beyond-funds.html
 *
 * Where the names come from, in order of preference:
 *   1. `author` in the package's own package.json — the human who wrote it.
 *   2. `contributors` / `maintainers` in that same file.
 *   3. Optionally (--fetch) the npm registry's `maintainers`, which are npm
 *      *account* names rather than people, so they're a last resort.
 *
 * Emails and URLs are stripped. This goes on a cinema screen.
 *
 * Flags:
 *   --fetch          look up packages that declare no author at all
 *   --prod           production dependencies only (default: everything installed)
 *   --max-people=N   names listed per package (default 2)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const target = args.find(a => a.endsWith('.html')) ?? 'sustainability-beyond-funds.html';
const doFetch = args.includes('--fetch');
const prodOnly = args.includes('--prod');
const maxPeople = Number(args.find(a => a.startsWith('--max-people='))?.split('=')[1] ?? 2);

if (!existsSync('node_modules')) {
  console.error('No node_modules here. Run `npm install` first — the names live in the\n' +
                'installed packages, not in the lockfile.');
  process.exit(1);
}

// ---- 1. every installed package, including nested and scoped ---------------
function collect(dir, found = new Map()) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }

  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name === '.bin' || e.name === '.cache') continue;

    const path = join(dir, e.name);

    // @scope/* — the packages sit one level down
    if (e.name.startsWith('@')) { collect(path, found); continue; }

    const pkgFile = join(path, 'package.json');
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
        if (pkg.name && !found.has(pkg.name)) found.set(pkg.name, pkg);
      } catch { /* unreadable package.json, skip */ }
    }

    // packages can carry their own nested node_modules
    const nested = join(path, 'node_modules');
    if (existsSync(nested)) collect(nested, found);
  }
  return found;
}

let installed = collect('node_modules');

if (prodOnly) {
  try {
    const raw = execFileSync('npm', ['ls', '--all', '--omit=dev', '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const keep = new Set();
    (function walk(n) {
      for (const [name, dep] of Object.entries(n.dependencies ?? {})) { keep.add(name); walk(dep); }
    })(JSON.parse(raw));
    installed = new Map([...installed].filter(([name]) => keep.has(name)));
  } catch {
    console.warn('Could not resolve the production-only tree; using everything installed.');
  }
}

console.log(`${installed.size} packages installed.`);

// ---- 2. turn package.json people into readable names ----------------------
// npm accepts either "Name <email> (url)" or { name, email, url }.
function personName(p) {
  if (!p) return '';
  if (typeof p === 'string') {
    return p.replace(/<[^>]*>/g, '')      // drop <email>
            .replace(/\([^)]*\)/g, '')    // drop (url)
            .replace(/\s+/g, ' ')
            .trim();
  }
  if (typeof p === 'object' && p.name) return String(p.name).trim();
  return '';
}

function peopleOf(pkg) {
  const names = [];
  const push = p => {
    const n = personName(p);
    if (n && !/^(npm|bot|github-actions)$/i.test(n) && !names.includes(n)) names.push(n);
  };

  push(pkg.author);
  for (const c of [].concat(pkg.contributors ?? [])) push(c);
  for (const m of [].concat(pkg.maintainers ?? [])) push(m);
  return names;
}

const credits = [];
const needsLookup = [];

for (const [name, pkg] of [...installed].sort((a, b) => a[0].localeCompare(b[0]))) {
  const names = peopleOf(pkg);
  if (names.length) {
    credits.push([name, names.slice(0, maxPeople).join(', ')]);
  } else {
    credits.push([name, '']);
    needsLookup.push(name);
  }
}

// ---- 3. optional registry fallback for packages that declare nobody -------
if (doFetch && needsLookup.length) {
  console.log(`Looking up ${needsLookup.length} packages with no author field...`);
  const index = new Map(credits.map((c, i) => [c[0], i]));

  for (let i = 0; i < needsLookup.length; i++) {
    const name = needsLookup[i];
    try {
      // NOTE: no abbreviated-packument accept header here. That document
      // contains only name/dist-tags/versions/modified — no maintainers.
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
      if (!res.ok) continue;
      const meta = await res.json();
      const names = [];
      for (const p of [meta.author, ...[].concat(meta.maintainers ?? [])]) {
        const n = personName(p);
        if (n && !names.includes(n)) names.push(n);
      }
      if (names.length) credits[index.get(name)][1] = names.slice(0, maxPeople).join(', ');
    } catch { /* leave unlisted */ }
    if (i % 25 === 0) process.stderr.write(`  ${i}/${needsLookup.length}\r`);
  }
  console.log('');
}

const named = credits.filter(c => c[1]).length;
console.log(`${named} of ${credits.length} packages have a name attached.`);
if (named === 0) {
  console.error('That is almost certainly a bug, not a fact about your dependencies. Stopping.');
  process.exit(1);
}

// ---- 4. write it into the deck -------------------------------------------
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

#!/usr/bin/env node
/**
 * scripts/verify-pack.mjs - the reproducible packaging gate.
 *
 * `npm pack` copies the on-disk dist/ verbatim and does NOT run `prepublishOnly`, so a tarball built
 * from a stale (or absent) dist/ can ship compiled bytes that are not the code under review, or no
 * compiled bytes at all. This script makes the packaging claim transferable from the commit:
 *
 *   1. build (so dist/ is current),
 *   2. pack into a temp dir and read the tarball's file list,
 *   3. assert every declared entry point exists INSIDE the tarball (main/module/types + every
 *      exports subpath, import and require targets),
 *   4. assert the tarball's compiled registry agrees with the emitted capabilities.json (planHash),
 *   5. install the tarball into a clean temp project and import the root and every subpath from
 *      BOTH ESM and CJS.
 *
 * Usage: node scripts/verify-pack.mjs           (exit 0 = shippable, 1 = not)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: 'utf8' });
const failures = [];
const ok = [];
const check = (label, condition, detail = '') => {
  if (condition) ok.push(label);
  else failures.push(`${label}${detail ? ` - ${detail}` : ''}`);
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// 1. build
process.stdout.write('verify:pack - building dist ... ');
run('npm', ['run', 'build']);
console.log('ok');

// 2. pack
const tmp = mkdtempSync(join(tmpdir(), 'hudu-verify-pack-'));
const packed = run('npm', ['pack', '--pack-destination', tmp]).trim().split('\n').pop().trim();
const tarball = join(tmp, packed);
check('tarball exists', existsSync(tarball), tarball);
const listing = new Set(
  run('tar', ['-tzf', tarball]).split('\n').map((l) => l.replace(/^package\//, '').trim()).filter(Boolean),
);

// 3. every declared entry point must exist INSIDE the tarball
const declared = new Set();
for (const [sub, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value === 'string') declared.add(value);
  else for (const cond of Object.values(value)) {
    if (typeof cond === 'string') declared.add(cond);
    else for (const t of Object.values(cond)) declared.add(t);
  }
}
for (const f of [pkg.main, pkg.module, pkg.types]) if (f) declared.add(f);
for (const f of declared) {
  check(`tarball ships ${f}`, listing.has(f.replace(/^\.\//, '')), 'declared in package.json but absent from the tarball');
}
check('tarball ships capabilities.json', listing.has('capabilities.json'));
check('tarball ships capabilities.schema.json', listing.has('capabilities.schema.json'));
check('tarball does not ship src/', ![...listing].some((f) => f.startsWith('src/')));

// 4. the compiled registry must agree with the emitted JSON
const extract = (member) => run('tar', ['-xzOf', tarball, `package/${member}`]);
// Search the WHOLE packed dist, not just dist/capabilities.js: the bundler hoists the registry data into a
// shared chunk once other modules import it, leaving the entry file a few hundred bytes that merely re-imports
// the constant. A check pinned to one filename then reports a stale registry when nothing is wrong.
const emittedJson = JSON.parse(extract('capabilities.json'));
const distText = [...listing].filter((f) => /^dist\/.*\.c?js$/.test(f)).map(extract).join('\n');
const distHash = (distText.match(/CAPABILITIES_PLAN_HASH\s*=\s*["']([0-9a-f]{16,})["']/) ?? [])[1];
check('dist registry is not stale', Boolean(distHash), 'no CAPABILITIES_PLAN_HASH found anywhere in the packed dist');
check(
  'dist registry agrees with capabilities.json',
  distHash === emittedJson.planHash,
  `dist ${String(distHash).slice(0, 12)} vs json ${String(emittedJson.planHash).slice(0, 12)} - re-run npm run capabilities:build && npm run build before packing`,
);

// 5. install into a clean project and import every surface, ESM and CJS
const consumer = join(tmp, 'consumer');
mkdirSync(consumer, { recursive: true });
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module', private: true }, null, 2));
run('npm', ['install', '--no-audit', '--no-fund', tarball], consumer);

// `./types` is type-only: its runtime module legitimately has no exports, so it is checked for
// existence (above) and for its .d.ts, never imported.
const TYPE_ONLY = new Set(['./types']);
const valueSubpaths = ['.', ...Object.keys(pkg.exports ?? {}).filter((k) => !k.includes('*') && k !== './package.json' && !TYPE_ONLY.has(k))];
const esm = `const mods = ${JSON.stringify(valueSubpaths)};
for (const sub of mods) {
  const m = await import(sub === '.' ? 'node-hudu' : 'node-hudu' + sub.slice(1));
  if (!m || Object.keys(m).length === 0) throw new Error('no exports from ' + sub);
}
console.log('ESM ok: ' + mods.length + ' subpaths');`;
const cjs = `const mods = ${JSON.stringify(valueSubpaths)};
for (const sub of mods) {
  const m = require(sub === '.' ? 'node-hudu' : 'node-hudu' + sub.slice(1));
  if (!m || Object.keys(m).length === 0) throw new Error('no exports from ' + sub);
}
console.log('CJS ok: ' + mods.length + ' subpaths');`;
try {
  const out = run('node', ['--input-type=module', '-e', esm], consumer).trim();
  ok.push(out);
} catch (err) {
  failures.push(`ESM import failed: ${String(err.stderr || err.message).split('\n')[0]}`);
}
// The strongest form of the registry check: read the hash out of the INSTALLED package rather than out of the
// tarball's text, so it survives any bundling shape.
try {
  const probe = `const m = await import('node-hudu/capabilities');process.stdout.write(String(m.CAPABILITIES_PLAN_HASH ?? ''));`;
  const shippedHash = run('node', ['--input-type=module', '-e', probe], consumer).trim();
  check('the installed package reports the registry hash that ships beside it', shippedHash === emittedJson.planHash,
    `installed ${shippedHash.slice(0, 12)} vs capabilities.json ${String(emittedJson.planHash).slice(0, 12)}`);
} catch (err) {
  failures.push(`could not read CAPABILITIES_PLAN_HASH from the installed package: ${String(err.stderr || err.message).split('\n')[0]}`);
}
try {
  const out = run('node', ['-e', cjs], consumer).trim();
  ok.push(out);
} catch (err) {
  failures.push(`CJS require failed: ${String(err.stderr || err.message).split('\n')[0]}`);
}

console.log(`\nverify:pack - ${ok.length} check(s) passed`);
for (const f of failures) console.log(`  FAIL ${f}`);
if (failures.length > 0) {
  console.log(`\nNOT SHIPPABLE - ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`SHIPPABLE - ${packed} carries every declared entry point, agrees with capabilities.json, and imports from ESM and CJS`);

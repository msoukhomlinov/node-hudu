#!/usr/bin/env node
/**
 * scripts/public-surface.mjs — capture or verify the SDK's public surface.
 *
 * Usage:
 *   node scripts/public-surface.mjs --write     # rewrite test/__fixtures__/public-surface.json
 *   node scripts/public-surface.mjs             # print the current surface as JSON
 *
 * The fixture is the 0.2.1 baseline captured on branch feat/agent-execution-layer BEFORE the
 * agent-layer retrofit. test/public-surface.test.ts asserts that every name in it still exists,
 * which is how "additive only" is proven rather than asserted. Regenerating the fixture is a
 * reviewable event: it must never shrink without an explicit major-version decision.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repo file at an explicit git ref, so the fixture can be captured from the BASELINE. */
const REF = (() => {
  const i = process.argv.indexOf('--ref');
  return i >= 0 ? process.argv[i + 1] : null;
})();
function readAt(rel) {
  if (!REF) return readFileSync(join(ROOT, rel), 'utf8');
  return execFileSync('git', ['show', `${REF}:${rel}`], { cwd: ROOT, encoding: 'utf8' });
}
function listAt(dir, filter) {
  if (!REF) return readdirSync(join(ROOT, dir)).filter(filter);
  return execFileSync('git', ['ls-tree', '--name-only', `${REF}:${dir}`], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter(filter);
}

/** Root barrel export names, from src/index.ts, split into runtime values and type-only names. */
function rootExports() {
  const src = readAt('src/index.ts');
  const values = new Set();
  const types = new Set();
  const star = [];
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]+)\}/gm)) {
    const typeOnly = Boolean(m[1]);
    for (const part of m[2].split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const name = raw.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (!name) continue;
      (typeOnly || raw.startsWith('type ') ? types : values).add(name);
    }
  }
  // `export type * from './x.js'` and `export * from './x.js'` both re-export a whole barrel.
  // The original regex missed the `type` keyword, which made the additive guard vacuous for
  // every type reachable only through a star barrel (the whole types barrel, 35 record types).
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\*\s+from\s+'\.\/([\w./]+)'/gm)) star.push(m[1]);
  return { values: [...values].sort(), types: [...types].sort(), starBarrels: star };
}

/** public (non-protected, non-private) method names per resource class, from source. */
function resourceMethods() {
  const out = {};
  for (const file of listAt('src/resources', (f) => f.endsWith('.ts')).sort()) {
    if (file === 'index.ts' || file === 'base.ts') continue;
    const src = readAt(`src/resources/${file}`);
    const cls = src.match(/export class (\w+)/);
    if (!cls) continue;
    const names = [];
    for (const m of src.matchAll(/^  (?:public\s+)?(?:async\s+)?([a-z][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/gm)) names.push(m[1]);
    out[cls[1]] = [...new Set(names)].sort();
  }
  return out;
}

/** error class -> code, from src/errors.ts. */
function errorCodes() {
  const src = readAt('src/errors.ts');
  const out = {};
  for (const chunk of src.split('export class ').slice(1)) {
    const name = chunk.match(/^(\w+)/);
    const code = chunk.match(/code: '([A-Z_]+)'/);
    if (name && code) out[name[1]] = code[1];
  }
  return out;
}

/** Names re-exported by the types barrel at the ref - this is what protects the 35 record types. */
function typeBarrelExports() {
  const src = readAt('src/types/index.ts');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return [...names].sort();
}

const surface = { capturedFrom: REF ? `${REF} (0.2.1 baseline)` : 'working tree', rootExports: rootExports(), typeBarrelExports: typeBarrelExports(), resources: resourceMethods(), errorCodes: errorCodes() };
const target = join(ROOT, 'test', '__fixtures__', 'public-surface.json');
if (process.argv.includes('--write')) {
  writeFileSync(target, `${JSON.stringify(surface, null, 2)}\n`);
  console.log(`wrote ${target} from ${surface.capturedFrom}: ${surface.rootExports.values.length} value exports, ${surface.rootExports.types.length} type exports, ${surface.rootExports.starBarrels.length} star barrels, ${surface.typeBarrelExports.length} type-barrel names, ${Object.keys(surface.resources).length} resource classes, ${Object.keys(surface.errorCodes).length} error codes`);
} else {
  console.log(JSON.stringify(surface, null, 2));
}

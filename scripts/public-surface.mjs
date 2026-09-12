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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Root barrel export names, from src/index.ts, split into runtime values and type-only names. */
function rootExports() {
  const src = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
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
  for (const m of src.matchAll(/^export\s+\*\s+from\s+'\.\/types\/index\.js'/gm)) star.push('src/types/index.ts');
  return { values: [...values].sort(), types: [...types].sort(), starTypeBarrels: star };
}

/** public (non-protected, non-private) method names per resource class, from source. */
function resourceMethods() {
  const dir = join(ROOT, 'src', 'resources');
  const out = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file === 'index.ts' || file === 'base.ts') continue;
    const src = readFileSync(join(dir, file), 'utf8');
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
  const src = readFileSync(join(ROOT, 'src', 'errors.ts'), 'utf8');
  const out = {};
  for (const chunk of src.split('export class ').slice(1)) {
    const name = chunk.match(/^(\w+)/);
    const code = chunk.match(/code: '([A-Z_]+)'/);
    if (name && code) out[name[1]] = code[1];
  }
  return out;
}

const surface = { capturedFrom: 'main @ 9332efe (0.2.1)', rootExports: rootExports(), resources: resourceMethods(), errorCodes: errorCodes() };
const target = join(ROOT, 'test', '__fixtures__', 'public-surface.json');
if (process.argv.includes('--write')) {
  writeFileSync(target, `${JSON.stringify(surface, null, 2)}\n`);
  console.log(`wrote ${target}: ${surface.rootExports.values.length} value exports, ${surface.rootExports.types.length} type exports, ${Object.keys(surface.resources).length} resource classes, ${Object.keys(surface.errorCodes).length} error codes`);
} else {
  console.log(JSON.stringify(surface, null, 2));
}

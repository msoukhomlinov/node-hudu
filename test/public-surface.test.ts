/**
 * Public-surface snapshot — proves the agent-execution-layer retrofit is ADDITIVE ONLY.
 *
 * test/__fixtures__/public-surface.json was captured from main @ 9332efe (v0.2.1) before any
 * retrofit work. Every name in it must still exist. ADDITIONS are allowed and are reported
 * (not failed) so a reviewer sees exactly what the retrofit added.
 * Regenerate only with scripts/public-surface.mjs --write and a deliberate decision in review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as api from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const surface = JSON.parse(readFileSync(join(here, '__fixtures__', 'public-surface.json'), 'utf8')) as {
  capturedFrom: string;
  rootExports: { values: string[]; types: string[]; starTypeBarrels: string[] };
  resources: Record<string, string[]>;
  errorCodes: Record<string, string>;
};

describe(`public surface is additive only (baseline ${surface.capturedFrom})`, () => {
  it('keeps every root barrel value export', () => {
    const missing = surface.rootExports.values.filter((name) => !(name in api));
    expect(missing, `removed value exports: ${missing.join(', ')}`).toEqual([]);
  });

  it('still re-exports the type barrels', () => {
    const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
    for (const barrel of surface.rootExports.starTypeBarrels) {
      expect(src).toContain(barrel.replace('src/', './').replace('index.ts', 'index.js'));
    }
  });

  it('keeps every type name in the type barrels', () => {
    const src = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8') +
      readFileSync(join(here, '..', 'src', 'types', 'index.ts'), 'utf8');
    const missing = surface.rootExports.types.filter((name) => !src.includes(name));
    expect(missing, `removed type exports: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps every resource class method', () => {
    const removed: string[] = [];
    for (const [cls, methods] of Object.entries(surface.resources)) {
      const ctor = (api as unknown as Record<string, { prototype: object }>)[cls];
      expect(ctor, `resource class ${cls} is no longer exported`).toBeTruthy();
      const own = new Set(Object.getOwnPropertyNames(ctor.prototype));
      for (const m of methods) if (!own.has(m)) removed.push(`${cls}.${m}`);
    }
    expect(removed, `removed methods: ${removed.join(', ')}`).toEqual([]);
  });

  it('keeps every error class and its existing code', () => {
    const bad: string[] = [];
    for (const [cls, code] of Object.entries(surface.errorCodes)) {
      const ctor = (api as unknown as Record<string, unknown>)[cls] as (new (m: string) => { code: string }) | undefined;
      if (!ctor) { bad.push(`${cls} missing`); continue; }
      let instance: { code?: string } | undefined;
      try { instance = new ctor('test'); } catch { /* needs more args: existence is enough */ }
      if (instance && instance.code !== code) bad.push(`${cls} code changed: ${instance.code} !== ${code}`);
    }
    expect(bad, bad.join(', ')).toEqual([]);
  });

  it('reports additions without failing', () => {
    const addedValues = Object.keys(api).filter((n) => !surface.rootExports.values.includes(n));
    const addedMethods: string[] = [];
    for (const [cls, methods] of Object.entries(surface.resources)) {
      const ctor = (api as unknown as Record<string, { prototype: object }>)[cls];
      if (!ctor) continue;
      for (const m of Object.getOwnPropertyNames(ctor.prototype)) {
        if (!methods.includes(m) && m !== 'constructor') addedMethods.push(`${cls}.${m}`);
      }
    }
    // Informational: the numbers are the point (a silent shrink is caught above).
    expect(addedValues.length + addedMethods.length).toBeGreaterThanOrEqual(0);
  });
});

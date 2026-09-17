/**
 * The converter dependencies and the seam that keeps them swappable.
 * Rationale for retiring the zero-dependency property: ARCHITECTURE.md §15.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('converter dependencies', () => {
  it('pins the three runtime dependencies the design settled on', () => {
    expect(pkg.dependencies).toMatchObject({
      turndown: '^7.2.4',
      '@joplin/turndown-plugin-gfm': '^1.0.68',
      marked: '^18.0.13',
    });
  });

  it('loads marked from CJS through require(esm), which is why the Node floor is 24', () => {
    // marked >=16 is ESM-only. Node >=22.12 resolves it from require() anyway.
    const require = createRequire(import.meta.url);
    const marked = require('marked');
    expect(typeof marked.parse).toBe('function');
  });

  it('exposes ./content as a dual-format subpath', () => {
    expect(pkg.exports['./content']).toEqual({
      import: { types: './dist/content/index.d.ts', default: './dist/content/index.js' },
      require: { types: './dist/content/index.d.cts', default: './dist/content/index.cjs' },
    });
  });
});

describe('the converter seam', () => {
  const read = (p: string) => readFileSync(new URL(`../../src/content/${p}`, import.meta.url), 'utf8');

  it('confines turndown to turndown-engine.ts and marked to marked-engine.ts', () => {
    // Swapping converters (the @xberg-io watchlist) must mean rewriting one file, not auditing the SDK.
    expect(read('turndown-engine.ts')).toMatch(/from 'turndown'/);
    expect(read('marked-engine.ts')).toMatch(/from 'marked'/);
    for (const file of ['markdown.ts', 'index.ts']) {
      expect(read(file), `${file} must not import a converter directly`).not.toMatch(/from '(turndown|marked|@joplin\/)/);
    }
  });
});

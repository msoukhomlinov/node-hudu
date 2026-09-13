/**
 * Progressive-disclosure tests (build-order step 4): the generated catalog, the CORE profile, and
 * the `hudu_invoke` safety path.
 *
 * The catalog and the CORE list are GENERATED (`scripts/build-tool-catalog.mjs` ->
 * `examples/tool-catalog.generated.ts`) from the capability registry plus the curated projection.
 * These tests assert the two invariants that make the mechanism honest, against the registry the
 * SDK actually ships:
 *
 *   1. REACHABILITY — every registry operation has a catalog row, and a row with no tool says why
 *      it is reachable (`hudu_invoke`) or why it is refused. 78 of 225 operations have no tool; an
 *      operation that is indistinguishable from a missing one is the defect this closes.
 *   2. THE GENERATED ARTIFACT CARRIES NO SECOND VALIDATOR. The catalog module used to carry its
 *      own copy of the registry schema language plus a write governor; the reference server now
 *      dispatches through the SDK (`hudu.operations.invoke`), so the copy was retired rather than
 *      left as a second, uncovered place that decides whether a call is allowed. The equivalent —
 *      and stronger — assertions live in `test/operations/invoke.test.ts`, which enumerates the
 *      same registry and exercises every shape (accept, refuse at every field path, unknown shape
 *      is a refusal) against the ONE implementation, plus the governance and refusal-parity rules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CAPABILITY_REGISTRY, getCapability } from '../src/capabilities.js';
import {
  CATALOG,
  CATALOG_PLAN_HASH,
  CORE_TOOLS,
  DEFAULT_CATALOG_LIMIT,
  EXPOSED,
  MAX_CATALOG_LIMIT,
  META_TOOLS,
  REFUSALS,
  WORKFLOW_RESOURCES,
  catalogPage,
  configError,
  describeOperation,
  requireCatalogRow,
} from '../examples/tool-catalog.generated.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const records = Object.values(CAPABILITY_REGISTRY);

describe('catalog reachability (the defect this closes)', () => {
  it('has one row for every registry operation', () => {
    const ops = new Set(CATALOG.map((r) => r.op));
    const missing = records.map((r) => r.name).filter((n) => !ops.has(n));
    expect(missing).toEqual([]);
    expect(CATALOG.length).toBe(records.length);
  });

  it('accounts for every operation exactly once', () => {
    const counts = { exposed: 0, invokeOnly: 0, refused: 0 };
    for (const row of CATALOG) {
      if (row.reachable === false) counts.refused += 1;
      else if (row.tool === null) counts.invokeOnly += 1;
      else counts.exposed += 1;
    }
    expect(counts.exposed + counts.invokeOnly + counts.refused).toBe(CATALOG.length);
    // The measured split: 148 exposed as their own tool (147 before the knowledge search landed),
    // 56 reachable only through hudu_invoke, 22 refused (10 unbounded reads + 12 binary/download).
    // The 86 with no tool are the point.
    expect(counts.exposed).toBe(Object.keys(EXPOSED).length);
    // 139, not 148: the 9 redundant search tools are retired by curation (one self-describing
    // `hudu_search` replaces them) and every one of their operations stays reachable through
    // `hudu_invoke` — the count here is the curated surface, and it is asserted exactly.
    // 140 is unreachable: when the `operations.invoke` plan row landed, its generated tool
    // (`hudu_operations_invoke`) was curated OUT — the META `hudu_invoke` is the designed entry
    // point for that capability, and a second tool for one job is the same defect as a second
    // validator. The ROW stays, so the capability is validated and checkable.
    expect(counts.exposed).toBe(139);
    // 88 = 78 + the 9 retired search tools + `operations.invoke` (curated out): an operation that
    // loses its tool keeps its capability.
    expect(counts.invokeOnly + counts.refused).toBe(88);
    expect(counts.refused).toBe(Object.keys(REFUSALS).length);
  });

  it('explains every row that has no tool, and refuses with a reason', () => {
    for (const row of CATALOG) {
      if (row.tool === null) {
        expect(typeof row.reason, `${row.op} has no tool and no reason`).toBe('string');
        expect(String(row.reason).length).toBeGreaterThan(0);
      }
      if (row.reachable === false) {
        expect(String(row.reason)).toMatch(/never exposed as a tool|not a tool result/);
        expect(EXPOSED[row.op]).toBeUndefined();
      } else {
        expect(row.reason === undefined || typeof row.reason === 'string').toBe(true);
      }
    }
  });

  it('keeps the catalog pinned to the plan hash (it cannot drift from the registry)', () => {
    expect(CATALOG_PLAN_HASH).toBe(JSON.parse(readFileSync(join(root, 'capabilities.json'), 'utf8')).planHash);
  });

  it('refuses the operations the projection never exposes, with the bounded alternative named', () => {
    // Measured today: all 22 rule-exclusions are binary/download surfaces. `listAll`/`listPages`
    // (the unbounded reads) are NOT registry records — they exist as public SDK methods and are
    // reported by `capabilities:check` as unplanned surface — so the rule is asserted below on any
    // record that has one, and it is currently vacuous for that half only.
    expect(Object.keys(REFUSALS).length).toBe(22);
    for (const op of Object.keys(REFUSALS)) {
      expect(REFUSALS[op]!.reason, op).toMatch(/unbounded read|binary\/download/);
      expect(REFUSALS[op]!.reason.length).toBeGreaterThan(20);
      const record = getCapability(op);
      expect(record, `${op} is refused but is not a registry record`).toBeDefined();
      const method = op.split('.').slice(1).join('.');
      if (/^(listAll|listPages)$/.test(method)) expect(REFUSALS[op]!.reason).toMatch(/unbounded read/);
      else expect(REFUSALS[op]!.reason).toMatch(/binary\/download/);
    }
    const refusalByOp = new Map(Object.entries(REFUSALS));
    for (const record of records) {
      const method = record.name.split('.').slice(1).join('.');
      if (/^(listAll|listPages)$/.test(method)) expect(refusalByOp.has(record.name), `${record.name}: an unbounded read must be refused through hudu_invoke`).toBe(true);
    }
  });
});

describe('the CORE profile is by rule, not by taste', () => {
  it('carries the three META tools and one read entry per workflow resource', () => {
    for (const meta of META_TOOLS) expect(CORE_TOOLS).toContain(meta.name);
    for (const resource of WORKFLOW_RESOURCES) {
      const covered = CORE_TOOLS.some((name) => (EXPOSED as Record<string, string>)[`${resource}.${'x'}`] === name
        || Object.entries(EXPOSED).some(([op, tool]) => tool === name && op.split('.')[0] === resource));
      expect(covered, `${resource} has no read entry in CORE`).toBe(true);
    }
  });

  it('states the subset fact in the catalog description (the honesty contract)', () => {
    const catalogSpec = META_TOOLS.find((m) => m.name === 'hudu_catalog');
    expect(catalogSpec).toBeDefined();
    expect(catalogSpec!.description).toMatch(/SUBSET/);
    expect(catalogSpec!.description).toMatch(/hudu_invoke/);
  });

  it('keeps the always-present surface inside its token budget', () => {
    const projected = JSON.parse(
      readFileSync(join(root, 'MCP_TOOL_MANIFEST.md'), 'utf8')
        .split('## Machine-readable projection')[1]!
        .split('```json')[1]!
        .split('```')[0]!,
    ) as { name: string }[];
    // Only the fields a client actually receives in tools/list, which is what the budget measures.
    const payload = CORE_TOOLS.map((name) => {
      const p = projected.find((x) => x.name === name) as Record<string, unknown> | undefined;
      if (p) return { name: p.name, description: p.description, inputSchema: p.inputSchema, outputSchema: p.outputSchema, annotations: p.annotations };
      const meta = META_TOOLS.find((m) => m.name === name)!;
      return { name: meta.name, title: meta.title, description: meta.description, inputSchema: meta.inputSchema };
    });
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bytes).toBeLessThanOrEqual(32000); // ≈8k tokens; the flat surface is ~327k bytes
  });
});

describe('hudu_catalog + hudu_describe', () => {
  it('pages, filters and bounds the catalog', () => {
    const page = catalogPage({});
    expect(page.rows.length).toBe(DEFAULT_CATALOG_LIMIT);
    expect(page.total_operations).toBe(records.length);
    // 66 = 56 duplicate-outcome operations + the 9 retired search tools + `operations.invoke`, all
    // reachable through hudu_invoke.
    expect(page.unexposed_operations).toBe(66);
    expect(page.unreachable_operations).toBe(22);
    const second = catalogPage({ offset: DEFAULT_CATALOG_LIMIT });
    expect(second.rows[0]!.op).not.toBe(page.rows[0]!.op);
    const unexposed = catalogPage({ unexposed_only: true, limit: MAX_CATALOG_LIMIT });
    expect(unexposed.rows.every((r) => r.tool === null && r.reachable === true)).toBe(true);
    expect(unexposed.matched).toBe(66);
    const destructive = catalogPage({ effect: 'destructive', limit: MAX_CATALOG_LIMIT });
    expect(destructive.rows.every((r) => r.effect === 'destructive')).toBe(true);
    const websites = catalogPage({ resource: 'websites', limit: MAX_CATALOG_LIMIT });
    expect(websites.rows.every((r) => r.op.startsWith('websites.'))).toBe(true);
  });

  it('never clamps the bound silently', () => {
    expect(() => catalogPage({ limit: MAX_CATALOG_LIMIT + 1 })).toThrow(/limit must be an integer/);
    expect(() => catalogPage({ limit: 0 })).toThrow(/limit must be an integer/);
    expect(() => catalogPage({ offset: -1 })).toThrow(/offset must be an integer/);
  });

  it('describes an operation from its registry record, and names the nearest keys for an unknown one', () => {
    const described = describeOperation(getCapability('companies.update')!);
    expect(described.op).toBe('companies.update');
    expect(described.effect).toBe('write');
    expect(described.requires).toContain('id');
    expect(described.reachable).toBe(true);
    const refused = describeOperation(getCapability('exports.get')!);
    expect(refused.reachable).toBe(false);
    expect(String(refused.why_not)).toMatch(/binary\/download/);
    expect(() => requireCatalogRow('companies.bogus')).toThrow(/Unknown operation/);
    expect(() => requireCatalogRow('companies.bogus')).toThrow(/companies\./);
    expect(() => requireCatalogRow('')).toThrow(/canonical registry key/);
  });
});


describe('configError', () => {
  it('carries a message and the CONFIG_ERROR name', () => {
    const err = configError('nope');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('ConfigError');
  });
});


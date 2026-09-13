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
 *   2. VALIDATION IS NOT A NO-OP — the validator is a SECOND implementation of the generator's
 *      schema language, so every shape the registry actually uses is enumerated here and exercised
 *      (accept and refuse). A shape the validator does not know is refused, never accepted.
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
  auditSchemaVocabulary,
  catalogPage,
  configError,
  describeOperation,
  governInvoke,
  inputFields,
  requireCatalogRow,
  validateInvokeInput,
} from '../examples/tool-catalog.generated.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const records = Object.values(CAPABILITY_REGISTRY);

/** A synthesized value for a registry field spec, used to exercise every type the registry uses. */
function sampleValue(field: Record<string, unknown>, depth = 0): unknown {
  const type = field.type as string;
  if (Array.isArray(field.enum) && (field.enum as unknown[]).length) return (field.enum as unknown[])[0];
  switch (type) {
    case 'string': return 'example';
    case 'number': return 1;
    case 'boolean': return true;
    case 'null': return null;
    case 'unknown': return { any: true };
    case 'array': {
      const items = field.items as Record<string, unknown> | undefined;
      return items ? [sampleValue(items, depth + 1)] : [1];
    }
    case 'object': {
      const nested = Array.isArray(field.fields) ? (field.fields as Record<string, unknown>[]) : [];
      const out: Record<string, unknown> = {};
      for (const f of nested) out[f.name as string] = sampleValue(f, depth + 1);
      return out;
    }
    case 'union': {
      const variants = Array.isArray(field.variants) ? (field.variants as Record<string, unknown>[]) : [];
      if (variants.length) return sampleValue(variants[0] as Record<string, unknown>, depth + 1);
      const anyOf = Array.isArray(field.anyOf) ? (field.anyOf as string[]) : ['unknown'];
      return sampleValue({ type: anyOf[0] }, depth + 1);
    }
    default: return { any: true };
  }
}

function validInputFor(record: (typeof records)[number]): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of inputFields(record.inputSchema) as Record<string, unknown>[]) {
    if (field.required === true) input[field.name as string] = sampleValue(field);
  }
  return input;
}

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
    // The 78 with no tool are the point.
    expect(counts.exposed).toBe(Object.keys(EXPOSED).length);
    expect(counts.exposed).toBe(148);
    expect(counts.invokeOnly + counts.refused).toBe(78);
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
    expect(page.unexposed_operations).toBe(56);
    expect(page.unreachable_operations).toBe(22);
    const second = catalogPage({ offset: DEFAULT_CATALOG_LIMIT });
    expect(second.rows[0]!.op).not.toBe(page.rows[0]!.op);
    const unexposed = catalogPage({ unexposed_only: true, limit: MAX_CATALOG_LIMIT });
    expect(unexposed.rows.every((r) => r.tool === null && r.reachable === true)).toBe(true);
    expect(unexposed.matched).toBe(56);
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

describe('hudu_invoke validation is not a no-op (G4)', () => {
  it('handles every type and key the registry actually uses', () => {
    const exercisedTypes = new Set<string>();
    const exercisedKeys = new Set<string>();
    const collect = (field: unknown, depth = 0): void => {
      if (depth > 12) return;
      if (Array.isArray(field)) { for (const n of field) collect(n, depth + 1); return; }
      if (field === null || typeof field !== 'object') return;
      const f = field as Record<string, unknown>;
      for (const k of Object.keys(f)) exercisedKeys.add(k);
      if (typeof f.type === 'string') exercisedTypes.add(f.type);
      for (const v of Object.values(f)) collect(v, depth + 1);
    };
    // 1. every record's schema is a shape the validator knows (no silent no-op material)
    for (const record of records) {
      expect(auditSchemaVocabulary(record.inputSchema), record.name).toEqual([]);
      for (const field of inputFields(record.inputSchema) as unknown[]) collect(field);
    }
    // 2. an INDEPENDENT deep walk of every schema in the registry, so a type or key shape the
    //    walker above cannot reach still has to be accounted for: anything the registry uses must
    //    be a type the validator knows and a type this enumeration exercised.
    const registryTypes = new Set<string>();
    const registryKeys = new Set<string>();
    const deep = (node: unknown): void => {
      if (Array.isArray(node)) { for (const n of node) deep(n); return; }
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        registryKeys.add(k);
        if (k === 'type' && typeof v === 'string') registryTypes.add(v);
        deep(v);
      }
    };
    for (const record of records) deep(record.inputSchema);
    expect([...registryTypes].sort()).toEqual(['array', 'boolean', 'null', 'number', 'object', 'string', 'union', 'unknown']);
    for (const type of registryTypes) expect([...exercisedTypes], `type ${type} was never reached by the field walker`).toContain(type);
    for (const key of ['fields', 'items', 'variants', 'anyOf', 'enum', 'typeName', 'required']) {
      expect(registryKeys, `the registry does not use ${key} any more — this test is now vacuous for it`).toContain(key);
      expect(exercisedKeys).toContain(key);
    }
    expect(exercisedKeys.has('fields')).toBe(true);
    expect(exercisedKeys.has('items')).toBe(true);
    expect(exercisedKeys.has('variants')).toBe(true);
    expect(exercisedKeys.has('anyOf')).toBe(true);
    expect(exercisedKeys.has('enum')).toBe(true);
    expect(exercisedKeys.has('typeName')).toBe(true);
  });

  it('exercises every distinct registry input shape: the synthesized valid input is accepted', () => {
    const shapes = new Set<string>();
    let checked = 0;
    for (const record of records) {
      shapes.add(JSON.stringify(record.inputSchema));
      const result = validateInvokeInput(record, validInputFor(record));
      expect(result.ok, `${record.name}: ${result.message}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(records.length);
    expect(shapes.size).toBeGreaterThan(100);
  });

  it('refuses an unknown field, a missing required field, a wrong type and an out-of-enum value', () => {
    const update = getCapability('companies.update')!;
    const unknown = validateInvokeInput(update, { id: 1, data: {}, nope: true });
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('CONFIG_ERROR');
    expect(unknown.message).toMatch(/unknown field/);
    const missing = validateInvokeInput(update, { id: 1 });
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/data: required/);
    const wrongType = validateInvokeInput(update, { id: 'one', data: {} });
    expect(wrongType.ok).toBe(false);
    expect(wrongType.message).toMatch(/id: expected number, got string/);
    // a real enum in the registry: magic_dash create has an enum field
    const enumRecord = records.find((r) => JSON.stringify(r.inputSchema).includes('"enum"'))!;
    const enumField = (inputFields(enumRecord.inputSchema) as Record<string, unknown>[])
      .find((f) => Array.isArray(f.enum) || (Array.isArray(f.fields) && (f.fields as Record<string, unknown>[]).some((n) => Array.isArray(n.enum))));
    expect(enumField).toBeDefined();
    const top = enumField!.enum as unknown[] | undefined;
    const target = top ? enumField! : (enumField!.fields as Record<string, unknown>[]).find((n) => Array.isArray(n.enum))!;
    const enumValues = target.enum as unknown[];
    const input: Record<string, unknown> = validInputFor(enumRecord);
    const holder = top ? input : (input[enumField!.name as string] as Record<string, unknown>);
    holder[target.name as string] = '__not_in_enum__';
    const refused = validateInvokeInput(enumRecord, input);
    expect(refused.ok, `${enumRecord.name} accepted ${JSON.stringify(holder)} against enum ${JSON.stringify(enumValues)}`).toBe(false);
    expect(refused.message).toMatch(/expected one of/);
  });

  it('refuses rather than accepts an unknown schema shape (the silent no-op)', () => {
    const gaps = auditSchemaVocabulary({ thing: { name: 'thing', type: 'string', madeUpKey: 1 } });
    expect(gaps).toEqual(['unknown field key "madeUpKey"']);
    const fake = {
      name: 'fake.op', kind: 'primitive', resource: 'fake', purpose: null, outputSchema: {},
      examples: [], effect: 'read', flags: [], dryRun: false, permissions: 'read', pagination: {},
      resolution: null, retry: {}, errors: [], related: [], preferredWhen: null, usage: null, compact: null,
      inputSchema: { thing: { name: 'thing', type: 'string', madeUpKey: 1 } },
    } as unknown as Parameters<typeof validateInvokeInput>[0];
    const result = validateInvokeInput(fake, { thing: 'x' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/schema shape this validator does not know/);
    expect(auditSchemaVocabulary({ a: { name: 'a', type: 'not-a-type' } })).toEqual(['unknown field type "not-a-type"']);
  });

  it('refuses a non-object input and a null input for a required-argument operation', () => {
    const update = getCapability('companies.update')!;
    expect(validateInvokeInput(update, 'nope').ok).toBe(false);
    expect(validateInvokeInput(update, [1, 2]).ok).toBe(false);
    const nulled = validateInvokeInput(update, null);
    expect(nulled.ok).toBe(false);
    expect(nulled.message).toMatch(/required/);
  });
});

describe('the write governor', () => {
  it('runs a read directly', () => {
    const governed = governInvoke(getCapability('companies.resolve')!, {});
    expect(governed.ok).toBe(true);
    expect(governed.dry_run).toBe(false);
  });

  it('REFUSES every write without a dry run (the negative fixture that must fail)', () => {
    for (const record of records) {
      if (record.effect === 'read') continue;
      if (REFUSALS[record.name] !== undefined) continue; // refused outright, asserted separately below
      const refused = governInvoke(record, { dry_run: false });
      expect(refused.ok, `${record.name} was allowed to write without a dry run`).toBe(false);
      expect(refused.message).toMatch(/dry-run-first/);
      const dry = governInvoke(record, { dry_run: true });
      if (record.effect === 'destructive' || record.flags.includes('requiresApproval')) {
        expect(dry.ok).toBe(false);
        expect(dry.message).toMatch(/confirm/);
        const confirmed = governInvoke(record, { dry_run: true, confirm: record.name });
        expect(confirmed.ok, `${record.name} refused with its own confirm value`).toBe(true);
        expect(governInvoke(record, { dry_run: true, confirm: 'yes' }).ok).toBe(false);
      } else {
        expect(dry.ok).toBe(true);
        expect(dry.dry_run).toBe(true);
      }
    }
  });

  it('refuses an operation the projection deliberately never exposes', () => {
    for (const op of Object.keys(REFUSALS)) {
      const refused = governInvoke(getCapability(op)!, { dry_run: true, confirm: op });
      expect(refused.ok, `${op} was allowed through the escape hatch`).toBe(false);
      expect(refused.message).toMatch(/deliberately not callable/);
    }
  });

  it('gives a write a message a caller can act on (the SDK dry-run path)', () => {
    const refused = governInvoke(getCapability('companies.create')!, {});
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/dry_run: true/);
    expect(refused.message).toMatch(/no request issued/);
  });
});

describe('configError', () => {
  it('carries a message and the CONFIG_ERROR name', () => {
    const err = configError('nope');
    expect(err.message).toBe('nope');
    expect(err.name).toBe('ConfigError');
  });
});

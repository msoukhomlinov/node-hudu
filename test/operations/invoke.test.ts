/**
 * SDK-side INVOKE tests — `operations.invoke` (progressive-disclosure build order, step 3b).
 *
 * The design names the validator as the one unsound corner: it is a SECOND implementation of the
 * generator's schema language, so without a test that enumerates and exercises every shape it can
 * silently no-op and accept anything. This file is that test (the design's G4), run against the
 * registry the SDK actually ships: every record's `inputSchema` is audited for vocabulary gaps,
 * accepted with a synthesised valid argument bag, and refused at EVERY declared field path when one
 * value is mutated. An unknown shape is a refusal, never an accept.
 *
 * The rest is the enforcement contract: one negative fixture per refusal class (each asserted to
 * have issued NO request), one happy path per representative shape (read, write, composite,
 * client-scan), and the parity check that the SDK's refusal set is exactly the projection's.
 *
 * Mocked global fetch only — no test here touches the network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HuduClient } from '../../src/client.js';
import { Operations } from '../../src/operations/index.js';
import {
  INVOKE_REFUSED_RESOURCES,
  SCHEMA_FIELD_KEYS,
  SCHEMA_FIELD_TYPES,
  auditSchemaVocabulary,
  inputFields,
  nearestOperations,
  planInvoke,
  resolveInvokeTarget,
  validateInvokeInput,
} from '../../src/operations/invoke.js';
import { CAPABILITY_NAMES, getCapability, type CapabilityRecord } from '../../src/capabilities.js';
import { HuduConfigError } from '../../src/errors.js';
import { REFUSALS } from '../../examples/tool-catalog.generated.js';
import { stubFetch, json, empty, clearFetch, type FetchHandler, type FetchSpy } from '../helpers.js';

const ORIGIN = 'https://hudu.example.com';
const BASE = ORIGIN + '/api/v1';
const makeClient = (): HuduClient => new HuduClient({ baseUrl: ORIGIN, apiKey: 'test-key' });
const makeOps = (): Operations => new Operations(makeClient());
const records: CapabilityRecord[] = CAPABILITY_NAMES.map((name) => getCapability(name) as CapabilityRecord);

type Field = Record<string, unknown>;
const fieldsOf = (field: Field): Field[] => (Array.isArray(field.fields) ? (field.fields as Field[]) : []);
const nameOf = (field: Field): string => (typeof field.name === 'string' ? field.name : '');
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Shape enumeration: build a valid argument bag for any record, and a mutation per field.
// ---------------------------------------------------------------------------

/** A value the schema accepts: the first enum member, or a value of the declared type. */
function sampleValue(field: Field, depth = 0): unknown {
  const allowed = field.enum;
  if (Array.isArray(allowed) && allowed.length > 0) return allowed[0];
  switch (field.type) {
    case 'string': return 'sample';
    case 'number': return 1;
    case 'boolean': return true;
    case 'null': return null;
    case 'unknown': return 'sample';
    case 'array': return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const nested of fieldsOf(field)) {
        const name = nameOf(nested);
        if (name.length === 0) continue;
        const value = sampleValue(nested, depth + 1);
        if (value !== undefined) out[name] = value;
      }
      return out;
    }
    case 'union': {
      const anyOf = Array.isArray(field.anyOf) ? (field.anyOf as string[]) : [];
      for (const candidate of anyOf.length > 0 ? anyOf : ['unknown']) {
        const variant = fieldsOf(field).find((entry) => entry.type === candidate);
        if (variant !== undefined) return sampleValue(variant, depth + 1);
        if (candidate !== 'object') return sampleValue({ type: candidate }, depth + 1);
      }
      return {};
    }
    default: return undefined;
  }
}

/** The argument bag the operation accepts, in registry declaration order. */
function sampleInput(record: CapabilityRecord): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const field of inputFields(record.inputSchema)) {
    const name = nameOf(field);
    if (name.length === 0) continue;
    const value = sampleValue(field);
    if (value !== undefined) bag[name] = value;
  }
  return bag;
}

/** A value the schema must REFUSE for this field, or undefined when no such value exists. */
function wrongValueFor(field: Field): { value: unknown } | undefined {
  if (Array.isArray(field.enum) && field.enum.length > 0) return { value: '__not_in_enum__' };
  switch (field.type) {
    case 'string': return { value: 12345 };
    case 'number': return { value: 'not-a-number' };
    case 'boolean': return { value: 'not-a-boolean' };
    case 'array': return { value: 42 };
    case 'object': return { value: [] };
    case 'null': return { value: 'not-null' };
    case 'union': {
      const anyOf = Array.isArray(field.anyOf) ? (field.anyOf as string[]) : ['unknown'];
      if (anyOf.includes('unknown')) return undefined;
      const candidates: [string, unknown][] = [
        ['array', []], ['number', 42], ['string', 'x'], ['boolean', true], ['null', null], ['object', {}],
      ];
      const found = candidates.find(([name]) => !anyOf.includes(name));
      return found === undefined ? undefined : { value: found[1] };
    }
    default: return undefined;
  }
}

interface Mutation {
  /** Field path, as the validator reports it (`data.name`). */
  path: string[];
  /** The exact path the refusal must name. */
  expected: string;
  value: unknown;
  /** True when the mutation replaces an array with a single wrong-typed element. */
  arrayItem: boolean;
}

/**
 * One mutation per declared field PATH, so every shape the registry uses — including the ones
 * nested inside `data` — is exercised, not just the top-level fields.
 */
function mutationsOf(record: CapabilityRecord): Mutation[] {
  const out: Mutation[] = [];
  const visit = (field: Field, path: string[]): void => {
    const wrong = wrongValueFor(field);
    if (wrong !== undefined) out.push({ path, expected: path.join('.'), value: wrong.value, arrayItem: false });
    if (field.type === 'object') {
      for (const nested of fieldsOf(field)) {
        const name = nameOf(nested);
        if (name.length > 0) visit(nested, [...path, name]);
      }
    }
    if (field.type === 'array' && isObject(field.items)) {
      const itemWrong = wrongValueFor(field.items);
      if (itemWrong !== undefined) {
        out.push({ path, expected: path.join('.') + '[0]', value: itemWrong.value, arrayItem: true });
      }
    }
  };
  for (const field of inputFields(record.inputSchema)) {
    const name = nameOf(field);
    if (name.length > 0) visit(field, [name]);
  }
  return out;
}

/** Apply a mutation in place; false when the synthesised bag has no such parent object. */
function applyMutation(input: Record<string, unknown>, mutation: Mutation): boolean {
  let cursor: Record<string, unknown> = input;
  for (const key of mutation.path.slice(0, -1)) {
    const next = cursor[key];
    if (!isObject(next)) return false;
    cursor = next;
  }
  const leaf = mutation.path[mutation.path.length - 1] as string;
  cursor[leaf] = mutation.arrayItem ? [mutation.value] : mutation.value;
  return true;
}

/** A coarse signature of a top-level field, used to prove each SHAPE (not each record) is exercised. */
function shapeOf(field: Field): string {
  const type = field.type;
  if (type === 'array') return 'array<' + (isObject(field.items) ? shapeOf(field.items) : '?') + '>';
  if (type === 'object') return 'object{' + fieldsOf(field).map((nested) => nameOf(nested)).join(',') + '}';
  if (type === 'union') return 'union(' + (Array.isArray(field.anyOf) ? (field.anyOf as string[]).join('|') : '?') + ')';
  if (Array.isArray(field.enum)) return 'enum:' + String(type);
  return String(type);
}

afterEach(() => clearFetch());

// ---------------------------------------------------------------------------
// G4 — the shape-enumeration test.
// ---------------------------------------------------------------------------

describe('operations.invoke — G4 schema-vocabulary coverage over the whole registry', () => {
  it('every record is dispatched by a validator that understands every key and type it uses', () => {
    const keys = new Set<string>();
    const types = new Set<string>();
    const walk = (field: Field): void => {
      for (const key of Object.keys(field)) keys.add(key);
      if (typeof field.type === 'string') types.add(field.type);
      for (const nested of fieldsOf(field)) walk(nested);
      if (isObject(field.items)) walk(field.items);
      for (const variant of Array.isArray(field.variants) ? (field.variants as Field[]) : []) walk(variant);
      if (isObject(field.additionalProperties)) walk(field.additionalProperties);
    };
    for (const record of records) for (const field of inputFields(record.inputSchema)) walk(field);

    // A key or type the registry uses but this validator does not know is exactly the silent no-op
    // the design warns about: it must fail HERE, not at a caller's turn.
    expect([...keys].filter((key) => !SCHEMA_FIELD_KEYS.includes(key))).toEqual([]);
    expect([...types].filter((type) => !SCHEMA_FIELD_TYPES.includes(type))).toEqual([]);

    const withGaps = records
      .map((record) => ({ name: record.name, gaps: auditSchemaVocabulary(record.inputSchema) }))
      .filter((entry) => entry.gaps.length > 0);
    expect(withGaps).toEqual([]);
  });

  it('accepts a synthesised valid argument bag for every registry record', () => {
    const rejected: string[] = [];
    for (const record of records) {
      const verdict = validateInvokeInput(record, sampleInput(record));
      if (!verdict.ok) rejected.push(record.name + ': ' + verdict.message);
    }
    expect(rejected).toEqual([]);
    expect(records.length).toBeGreaterThan(200);
  });

  it('refuses a wrong-typed or out-of-enum value at EVERY declared field path', () => {
    const missed: string[] = [];
    let exercised = 0;
    for (const record of records) {
      for (const mutation of mutationsOf(record)) {
        const input = sampleInput(record);
        if (!applyMutation(input, mutation)) {
          missed.push(record.name + ' ' + mutation.expected + ': the synthesised bag had no parent object');
          continue;
        }
        exercised += 1;
        const verdict = validateInvokeInput(record, input);
        const named = verdict.problems.some((problem) => problem.path === mutation.expected);
        if (verdict.ok || !named) {
          missed.push(record.name + ' ' + mutation.expected + ': ' + (verdict.ok ? 'ACCEPTED' : verdict.message));
        }
      }
    }
    expect(missed).toEqual([]);
    // Sanity: the enumeration really did walk the vocabulary (549 string fields alone per the plan).
    expect(exercised).toBeGreaterThan(500);
  });

  it('refuses an unknown field, a missing required field and a malformed payload for EVERY record', () => {
    const missed: string[] = [];
    for (const record of records) {
      const unknownKey = validateInvokeInput(record, { ...sampleInput(record), zzz_not_a_field: 1 });
      if (unknownKey.ok || !unknownKey.problems.some((problem) => problem.path === 'zzz_not_a_field')) {
        missed.push(record.name + ': unknown field accepted');
      }
      const malformed = validateInvokeInput(record, 'not-an-object');
      if (malformed.ok || malformed.code !== 'CONFIG_ERROR') missed.push(record.name + ': malformed payload accepted');
      const required = inputFields(record.inputSchema).filter((field) => field.required === true);
      if (required.length > 0) {
        const bag = sampleInput(record);
        for (const field of required) delete bag[nameOf(field)];
        const missing = validateInvokeInput(record, bag);
        if (missing.ok) missed.push(record.name + ': missing required field accepted');
      }
    }
    expect(missed).toEqual([]);
  });

  it('refuses every DISTINCT top-level shape, and accepts a valid bag for it', () => {
    const byShape = new Map<string, CapabilityRecord>();
    for (const record of records) {
      const signature = inputFields(record.inputSchema).map(shapeOf).join('|') || '(no arguments)';
      if (!byShape.has(signature)) byShape.set(signature, record);
    }
    expect(byShape.size).toBeGreaterThanOrEqual(20);
    const failures: string[] = [];
    for (const [signature, record] of byShape) {
      if (!validateInvokeInput(record, sampleInput(record)).ok) failures.push(signature + ': valid bag refused');
      const mutation = mutationsOf(record)[0];
      if (mutation === undefined) continue;
      const input = sampleInput(record);
      applyMutation(input, mutation);
      if (validateInvokeInput(record, input).ok) failures.push(signature + ': mutation accepted');
    }
    expect(failures).toEqual([]);
  });

  it('treats a shape it does not know as a REFUSAL, never an accept', () => {
    const base = getCapability('articles.get') as CapabilityRecord;
    const unknownType = { ...base, name: 'future.thing', inputSchema: { widget: { name: 'widget', type: 'quantum', required: true } } };
    expect(auditSchemaVocabulary(unknownType.inputSchema).join(' ')).toContain('unknown field type "quantum"');
    const verdict = validateInvokeInput(unknownType, { widget: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('CONFIG_ERROR');
    expect(verdict.message).toContain('does not understand');

    const unknownKey = { ...base, name: 'future.thing', inputSchema: { widget: { name: 'widget', type: 'string', required: false, coerce: true } } };
    expect(auditSchemaVocabulary(unknownKey.inputSchema).join(' ')).toContain('unknown field key "coerce"');
    expect(validateInvokeInput(unknownKey, { widget: 'x' }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispatch reachability: every registry key resolves to a real typed method.
// ---------------------------------------------------------------------------

describe('operations.invoke — dispatch resolves every registry key', () => {
  it('resolves a callable typed method for every registry operation', () => {
    const client = makeClient();
    const broken: string[] = [];
    for (const record of records) {
      try {
        if (typeof resolveInvokeTarget(client, record) !== 'function') broken.push(record.name);
      } catch (error) {
        broken.push(record.name + ': ' + (error as Error).message);
      }
    }
    expect(broken).toEqual([]);
  });

  it('names the drift instead of throwing a TypeError when a record has no target', () => {
    const client = makeClient();
    const base = getCapability('articles.get') as CapabilityRecord;
    expect(() => resolveInvokeTarget(client, { ...base, name: 'articles.notAMethod' })).toThrow(HuduConfigError);
    expect(() => resolveInvokeTarget(client, { ...base, name: 'not_a_resource.get', resource: 'not_a_resource' }))
      .toThrow(/no "notAResource" resource/);
  });
});

// ---------------------------------------------------------------------------
// Negative fixtures: one per refusal class, each proving NO request was issued.
// ---------------------------------------------------------------------------

/** Assert a refusal that never reached the transport, and hand the error back for its message. */
async function refusal(
  operation: string,
  input?: Record<string, unknown>,
  opts?: { dryRun?: boolean; confirm?: string },
): Promise<{ error: HuduConfigError; spy: FetchSpy }> {
  const spy = stubFetch(() => json({ error: 'the transport must not be reached' }, 500));
  const ops = makeOps();
  let error: unknown;
  try {
    await ops.invoke(operation, input, opts);
  } catch (caught) {
    error = caught;
  }
  expect(error, operation + ' should have been refused').toBeInstanceOf(HuduConfigError);
  expect((error as HuduConfigError).code).toBe('CONFIG_ERROR');
  expect(spy.calls, operation + ' must not issue a request').toHaveLength(0);
  return { error: error as HuduConfigError, spy };
}

describe('operations.invoke — refusals (each one request-free)', () => {
  it('refuses an unknown operation, naming the nearest real keys', async () => {
    const { error } = await refusal('articles.gett', { id: 1 });
    expect(error.message).toContain('unknown operation "articles.gett"');
    expect(nearestOperations('articles.gett')).toContain('articles.get');
  });

  it('refuses an empty or non-string operation', async () => {
    const { error } = await refusal('');
    expect(error.message).toContain('non-empty registry key');
  });

  it('refuses every operation the projection excludes, with a reason', async () => {
    for (const operation of Object.keys(REFUSALS)) {
      const { error } = await refusal(operation, {});
      expect(error.message).toContain('not invocable here');
    }
  });

  it('refuses a destructive operation without the confirmation flag', async () => {
    const { error } = await refusal('articles.delete', { id: 16 });
    expect(error.message).toContain('needs a deliberate act');
    expect(error.message).toContain('confirm: "articles.delete"');
  });

  it('refuses a destructive operation that asks to execute without confirmation', async () => {
    const { error } = await refusal('articles.delete', { id: 16 }, { dryRun: false });
    expect(error.message).toContain('confirm');
  });

  it('refuses a confirmation that names a different operation', async () => {
    const { error } = await refusal('articles.delete', { id: 16 }, { confirm: 'photos.delete', dryRun: false });
    expect(error.message).toContain('confirm must equal the operation key exactly');
  });

  it('refuses an argument the operation cannot honour', async () => {
    const unknownField = await refusal('articles.get', { id: 16, name: 'nope' });
    expect(unknownField.error.message).toContain('name: unknown field');
    expect(unknownField.error.message).toContain('No request was issued');
    const declared = inputFields((getCapability('articles.get') as CapabilityRecord).inputSchema).map(nameOf);
    expect(declared).toEqual(['id']);

    const missing = await refusal('articles.get', {});
    expect(missing.error.message).toContain('id: required');

    const illTyped = await refusal('articles.get', { id: 'sixteen' });
    expect(illTyped.error.message).toContain('id: expected number, got string');

    const nested = await refusal('articles.update', { id: 1, data: { draft: 'yes' } });
    expect(nested.error.message).toContain('data.draft: expected boolean, got string');

    const mismatched = await refusal('articles.getContext', { id: 1, opts: { expand: 'true' } });
    expect(mismatched.error.message).toContain('opts.expand: expected boolean, got string');
  });

  it('refuses an out-of-enum value, at the nested path the enum is declared on', async () => {
    const candidate = records
      .map((record) => ({ record, mutation: mutationsOf(record).find((entry) => entry.value === '__not_in_enum__') }))
      .find((entry) => entry.mutation !== undefined && entry.record.effect === 'read') as
      { record: CapabilityRecord; mutation: Mutation };
    expect(candidate).toBeDefined();
    const input = sampleInput(candidate.record);
    expect(applyMutation(input, candidate.mutation)).toBe(true);
    const verdict = validateInvokeInput(candidate.record, input);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.map((problem) => problem.path)).toContain(candidate.mutation.expected);
    const { error } = await refusal(candidate.record.name, input);
    expect(error.message).toContain(candidate.mutation.expected + ': expected one of');
  });

  it('refuses a malformed payload (not an object)', async () => {
    const asArray = await refusal('articles.get', [16] as unknown as Record<string, unknown>);
    expect(asArray.error.message).toContain('must be an object of the operation');
    const asNumber = await refusal('articles.get', 16 as unknown as Record<string, unknown>);
    expect(asNumber.error.message).toContain('must be an object of the operation');
  });

  it('refuses a dryRun smuggled into the payload', async () => {
    const { error } = await refusal('companies.update', { id: 4, data: { name: 'Acme' }, opts: { dryRun: true } });
    expect(error.message).toContain('must not carry dryRun inside the payload');
  });

  it('refuses dryRun on a read — a read has no dry run', async () => {
    const { error } = await refusal('articles.get', { id: 16 }, { dryRun: true });
    expect(error.message).toContain('a read has no dry run');
  });

  it('refuses a write whose schema exposes no dry-run option, instead of executing it', () => {
    const base = getCapability('articles.get') as CapabilityRecord;
    const write = {
      ...base,
      name: 'future.write',
      effect: 'write' as const,
      inputSchema: { data: { name: 'data', type: 'object', required: true, fields: [{ name: 'name', type: 'string', required: false }] } },
    };
    expect(() => planInvoke(write, 'future.write', { data: { name: 'x' } })).toThrow(/no dry-run option/);
  });

  it('refuses an operation the registry cannot classify', () => {
    const base = getCapability('articles.get') as CapabilityRecord;
    const unknownEffect = { ...base, name: 'future.unclassified', effect: null };
    expect(() => planInvoke(unknownEffect, 'future.unclassified', { id: 1 })).toThrow(/no effect in the registry/);
  });
});

// ---------------------------------------------------------------------------
// Happy paths: one per representative shape.
// ---------------------------------------------------------------------------

describe('operations.invoke — happy paths per representative shape', () => {
  it('read: dispatches to the typed method and returns ITS result', async () => {
    const article = { id: 16, name: 'VPN setup', slug: 'vpn-setup', draft: false, content: '<p>x</p>' };
    const spy = stubFetch(() => json({ article }));
    const result = await makeOps().invoke('articles.get', { id: 16 });
    expect(result).toEqual(article);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toBe(BASE + '/articles/16');
    expect(spy.calls[0]?.init.method).toBe('GET');
  });

  it('write: dry-run FIRST by default — no request, and a DryRunResult says so', async () => {
    const spy = stubFetch(() => json({ company: { id: 4 } }));
    const result = (await makeOps().invoke('companies.update', { id: 4, data: { name: 'Acme' } })) as Record<string, unknown>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
    expect(result.operation).toBe('companies.update');
    expect(result.request).toEqual({ method: 'PUT', path: '/companies/4' });
  });

  it('write: an explicit { dryRun: false } executes it, through the same typed method', async () => {
    const spy = stubFetch(() => json({ company: { id: 4, name: 'Acme' } }));
    const result = (await makeOps().invoke(
      'companies.update',
      { id: 4, data: { name: 'Acme' } },
      { dryRun: false },
    )) as Record<string, unknown>;
    expect(result).toEqual({ id: 4, name: 'Acme' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('PUT');
    expect(spy.calls[0]?.url).toBe(BASE + '/companies/4');
  });

  it('destructive: executes only with the exact confirmation AND an explicit dry-run opt-out', async () => {
    const spy = stubFetch(() => empty(204));
    await expect(
      makeOps().invoke('articles.delete', { id: 16 }, { confirm: 'articles.delete', dryRun: false }),
    ).resolves.toBeUndefined();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.init.method).toBe('DELETE');
    expect(spy.calls[0]?.url).toBe(BASE + '/articles/16');
  });

  it('destructive: with the confirmation but no dry-run opt-out, it is still a dry run', async () => {
    const spy = stubFetch(() => empty(204));
    const result = (await makeOps().invoke('articles.delete', { id: 16 }, { confirm: 'articles.delete' })) as Record<string, unknown>;
    expect(spy.calls).toHaveLength(0);
    expect(result.simulated).toBe(true);
  });

  it('composite: one invoke fans out to the typed method\'s own composed calls', async () => {
    const handler: FetchHandler = (url) => {
      if (url.includes('/articles/1')) return json({ article: { id: 1, name: 'A', company_id: 7, folder_id: 5 } });
      if (url.includes('/companies/7')) return json({ company: { id: 7, name: 'Acme' } });
      return json({ folder: { id: 5, name: 'Ops' } });
    };
    const spy = stubFetch(handler);
    const result = (await makeOps().invoke('articles.getContext', { id: 1 })) as Record<string, unknown>;
    expect((result.article as Record<string, unknown>).id).toBe(1);
    expect((result.company as Record<string, unknown>).id).toBe(7);
    expect((result.folder as Record<string, unknown>).id).toBe(5);
    expect(spy.calls).toHaveLength(3);
  });

  it('client-scan: a resolve with no vendor id endpoint goes through the bounded scan', async () => {
    const spy = stubFetch(() => json([{
      id: 9, user_id: 2, user_email: 'tech@acme.example', resource_id: 77,
      resource_type: 'Asset', action_message: 'updated an asset', created_at: '2024-05-01T10:00:00Z',
    }]));
    const result = (await makeOps().invoke('activity_logs.resolve', {
      identifier: { id: 9, resource_type: 'Asset', resource_id: 77 },
    })) as Record<string, unknown>;
    expect(result.id).toBe(9);
    expect(result.resource_type).toBe('Asset');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.url).toContain('/activity_logs');
  });

  it('cross-resource: one invoke drives the bounded fan-out of a helper', async () => {
    const spy = stubFetch(() => json([]));
    const result = await makeOps().invoke('operations.searchAcrossResources', { query: 'acme' });
    expect(result).toEqual([]);
    expect(spy.calls).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Parity: the SDK's refusal set is the projection's, and the catalog stays truthful.
// ---------------------------------------------------------------------------

describe('operations.invoke — refusal parity with the generated catalog', () => {
  it('refuses exactly the resources the projection refuses (no drift, no bypass)', () => {
    const refusedOperations = Object.keys(REFUSALS);
    expect(refusedOperations.length).toBeGreaterThan(0);
    const refusedResources = [...new Set(refusedOperations.map((operation) => operation.split('.')[0]))].sort();
    expect(refusedResources).toEqual(Object.keys(INVOKE_REFUSED_RESOURCES).sort());
    for (const operation of refusedOperations) {
      const reason = (REFUSALS as Record<string, { reason: string }>)[operation]?.reason ?? '';
      expect(reason).toContain('binary/download');
    }
  });
});

describe('the authored example on the operations.invoke row', () => {
  // The row's `examples[0]` is the one thing an agent copies, so it is not prose: it is EXECUTED
  // here through the same dispatcher the G4 test covers. An example that would throw (or name an
  // operation that does not exist) is worse than no example, and this is the guard for that.
  it('is a real registry key whose bag the SDK accepts, and it reaches the wire', async () => {
    const example = getCapability('operations.invoke')!.examples[0]!;
    const parsed = /operations\.invoke\('([^']+)', (\{[^}]*\})\)/.exec(example);
    expect(parsed, `unrecognised example shape: ${example}`).not.toBeNull();
    const operation = parsed![1]!;
    expect(getCapability(operation), `${operation} is not a registry key`).toBeDefined();
    // The example is a JS call, not JSON: quote its bare keys before parsing the bag.
    const bag = JSON.parse(parsed![2]!.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')) as Record<string, unknown>;
    const spy = stubFetch(() => json({ id: 42, name: 'Rack 1' }));
    const result = (await makeOps().invoke(operation, bag)) as Record<string, unknown>;
    expect(spy.calls).toHaveLength(1);
    expect(result.id).toBe(42);
  });
});

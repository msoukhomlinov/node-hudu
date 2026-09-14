/**
 * `operations.invoke` — the SDK-side INVOKE (progressive-disclosure design §5, build-order step 3b).
 *
 * The generated catalog lists EVERY registry operation, including the ones the MCP projection never
 * exposes as a tool of their own. A listing is not reachability: unless an agent can actually CALL
 * one of those operations, the catalog is a promise the SDK cannot keep. This module is that call
 * path, and it is deliberately MCP-independent — plain `node-hudu` code (no MCP import, no MCP
 * type), so a host can call it and nothing in it knows what a tool is.
 *
 * ```ts
 * const hudu = new HuduClient({ baseUrl, apiKey });
 * const ops = new Operations(hudu);
 *
 * await ops.invoke('articles.get', { id: 16 });                       // read: one request
 * await ops.invoke('companies.update', { id: 4, data: { name: 'A' } }); // write: DRY RUN by default
 * await ops.invoke('companies.update', { id: 4, data: { name: 'A' } }, { dryRun: false });
 * await ops.invoke('companies.delete', { id: 4 }, { confirm: 'companies.delete', dryRun: false });
 * ```
 *
 * What this module owns, and what it deliberately does not:
 *
 * - it owns the RESOLVE step (exact registry-key lookup), the VALIDATE step (the caller's input
 *   against the registry record's `inputSchema`, before any transport call) and the GOVERN step
 *   (dry-run-first writes, an exact confirmation string for destructive operations, and the
 *   projection's refusals);
 * - it owns NO transport, NO retries, NO pagination and NO scanning. Dispatch calls the SAME typed
 *   method the SDK publishes, so every guard that path already has — bounded scans, the
 *   `expectedUpdatedAt` stale check, sensitive-field redaction, the dry-run result shape — is that
 *   path's, not a second implementation of it.
 *
 * The CALL SHAPE is decided from the record's structure, never from field order alone: a flat set
 * of named fields whose target takes ONE object parameter travels as ONE object
 * (`cards.lookup({ integration_slug })`), while a flat set whose target takes several parameters
 * stays positional (`assets.get(companyId, id)`). See `invokeCallShape`.
 *
 * The unsound corner, named rather than hidden: `inputSchema` is NOT JSON Schema, it is the
 * generator's own vocabulary (`type`, `required`, `fields`, `items`, `enum`, `anyOf`, `variants`,
 * `typeName`, `additionalProperties`, `keyType`), and this validator is a SECOND implementation of
 * that vocabulary. A validator that silently no-ops accepts anything. Two mechanisms stop that:
 * `auditSchemaVocabulary` refuses a record whose schema uses a key or type this module does not
 * know (so an unknown shape is a refusal, never an accept), and `test/operations/invoke.test.ts`
 * enumerates EVERY distinct shape in the shipped registry and exercises each one (accept AND
 * refuse). A shape added to the registry without being handled here fails that test.
 */
import { CAPABILITY_NAMES, getCapability, type CapabilityRecord } from '../capabilities.js';
import { HuduConfigError } from '../errors.js';
import type { HuduClient } from '../client.js';

// ---------------------------------------------------------------------------
// The invoke contract.
// ---------------------------------------------------------------------------

/** Caller options for `operations.invoke`. The dry-run flag lives HERE, never in the payload. */
export interface InvokeOptions {
  /**
   * Writes are DRY-RUN-FIRST: omit this (or pass `true`) and the operation runs on the SDK's
   * dry-run path — the real request is never issued and the result is a `DryRunResult` with
   * `simulated: true`. Only an explicit `dryRun: false` executes a write.
   *
   * A read refuses `dryRun: true`: a read has no dry run to run.
   */
  dryRun?: boolean;
  /**
   * Deliberate-act acknowledgement. When present it must EQUAL the operation key exactly (no
   * fuzzy matching, no booleans), and it is REQUIRED for a destructive or approval-gated
   * operation.
   */
  confirm?: string;
}

/** One input problem, with the field path it applies to (`data.name`, `identifier.id`, ...). */
export interface InvokeProblem {
  path: string;
  message: string;
}

/** The validator's verdict. `ok: false` is always `CONFIG_ERROR` and never issues a request. */
export interface InvokeVerdict {
  ok: boolean;
  code: 'CONFIG_ERROR' | null;
  problems: InvokeProblem[];
  message: string;
}

/** A registry record's input field, in the generator's own vocabulary. */
type SchemaField = Record<string, unknown>;

/**
 * Every field key the generator's `inputSchema` vocabulary uses, measured over the shipped
 * registry. `auditSchemaVocabulary` FAILS on anything outside this list, so this list is a
 * commitment, not a sample: adding a shape to the registry means adding it here (and exercising
 * it), or invoke refuses the record.
 */
export const SCHEMA_FIELD_KEYS: readonly string[] = [
  'name', 'type', 'required', 'fields', 'items', 'enum', 'anyOf', 'variants', 'typeName',
  'additionalProperties', 'keyType', 'description',
];

/** Every field type the generator's `inputSchema` vocabulary uses. */
export const SCHEMA_FIELD_TYPES: readonly string[] = [
  'string', 'number', 'boolean', 'object', 'array', 'union', 'null', 'unknown',
];

/**
 * Resources the projection refuses as a class, mirrored here so the escape hatch cannot bypass
 * the projection rule through the back door (design §5.1). These are the binary/download surface:
 * the typed methods stay callable (they return or stream bytes, which is legitimate SDK work),
 * but they are not an invoke target. `test/operations/invoke.test.ts` asserts this set is exactly
 * the generated catalog's `REFUSALS` set, so the two cannot drift.
 */
export const INVOKE_REFUSED_RESOURCES: Readonly<Record<string, string>> = {
  exports: 'binary/download surface',
  photos: 'binary/download surface',
  public_photos: 'binary/download surface',
  s3_exports: 'binary/download surface',
  uploads: 'binary/download surface',
};

// ---------------------------------------------------------------------------
// The schema vocabulary: shape audit, then validation.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObjects(value: unknown): SchemaField[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function nameOf(field: SchemaField): string {
  return typeof field.name === 'string' ? field.name : '';
}

function enumOf(field: SchemaField): unknown[] | undefined {
  return Array.isArray(field.enum) ? field.enum : undefined;
}

/**
 * The top-level input fields of a record, in declaration order — which IS the typed method's
 * parameter order (`update(id, data, opts)`, `resolve(identifier, opts)`, `list(params)`).
 *
 * The generator emits two forms, both handled: a map of `fieldName -> field` (the primitive and
 * helper form) and `{ type: 'object', fields: [...] }` (the list form).
 *
 * In the MAP form the key IS the field name, and a field name is not a structural keyword: the
 * vendor's own filters include `name` (`companies.list`, `articles.list`, ...) and `type`
 * (`procedures.list`), so skipping keys by name silently dropped 18 records' fields — a caller's
 * `name` filter was refused as "unknown field", and `lists.findByName(name, opts)`, which the
 * generator flattened, lost its `name` parameter entirely. A field node is always an OBJECT, and
 * the structural keys are a string (`type`, `name`) or an array (`fields`), so testing the value's
 * shape keeps every real field and skips every keyword.
 */
export function inputFields(inputSchema: unknown): SchemaField[] {
  if (inputSchema === null || inputSchema === undefined) return [];
  if (Array.isArray(inputSchema)) return inputSchema.filter(isObject);
  if (!isObject(inputSchema)) return [];
  if (Array.isArray(inputSchema.fields)) return (inputSchema.fields as unknown[]).filter(isObject);
  const out: SchemaField[] = [];
  for (const key of Object.keys(inputSchema)) {
    const value = inputSchema[key];
    if (isObject(value)) out.push(value);
  }
  return out;
}

/**
 * Audit a record's `inputSchema` against the vocabulary this module implements. Returns one string
 * per gap; an empty array means every key and type is understood.
 *
 * This is the guard against the one unsound outcome: a schema shape the validator does not know
 * would otherwise be validated by nothing at all. An unknown shape is a REFUSAL, never an accept.
 */
export function auditSchemaVocabulary(inputSchema: unknown): string[] {
  const gaps: string[] = [];
  const seen = new Set<string>();
  const visit = (field: SchemaField): void => {
    for (const key of Object.keys(field)) {
      if (!SCHEMA_FIELD_KEYS.includes(key)) gaps.push('unknown field key "' + key + '"');
    }
    const type = field.type;
    if (typeof type === 'string' && !SCHEMA_FIELD_TYPES.includes(type)) {
      gaps.push('unknown field type "' + type + '"');
    }
    // Shapes this module would otherwise not look inside at all. Every container is walked, so no
    // branch of a schema is silently unenforced.
    for (const nested of asObjects(field.fields)) visit(nested);
    if (isObject(field.items)) visit(field.items);
    for (const variant of asObjects(field.variants)) visit(variant);
    if (isObject(field.additionalProperties)) visit(field.additionalProperties);
  };
  for (const field of inputFields(inputSchema)) {
    const key = JSON.stringify(field);
    if (seen.has(key)) continue;
    seen.add(key);
    visit(field);
  }
  return gaps;
}

function runtimeTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** `unknown` accepts every value; every other name is an exact match on the runtime type. */
function matchesType(expected: unknown, value: unknown): boolean {
  if (expected === 'unknown') return true;
  const actual = runtimeTypeOf(value);
  if (expected === 'object') return actual === 'object';
  if (expected === 'array') return actual === 'array';
  // A non-finite number is NOT a valid number: `JSON.stringify(NaN)` is `null`, so accepting
  // NaN/Infinity here let a caller's bug reach the vendor as a NULL field value (found by a
  // security review: `company_id: NaN` dispatched `{"company_id":null}`).
  if (expected === 'number') return actual === 'number' && Number.isFinite(value);
  if (expected === 'string') return actual === 'string';
  if (expected === 'boolean') return actual === 'boolean';
  if (expected === 'null') return actual === 'null';
  return false;
}

/** `anyOf` is authoritative; `variants` is the fallback when a record omits it. */
function anyOfTypes(field: SchemaField): unknown[] {
  if (Array.isArray(field.anyOf)) return field.anyOf;
  const variants = asObjects(field.variants);
  return variants.length > 0 ? variants.map((variant) => variant.type) : ['unknown'];
}

function checkValue(field: SchemaField, value: unknown, path: string, problems: InvokeProblem[]): void {
  const expected = field.type;
  if (expected === 'union') {
    const allowed = anyOfTypes(field);
    if (!allowed.some((name) => matchesType(name, value))) {
      problems.push({ path, message: 'expected one of ' + allowed.map((name) => String(name)).join(' | ') + ', got ' + runtimeTypeOf(value) });
      return;
    }
    // A union can ALSO carry an enum (measured: `procedures.*.data.process_type` is
    // `union(string|string|null)` with `enum: ["global","company","null"]`). Checking only the
    // anyOf types would accept every string, which is the silent no-op this validator must not have.
    const allowedValues = enumOf(field);
    if (allowedValues !== undefined && !allowedValues.includes(value)) {
      problems.push({ path, message: 'expected one of ' + JSON.stringify(allowedValues) + ', got ' + JSON.stringify(value) });
      return;
    }
    // A union does not stop at the type: the variant that matched the value's runtime type
    // carries declared fields, and those are checked like any other object.
    if (isObject(value)) {
      const variant = asObjects(field.variants).find((candidate) => candidate.type === 'object');
      if (variant !== undefined) checkObjectFields(variant, value, path, problems);
    }
    return;
  }
  if (!matchesType(expected, value)) {
    problems.push({ path, message: 'expected ' + String(expected) + ', got ' + runtimeTypeOf(value) });
    return;
  }
  const allowed = enumOf(field);
  if (allowed !== undefined && !allowed.includes(value)) {
    problems.push({ path, message: 'expected one of ' + JSON.stringify(allowed) + ', got ' + JSON.stringify(value) });
    return;
  }
  if (expected === 'array' && isObject(field.items)) {
    const items = field.items;
    const list = value as unknown[];
    for (let index = 0; index < list.length; index += 1) {
      checkValue(items, list[index], path + '[' + index + ']', problems);
    }
    return;
  }
  if (expected === 'object') checkObjectFields(field, value as Record<string, unknown>, path, problems);
}

/**
 * Declared nested fields are type- and enum-checked; UNDECLARED ones are allowed when the record
 * declares no field list (`{"type":"object"}` / a map-like `data` payload). That is the typed
 * path's own tolerance — the vendor accepts extra keys in open record payloads — and refusing them
 * here would be stricter than the method this must mirror. The top level is never tolerant.
 */
function checkObjectFields(field: SchemaField, value: Record<string, unknown>, path: string, problems: InvokeProblem[]): void {
  for (const nested of asObjects(field.fields)) {
    const name = nameOf(nested);
    if (name.length === 0) continue;
    const nestedValue = value[name];
    if (nestedValue === undefined) {
      if (nested.required === true) problems.push({ path: path + '.' + name, message: 'required' });
      continue;
    }
    checkValue(nested, nestedValue, path + '.' + name, problems);
  }
}

/**
 * Validate a call against the registry record, BEFORE any request. A refusal is a `CONFIG_ERROR`
 * naming every offending field path; nothing about it is a guess and nothing is clamped.
 *
 * An unknown top-level field is refused (the operation cannot honour an argument it does not
 * declare), and so is a `dry_run` / `confirm` key in the payload: those belong to
 * `InvokeOptions`, and accepting a second spelling would mean a caller could believe a write was
 * acknowledged when it was not.
 */
export function validateInvokeInput(record: CapabilityRecord, input: unknown): InvokeVerdict {
  const gaps = auditSchemaVocabulary(record.inputSchema);
  if (gaps.length > 0) {
    return {
      ok: false,
      code: 'CONFIG_ERROR',
      problems: [],
      message:
        'operations.invoke: the registry record for ' + record.name + ' uses a schema shape this validator does ' +
        'not understand (' + gaps.join('; ') + '). Refusing rather than validating nothing.',
    };
  }
  if (input !== undefined && input !== null && !isObject(input)) {
    return {
      ok: false,
      code: 'CONFIG_ERROR',
      problems: [],
      message:
        'operations.invoke: input for ' + record.name + ' must be an object of the operation\'s arguments (got ' +
        runtimeTypeOf(input) + ').',
    };
  }
  const fields = inputFields(record.inputSchema);
  const bag: Record<string, unknown> = isObject(input) ? input : {};
  const known = new Map<string, SchemaField>();
  for (const field of fields) known.set(nameOf(field), field);
  const problems: InvokeProblem[] = [];
  const valid = fields.map(nameOf).filter((name) => name.length > 0);
  for (const key of Object.keys(bag)) {
    if (known.has(key)) continue;
    problems.push({
      path: key,
      message: 'unknown field (valid fields: ' + (valid.join(', ') || 'none') + ')',
    });
  }
  for (const field of fields) {
    const name = nameOf(field);
    if (name.length === 0) continue;
    const value = bag[name];
    if (value === undefined) {
      if (field.required === true) problems.push({ path: name, message: 'required' });
      continue;
    }
    checkValue(field, value, name, problems);
  }
  if (problems.length > 0) {
    return {
      ok: false,
      code: 'CONFIG_ERROR',
      problems,
      message:
        'operations.invoke: invalid input for ' + record.name + ' — ' +
        problems.map((problem) => problem.path + ': ' + problem.message).join('; ') + '. No request was issued.',
    };
  }
  return { ok: true, code: null, problems: [], message: 'ok' };
}

// ---------------------------------------------------------------------------
// Resolution: registry key -> the typed method, and the refusal path.
// ---------------------------------------------------------------------------

/** The nearest registry keys to an unknown one. Exact-key lookup, but a refusal can still help. */
export function nearestOperations(operation: string, limit = 5): string[] {
  const want = String(operation).toLowerCase();
  const head = want.split('.')[0] ?? '';
  const scored: { name: string; score: number }[] = [];
  for (const name of CAPABILITY_NAMES) {
    const key = name.toLowerCase();
    let score = 0;
    if (key === want) score += 8;
    if (key.includes(want) || want.includes(key)) score += 4;
    if (key.split('.')[0] === head) score += 3;
    if (want.length >= 4 && key.includes(want.slice(0, 4))) score += 1;
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.name);
}

/** `asset_passwords` -> `assetPasswords`: the client property the registry resource maps to. */
function clientProperty(resource: string): string {
  return resource.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * The typed method a registry record dispatches to, bound to its resource object.
 *
 * Resolution is mechanical (`resource` -> the client property, `name` minus its prefix -> the
 * method), and it is not taken on trust: a record whose target is missing is a `CONFIG_ERROR`
 * naming the drift, never a `TypeError` at the call site. The registry test enumerates every
 * record, so a registry/implementation divergence fails the suite rather than a caller's turn.
 */
export function resolveInvokeTarget(
  client: HuduClient,
  record: CapabilityRecord,
): (...args: unknown[]) => Promise<unknown> {
  const resource = record.resource;
  const property = clientProperty(resource);
  const holder = (client as unknown as Record<string, unknown>)[property];
  if (holder === undefined || holder === null) {
    throw new HuduConfigError(
      'operations.invoke: ' + record.name + ' names resource "' + resource + '", but the client has no "' +
      property + '" resource. The registry and the implementation have drifted.',
      { operation: record.name },
    );
  }
  const methodName = record.name.slice(resource.length + 1);
  const holderRecord = holder as Record<string, unknown>;
  const candidate = holderRecord[methodName];
  if (typeof candidate !== 'function') {
    throw new HuduConfigError(
      'operations.invoke: ' + record.name + ' names method "' + methodName + '()" on resource "' + resource +
      '", but it does not exist. The registry and the implementation have drifted.',
      { operation: record.name },
    );
  }
  const bound = (candidate as (...args: unknown[]) => unknown).bind(holder);
  return async (...args: unknown[]): Promise<unknown> => bound(...args);
}

/** The field index of the mutation-options bag: the last object field declaring `dryRun`. */
function dryRunBagIndex(fields: SchemaField[]): number {
  let found = -1;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.type !== 'object') continue;
    if (asObjects(field.fields).some((nested) => nameOf(nested) === 'dryRun')) found = index;
  }
  return found;
}

/** True for an operation that needs a deliberate act before it runs. */
function needsConfirmation(record: CapabilityRecord): boolean {
  return record.effect === 'destructive' || (record.flags ?? []).includes('requiresApproval');
}

function refuse(message: string, operation: string, suggestedAction?: string): never {
  throw new HuduConfigError(message, suggestedAction === undefined ? { operation } : { operation, suggestedAction });
}

// ---------------------------------------------------------------------------
// Call SHAPE: what the target method expects, not merely which field comes first.
// ---------------------------------------------------------------------------

/**
 * The argument shape a record's typed method expects.
 *
 * - `positional` — one argument per declared field, in declaration order. This is the shape of BOTH
 *   ends of the registry: a method that takes several parameters (`assets.get(companyId, id)`, so
 *   `inputSchema` is flat and shares their names) AND a method whose parameter IS a caller-supplied
 *   object (`companies.update(id, data, opts)`, so `inputSchema` keeps `data`/`opts` as object
 *   fields). Neither needs a second treatment: field order is the parameter order in the first case,
 *   and the object field travels as one argument in the second.
 * - `bag` — the declared fields are the FIELDS OF ONE OBJECT PARAMETER, so they must travel as ONE
 *   object (`cards.lookup(params)`, `companies.list(params)`).
 * - `unknown` — the record does not say, and the dispatcher refuses rather than guess.
 */
export type InvokeCallShape = 'bag' | 'positional' | 'unknown';

/**
 * The argument count of the record's own `examples[0]`, or null when it cannot be read.
 *
 * This is the only surviving witness of the parameter list for a FLATTENED record. The generator
 * renders `examples[0]` from the SAME parameter resolution that builds `inputSchema`
 * (`paramInfo()`: one parameter with declared fields is flattened into top-level fields; several
 * parameters keep their names). So a flattened one-parameter method shows exactly ONE argument in
 * its example, while a method with N parameters shows N — the information the flattened schema
 * dropped. It is generated registry data, not prose, and the test asserts the invariant for every
 * record so a drift fails the suite instead of sending a wrong request.
 */
export function exampleCallArity(record: CapabilityRecord): number | null {
  const example = Array.isArray(record.examples) ? record.examples[0] : undefined;
  if (typeof example !== 'string' || example.length === 0) return null;
  const open = example.indexOf('(');
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let index = open; index < example.length; index += 1) {
    const char = example[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) { close = index; break; }
    }
  }
  if (close === -1) return null;
  const inner = example.slice(open + 1, close).trim();
  if (inner.length === 0) return 0;
  let nested = 0;
  let args = 1;
  for (const char of inner) {
    if (char === '(' || char === '[' || char === '{') nested += 1;
    else if (char === ')' || char === ']' || char === '}') nested -= 1;
    else if (char === ',' && nested === 0) args += 1;
  }
  return args;
}

/**
 * Decide the call shape from the record's STRUCTURE first, and only fall back to the example's
 * arity for the one case structure cannot settle: a flat set of scalar fields is either N positional
 * arguments or the fields of one object parameter, and the flattened schema looks identical either
 * way. A record with no fields takes no arguments. A record that keeps an object field
 * (`data`/`params`/`opts`) already carries the call's own shape. A single flat field is one scalar
 * parameter (`articles.get(id)`) — never a one-field bag, which is what the shipped registry shows.
 */
export function invokeCallShape(record: CapabilityRecord): InvokeCallShape {
  const fields = inputFields(record.inputSchema);
  if (fields.length === 0) return 'positional';
  if (fields.some((field) => field.type === 'object')) return 'positional';
  if (fields.length === 1) return 'positional';
  const arity = exampleCallArity(record);
  if (arity === null) return 'unknown';
  if (arity === 1) return 'bag';
  if (arity === fields.length) return 'positional';
  return 'unknown';
}

/**
 * The ONE object argument a `bag` record needs, built from the caller's own values. Undefined
 * fields are omitted rather than sent: the typed method distinguishes "absent" from "undefined
 * value" for its own query bag, and an explicit `undefined` would be a second spelling of absence.
 */
function bagArgument(fields: SchemaField[], bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const name = nameOf(field);
    if (name.length === 0) continue;
    if (bag[name] === undefined) continue;
    out[name] = bag[name];
  }
  return out;
}

/** True for the lazy streaming result of the SDK's `list()`/`listPages()` family. */
function isAsyncIterable(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/**
 * The refusal for a streaming result. The dispatcher is REQUEST-SCOPED: collecting a stream means
 * owning pagination and a bound, which this module deliberately does not. Returning the iterator
 * itself is worse than refusing — JSON serialises it as `{}`, a result that looks like data and
 * carries none — so an invoke of a `list()`-shaped operation stops here, request-free (an async
 * generator issues nothing until it is iterated).
 */
function streamRefusal(record: CapabilityRecord, client: HuduClient): string {
  const holder = (client as unknown as Record<string, unknown>)[clientProperty(record.resource)];
  const hasListAll = typeof (holder as Record<string, unknown> | undefined)?.listAll === 'function';
  const alternative = hasListAll
    ? 'Call the typed method for the array form instead: `hudu.' + clientProperty(record.resource) + '.listAll({ ... })`.'
    : 'Call the typed method that returns an array instead.';
  return (
    'operations.invoke: ' + record.name + ' returns an AsyncIterable (a streaming scan), not a call result. ' +
    'The dispatcher is request-scoped and owns no pagination, so it will not collect a stream into an array — ' +
    'and handing the iterator back would serialise as {}. Nothing was sent to Hudu. ' + alternative
  );
}

// ---------------------------------------------------------------------------
// The dispatcher.
// ---------------------------------------------------------------------------

/** What the governor decided for one call. */
export interface InvokePlan {
  /** True when the call may reach the network; false means the SDK dry-run path (no request). */
  execute: boolean;
  /**
   * The arguments for the typed method: one per declared field in the registry's own declaration
   * order, or — when the record's flat fields are the fields of ONE parameter object — a single
   * argument holding that object (`invokeCallShape`).
   */
  args: unknown[];
}

/**
 * Validate and govern one call WITHOUT dispatching it: the pure half of `invokeOperation`, split
 * out so the governor's refusals can be exercised directly (including shapes no registry record
 * currently has, e.g. a write with no dry-run option).
 *
 * Order is part of the contract: VALIDATE (schema) then GOVERN (confirmation, dry-run). A refusal
 * is a `CONFIG_ERROR` and no request is ever built, let alone issued.
 */
export function planInvoke(
  record: CapabilityRecord,
  operation: string,
  input?: Record<string, unknown>,
  opts?: InvokeOptions,
): InvokePlan {
  const verdict = validateInvokeInput(record, input);
  if (!verdict.ok) {
    refuse(verdict.message, operation, 'Fix the named field(s); nothing was sent to Hudu.');
  }
  const fields = inputFields(record.inputSchema);
  const bag: Record<string, unknown> = isObject(input) ? { ...input } : {};
  const options: InvokeOptions = opts ?? {};

  // `confirm`, when given, must always name THIS operation: a confirmation that names something
  // else is not an acknowledgement of this call.
  if (options.confirm !== undefined && options.confirm !== operation) {
    refuse(
      'operations.invoke: confirm must equal the operation key exactly to acknowledge ' + record.name + ' (got ' +
      JSON.stringify(options.confirm) + ').',
      operation,
    );
  }

  const effect = record.effect;
  if (effect === null) {
    refuse(
      'operations.invoke: ' + record.name + ' has no effect in the registry, so it cannot be classified as a read ' +
      'or a write. Refusing to run it.',
      operation,
    );
  }

  let execute = true;
  if (effect === 'read') {
    if (options.dryRun === true) {
      refuse(
        'operations.invoke: ' + record.name + ' is a read; a read has no dry run. Call it without { dryRun: true }.',
        operation,
      );
    }
  } else {
    if (needsConfirmation(record) && options.confirm !== operation) {
      refuse(
        'operations.invoke: ' + record.name + ' is ' + effect + ' (or approval-gated) and needs a deliberate act: pass ' +
        '{ confirm: "' + record.name + '" }. Refusing without it.',
        operation,
      );
    }
    const bagIndex = dryRunBagIndex(fields);
    if (bagIndex === -1) {
      refuse(
        'operations.invoke: ' + record.name + ' is a write whose registry schema exposes no dry-run option, so this ' +
        'dispatcher cannot force it through the SDK dry-run path. It is not invocable; call the typed method.',
        operation,
        'Call the typed method directly.',
      );
    }
    const bagName = nameOf(fields[bagIndex] as SchemaField);
    const supplied = bag[bagName];
    if (isObject(supplied) && supplied.dryRun !== undefined) {
      refuse(
        'operations.invoke: ' + record.name + ' must not carry dryRun inside the payload (' + bagName + '.dryRun); ' +
        'the dry-run flag belongs to the invoke options — call it with { dryRun: false } to execute.',
        operation,
      );
    }
    // Writes are DRY-RUN-FIRST: only an explicit `dryRun: false` reaches the wire.
    execute = options.dryRun === false;
    bag[bagName] = { ...(isObject(supplied) ? supplied : {}), dryRun: !execute };
  }

  // SHAPE, not merely order. A flat set of scalar fields is ambiguous: `cards.lookup` declares
  // integration_slug/integration_id/integration_identifier, which are the FIELDS OF ONE `params`
  // object, while `assets.get` declares companyId/id, which are TWO parameters. Passing the flat
  // fields positionally in the first case hands the method a bare string where an object belongs,
  // which the HTTP layer then serialises into the query as `0=a&1=c&2=m&3=e` — a request to the
  // right path that cannot succeed and cannot throw. `invokeCallShape` settles the case from the
  // record's structure, and refuses when the record itself does not say.
  const shape = invokeCallShape(record);
  if (shape === 'unknown') {
    refuse(
      'operations.invoke: ' + record.name + ' declares ' + String(fields.length) + ' flat scalar fields, which ' +
      'this dispatcher cannot tell apart from the fields of one object parameter, and the record\'s own example ' +
      'does not settle it (' + JSON.stringify(Array.isArray(record.examples) ? record.examples[0] ?? null : null) +
      '). Refusing rather than sending a request with the wrong argument shape.',
      operation,
    );
  }
  if (shape === 'bag') return { execute, args: [bagArgument(fields, bag)] };
  return { execute, args: fields.map((field) => bag[nameOf(field)]) };
}

/**
 * Resolve, validate, govern and dispatch one registry operation.
 *
 * Order matters and is asserted by the tests: RESOLVE (unknown key), REFUSE (the projection's
 * excluded classes), then `planInvoke` (schema validation, dry-run and confirmation), then
 * DISPATCH — the typed method, and nothing else.
 *
 * Returns the typed method's own result: a read returns its record(s), a write returns its
 * `DryRunResult` while it is a dry run, and the real record once `{ dryRun: false }` executes it.
 * There is no invoke-specific envelope, so a caller never has to reconcile two result shapes.
 */
export async function invokeOperation(
  client: HuduClient,
  operation: string,
  input?: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<unknown> {
  if (typeof operation !== 'string' || operation.length === 0) {
    refuse('operations.invoke: operation must be a non-empty registry key, for example "companies.get".', String(operation));
  }
  const record = getCapability(operation);
  if (record === undefined) {
    const near = nearestOperations(operation, 5);
    refuse(
      'operations.invoke: unknown operation "' + operation + '". Operation keys are exact registry keys (never a ' +
      'method name, never fuzzy). Nearest keys: ' + (near.length > 0 ? near.join(', ') : '(none)') + '.',
      operation,
      'Use an exact key from the capability catalog (`hudu_catalog` in the MCP layer).',
    );
  }
  const refusal = INVOKE_REFUSED_RESOURCES[record.resource];
  if (refusal !== undefined) {
    refuse(
      'operations.invoke: ' + record.name + ' is not invocable here — ' + refusal + '. The typed method remains ' +
      'available to code; it returns or streams bytes, which is not a call result.',
      operation,
    );
  }
  const plan = planInvoke(record, operation, input, opts);
  const target = resolveInvokeTarget(client, record);
  const result = await target(...plan.args);
  // A streaming scan is not a call result: see streamRefusal. The refusal is request-free because an
  // async generator does no work until it is iterated.
  if (isAsyncIterable(result)) refuse(streamRefusal(record, client), operation);
  return result;
}

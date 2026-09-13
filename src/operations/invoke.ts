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
 */
export function inputFields(inputSchema: unknown): SchemaField[] {
  if (inputSchema === null || inputSchema === undefined) return [];
  if (Array.isArray(inputSchema)) return inputSchema.filter(isObject);
  if (!isObject(inputSchema)) return [];
  if (Array.isArray(inputSchema.fields)) return (inputSchema.fields as unknown[]).filter(isObject);
  const out: SchemaField[] = [];
  for (const key of Object.keys(inputSchema)) {
    if (key === 'type' || key === 'fields' || key === 'name') continue;
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
  if (expected === 'number') return actual === 'number';
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
// The dispatcher.
// ---------------------------------------------------------------------------

/** What the governor decided for one call. */
export interface InvokePlan {
  /** True when the call may reach the network; false means the SDK dry-run path (no request). */
  execute: boolean;
  /** The positional arguments for the typed method, in the registry's own declaration order. */
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
  return target(...plan.args);
}

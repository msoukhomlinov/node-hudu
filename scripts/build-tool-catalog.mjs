// scripts/build-tool-catalog.mjs
//
// `node scripts/build-tool-catalog.mjs [--out <path>] [--check]`
//
// Builds the progressive-disclosure artifacts from the capability registry, and writes them as a
// generated consumer-layer module (`examples/tool-catalog.generated.ts`, default):
//
//   - the CATALOG: one row per registry operation (all of them, never a subset), with the tool
//     that exposes it when there is one, its effect, the arguments it requires, whether it is
//     dry-run-first, and — for an operation the projection deliberately never exposes —
//     `reachable: false` plus the reason and the bounded alternative. This is what closes the
//     reachability hole: an operation with no tool must be DISCOVERABLE, not indistinguishable
//     from an operation that does not exist.
//   - the CORE profile (rule implemented in `scripts/project-mcp-tools.mjs`, never listed by hand)
//     and the three META tools whose descriptions the projection owns.
//   - the runtime helpers a host needs (catalog paging, describe, input validation against the
//     registry record, the write governor). They import NOTHING: the SDK stays MCP-independent,
//     and the host passes the registry record (`getCapability(op)`), so the validator cannot drift
//     from the registry it validates against.
//
// The projection is imported from `scripts/project-mcp-tools.mjs` — one implementation of the
// curation rules, never a second copy. The registry is `capabilities.json` (the same emission the
// SDK's `src/capabilities.ts` is generated from, planHash-gated by `capabilities:check`).
//
// `--check`: verify the generated module on disk is exactly what this script would write, and
// that every registry operation is reachable or explicitly refused. Exit 1 otherwise. Used by the
// capability gate (`npm run capabilities:check` reads the generated module directly as well).
//
// Exit codes: 0 ok, 1 registry missing/unreadable or a reachability violation.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  CORE_RULE,
  CORE_TOOL_NAMES,
  META_TOOLS,
  WORKFLOW_RESOURCES,
  curationExcluded,
  coreProfile,
  excluded as excludedByRule,
  registry,
  records,
  tools as projectedTools,
} from './project-mcp-tools.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => { const i = argv.indexOf(flag); return i === -1 ? fallback : argv[i + 1]; };
const OUT = path.resolve(ROOT, argValue('--out', 'examples/tool-catalog.generated.ts'));
const CHECK = argv.includes('--check');

// ---------------------------------------------------------------- reachability
// Two curated projection outcomes, two different catalog outcomes:
//   - excluded BY RULE (unbounded listAll/listPages read, or a binary/download resource) is
//     `reachable: false`: the escape hatch refuses it too, so the exclusion rule cannot be
//     bypassed through the back door. The bounded alternative is named when the registry has one.
//   - excluded BY CURATION (a duplicate outcome) stays `reachable: true` with `tool: null`: the
//     tool is gone, the capability is not. That is exactly the long tail `hudu_invoke` is for.
const REFUSAL_REASON = (why) => (why.includes('unbounded read')
  ? 'unbounded read (listAll/listPages) — never exposed as a tool, and refused through hudu_invoke so the projection rule cannot be bypassed'
  : 'binary/download surface — the SDK returns or streams bytes, which is not a tool result');
const exposedByOp = new Map();
for (const t of projectedTools) if (!exposedByOp.has(t.backingOperation)) exposedByOp.set(t.backingOperation, t.name);
const refusals = [];
for (const e of excludedByRule) {
  const alternativeTool = projectedTools
    .filter((t) => t.effect === 'read' && t.backingOperation.split('.')[0] === e.name.split('.')[0])
    .map((t) => t.name);
  refusals.push({
    op: e.name,
    reachable: false,
    reason: REFUSAL_REASON(e.why),
    alternative: alternativeTool.length ? alternativeTool[0] : null,
    why: e.why,
  });
}
const refusalByOp = new Map(refusals.map((r) => [r.op, r]));

// ---------------------------------------------------------------- catalog rows
const requiredNames = (inputSchema) => {
  if (!inputSchema || typeof inputSchema !== 'object') return [];
  const fields = Array.isArray(inputSchema.fields)
    ? inputSchema.fields
    : Object.keys(inputSchema).filter((k) => k !== 'type' && k !== 'name' && k !== 'fields').map((k) => inputSchema[k]);
  return fields.filter((f) => f && f.required === true).map((f) => f.name);
};
const catalog = records.map((rec) => {
  const refusal = refusalByOp.get(rec.name);
  const tool = exposedByOp.get(rec.name) ?? null;
  const destructive = rec.effect === 'destructive' || (rec.flags ?? []).includes('requiresApproval');
  const row = {
    op: rec.name,
    tool: tool,
    summary: rec.purpose ?? null,
    when: rec.preferredWhen ?? null,
    effect: rec.effect ?? null,
    requires: requiredNames(rec.inputSchema),
    dry_run: rec.effect !== 'read',
    confirm_required: rec.effect !== 'read' && destructive,
    reachable: refusal ? false : true,
  };
  if (refusal) {
    row.reason = refusal.reason;
    if (refusal.alternative) row.alternative = refusal.alternative;
  } else if (tool === null) {
    row.reason = 'no tool of its own (curated out as a duplicate outcome) — reachable through hudu_invoke';
  }
  return row;
});
catalog.sort((a, b) => (a.op < b.op ? -1 : a.op > b.op ? 1 : 0));

// ---------------------------------------------------------------- the invariant
const registryKeys = new Set(records.map((r) => r.name));
const violations = [];
const seen = new Set();
for (const row of catalog) {
  seen.add(row.op);
  const refusal = refusalByOp.get(row.op);
  if (row.reachable === true && row.tool === null && !refusal && row.reason === undefined) {
    violations.push(`${row.op}: reachable but neither exposed as a tool nor explained`);
  }
  if (row.reachable === false && !row.reason) violations.push(`${row.op}: refused with no reason string`);
}
for (const key of registryKeys) if (!seen.has(key)) violations.push(`${key}: no catalog row (the reachability hole this feature exists to close)`);
for (const t of projectedTools) {
  if (!registryKeys.has(t.backingOperation)) violations.push(`${t.name}: exposed tool backs an operation that is not a registry key (${t.backingOperation})`);
}
for (const e of excludedByRule) if (!refusalByOp.has(e.name)) violations.push(`${e.name}: excluded by rule but not refused with a reason in the catalog`);
for (const meta of META_TOOLS) if (projectedTools.some((t) => t.name === meta.name)) violations.push(`${meta.name}: a META tool name collides with a curated tool`);

// ---------------------------------------------------------------- the generated module
const runtime = `

// ---------------------------------------------------------------------------------------------
// Runtime helpers. Deliberately MCP-agnostic and dependency-free: this module is consumer-layer
// code (an MCP server needs it, the SDK must not), it imports nothing, and every function takes
// the registry record it needs as an argument, so a host passes \`getCapability(op)\` from
// \`node-hudu/capabilities\` and nothing here can drift from the registry it is used with.
// ---------------------------------------------------------------------------------------------

/** Bounded catalog page: default 40 rows, hard cap 100. */
export const DEFAULT_CATALOG_LIMIT = 40;
export const MAX_CATALOG_LIMIT = 100;

/** Config refusal, same code the SDK uses for a caller-side configuration error. */
export function configError(message) {
  const err = new Error(message);
  err.name = 'ConfigError';
  return err;
}

/** One catalog row by canonical operation key, or null. */
export function catalogRow(operation) {
  for (let i = 0; i < CATALOG.length; i += 1) if (CATALOG[i].op === operation) return CATALOG[i];
  return null;
}

/** The nearest catalog keys to an unknown one (exact-key lookup, but a useful refusal). */
export function nearestKeys(operation, limit) {
  const want = String(operation).toLowerCase();
  const head = want.split('.')[0];
  const scored = CATALOG.map((row) => {
    const op = row.op.toLowerCase();
    let score = 0;
    if (op.indexOf(want) !== -1 || want.indexOf(op) !== -1) score += 4;
    if (op.split('.')[0] === head) score += 3;
    if (op.indexOf(want.slice(0, 4)) !== -1) score += 1;
    return { op: row.op, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit === undefined ? 5 : limit).map((r) => r.op).concat(CATALOG.map((r) => r.op).slice(0, 3)).filter((v, i, arr) => arr.indexOf(v) === i).slice(0, limit === undefined ? 5 : limit);
}

/**
 * A bounded, filterable page of the catalog. Filters are ANDed. \`unexposed_only\` is the
 * "what can I reach that has no tool?" question, which is the whole point of the mechanism.
 */
export function catalogPage(options) {
  const o = options || {};
  const limit = o.limit === undefined ? DEFAULT_CATALOG_LIMIT : o.limit;
  const offset = o.offset === undefined ? 0 : o.offset;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_CATALOG_LIMIT) {
    throw configError('hudu_catalog: limit must be an integer from 1 to ' + MAX_CATALOG_LIMIT + ' (got ' + JSON.stringify(o.limit) + '); the catalog is never dumped whole by default.');
  }
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw configError('hudu_catalog: offset must be an integer >= 0 (got ' + JSON.stringify(o.offset) + ').');
  }
  const rows = CATALOG.filter((row) => {
    if (o.effect !== undefined && row.effect !== o.effect) return false;
    if (o.resource !== undefined && row.op.split('.')[0] !== o.resource) return false;
    if (o.unexposed_only === true && row.reachable !== true) return false;
    if (o.unexposed_only === true && row.tool !== null) return false;
    return true;
  });
  return {
    total_operations: CATALOG.length,
    reachable_operations: CATALOG.filter((r) => r.reachable === true).length,
    unexposed_operations: CATALOG.filter((r) => r.reachable === true && r.tool === null).length,
    unreachable_operations: CATALOG.filter((r) => r.reachable !== true).length,
    matched: rows.length,
    offset,
    limit,
    has_more: offset + limit < rows.length,
    rows: rows.slice(offset, offset + limit),
  };
}

/** Resolve an operation key to its catalog row, refusing an unknown key by naming the nearest. */
export function requireCatalogRow(operation) {
  if (typeof operation !== 'string' || operation.length === 0) {
    throw configError('operation must be a non-empty canonical registry key, for example "companies.update".');
  }
  const row = catalogRow(operation);
  if (row !== null) return row;
  const near = nearestKeys(operation, 5);
  throw configError('Unknown operation "' + operation + '". Operation keys are exact registry keys (never a tool name, never fuzzy). Nearest keys: ' + (near.length ? near.join(', ') : '(none)') + '. Call hudu_catalog to list every operation.');
}

/**
 * One operation's full description, from the registry record the host passes in. The generic
 * registry vocabulary is echoed verbatim; \`reachable\` / \`why_not\` come from the generated catalog.
 */
export function describeOperation(record) {
  const row = requireCatalogRow(record.name);
  const fields = inputFields(record.inputSchema);
  const required = [];
  for (let i = 0; i < fields.length; i += 1) if (fields[i].required === true) required.push(fields[i].name);
  return {
    op: record.name,
    kind: record.kind,
    resource: record.resource,
    effect: record.effect,
    flags: record.flags || [],
    dry_run: row.dry_run,
    confirm_required: row.confirm_required === true,
    permissions: record.permissions,
    requires: required,
    input_schema: record.inputSchema,
    example: (record.examples || [])[0] || null,
    errors: record.errors || [],
    related: record.related || [],
    purpose: record.purpose,
    usage: record.usage,
    preferred_when: record.preferredWhen,
    exposed_tool: row.tool,
    reachable: row.reachable,
    why_not: row.reason === undefined ? null : row.reason,
    bounded_alternative: row.alternative === undefined ? null : row.alternative,
    pagination: record.pagination || null,
    resolution: record.resolution || null,
  };
}

// ---- the registry schema vocabulary ---------------------------------------------------------
// \`inputSchema\` is NOT JSON Schema: it is the generator's own vocabulary. Every type and key the
// registry actually uses is listed here, and \`test/mcp-tool-catalog.test.ts\` enumerates the
// registry and exercises each one (the G4 shape test). An unknown shape is a HARD FAILURE, never
// an accept: a validator that silently no-ops is worse than no validator.
const KNOWN_FIELD_KEYS = ['name', 'type', 'required', 'fields', 'items', 'enum', 'anyOf', 'variants', 'typeName', 'additionalProperties', 'keyType', 'description', 'id', 'resourceType', 'resourceId'];
const KNOWN_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'union', 'null', 'unknown'];

/** The top-level fields of an inputSchema, whether the generator emitted a map or a field list. */
export function inputFields(inputSchema) {
  if (inputSchema === null || inputSchema === undefined) return [];
  if (Array.isArray(inputSchema)) return inputSchema;
  const fields = inputSchema.fields;
  if (Array.isArray(fields)) return fields;
  const out = [];
  const keys = Object.keys(inputSchema);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const v = inputSchema[k];
    if (k === 'type' || k === 'fields' || k === 'name') continue;
    if (v !== null && typeof v === 'object') out.push(v);
  }
  return out;
}

/** Shape audit: every key/type the registry uses must be handled below. Returns the gaps. */
export function auditSchemaVocabulary(inputSchema) {
  const gaps = [];
  const visit = (field) => {
    if (field === null || typeof field !== 'object') return;
    const keys = Object.keys(field);
    for (let i = 0; i < keys.length; i += 1) {
      if (KNOWN_FIELD_KEYS.indexOf(keys[i]) === -1) gaps.push('unknown field key "' + keys[i] + '"');
    }
    const t = field.type;
    if (typeof t === 'string' && KNOWN_TYPES.indexOf(t) === -1) gaps.push('unknown field type "' + t + '"');
    if (Array.isArray(field.fields)) for (let i = 0; i < field.fields.length; i += 1) visit(field.fields[i]);
    if (field.items !== null && typeof field.items === 'object') visit(field.items);
    if (Array.isArray(field.variants)) for (let i = 0; i < field.variants.length; i += 1) visit(field.variants[i]);
  };
  const top = inputFields(inputSchema);
  for (let i = 0; i < top.length; i += 1) visit(top[i]);
  return gaps;
}

function typeNameOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(expected, value) {
  const actual = typeNameOf(value);
  if (expected === 'unknown') return true;
  if (expected === 'null') return actual === 'null';
  if (expected === 'object') return actual === 'object';
  if (expected === 'array') return actual === 'array';
  if (expected === 'number') return actual === 'number';
  if (expected === 'string') return actual === 'string';
  if (expected === 'boolean') return actual === 'boolean';
  return true;
}

function checkValue(field, value, path, problems) {
  const expected = field.type;
  if (expected === 'union') {
    const anyOf = Array.isArray(field.anyOf) ? field.anyOf : (Array.isArray(field.variants) ? field.variants.map((v) => v.type) : ['unknown']);
    let okType = false;
    for (let i = 0; i < anyOf.length; i += 1) if (matchesType(anyOf[i], value)) okType = true;
    if (!okType) problems.push({ path, message: 'expected one of ' + anyOf.join(' | ') + ', got ' + typeNameOf(value) });
    return;
  }
  if (!matchesType(expected, value)) {
    problems.push({ path, message: 'expected ' + expected + ', got ' + typeNameOf(value) });
    return;
  }
  if (Array.isArray(field.enum) && field.enum.indexOf(value) === -1) {
    problems.push({ path, message: 'expected one of ' + JSON.stringify(field.enum) + ', got ' + JSON.stringify(value) });
    return;
  }
  if (expected === 'array' && field.items !== null && typeof field.items === 'object') {
    for (let i = 0; i < value.length; i += 1) checkValue(field.items, value[i], path + '[' + i + ']', problems);
    return;
  }
  if (expected === 'object' && Array.isArray(field.fields)) {
    for (let i = 0; i < field.fields.length; i += 1) {
      const nested = field.fields[i];
      if (value[nested.name] === undefined) {
        if (nested.required === true) problems.push({ path: path + '.' + nested.name, message: 'required' });
        continue;
      }
      checkValue(nested, value[nested.name], path + '.' + nested.name, problems);
    }
  }
}

/**
 * Validate a call against the registry record, BEFORE any HTTP request. A refusal is a
 * CONFIG_ERROR naming the field path. Returns { ok, code, message, problems }.
 *
 * Scope, stated rather than implied: unknown keys are refused at the TOP level only (the
 * generator's nested object fields are open record shapes the vendor accepts extra keys in, and
 * refusing them would be stricter than the typed path this must mirror); declared nested fields
 * are still type- and enum-checked.
 */
export function validateInvokeInput(record, input) {
  const gaps = auditSchemaVocabulary(record.inputSchema);
  if (gaps.length) {
    return { ok: false, code: 'CONFIG_ERROR', problems: [], message: 'hudu_invoke: the registry record for ' + record.name + ' uses a schema shape this validator does not know (' + gaps.join('; ') + '). Refusing rather than validating nothing.' };
  }
  const fields = inputFields(record.inputSchema);
  const known = {};
  for (let i = 0; i < fields.length; i += 1) known[fields[i].name] = fields[i];
  const value = input === undefined || input === null ? {} : input;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'CONFIG_ERROR', problems: [], message: 'hudu_invoke: input must be an object of the operation\\'s arguments (got ' + typeNameOf(value) + ').' };
  }
  const problems = [];
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (k === 'dry_run') continue;
    if (known[k] === undefined) problems.push({ path: k, message: 'unknown field (valid fields: ' + (fields.map((f) => f.name).join(', ') || 'none') + ')' });
  }
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (value[f.name] === undefined) {
      if (f.required === true) problems.push({ path: f.name, message: 'required' });
      continue;
    }
    checkValue(f, value[f.name], f.name, problems);
  }
  if (problems.length) {
    const parts = problems.map((p) => p.path + ': ' + p.message);
    return { ok: false, code: 'CONFIG_ERROR', problems, message: 'hudu_invoke: invalid input for ' + record.name + ' — ' + parts.join('; ') + '. No request was issued.' };
  }
  return { ok: true, code: null, problems: [], message: 'ok' };
}

/**
 * The write governor. Not a security boundary (a determined caller can pass dry_run): it stops an
 * accidental write. Writes are dry-run-first and destructive/approval-gated operations need
 * \`confirm\` to equal the operation key exactly.
 */
export function governInvoke(record, options) {
  const o = options || {};
  const row = catalogRow(record.name);
  if (row !== null && row.reachable !== true) {
    return { ok: false, code: 'CONFIG_ERROR', message: 'hudu_invoke: ' + record.name + ' is deliberately not callable here — ' + row.reason + (row.alternative ? ' Bounded alternative: ' + row.alternative + '.' : '') };
  }
  if (record.effect === 'read') return { ok: true, dry_run: false, message: 'read — runs directly' };
  if (o.dry_run !== true) {
    return { ok: false, code: 'CONFIG_ERROR', message: 'hudu_invoke: ' + record.name + ' is a ' + record.effect + ' operation; writes are dry-run-first. Call it again with dry_run: true to see the impact and the diff with no request issued, then repeat with the same dry_run: true to run it (the SDK dry-run path is the same call path).' };
  }
  if (record.effect === 'destructive' || (record.flags || []).indexOf('requiresApproval') !== -1) {
    if (o.confirm !== record.name) {
      return { ok: false, code: 'CONFIG_ERROR', message: 'hudu_invoke: ' + record.name + ' is destructive or approval-gated; pass confirm: "' + record.name + '" to acknowledge it. Refusing without it.' };
    }
  }
  return { ok: true, dry_run: true, message: 'dry-run only — nothing is written' };
}

`;
const exposures = [...exposedByOp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const lines = [];
lines.push('// MACHINE-GENERATED by scripts/build-tool-catalog.mjs — DO NOT HAND-EDIT.');
lines.push('// Regenerate with: node scripts/build-tool-catalog.mjs');
lines.push(`// Source of truth: capabilities.json (planHash ${registry.planHash}) + MCP_TOOL_OVERRIDES.json,`);
lines.push('// projected by scripts/project-mcp-tools.mjs. `npm run capabilities:check` fails on a stale copy.');
lines.push('//');
lines.push(`// ${catalog.length} operations, ${exposures.length} exposed as their own tool, ${catalog.filter((r) => r.reachable === true && r.tool === null).length} reachable only through hudu_invoke,`);
lines.push(`// ${refusals.length} deliberately refused (unbounded read / binary). CORE = ${CORE_TOOL_NAMES.length} tools + 3 META.`);
lines.push('');
lines.push(`export const CATALOG_PLAN_HASH = '${registry.planHash}';`);
lines.push('');
lines.push(`export const CORE_RULE = ${JSON.stringify(CORE_RULE)};`);
lines.push('');
lines.push(`export const WORKFLOW_RESOURCES = ${JSON.stringify(WORKFLOW_RESOURCES)};`);
lines.push('');
lines.push('/** The CORE profile: always-present tools, generated from the rule above. */');
lines.push(`export const CORE_TOOLS = ${JSON.stringify(CORE_TOOL_NAMES, null, 2)};`);
lines.push('');
lines.push('/** The three META tools. Their descriptions are owned by the projection (scripts/project-mcp-tools.mjs). */');
lines.push(`export const META_TOOLS = ${JSON.stringify(META_TOOLS, null, 2)};`);
lines.push('');
lines.push('/** operation -> the tool that exposes it (an operation absent here has no tool of its own). */');
lines.push('export const EXPOSED = {');
for (const [op, tool] of exposures) lines.push(`  ${JSON.stringify(op)}: ${JSON.stringify(tool)},`);
lines.push('};');
lines.push('');
lines.push('/** operation -> why hudu_invoke refuses it (the projection rule, preserved through the escape hatch). */');
lines.push('export const REFUSALS = {');
for (const r of refusals) lines.push(`  ${JSON.stringify(r.op)}: ${JSON.stringify({ reachable: false, reason: r.reason, alternative: r.alternative })},`);
lines.push('};');
lines.push('');
lines.push('/** One row per registry operation. `requires` = the required top-level argument names. */');
lines.push('export const CATALOG = [');
for (const row of catalog) lines.push(`  ${JSON.stringify(row)},`);
lines.push('];');
lines.push('');
lines.push(runtime.trim());
lines.push('');

const output = lines.join('\n');
if (violations.length) {
  console.error(`build-tool-catalog — REACHABILITY VIOLATIONS (${violations.length}):`);
  for (const v of violations) console.error(`  x ${v}`);
  process.exit(1);
}
if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : null;
  if (current === null) {
    console.error(`build-tool-catalog --check — FAILED: ${path.relative(ROOT, OUT)} is missing — run \`node scripts/build-tool-catalog.mjs\``);
    process.exit(1);
  }
  if (current !== output) {
    console.error(`build-tool-catalog --check — FAILED: ${path.relative(ROOT, OUT)} is stale — run \`node scripts/build-tool-catalog.mjs\``);
    process.exit(1);
  }
  console.log(`build-tool-catalog --check — PASS: ${path.relative(ROOT, OUT)} is current; ${catalog.length} catalog row(s), ${exposures.length} exposed, ${catalog.filter((r) => r.reachable === true && r.tool === null).length} reachable via hudu_invoke only, ${refusals.length} refused with a reason`);
  process.exit(0);
}
writeFileSync(OUT, output);
console.log(`build-tool-catalog — operations=${catalog.length}; exposed as a tool=${exposures.length}; reachable via hudu_invoke only=${catalog.filter((r) => r.reachable === true && r.tool === null).length}; refused with a reason=${refusals.length}`);
console.log(`build-tool-catalog — CORE=${CORE_TOOL_NAMES.length} tools (${CORE_TOOL_NAMES.join(', ')})`);
if (coreProfile.gaps.discoveryOperationsMissing.length) console.log(`build-tool-catalog — CORE gap: R3 ${coreProfile.gaps.discoveryOperationsMissing.join(', ')} is not in the projection yet (a later build step adds it); CORE grows by rule when it lands`);
console.log(`build-tool-catalog — wrote ${path.relative(ROOT, OUT)}`);

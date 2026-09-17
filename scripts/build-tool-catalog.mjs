// scripts/build-tool-catalog.mjs
//
// `node scripts/build-tool-catalog.mjs [--out <path>] [--check]`
//
// Builds the progressive-disclosure artifacts from the capability registry, and writes them as a
// generated consumer-layer module (`src/mcp/catalog.generated.ts`, default — compiled by tsup and
// published as the `node-hudu/mcp` subpath, re-exported through `src/mcp/index.ts`):
//
//   - the CATALOG: one row per registry operation (all of them, never a subset), with the tool
//     that exposes it when there is one, its effect, the arguments it requires, whether it is
//     dry-run-first, and — for an operation the projection deliberately never exposes —
//     `reachable: false` plus the reason and the bounded alternative. This is what closes the
//     reachability hole: an operation with no tool must be DISCOVERABLE, not indistinguishable
//     from an operation that does not exist.
//   - the CORE profile (rule implemented in `scripts/project-mcp-tools.mjs`, never listed by hand)
//     and the three META tools whose descriptions the projection owns.
//   - the runtime DATA helpers a host needs (catalog paging, catalog lookup, describe, and the
//     schema reader the describe needs). They import NOTHING: the SDK stays MCP-independent, and
//     the host passes the registry record (`getCapability(op)`).
//     This module deliberately carries NO validator and NO write governor. Validation and
//     governance live in exactly ONE place — the SDK's `operations.invoke` / `planInvoke`
//     (`src/operations/invoke.ts`), which the reference server calls, and which
//     `test/operations/invoke.test.ts` walks over every registry record (the G4 shape test). A
//     second implementation here is a second chance to be wrong, and it would not be covered.
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
// The default lives in src/ on purpose: tsup compiles it, so `node-hudu/mcp` ships the catalog as
// compiled JS + .d.ts. Emitting it under examples/ published it as raw TypeScript, which a compiled
// consumer could not import. `--out` still overrides, but the emitted `import type` is relative to
// src/mcp/, so an out-of-tree path needs its own re-export.
const OUT = path.resolve(ROOT, argValue('--out', 'src/mcp/catalog.generated.ts'));
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
// code (an MCP server needs it, the SDK must not) and every function takes the registry record it
// needs as an argument, so a host passes \`getCapability(op)\` from \`node-hudu/capabilities\` and
// nothing here can drift from the registry it is used with. The module's ONLY import is the
// type-only one at the top: \`verbatimModuleSyntax\` erases it, so the emitted JS still imports
// nothing and the SDK stays MCP-independent in both directions.
// ---------------------------------------------------------------------------------------------

/** Bounded catalog page: default 40 rows, hard cap 100. */
export const DEFAULT_CATALOG_LIMIT = 40;
export const MAX_CATALOG_LIMIT = 100;

/** The filters \`catalogPage\` honours. All optional, all ANDed. */
export interface CatalogPageOptions {
  limit?: number;
  offset?: number;
  effect?: string;
  resource?: string;
  unexposed_only?: boolean;
}

/** Config refusal, same code the SDK uses for a caller-side configuration error. */
export function configError(message: string): Error {
  const err = new Error(message);
  err.name = 'ConfigError';
  return err;
}

/** One catalog row by canonical operation key, or null. */
export function catalogRow(operation: string): CatalogRow | null {
  for (const row of CATALOG) if (row.op === operation) return row;
  return null;
}

/** The nearest catalog keys to an unknown one (exact-key lookup, but a useful refusal). */
export function nearestKeys(operation: string, limit?: number): string[] {
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
export function catalogPage(options?: CatalogPageOptions) {
  const o: CatalogPageOptions = options || {};
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
export function requireCatalogRow(operation: string): CatalogRow {
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
export function describeOperation(record: CapabilityRecord) {
  const row = requireCatalogRow(record.name);
  const fields = inputFields(record.inputSchema);
  const required: string[] = [];
  for (const field of fields) if (field.required === true) required.push(field.name);
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

// ---- the registry schema reader --------------------------------------------------------------
// \`inputSchema\` is NOT JSON Schema: it is the generator's own vocabulary. This module reads it
// (top-level fields, for \`describeOperation\`'s \`requires\`); it does NOT validate a call against
// it. Validation is the SDK's (\`src/operations/invoke.ts\`), one implementation, G4-tested over
// every registry record — see the header.

export function inputFields(inputSchema: unknown): CapabilityField[] {
  if (inputSchema === null || inputSchema === undefined) return [];
  if (Array.isArray(inputSchema)) return inputSchema as CapabilityField[];
  const schema = inputSchema as Record<string, unknown>;
  const fields = schema.fields;
  if (Array.isArray(fields)) return fields as CapabilityField[];
  const out: CapabilityField[] = [];
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' || k === 'fields' || k === 'name') continue;
    if (v !== null && typeof v === 'object') out.push(v as CapabilityField);
  }
  return out;
}

`;
// ---------------------------------------------------------------- the one search tool (contract)
const planPath = path.resolve(ROOT, argValue('--plan', 'capabilities.plan.json'));
const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : { resources: {}, operations: [] };
const planRows = Array.isArray(plan.operations) ? plan.operations : [];
const resourceOfRow = (row) => {
  const key = row.primitive || row.endpoint || '';
  if (row.primitive) return String(row.primitive).split('.')[0];
  const m = /^GET\/([a-z_]+)$/.exec(String(row.endpoint).replace(/\s+/g, ''));
  return m ? m[1] : null;
};
const searchTool = projectedTools.find((t) => t.backingOperation === 'operations.searchKnowledge') || null;
const searchRow = planRows.find((r) => r.helper === 'operations.searchKnowledge') || null;
const searchModes = Object.entries((searchRow && searchRow.metadata && searchRow.metadata.modes) || {})
  .map(([mode, m]) => ({ mode, shape: m.shape, fields: m.fields, requires: m.requires, rejects: m.rejects, vendorRequest: m.vendorRequest === true, summary: m.summary }));
if (!searchTool) violations.push('operations.searchKnowledge is not exposed as a tool: mode="help" and mode="resources" would have no entry point');
if (!searchModes.length) violations.push('operations.searchKnowledge declares no metadata.modes: the mode table (and the mode-honours-fields gate) has nothing to read');
const searchableRows = planRows.filter((r) => r.search === 'search');
const searchResources = {
  derivedFrom: path.basename(planPath) + ' -> operations[] rows declaring `search: "search"`; text coverage from resources[].searchCovers',
  count: searchableRows.length,
  searchable: searchableRows.map((r) => {
    const resource = resourceOfRow(r);
    const covers = (plan.resources && plan.resources[resource] && plan.resources[resource].searchCovers) || null;
    if (!covers) violations.push(`${resource}: declares a search vendor filter but the plan records no searchCovers text for it (mode="resources" would have to invent one)`);
    return {
      resource,
      textFilter: covers,
      otherFilters: (r.vendorFilters || []).filter((f) => f !== 'search').sort(),
      redaction: r.redaction === 'credentials' ? 'credentials' : 'none',
      snippetAllowed: r.redaction !== 'credentials',
    };
  }).sort((a, b) => (a.resource < b.resource ? -1 : 1)),
  notSearchable: Object.keys(plan.resources || {})
    .filter((r) => !searchableRows.some((row) => resourceOfRow(row) === r))
    .sort()
    .map((resource) => ({ resource, reason: 'declares no search vendor filter: ?search= is SILENTLY IGNORED and an unfiltered page comes back. Never read those rows as matches.' })),
};
const advertisedFields = searchTool
  ? Object.values(searchTool.inputSchema || {}).filter((f) => f && typeof f === 'object' && typeof f.name === 'string')
  : [];
const searchFieldLines = advertisedFields
  .filter((f) => (searchModes.find((m) => m.mode === 'search') || { fields: [] }).fields.indexOf(f.name) !== -1)
  .map((f) => `  ${f.name.padEnd(15)} ${f.description || '(no description in the curated schema — a gate failure)'}`);
const modeLines = searchModes.map((m) => `  mode="${m.mode}"${m.mode === 'search' ? ' (default)' : ''} ${m.summary}\n`
  + `      honours : ${m.fields.join(', ')}\n`
  + `      refuses : ${(m.rejects || []).join(', ') || '(nothing)'} (a CONFIG_ERROR naming the honoured fields, never a silent ignore)\n`
  + `      returns : {mode:"${m.mode}", ${m.shape}}${m.vendorRequest ? ' - issues vendor requests' : ' - no vendor request, no index build, no state change'}`);
const helpSections = {
  modes: 'MODES\n' + modeLines.join('\n'),
  limits: 'LIMITS AND DEFAULTS (a bound is REFUSED, never silently clamped)\n' + searchFieldLines.join('\n'),
  degradation: [
    'DEGRADATION, AND WHAT AN EMPTY ANSWER MEANS',
    '  meta.complete   false when ANY bound bit (result limit, response bytes, candidate cap, fetch budget,',
    '                  body truncation) or when the body index could not be used. meta.reasons names every bound',
    '                  that bit; meta.truncation carries the detail. A truncated answer is never reported as complete.',
    '  meta.degraded   null when article BODIES were searched. Otherwise {reason, advice}:',
    '                  reason "body-not-indexed"  bodies exist but are not indexed (indexArticles:false, or every',
    '                                             body exceeded maxDocBytes), or the index could not be built.',
    '                  reason "vendor-only"       no index was used, so titles, names, custom-field values and',
    '                                             identifiers were searched and article bodies were NOT.',
    '  THE RULE        hits=[] with complete=true and degraded=null is the ONLY complete "nothing matched" answer.',
    '                  In every other case the answer is partial or body-blind, and reporting "not documented" from',
    '                  it is a wrong answer. This TOOL defaults to tier "index" (build or await the body index), so a',
    '                  cold, body-blind answer is not the default it hands an agent - and when it happens it says so.',
    '  Per-resource failure is isolated: the resource appears in meta.errors and the other hits survive.',
  ].join('\n'),
  results: [
    'RESULTS',
    '  Hit: {resource,id,title,score,relevance,scoreScope,match:{fields,terms,coverage,fuzzy},snippet:{text,spans,truncated},fetch,url}.',
    '  match.fields says WHY it matched (title|slug|body|custom_field|ident); a fuzzy match is weaker evidence',
    '  than an exact one, so say so when you report it. snippet.text is a verbatim slice of the record\'s',
    '  HTML-stripped text, never a summary; it is DERIVED text, so its spans do not index the raw content - fetch',
    '  the record for that. Full bodies are never returned: use the hit\'s fetch call (hudu_get_article / hudu_get_asset).',
    '  meta.tokens_unmatched lists query terms that matched nothing: drop them and re-query rather than reporting failure.',
  ].join('\n'),
  followup: [
    'FOLLOW-UP PATTERN',
    '  1. hudu_search({query:"vpn tunnel down"})               -> ranked hits with snippets',
    '  2. the hit\'s fetch call, e.g. hudu_get_article({id:28}) -> the full body (the only way to spend context on it)',
    '  Identity lookup by exact key (serial, slug, domain, email) is hudu_find_* / hudu_get_*; paging and',
    '  enumeration are the resource\'s hudu_list_* tools. This tool ranks; it does not list and it does not write.',
    '  asset_passwords / password_folders hits are redacted with snippets suppressed (meta.redaction:"credentials").',
  ].join('\n'),
  query: [
    'QUERY SYNTAX',
    '  Free text: terms match independently (order does not matter), fuzzily within a bounded edit distance, and',
    '  partial words match by prefix. exact_only:true disables fuzziness (vendor-style exact substring) while',
    '  keeping ranking and snippets. min_score drops weak hits and reports how many it dropped, so a threshold',
    '  never looks like absence. Prefer 2-4 meaning-bearing words over a sentence, and a serial or a field VALUE',
    '  over the label of that field.',
  ].join('\n'),
  scoring: [
    'SCORE BANDS',
    '  90-100  exact title or identifier hit (or every term exact in a strong field)',
    '  70-89   every query term matched, not all in the strongest field',
    '  50-69   partial coverage (some terms matched)',
    '  <50     fuzzy-only evidence - report it as such',
    '  scoreScope:"per-resource" means do not compare scores across resources; "cross-resource" means you may.',
    '  Ties break on updated_at desc, then (resource,id) ascending. relevance (1.0 = best in THIS response) is',
    '  the number to show a human.',
  ].join('\n'),
};
const searchHelp = {
  sections: Object.keys(helpSections),
  default: 'core',
  core: ['modes', 'limits', 'degradation', 'results', 'followup'],
  all: ['modes', 'limits', 'degradation', 'results', 'followup', 'query', 'scoring'],
  text: helpSections,
};
const exposures = [...exposedByOp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
const lines = [];
lines.push('// MACHINE-GENERATED by scripts/build-tool-catalog.mjs — DO NOT HAND-EDIT.');
lines.push('// Regenerate with: node scripts/build-tool-catalog.mjs');
lines.push(`// Source of truth: capabilities.json (planHash ${registry.planHash}) + MCP_TOOL_OVERRIDES.json,`);
lines.push('// projected by scripts/project-mcp-tools.mjs. `npm run capabilities:check` fails on a stale copy.');
lines.push('//');
lines.push(`// ${catalog.length} operations, ${exposures.length} exposed as their own tool, ${catalog.filter((r) => r.reachable === true && r.tool === null).length} reachable only through hudu_invoke,`);
lines.push(`// ${refusals.length} deliberately refused (unbounded read / binary). CORE = ${CORE_TOOL_NAMES.length} tools + 3 META.`);
lines.push('//');
lines.push('// This module lives in src/ so tsup compiles it and `node-hudu/mcp` ships it to a consumer that');
lines.push('// only has the tarball. It is re-exported by src/mcp/index.ts and must never be hand-edited.');
lines.push('');
// The one import, and it is type-only: `verbatimModuleSyntax` erases it, so the emitted JS still
// imports nothing at runtime. The alternative — re-declaring the registry record shape here —
// would be a second definition free to drift from the registry this module is used with.
lines.push("import type { CapabilityField, CapabilityRecord } from '../capabilities.js';");
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
// ---------------------------------------------------------------- the one search tool
// `hudu_search` has three modes, and the meta modes must answer from GENERATED data or they drift
// from what the tool can actually do: the mode table comes from the plan row's `metadata.modes`,
// the resources table from the plan rows that declare a search vendor filter, and the help text
// from the curated schema plus those two. Nothing below is re-typed prose about a bound.
lines.push('/** Curated descriptions of the CORE tools, so a consumer never re-types (or drifts from) them. */');
lines.push('export const TOOL_DESCRIPTIONS = {');
for (const name of CORE_TOOL_NAMES) {
  const t = projectedTools.find((x) => x.name === name);
  if (t) lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(t.description)},`);
}
lines.push('};');
lines.push('');
lines.push('/**');
lines.push(' * mode -> the fields it honours, the fields it REFUSES (a CONFIG_ERROR, never a silent ignore),');
lines.push(' * the shape it returns and whether it touches the vendor. Source: capabilities.plan.json ->');
lines.push(' * operations[operations.searchKnowledge].metadata.modes, cross-checked against the curated schema');
lines.push(' * by the `mode-honours-fields` gate.');
lines.push(' */');
lines.push(`export const SEARCH_MODES = ${JSON.stringify(searchModes, null, 2)};`);
lines.push('');
lines.push('/**');
lines.push(' * The EXACT searchable-resource set, derived from capabilities.plan.json: a resource is searchable');
lines.push(' * only when its list row declares a `search` vendor filter. Every other resource IGNORES ?search=');
lines.push(' * and returns an unfiltered page, so advertising it would make the tool promise a search it cannot');
lines.push(' * perform. Gated by `searchable-resource-parity`.');
lines.push(' */');
lines.push(`export const SEARCH_RESOURCES = ${JSON.stringify(searchResources, null, 2)};`);
lines.push('');
lines.push('/**');
lines.push(' * mode="help" sections. GENERATED: the mode list, the field/limit list and the resource table are');
lines.push(' * built from the projection + the plan, so help cannot advertise a field or a bound the tool does');
lines.push(' * not have (gated by `help-mode-documents-resources`).');
lines.push(' */');
lines.push(`export const SEARCH_HELP = ${JSON.stringify(searchHelp, null, 2)};`);
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
lines.push('/**');
lines.push(' * One row per registry operation. `reason` is present on every row without a tool of its own');
lines.push(' * (curated out as a duplicate outcome, or refused by rule); `alternative` names the bounded tool');
lines.push(' * a refused row points at, when the registry has one. Annotated rather than inferred so the');
lines.push(' * emitted .d.ts is one named type instead of a 227-member union of object literals.');
lines.push(' */');
lines.push('export interface CatalogRow {');
lines.push('  op: string;');
lines.push('  tool: string | null;');
lines.push('  summary: string | null;');
lines.push('  when: string | null;');
lines.push('  effect: string | null;');
lines.push('  requires: string[];');
lines.push('  dry_run: boolean;');
lines.push('  confirm_required: boolean;');
lines.push('  reachable: boolean;');
lines.push('  reason?: string;');
lines.push('  alternative?: string;');
lines.push('}');
lines.push('');
lines.push('/** One row per registry operation. `requires` = the required top-level argument names. */');
lines.push('export const CATALOG: CatalogRow[] = [');
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

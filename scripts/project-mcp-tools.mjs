// scripts/project-mcp-tools.mjs
//
// `npm run mcp:project`
//
// Mechanical projection of the capability registry (capabilities.json at the repo root) into
// MCP_TOOL_MANIFEST.md at the repo root. It is a PROJECTION, not curation:
//   - tool name          = `hudu_` + operation name (mechanical; the Toolsmith renames via overrides)
//   - description        = the registry `purpose`, verbatim. This script NEVER re-derives or
//                          invents a description; a missing purpose is printed as missing.
//   - backingOperation   = the registry operation name
//   - inputSchema/outputSchema = the registry schemas (mutating tools gain the dry_run affordance)
//   - annotations        = derived from `effect` + `flags` only
//
// Policy: agent-execution-layer.md §4.2 ("MCP projection is script-generated; curation is LLM",
// override discipline) and §7 (MCP tool rules). Rules applied:
//   1. Read tools must be backed by the helper tier (search / findBy* / resolve / getContext).
//      Helper records do not exist until the coordinator's helper rows reach implemented/tested,
//      so this script projects what the registry has and PRINTS every read tool still missing a
//      helper-tier backing — that is the gap the coordinator must close.
//   2. `listAll` / `listPages` are NEVER projected (unbounded reads are not tools). `list` is
//      projected with its explicit bounds.
//   3. Every list-shaped tool states its bound (page size default/max, page cap, scan cap).
//   4. Every mutating tool exposes a `dry_run` affordance and states its impact metadata.
//   5. `sensitive` / `requiresApproval` flags are stated on the tool, not hidden.
//   6. No binary/download tool is projected (resource in the binary set below, or specialOp
//      "download").
//   7. MCP_TOOL_OVERRIDES.json (repo root, [{tool, field, newValue, reason}]) is applied to the
//      projection when present. An override that names an unknown tool or field is reported and
//      exits non-zero — silent divergence is a defect.
//   8. An override record with field "exclude" and newValue true DROPS the tool from the projection
//      (curation, not a rule): a tools/list where two tools do the same job is worse than a shorter
//      one, so curation keeps exactly one tool per distinct outcome. Dropped tools are still
//      reported — the manifest lists them under "Excluded by curation" with the override's reason.
//
// Flags: --registry <path> (default capabilities.json)  --out <path> (default MCP_TOOL_MANIFEST.md)
//        --check-example [--example <path>] (default examples/mcp-server.ts) — fail when the example
//        drifts from the curated projection: an unknown tool name, an unbounded read, a mutating
//        tool with no dry-run affordance, or a description that is not the curated one.
// Exit codes: 0 ok, 1 registry missing/unreadable or an unresolved override.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Importable: `scripts/build-tool-catalog.mjs` and the capability gates import this module for the
// projection itself, so the projection is computed once, in one place. Everything above the
// `IS_MAIN` guard is pure computation (read the registry, build the tools, apply curation);
// everything inside it writes a file or exits the process.
const IS_MAIN = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => { const i = argv.indexOf(flag); return i === -1 ? fallback : argv[i + 1]; };
const REGISTRY = path.resolve(ROOT, argValue('--registry', 'capabilities.json'));
const OUT = path.resolve(ROOT, argValue('--out', 'MCP_TOOL_MANIFEST.md'));
const OVERRIDES_PATH = path.resolve(ROOT, 'MCP_TOOL_OVERRIDES.json');
// --check-example: verification mode. Recomputed projection, no manifest write, exit non-zero when
// an advertised tool would fail at runtime (an example or a schema field the SDK rejects).
const CHECK_EXAMPLE = argv.includes('--check-example');
const TOOL_PREFIX = 'hudu_';

// Mechanical exclusion sets (documented, not curated):
const NEVER_METHODS = new Set(['listAll', 'listPages']);            // unbounded reads
const BINARY_RESOURCES = new Set(['photos', 'public_photos', 'uploads', 'exports', 's3_exports']); // binary / download surfaces
const HELPER_TIER_METHODS = /^(resolve|findBy[A-Za-z0-9_]*|search|getContext)$/;
// Registry records identify themselves; the regex is a fallback only.
const isHelperRecord = (rec) => rec.kind === 'helper' || (rec.kind === undefined && HELPER_TIER_METHODS.test(methodOf(rec.name)));
const LIST_METHODS = new Set(['list']);

if (!existsSync(REGISTRY)) {
  console.error(`mcp:project: registry not found at ${REGISTRY} — run \`npm run capabilities:build\` first.`);
  process.exit(1);
}
let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (err) {
  console.error(`mcp:project: registry is not valid JSON: ${err.message}`);
  process.exit(1);
}
const records = Array.isArray(registry.operations) ? registry.operations : [];
const methodOf = (name) => name.split('.').slice(1).join('.');
const resourceOf = (name) => name.split('.')[0];

const excluded = [];
const tools = [];
for (const rec of records) {
  const method = methodOf(rec.name);
  if (NEVER_METHODS.has(method)) { excluded.push({ name: rec.name, why: 'unbounded read (listAll/listPages) — never an MCP tool' }); continue; }
  if (BINARY_RESOURCES.has(rec.resource)) { excluded.push({ name: rec.name, why: `binary/download surface (resource "${rec.resource}") — never an MCP tool` }); continue; }
  const annotations = {
    effect: rec.effect,
    readOnlyHint: rec.effect === 'read',
    destructiveHint: rec.effect === 'destructive',
    idempotentHint: (rec.flags ?? []).includes('idempotent'),
    openWorldHint: true,
    sensitive: (rec.flags ?? []).includes('sensitive'),
    requiresApproval: (rec.flags ?? []).includes('requiresApproval'),
    dryRunAffordance: rec.effect !== 'read' ? 'dry_run' : null,
    // The registry answers this exactly: `kind` is authored by the generator (helper vs primitive).
    // The method-name regex is only a fallback for a record that carries no kind, so a composite
    // helper (`procedures.getWithTasks`) or a cross-resource one (`operations.resolveAny`) is not
    // mislabelled by its name shape.
    tier: (rec.kind === 'helper' || (rec.kind === undefined && HELPER_TIER_METHODS.test(method)))
      ? 'helper'
      : rec.effect === 'read' ? 'primitive-read' : 'primitive-write',
  };
  if (rec.resolution && rec.resolution.maxScanRecords) {
    annotations.bounded = `client scan capped at ${rec.resolution.maxScanRecords} records / ${rec.resolution.maxScanPages} pages`;
  } else if (LIST_METHODS.has(method)) {
    const p = rec.pagination ?? {};
    annotations.bounded = `page/page_size, default ${p.defaultPageSize ?? '?'}${p.nonPaginated ? ', endpoint is non-paginated (single page response)' : `, mode ${p.mode}`}`;
  } else if (rec.compact) {
    annotations.bounded = `compact shape ${rec.compact}`;
  }
  if (annotations.sensitive) annotations.sensitiveNotice = 'returns credential-shaped fields; SDK logs/audit payloads redact them by default';
  const HELPER_TIER_OK = annotations.tier === 'helper';
  const IS_READ = rec.effect === 'read';
  if (!HELPER_TIER_OK && IS_READ) {
    // Read tools must be backed by the helper tier; while curation is still open, name the
    // registry's helper-tier alternatives for the same resource so the worklist is precise.
    const alternatives = records
      .filter((h) => h.resource === rec.resource && isHelperRecord(h))
      .map((h) => h.name);
    annotations.helperTierAlternatives = alternatives;
    annotations.helperTierBacked = false;
  } else if (HELPER_TIER_OK) {
    annotations.helperTierBacked = true;
    annotations.helperTierBacking = rec.name;
  }
  // A mutation is neither helper-backed nor a primitive READ: the `helperTier*` keys are read-tier
  // vocabulary, so a mutation carries only `tier` (its effect/flags already say what it is).
  const inputSchema = { ...(rec.inputSchema ?? {}) };
  if (rec.effect !== 'read') {
    inputSchema.dry_run = { type: 'boolean', required: false, description: 'Validate without issuing the write. Returns DryRunResult with simulated: true.' };
  }
  tools.push({
    name: `${TOOL_PREFIX}${rec.name.split('.').join('_')}`,
    backingOperation: rec.name,
    description: rec.purpose === null || rec.purpose === undefined ? '<MISSING: no purpose recorded in the plan — Toolsmith curation owed>' : rec.purpose,
    inputSchema,
    outputSchema: rec.outputSchema ?? {},
    annotations,
    effect: rec.effect,
    // The advertised call: the registry's first example, verbatim (never re-derived here).
    example: Array.isArray(rec.examples) && rec.examples.length ? rec.examples[0] : null,
    registryKind: rec.kind ?? null,
    flags: rec.flags ?? [],
    permissions: rec.permissions,
    dryRun: rec.dryRun,
    compact: rec.compact,
    errors: rec.errors ?? [],
  });
}
tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// ---------------------------------------------------------------- overrides
const overrideLog = [];
const unresolvedOverrides = [];
// Tools dropped by a curation `exclude` override (reported in the manifest, never silently gone).
const curationExcluded = [];
if (existsSync(OVERRIDES_PATH)) {
  let overrides;
  try {
    overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch (err) {
    console.error(`mcp:project: MCP_TOOL_OVERRIDES.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(overrides)) {
    console.error('mcp:project: MCP_TOOL_OVERRIDES.json must be an array of {tool, field, newValue, reason}');
    process.exit(1);
  }
  for (const ov of overrides) {
    if (!ov || !ov.tool || !ov.field) { unresolvedOverrides.push({ ov, why: 'override needs {tool, field, newValue, reason}' }); continue; }
    const tool = tools.find((t) => t.name === ov.tool);
    if (!tool) { unresolvedOverrides.push({ ov, why: `no projected tool named "${ov.tool}"` }); continue; }
    const parts = String(ov.field).split('.');
    let target = tool;
    let ok = true;
    for (const key of parts.slice(0, -1)) {
      if (target[key] === undefined || typeof target[key] !== 'object') { ok = false; break; }
      target = target[key];
    }
    if (ov.field === 'exclude') {
      // Curation, not a rule: drop the tool from the projection. Kept one-per-outcome so no two
      // tools in the curated list do the same job; the drop is reported, never silent.
      if (ov.newValue !== true) { unresolvedOverrides.push({ ov, why: 'exclude expects newValue: true' }); continue; }
      curationExcluded.push({
        name: tool.name,
        backingOperation: tool.backingOperation,
        effect: tool.effect,
        tier: tool.annotations.tier,
        reason: ov.reason ?? '',
      });
      tools.splice(tools.indexOf(tool), 1);
      overrideLog.push(ov);
      continue;
    }
    if (!ok) { unresolvedOverrides.push({ ov, why: `field path "${ov.field}" does not exist on ${ov.tool}` }); continue; }
    if (parts[0] === 'name' && parts.length === 1) {
      tool.name = ov.newValue;
    } else {
      target[parts[parts.length - 1]] = ov.newValue;
    }
    overrideLog.push(ov);
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------- gaps the coordinator must close
const helperBackedResources = new Set(tools.filter((t) => t.annotations.tier === 'helper').map((t) => resourceOf(t.backingOperation)));
const primitiveBackedReadTools = tools.filter((t) => t.annotations.tier !== 'helper' && t.effect === 'read');
const readToolsMissingHelperBacking = primitiveBackedReadTools
  .filter((t) => !helperBackedResources.has(resourceOf(t.backingOperation)))
  .map((t) => `${t.name} (${t.backingOperation})`);
const primitiveReadWithHelperAlternative = primitiveBackedReadTools
  .filter((t) => helperBackedResources.has(resourceOf(t.backingOperation)))
  .map((t) => `${t.name} (${t.backingOperation}) → helper-tier alternatives: ${(t.annotations.helperTierAlternatives ?? []).join(', ')}`);
const helperTierTools = tools.filter((t) => t.annotations.tier === 'helper');
const missingPurpose = tools.filter((t) => String(t.description).startsWith('<MISSING')).map((t) => t.name);


// ---------------------------------------------------------------- CORE profile (progressive disclosure)
// Progressive-disclosure design, section 3, build order step 4. The rule is IMPLEMENTED
// here, not described elsewhere: this block is what "core" means, and `npm run capabilities:check`
// re-reads the generated artifacts against it. Selection is mechanical (no hand-picked list), so
// adding a workflow resource to the plan changes the core set without anyone editing a list.
const CORE_RULE =
  'CORE = every tool an agent needs to (R1) discover any capability, (R2) identify itself to the ' +
  'tenant, (R3) find a record it cannot name, and (R4) read one record of each workflow resource. ' +
  'A write is NOT in core: writes are reachable through `hudu_invoke`, which forces a dry run first ' +
  'and refuses a destructive operation without its confirmation flag. The workflow resources are the ' +
  'repo\'s own authored group A (scripts/derive-plan.mjs GROUPS.A), so the rule inherits an existing, ' +
  'versioned definition instead of a new opinion.';

/** Group A — "the workflow resources" (scripts/derive-plan.mjs GROUPS.A), one read entry each. */
const WORKFLOW_RESOURCES = ['companies', 'articles', 'assets', 'asset_layouts', 'asset_passwords', 'websites', 'folders', 'password_folders', 'groups'];

/** R2: identify the tenant/key the client is talking to. */
const CORE_TENANT_OPS = ['api_info.resolve'];

/** R3: find a record the caller cannot name (cross-resource helpers). */
// R3 = "find a record the caller cannot name". `operations.searchAcrossResources` is NOT here:
// `hudu_search` supersedes it as the cross-resource entry point, and the projection retires that
// tool (`MCP_TOOL_OVERRIDES.json`), while the SDK operation stays callable and `hudu_invoke`-reachable
// (single-search-tool design, section 4.1).
const CORE_DISCOVERY_OPS = ['operations.resolveAny', 'operations.searchKnowledge'];

/**
 * R1: the three META tools. Their names, titles and descriptions are owned HERE (the projection is
 * the only place a description may change — the same discipline `MCP_TOOL_OVERRIDES.json` has for
 * the curated tools), so `--check-example` can hold the reference server to them verbatim.
 */
const META_TOOLS = [
  {
    name: 'hudu_catalog',
    title: 'Discover Operations (Catalog)',
    description:
      'List the operations the Hudu SDK implements, with the tool that exposes each one (when it has one), its effect, whether it needs a dry run or a confirmation flag, and the arguments it requires. The tool list on this server is a SUBSET: this is a curated core profile, and the catalog is how you discover a capability that has no tool of its own — find the row, call hudu_describe for the exact schema, then hudu_invoke. Rows with no "tool" are reachable only through hudu_invoke. Rows with "reachable": false are deliberately not callable here and state why (an unbounded read, or a binary/download surface). Bounded: limit defaults to 40 and is hard-capped at 100, offset pages through the rest; the whole catalog is ~10k tokens, so ask for a filter or a page rather than dumping it.',
    inputSchema: {
      type: 'object',
      fields: {
        limit: { name: 'limit', type: 'number', required: false },
        offset: { name: 'offset', type: 'number', required: false },
        effect: { name: 'effect', type: 'string', required: false, enum: ['read', 'write', 'destructive'] },
        resource: { name: 'resource', type: 'string', required: false },
        unexposed_only: { name: 'unexposed_only', type: 'boolean', required: false },
      },
    },
  },
  {
    name: 'hudu_describe',
    title: 'Describe One Operation',
    description:
      'Return the full input schema, effect, flags, dry-run support, error vocabulary, related operations and preferredWhen guidance for ONE operation, so a capability can be called correctly without carrying every schema in context. Use it after hudu_catalog named the operation and before hudu_invoke. Takes the canonical operation key exactly as the catalog prints it (for example "companies.update") — never a tool name, and there is no fuzzy matching: an unknown key is a CONFIG_ERROR naming the nearest catalog keys.',
    inputSchema: { type: 'object', fields: { operation: { name: 'operation', type: 'string', required: true } } },
  },
  {
    name: 'hudu_invoke',
    title: 'Invoke Any Operation (Escape Hatch)',
    description:
      'Execute an operation by its canonical registry key, including the ones with no tool of their own. Every call goes through the SDK dispatcher `operations.invoke`: the input is validated against the registry record BEFORE any HTTP request — unknown fields, missing required fields, wrong types and out-of-enum values are refused with CONFIG_ERROR and the field path, and no request is issued. Reads run directly. Writes are dry-run-first: omit dry_run (or pass dry_run: true) and nothing is written — the SDK dry-run path runs and returns simulated: true with the impact and the diff; pass dry_run: false to execute. A destructive or approval-gated operation also requires confirm to equal the operation key exactly, and a confirmed destructive call is still only a dry run unless dry_run: false is also passed. Operations the projection never exposes (unbounded listAll/listPages reads, binary/download resources) are refused with a reason and the bounded alternative where one exists. This is the escape hatch for the long tail, not the common path: prefer a typed tool when one fits, and read the schema with hudu_describe first when the arguments are not obvious.',
    inputSchema: {
      type: 'object',
      fields: {
        operation: { name: 'operation', type: 'string', required: true },
        input: { name: 'input', type: 'object', required: false },
        dry_run: { name: 'dry_run', type: 'boolean', required: false },
        confirm: { name: 'confirm', type: 'string', required: false },
      },
    },
  },
];
const META_TOOL_NAMES = META_TOOLS.map((m) => m.name);

// R4: the read entry for a workflow resource is the projected HELPER-tier read tool for that
// resource, chosen deterministically by the documented preference order (the helper that answers
// "read one record" first, then the bounded search, then the identity lookup), then by name.
const CORE_READ_PREFERENCE = ['getContext', 'getWithTasks', 'search', 'findBySlug', 'findByName', 'findByDomain', 'findBySerial', 'resolve'];
const coreReadFor = (resource) => {
  const candidates = tools
    .filter((t) => t.effect === 'read' && t.annotations.tier === 'helper' && resourceOf(t.backingOperation) === resource)
    .sort((a, b) => {
      const rank = (t) => {
        const i = CORE_READ_PREFERENCE.indexOf(methodOf(t.backingOperation));
        return i === -1 ? CORE_READ_PREFERENCE.length : i;
      };
      return rank(a) - rank(b) || (a.name < b.name ? -1 : 1);
    });
  return candidates[0] ?? null;
};
const coreReadEntries = WORKFLOW_RESOURCES.map((resource) => ({ resource, tool: coreReadFor(resource) }));
const coreMissingResources = coreReadEntries.filter((e) => e.tool === null).map((e) => e.resource);
const coreDiscovery = CORE_DISCOVERY_OPS.map((op) => tools.find((t) => t.backingOperation === op) ?? null).filter((t) => t !== null);
const coreDiscoveryMissing = CORE_DISCOVERY_OPS.filter((op) => !tools.some((t) => t.backingOperation === op));
const coreTenant = CORE_TENANT_OPS.map((op) => tools.find((t) => t.backingOperation === op) ?? null).filter((t) => t !== null);
const coreTenantMissing = CORE_TENANT_OPS.filter((op) => !tools.some((t) => t.backingOperation === op));
const coreTools = [
  ...META_TOOL_NAMES.map((name) => ({ name, backingOperation: null, effect: null, profile: 'R1 discover/meta' })),
  ...coreDiscovery.map((t) => ({ name: t.name, backingOperation: t.backingOperation, effect: t.effect, profile: 'R3 discover' })),
  ...coreTenant.map((t) => ({ name: t.name, backingOperation: t.backingOperation, effect: t.effect, profile: 'R2 tenant' })),
  ...coreReadEntries.filter((e) => e.tool !== null).map((e) => ({ name: e.tool.name, backingOperation: e.tool.backingOperation, effect: e.tool.effect, profile: `R4 ${e.resource}` })),
];
const CORE_TOOL_NAMES = coreTools.map((t) => t.name);
const coreProfile = {
  planHash: registry.planHash ?? null,
  rule: CORE_RULE,
  workflowResources: WORKFLOW_RESOURCES,
  coreTools,
  metaTools: META_TOOLS.map((m) => ({ name: m.name, title: m.title, description: m.description, inputSchema: m.inputSchema })),
  gaps: {
    workflowResourcesWithoutReadEntry: coreMissingResources,
    discoveryOperationsMissing: coreDiscoveryMissing,
    tenantOperationsMissing: coreTenantMissing,
  },
};

// The projection is exported so the catalog builder and the capability gate read ONE implementation
// of the rules (never a second copy that can drift).
export {
  CORE_RULE,
  CORE_TOOL_NAMES,
  META_TOOLS,
  META_TOOL_NAMES,
  WORKFLOW_RESOURCES,
  curationExcluded,
  coreProfile,
  coreTools,
  excluded,
  overrideLog,
  registry,
  records,
  tools,
  unresolvedOverrides,
};

if (IS_MAIN) {
  const lines = [];
  lines.push('# MCP_TOOL_MANIFEST.md');
  lines.push('');
  lines.push('> **Machine-generated** by `scripts/project-mcp-tools.mjs` (`npm run mcp:project`) from');
  lines.push(`> \`capabilities.json\` (planHash \`${registry.planHash}\`, generatedAt \`${registry.generatedAt}\`).`);
  lines.push('> Do not hand-edit. Curation is recorded in `MCP_TOOL_OVERRIDES.json` and re-applied by the script.');
  lines.push('');
  lines.push('## Projection summary');
  lines.push('');
  lines.push(`- registry records: ${records.length}`);
  lines.push(`- tools projected: ${tools.length} (helper-tier ${helperTierTools.length}, read primitives ${primitiveBackedReadTools.length}, mutations ${tools.filter((t) => t.effect !== 'read').length})`);
  lines.push(`- excluded by rule: ${excluded.length}`);
  lines.push(`- excluded by curation: ${curationExcluded.length} (dropped through \`MCP_TOOL_OVERRIDES.json\` — one tool kept per distinct outcome)`);
  lines.push(`- overrides applied: ${overrideLog.length}${existsSync(OVERRIDES_PATH) ? '' : ' (no MCP_TOOL_OVERRIDES.json present)'}`);
  lines.push(`- projection timestamp: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`> ${tools.length} projected tools is a projection, not a shipped tool list. MCP servers are`);
  lines.push('> token-budgeted: tiering (core / extended) and trimming are curation, recorded in');
  lines.push('> `MCP_TOOL_OVERRIDES.json`.');
  lines.push('');
  lines.push('## Rules applied (mechanical)');
  lines.push('');
  lines.push('1. Read tools must be backed by the helper tier (`resolve` / `findBy*` / `search` / `getContext`).');
  lines.push(`   The registry currently carries ${helperTierTools.length} helper-tier tools, ${primitiveBackedReadTools.length} read`);
  lines.push('   tools are still backed by a plain primitive — see "Helper-tier gaps" for the worklist.');
  lines.push('2. `listAll` / `listPages` are never projected (unbounded reads).');
  lines.push('3. Every list tool states its bound; every helper scan states its cap.');
  lines.push('4. Mutating tools expose a `dry_run` input affordance.');
  lines.push('5. `sensitive` / `requiresApproval` are stated on the tool.');
  lines.push('6. No binary/download tool (resources ' + [...BINARY_RESOURCES].join(', ') + ') is projected.');
  lines.push('7. `MCP_TOOL_OVERRIDES.json` is the only place a description may change; this script never re-derives one.');
  lines.push('8. A curation `exclude` override (`{tool, field: "exclude", newValue: true, reason}`) drops a projected');
  lines.push('   tool: one tool per distinct outcome, so no two tools in the curated list do the same job.');
  lines.push('');
  lines.push(`## Helper-tier backing`);
  lines.push('');
  lines.push(`Helper-tier tools in the registry (${helperTierTools.length}): ` + (helperTierTools.length ? helperTierTools.map((t) => `\`${t.name}\``).join(', ') : 'none'));
  lines.push('');
  lines.push(`### WARNING — read tools still backed by a plain primitive (${primitiveBackedReadTools.length})`);
  lines.push('');
  lines.push('A read tool must be backed by the helper tier. These are still the primitive, which is the');
  lines.push('Phase-2 curation worklist. `listAll`/`listPages` are never projected at all.');
  lines.push('');
  for (const t of primitiveBackedReadTools) {
    const alts = t.annotations.helperTierAlternatives ?? [];
    lines.push(`- ${t.name} (${t.backingOperation}) — helper-tier alternatives: ${alts.length ? alts.map((a) => `\`${a}\``).join(', ') : 'none in the registry yet'}`);
  }
  if (!primitiveBackedReadTools.length) lines.push('- none');
  lines.push('');
  if (readToolsMissingHelperBacking.length) {
    lines.push(`### No helper exists for the resource yet (${readToolsMissingHelperBacking.length})`);
    lines.push('');
    for (const t of readToolsMissingHelperBacking) lines.push(`- ${t}`);
    lines.push('');
  }
  lines.push('## Curation still owed (the Toolsmith owns this; the script does not)');
  lines.push('');
  lines.push('- Tool names are mechanical (`' + TOOL_PREFIX + '<resource>_<method>`). Verb-first names and prefixes are curation.');
  lines.push('- Descriptions are the registry `purpose` verbatim. The registry purpose never states the bound or the tier, so bound/tier statements are curation.');
  lines.push('- Tiers and the per-server token budget are curation.');
  if (missingPurpose.length) {
    lines.push('');
    lines.push(`- **Missing purposes** (no description could be projected): ${missingPurpose.join(', ')}`);
  }
  lines.push('');
  if (overrideLog.length) {
    lines.push('## Overrides applied');
    lines.push('');
    lines.push('| tool | field | newValue | reason |');
    lines.push('| --- | --- | --- | --- |');
    for (const ov of overrideLog) lines.push(`| ${ov.tool} | ${ov.field} | ${JSON.stringify(ov.newValue)} | ${ov.reason ?? ''} |`);
    lines.push('');
  }
  lines.push('## Excluded operations');
  lines.push('');
  lines.push('| operation | reason |');
  lines.push('| --- | --- |');
  for (const e of excluded) lines.push(`| ${e.name} | ${e.why} |`);
  lines.push('');
  lines.push('## Excluded by curation (dropped through `MCP_TOOL_OVERRIDES.json`)');
  lines.push('');
  if (curationExcluded.length) {
    lines.push('Dropped from the projection by Toolsmith curation, not by a rule: each one shared its');
    lines.push('outcome (`backingOperation`) with a better-named tool that survives, or was otherwise');
    lines.push('redundant. The reason column is the override\'s `reason`.');
    lines.push('');
    lines.push('| tool | backingOperation | effect | projected tier | reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const e of curationExcluded) lines.push(`| ${e.name} | ${e.backingOperation} | ${e.effect} | ${e.tier} | ${e.reason} |`);
    lines.push('');
    lines.push('Restore one by deleting its `exclude` override record and re-running `npm run mcp:project`.');
  } else {
    lines.push('- none');
  }
  lines.push('');
  lines.push('## Tools');
  lines.push('');
  for (const t of tools) {
    lines.push(`### ${t.name}`);
    lines.push('');
    lines.push(`- backingOperation: \`${t.backingOperation}\``);
    lines.push(`- description: ${t.description}`);
    lines.push(`- example: ${t.example === null ? '<none recorded>' : '\`' + String(t.example).replace(/\|/g, '\\|') + '\`'}`);
    lines.push(`- effect: \`${t.effect}\`; flags: ${t.flags.length ? t.flags.map((f) => `\`${f}\``).join(', ') : '(none)'}; permissions: \`${t.permissions}\`; dryRun: ${t.dryRun}`);
    lines.push(`- annotations: ${Object.entries(t.annotations).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
    // Schemas are written single-line: this manifest is machine-generated and consumed by the
    // Toolsmith, and pretty-printing 141 full Hudu record shapes costs thousands of lines.
    lines.push(`- inputSchema: \`${JSON.stringify(t.inputSchema)}\``);
    lines.push(`- outputSchema: \`${JSON.stringify(t.outputSchema)}\``);
    lines.push('');
  }
  lines.push('## Machine-readable projection');
  lines.push('');
  lines.push('```json');
  lines.push('[');
  lines.push(tools.map((t) => '  ' + JSON.stringify(t)).join(',\n'));
  lines.push(']');
  lines.push('```');
  lines.push('');
  // ---------------------------------------------------------------- core profile (manifest section)
  // The CORE set is generated from the rule above, never listed by hand. The section is part of the
  // manifest so the rule is readable where the projection is, and so the gate can re-read it.
  lines.push('## Core profile (progressive disclosure)');
  lines.push('');
  lines.push('The client-visible `tools/list` is a TOKEN BUDGET, not a security boundary. MCP has no');
  lines.push('per-call schema fetch, so a host holds every registered tool on every turn; a reference');
  lines.push('server therefore registers a CORE profile plus three META tools that make the whole registry');
  lines.push('reachable on demand (progressive-disclosure design).');
  lines.push('');
  lines.push(`> **CORE inclusion rule (implemented in \`scripts/project-mcp-tools.mjs\`, not hand-listed):** ${CORE_RULE}`);
  lines.push('');
  lines.push(`- CORE tools: ${CORE_TOOL_NAMES.length} (3 META + ${CORE_TOOL_NAMES.length - 3} typed)`);
  lines.push(`- workflow resources (group A): ${WORKFLOW_RESOURCES.join(', ')}`);
  lines.push(`- every write is OUT of core and reachable through \`hudu_invoke\`, which forces \`dry_run: true\` first`);
  lines.push('');
  lines.push('| # | tool | rule | backing operation |');
  lines.push('| --- | --- | --- | --- |');
  coreTools.forEach((t, i) => lines.push(`| ${i + 1} | \`${t.name}\` | ${t.profile} | ${t.backingOperation === null ? '— (serves the whole registry)' : '`' + t.backingOperation + '`'} |`));
  lines.push('');
  if (coreMissingResources.length || coreDiscoveryMissing.length || coreTenantMissing.length) {
    lines.push(`### CORE gaps (a gate failure, reported here so it cannot be missed)`);
    lines.push('');
    if (coreMissingResources.length) lines.push(`- workflow resources with NO projected helper-tier read entry: ${coreMissingResources.join(', ')}`);
    if (coreDiscoveryMissing.length) lines.push(`- R3 discovery operations not in the projection yet: ${coreDiscoveryMissing.join(', ')} (a later build step adds \`operations.searchKnowledge\`)`);
    if (coreTenantMissing.length) lines.push(`- R2 tenant operations not in the projection: ${coreTenantMissing.join(', ')}`);
    lines.push('');
  }
  lines.push('### META tools (R1 — discovery of a capability that has no tool)');
  lines.push('');
  lines.push('| tool | what it answers |');
  lines.push('| --- | --- |');
  lines.push('| `hudu_catalog` | every registry operation as a row: `op`, `tool`, `effect`, `requires`, `dry_run`, `reachable`, `reason` |');
  lines.push('| `hudu_describe` | one operation\'s full schema, flags, errors and guidance |');
  lines.push('| `hudu_invoke` | execute by canonical key, validated against the registry record before any request |');
  lines.push('');
  lines.push('The catalog is GENERATED from `capabilities.json` (see `examples/tool-catalog.generated.ts`,');
  lines.push('emitted by `scripts/build-tool-catalog.mjs`), so an operation that gains or loses a tool cannot');
  lines.push('become invisible: every operation has a row, and an operation the escape hatch refuses has');
  lines.push('`reachable: false` with the reason. An unexposed capability that is indistinguishable from a');
  lines.push('missing one is the defect this closes.');
  lines.push('');
  lines.push('Profiles a host may select (`HUDU_MCP_PROFILE=core|extended|all` in the reference server):');
  lines.push(`\`core\` = the ${CORE_TOOL_NAMES.length} tools above; \`extended\` = the whole curated projection`);
  lines.push(`(${tools.length} tools); \`all\` = both. The profile is a host knob, never a reachability boundary —`);
  lines.push('every operation stays reachable through `hudu_invoke` under any profile.');
  lines.push('');
  // Operation-conditional fields and examples must be calls that work: base.ts
  // assertNoExpectedUpdatedAt rejects expectedUpdatedAt outside an update operation, so a tool that
  // advertises or demonstrates it for anything else would fail at runtime.
  const updateShaped = (opName, kind) => {
    const method = opName.split('.').slice(1).join('.');
    return kind === 'helper' ? /^(update|set|patch|move)[A-Za-z0-9_]*$/.test(method) : method === 'update';
  };
  const exampleViolations = [];
  for (const t of tools) {
    const isUpdate = updateShaped(t.backingOperation, t.registryKind);
    if (isUpdate) continue;
    if (t.example && String(t.example).includes('expectedUpdatedAt')) {
      exampleViolations.push(`${t.name} (${t.backingOperation}): the example passes expectedUpdatedAt, which the SDK rejects outside an update`);
    }
    if (process.env.MCP_DEBUG_EXAMPLE === '1' && JSON.stringify(t.inputSchema).includes('expectedUpdatedAt')) {
      const jj = JSON.stringify(t.inputSchema);
      const at = jj.indexOf('expectedUpdatedAt');
      console.log('DEBUG', t.name, '...' + jj.slice(Math.max(0, at - 220), at + 80));
    }
    if (JSON.stringify(t.inputSchema).includes('expectedUpdatedAt')) {
      exampleViolations.push(`${t.name} (${t.backingOperation}): the inputSchema advertises expectedUpdatedAt, which the SDK rejects outside an update`);
    }
  }
  // (the operation-invalid-field gate is enforced by `runCheckExample()` below, so that a
  // `--check-example` run also reaches the profile and META-tool checks; the manifest is not
  // written in this mode.)
  // NOTE: the manifest is written only AFTER the violation checks below. Writing first meant a projection
  // that failed its own operation-invalid-field gate still overwrote the published manifest with the invalid
  // schema - which is exactly how 43 tools came to advertise `expectedUpdatedAt` on create/delete operations
  // that reject it (live-verified: the SDK throws CONFIG_ERROR). A failing projection must change nothing.

  console.log(`mcp:project — registry ${path.relative(ROOT, REGISTRY)} planHash=${registry.planHash}; records=${records.length}`);
  console.log(`mcp:project — tools projected=${tools.length}; excluded=${excluded.length}; overrides applied=${overrideLog.length}`);
  // (the write happens after the violation gate; see the note above)
  console.log(`mcp:project — read tools missing helper-tier backing: ${readToolsMissingHelperBacking.length}${readToolsMissingHelperBacking.length ? ' (first 10: ' + readToolsMissingHelperBacking.slice(0, 10).join(', ') + ')' : ''}`);
  // Two different things, reported separately (never conflated):
  //   re-pointed — a PRIMITIVE registry record the curation backs with a helper operation (curation);
  //   mislabelled — a HELPER registry record the projection failed to classify as helper (a defect).
  const rePointedByCuration = tools.filter((t) => t.registryKind !== 'helper' && t.annotations.tier === 'helper');
  const mislabelled = tools.filter((t) => t.registryKind === 'helper' && t.annotations.tier !== 'helper');
  console.log(`mcp:project — classification by registry kind: helper-tier tools=${helperTierTools.length}, primitive-read=${primitiveBackedReadTools.length}, primitive-write=${tools.filter((t) => t.effect !== 'read' && t.annotations.tier !== 'helper').length}; re-pointed-by-curation=${rePointedByCuration.length}; mislabelled=${mislabelled.length}${mislabelled.length ? ' (' + mislabelled.map((t) => t.backingOperation).join(', ') + ')' : ''}`);
  console.log(`mcp:project — curation exclusions: ${curationExcluded.length} tool(s) dropped through MCP_TOOL_OVERRIDES.json (listed under "Excluded by curation" in the manifest); no two curated read tools share a backingOperation=${(() => { const seen = new Map(); for (const t of tools) if (t.effect === 'read') { if (seen.has(t.backingOperation)) return false; seen.set(t.backingOperation, t.name); } return true; })()}`);
  console.log(`mcp:project — read tools missing helper-tier backing (resource has no helper record): ${readToolsMissingHelperBacking.length}`);
  if (exampleViolations.length) {
    console.error(`mcp:project — EXAMPLE/FIELD VIOLATIONS (${exampleViolations.length}):`);
    for (const v of exampleViolations) console.error(`  ✗ ${v}`);
  }
  console.log(`mcp:project — WARNING: ${primitiveBackedReadTools.length} read tool(s) are still backed by a plain primitive (${primitiveReadWithHelperAlternative.length} have a helper-tier alternative in the registry); listAll/listPages are never projected`);
  console.log(`mcp:project — helper-tier backing stated for every tool; curation worklist in the manifest`);
  if (missingPurpose.length) console.log(`mcp:project — tools with no projected description (missing purpose): ${missingPurpose.join(', ')}`);
  if (exampleViolations.length) process.exit(1);
  if (unresolvedOverrides.length) {
    console.error(`mcp:project — UNRESOLVED OVERRIDES (${unresolvedOverrides.length}):`);
    for (const u of unresolvedOverrides) console.error(`  ✗ ${JSON.stringify(u.ov)}: ${u.why}`);
    process.exit(1);
  }
  if (CHECK_EXAMPLE) {
    console.log('mcp:project — check mode: MCP_TOOL_MANIFEST.md not rewritten');
  } else {
    writeFileSync(OUT, lines.join('\n'));
    console.log(`mcp:project — wrote ${path.relative(ROOT, OUT)}`);
  }
  // A machine-readable projection of the SAME tools the manifest describes. The manifest's tool table only
  // lists the curated exclusions, so nothing could verify MCP coverage mechanically; this lets a coverage or
  // audit script map every projected tool to the registry operation that backs it.
  const toolsJson = argValue('--list-tools', '');
  if (toolsJson) {
    const rows = tools.map((t) => ({
      name: t.name,
      backingOperation: t.backingOperation,
      effect: t.effect,
      tier: t.annotations?.tier ?? null,
      registryKind: t.registryKind ?? null,
    }));
    writeFileSync(path.resolve(ROOT, toolsJson), JSON.stringify(rows, null, 2));
    console.log(`mcp:project — wrote ${toolsJson} (${rows.length} tools)`);
  }

  // ---------------------------------------------------------------- --check-example
  // The example MCP server is a REFERENCE CONSUMER generated from the curated projection plus the
  // generated CORE profile. It fails on exactly these kinds of drift:
  //   1. a registered tool name that is not in the profile it declares (`core` = CORE + META);
  //   2. an unbounded read anywhere in the example (`listAll` / `listPages` / a streaming `.list(`);
  //   3. a mutating tool that does not declare a `dry_run` input affordance, or whose handler never
  //      calls the SDK's `{ dryRun: true }` path;
  //   4. a description that is not the curated (or, for a META tool, the projected) one, verbatim;
  //   5. a `core` profile that does not register the whole generated CORE set;
  //   6. a `hudu_invoke` whose handler does not call the SDK dispatcher `operations.invoke` — the
  //      ONE place that decides whether a call is allowed (the generated catalog carries no second
  //      validator and no second write governor: it carries data and a schema reader only).
  // The example declares its profile with `const MCP_PROFILE = 'core';`; `--profile <p>` overrides it.
  // Comments and string literals are stripped before the call scan and the config scan, because the
  // curated descriptions legitimately mention `listAll` and `dry_run` without calling anything.
  function runCheckExample() {
    const EXAMPLE = path.resolve(ROOT, argValue('--example', 'examples/mcp-server.ts'));
    const rel = path.relative(ROOT, EXAMPLE);
    const failures = exampleViolations.slice();
    for (const v of exampleViolations) console.error(`  x ${v}`);
    if (!existsSync(EXAMPLE)) {
      console.error(`mcp:project --check-example — FAILED (1):`);
      console.error(`  ✗ ${rel} not found`);
      process.exit(1);
    }
    const source = readFileSync(EXAMPLE, 'utf8');
    const declared = /MCP_PROFILE\s*=\s*'([a-z]+)'/.exec(source);
    const profile = argValue('--profile', declared ? declared[1] : 'extended');
    if (!['core', 'extended', 'all'].includes(profile)) {
      console.error(`mcp:project --check-example — FAILED (1):`);
      console.error(`  ✗ unknown profile "${profile}" (expected core | extended | all)`);
      process.exit(1);
    }
    const curatedNames = tools.map((t) => t.name);
    const allowed = profile === 'core'
      ? [...CORE_TOOL_NAMES]
      : profile === 'extended'
        ? curatedNames
        : [...new Set([...curatedNames, ...CORE_TOOL_NAMES])];
    const byName = new Map(tools.map((t) => [t.name, t]));
    const metaByName = new Map(META_TOOLS.map((m) => [m.name, m]));
    const registered = [];
    let readTools = 0;
    let writeTools = 0;
    let metaTools = 0;
    const stripLiterals = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const unbounded = [...new Set((stripLiterals(source).match(/\b(?:listAll|listPages)\s*\(|\.list\s*\(/g) ?? []).map((s) => s.trim()))];
    if (unbounded.length) {
      failures.push(`the example uses an unbounded read (${unbounded.join(', ')}) — a read tool must call the helper tier (search / findBy* / resolve / getContext / operations.*)`);
    }
    const starts = [...source.matchAll(/registerTool\(\s*'([^']+)'/g)];
    for (let i = 0; i < starts.length; i += 1) {
      const name = starts[i][1];
      const body = source.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : source.length);
      registered.push(name);
      if (!allowed.includes(name)) {
        failures.push(`${name}: not a tool of the "${profile}" profile (a curated tool) — curate it in MCP_TOOL_OVERRIDES.json, or move it out of the example`);
        continue;
      }
      const describedMatch = /description:\s*'((?:[^'\\]|\\.)*)'/.exec(body);
      // A description may also be a reference to the GENERATED map, `description: TOOL_DESCRIPTIONS['name']`,
      // which is stronger than re-typing 2 KB of curated prose: the text compared here is still the
      // curated one, and the reference must name the tool it is registering. A reference to an
      // unknown tool, or to another tool's description, is a failure (it would ship the wrong prose).
      const describedRef = /description:\s*TOOL_DESCRIPTIONS\[\s*'((?:[^'\\]|\\.)*)'\s*\]/.exec(body);
      if (describedRef && describedRef[1] !== name) {
        failures.push(`${name}: description references TOOL_DESCRIPTIONS['${describedRef[1]}'] — a tool must carry its OWN curated description`);
        continue;
      }
      const referenced = describedRef ? (byName.get(describedRef[1]) ?? metaByName.get(describedRef[1]) ?? null) : null;
      if (describedRef && referenced === null) {
        failures.push(`${name}: description references TOOL_DESCRIPTIONS['${describedRef[1]}'], which is not a curated (or META) tool name`);
        continue;
      }
      const described = describedMatch ? describedMatch[1].replace(/\\(['\\])/g, '$1') : referenced ? referenced.description : null;
      if (metaByName.has(name)) {
        metaTools += 1;
        const spec = metaByName.get(name);
        if (described === null) failures.push(`${name}: no description`);
        else if (described !== spec.description) failures.push(`${name}: description drifts from the projected META tool (fix scripts/project-mcp-tools.mjs and regenerate the example)`);
        const handlerAt = body.search(/async\s*\(\s*args\s*\)\s*=>/);
        const handlerCode = handlerAt === -1 ? '' : stripLiterals(body.slice(handlerAt));
        if (name === 'hudu_invoke') {
          if (!/operations\.invoke\s*\(/.test(handlerCode)) failures.push('hudu_invoke: the handler never calls the SDK dispatcher operations.invoke — registry validation and the write governor must live in exactly ONE implementation');
          if (/validateInvokeInput\s*\(|governInvoke\s*\(/.test(handlerCode)) failures.push('hudu_invoke: the handler calls a SECOND validator/governor — the SDK dispatcher is the only place that decides whether a call is allowed');
        }
        if (name === 'hudu_catalog' && (described === null || !/SUBSET/.test(described) || !/hudu_invoke/.test(described))) {
          failures.push('hudu_catalog: the catalog description must state that the tool list is a SUBSET and name hudu_invoke as the way to reach the rest');
        }
        continue;
      }
      const tool = byName.get(name);
      if (!tool) {
        failures.push(`${name}: not a tool in the curated manifest (fix the name here, or curate it in MCP_TOOL_OVERRIDES.json)`);
        continue;
      }
      if (tool.effect === 'read') {
        readTools += 1;
        if (tool.annotations.tier !== 'helper') {
          failures.push(`${name}: the manifest backs this read with ${tool.backingOperation} (tier ${tool.annotations.tier}) — re-point it in MCP_TOOL_OVERRIDES.json`);
        }
      } else {
        writeTools += 1;
        const handlerAt = body.search(/async\s*\(\s*args\s*\)\s*=>/);
        const configCode = stripLiterals(handlerAt === -1 ? body : body.slice(0, handlerAt));
        const handlerCode = handlerAt === -1 ? '' : stripLiterals(body.slice(handlerAt));
        if (!/\bdry_run\b/.test(configCode)) failures.push(`${name}: mutating tool with no dry_run input affordance`);
        if (!/dryRun:\s*true/.test(handlerCode)) failures.push(`${name}: mutating tool never calls the SDK's { dryRun: true } path`);
      }
      if (described === null) failures.push(`${name}: no description`);
      else if (described !== tool.description) failures.push(`${name}: description drifts from the curated manifest (re-run mcp:project and regenerate the example from it)`);
    }
    if (profile === 'core') {
      for (const name of CORE_TOOL_NAMES) {
        if (!registered.includes(name)) failures.push(`${name}: CORE is declared but the example does not register it (a core profile registers the whole generated CORE set)`);
      }
    }
    const excluded = tools.length - registered.filter((n) => byName.has(n)).length;
    console.log(`mcp:project --check-example — ${rel}: profile=${profile}${declared ? ' (declared in the example)' : ' (default)'}; ${registered.length} tool(s) registered (${readTools} read, ${writeTools} mutating, ${metaTools} META); CORE=${CORE_TOOL_NAMES.length}; manifest projects ${tools.length}; ${excluded} curated tool(s) deliberately not registered (reference consumer, not the surface)`);
    if (failures.length) {
      console.error(`mcp:project --check-example — FAILED (${failures.length}):`);
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log('mcp:project --check-example — OK: every tool name is in the declared profile, no unbounded read is used, every mutating tool declares dry_run and calls the SDK dry-run path, the META tools match the projected descriptions, and hudu_invoke dispatches through the SDK operations.invoke — the single validator and governor.');
  }
  runCheckExample();
}

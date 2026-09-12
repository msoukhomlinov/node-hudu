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

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const argValue = (flag, fallback) => { const i = argv.indexOf(flag); return i === -1 ? fallback : argv[i + 1]; };
const REGISTRY = path.resolve(ROOT, argValue('--registry', 'capabilities.json'));
const OUT = path.resolve(ROOT, argValue('--out', 'MCP_TOOL_MANIFEST.md'));
const OVERRIDES_PATH = path.resolve(ROOT, 'MCP_TOOL_OVERRIDES.json');
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

// ---------------------------------------------------------------- manifest
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
writeFileSync(OUT, lines.join('\n'));

console.log(`mcp:project — registry ${path.relative(ROOT, REGISTRY)} planHash=${registry.planHash}; records=${records.length}`);
console.log(`mcp:project — tools projected=${tools.length}; excluded=${excluded.length}; overrides applied=${overrideLog.length}`);
console.log(`mcp:project — wrote ${path.relative(ROOT, OUT)}`);
console.log(`mcp:project — read tools missing helper-tier backing: ${readToolsMissingHelperBacking.length}${readToolsMissingHelperBacking.length ? ' (first 10: ' + readToolsMissingHelperBacking.slice(0, 10).join(', ') + ')' : ''}`);
// Two different things, reported separately (never conflated):
//   re-pointed — a PRIMITIVE registry record the curation backs with a helper operation (curation);
//   mislabelled — a HELPER registry record the projection failed to classify as helper (a defect).
const rePointedByCuration = tools.filter((t) => t.registryKind !== 'helper' && t.annotations.tier === 'helper');
const mislabelled = tools.filter((t) => t.registryKind === 'helper' && t.annotations.tier !== 'helper');
console.log(`mcp:project — classification by registry kind: helper-tier tools=${helperTierTools.length}, primitive-read=${primitiveBackedReadTools.length}, primitive-write=${tools.filter((t) => t.effect !== 'read' && t.annotations.tier !== 'helper').length}; re-pointed-by-curation=${rePointedByCuration.length}; mislabelled=${mislabelled.length}${mislabelled.length ? ' (' + mislabelled.map((t) => t.backingOperation).join(', ') + ')' : ''}`);
console.log(`mcp:project — curation exclusions: ${curationExcluded.length} tool(s) dropped through MCP_TOOL_OVERRIDES.json (listed under "Excluded by curation" in the manifest); no two curated read tools share a backingOperation=${(() => { const seen = new Map(); for (const t of tools) if (t.effect === 'read') { if (seen.has(t.backingOperation)) return false; seen.set(t.backingOperation, t.name); } return true; })()}`);
console.log(`mcp:project — read tools missing helper-tier backing (resource has no helper record): ${readToolsMissingHelperBacking.length}`);
console.log(`mcp:project — WARNING: ${primitiveBackedReadTools.length} read tool(s) are still backed by a plain primitive (${primitiveReadWithHelperAlternative.length} have a helper-tier alternative in the registry); listAll/listPages are never projected`);
console.log(`mcp:project — helper-tier backing stated for every tool; curation worklist in the manifest`);
if (missingPurpose.length) console.log(`mcp:project — tools with no projected description (missing purpose): ${missingPurpose.join(', ')}`);
if (unresolvedOverrides.length) {
  console.error(`mcp:project — UNRESOLVED OVERRIDES (${unresolvedOverrides.length}):`);
  for (const u of unresolvedOverrides) console.error(`  ✗ ${JSON.stringify(u.ov)}: ${u.why}`);
  process.exit(1);
}

// ---------------------------------------------------------------- --check-example
// The example MCP server is a REFERENCE CONSUMER generated from the curated projection. This gate
// keeps it honest and fails on exactly four kinds of drift:
//   1. a registered tool name that is not a tool of the curated manifest;
//   2. an unbounded read anywhere in the example (`listAll` / `listPages` / a streaming `.list(`) —
//      read tools call the helper tier (`search` / `findBy*` / `resolve` / `getContext`);
//   3. a mutating tool that does not declare a `dry_run` input affordance, or whose handler never
//      calls the SDK's `{ dryRun: true }` path;
//   4. a description that is not the curated description, verbatim.
// Comments and string literals are stripped before the call scan and the config scan, because the
// curated descriptions (and the example's own prose) legitimately mention `listAll` and `dry_run`
// without calling or declaring anything. Structure (positional handler arguments, zod shape,
// formatting) is the example's own. The example is expected to cover a SUBSET of the projection:
// it is a reference consumer, not the tool surface.
if (argv.includes('--check-example')) {
  const EXAMPLE = path.resolve(ROOT, argValue('--example', 'examples/mcp-server.ts'));
  const rel = path.relative(ROOT, EXAMPLE);
  const failures = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const registered = [];
  let readTools = 0;
  let writeTools = 0;
  const stripLiterals = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (!existsSync(EXAMPLE)) {
    failures.push(`${rel} not found`);
  } else {
    const source = readFileSync(EXAMPLE, 'utf8');
    const unbounded = [...new Set((stripLiterals(source).match(/\b(?:listAll|listPages)\s*\(|\.list\s*\(/g) ?? []).map((s) => s.trim()))];
    if (unbounded.length) {
      failures.push(`the example uses an unbounded read (${unbounded.join(', ')}) — a read tool must call the helper tier (search / findBy* / resolve / getContext / operations.*)`);
    }
    const starts = [...source.matchAll(/registerTool\(\s*'([^']+)'/g)];
    for (let i = 0; i < starts.length; i += 1) {
      const name = starts[i][1];
      const body = source.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : source.length);
      registered.push(name);
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
      const described = /description:\s*'((?:[^'\\]|\\.)*)'/.exec(body);
      const text = described ? described[1].replace(/\\(['\\])/g, '$1') : null;
      if (text === null) failures.push(`${name}: no description`);
      else if (text !== tool.description) failures.push(`${name}: description drifts from the curated manifest (re-run mcp:project and regenerate the example from it)`);
    }
  }
  const excluded = tools.length - registered.length;
  console.log(`mcp:project --check-example — ${rel}: ${registered.length} tool(s) registered (${readTools} read, ${writeTools} mutating); manifest projects ${tools.length}; ${excluded} deliberately excluded (reference consumer, not the surface)`);
  if (failures.length) {
    console.error(`mcp:project --check-example — FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('mcp:project --check-example — OK: every tool name is in the curated manifest, no unbounded read is used, every mutating tool declares dry_run and calls the SDK dry-run path, every description matches.');
}

// scripts/check-capabilities.mjs
//
// `npm run capabilities:check [-- --group A|B|C|D|operations] [-- --ship] [-- --plan <path>]`
//
// The capability gate. Normative definition: api-node-squad
// references/agent-execution-layer.md §4.2 ("It fails when any of the following is true").
// This script implements that list, not an approximation. Rules and their ids:
//
//   malformed-row            exactly one of primitive/helper must be non-null (coordinator contract)
//   missing-key              a row is missing one of the §4 keys (every key is present on every row)
//   batch-status             --group: a scoped row is still "planned"
//   ship-status              --ship: a row is not "tested" (planned OR implemented)
//   coverage-source-missing  a scoped row at implemented/tested names a method that does not exist
//                            in src/resources/<resource>.ts (or src/operations/<module>.ts)
//   coverage-registry        a scoped row at implemented/tested has no record in src/capabilities.ts
//   registry-orphan          a registry record names an operation that is not in the plan
//   mutation-effect          a mutation has no effect
//   mutation-dryRun          a mutation has no dryRun, or dryRun is false
//   record-examples          a registry record carries no examples
//   record-permissions       a registry record has no permissions (the literal "unknown" is fine)
//   helper-rationale         a helper has no helperRationale
//   helper-tests             a helper has no test rows
//   helper-usage             a helper has no usage guidance
//   helper-compact-drops     a helper returning a compact shape is unresolved (`dropsUnresolved`)
//                            or carries no drops array; a record whose `compact` is null must
//                            make no drops claim at all. `drops: []` is valid (compact keeps all)
//   preferredWhen            an operation with a sibling reaching the same outcome has no
//                            preferredWhen. Sibling definition used here (documented, mechanical):
//                            two rows in the same resource with the same normalised endpoint
//                            (same HTTP method + path template). Curated near-duplicates that do
//                            not share an endpoint cannot be detected mechanically; see report.
//   impact-bound             a destructive/bulk operation has no recorded impact bound. Proxy
//                            implemented here: a destructive row must declare a dry-run test row
//                            (id or title containing "dry-run"), which is where the impact
//                            statement { affected, scope, reversible } is asserted.
//   staleCheck               a mutation has no staleCheck value (field name or "unavailable")
//   dryrun-shape             a dry-run of an update must record the warnings/diff contract.
//                            Proxy: an update-like row needs a dry-run test row (the dry-run
//                            result shape is asserted there).
//   example-expectedUpdatedAt a registry example shows `expectedUpdatedAt` on an operation that is
//                            not an update row (assertNoExpectedUpdatedAt throws CONFIG_ERROR first)
//   preferredWhen-required    a row of a resource that HAS a helper carries no preferredWhen
//   compact-shape-unknown     a non-null `compact` names a shape that is not declared in src/types/**
//   resolution-caps           a client-scan resolution without both caps, or a server-filter without them
//   redaction-value           `redaction` is not exactly "none" or "credentials"
//   errors-vocabulary         an `errors` entry is not SCREAMING_SNAKE, or a required code is
//                            missing (CONFIG_ERROR on every row; STALE_OBJECT when staleCheck is
//                            updated_at) — checked on the plan rows AND on the registry records
//   inputSchema-conditional-field  a record advertises a field the operation cannot honour
//                            (expectedUpdatedAt outside an update-shaped operation)
//   related-dangling          a `related` entry names an operation with no registry record —
//                            checked on the plan rows AND on the registry records
//   prose-dangling            a prose field (purpose/usage/preferredWhen) names an operation the
//                            client cannot call (no public method of that name) — the prose is
//                            projected into the MCP tool descriptions, so a name an agent is told
//                            to call must exist; checked on the plan rows AND on the registry
//                            records. The plan-side scan is unscoped (a wrong name is wrong in
//                            every group), unlike related-dangling
//   pagination                a record's pagination is absent, or claims nonPaginated AND mode "page"
//   inputSchema-name          an inputSchema field object omits the `name` key CapabilityField declares
//   inputSchema-unresolved-item  a published inputSchema node is an unresolvable object: an
//                            `items` projection that carries a typeName (the generator keeps the
//                            item's name ONLY when resolution failed), any node the generator marked
//                            resolved:false, or a DETAIL-LESS object item outside the `.data` record
//                            payload — the last one is the shape the reproduced defect emitted
//                            (`items: {"type":"object"}` with the name dropped, invisible to the
//                            other two markers because the projection is what lost the evidence).
//                            Platform binary names (Blob/File/Buffer/...) are excluded, mirroring the
//                            generator's opaqueSchemaNodes policy. Covers inputSchema only: the
//                            pre-dispatch validator contract is the input surface, and generic
//                            output shapes (typeName R) are out of scope
//   test-title               a row at "tested": no test with that exact title in the named file
//   implemented-tests        a row at "implemented": empty tests array
//   test-row                 a tests[] entry without id/file/title
//   emission-planhash        capabilities.json is stale (planHash mismatch) — SKIPPED when --plan
//                            points somewhere other than capabilities.plan.json, so a fixture can
//                            exercise the other rules without a matching emission
//   manifest-planhash        MCP_TOOL_MANIFEST.md does not carry the current planHash, or claims a
//                            registry record count that disagrees with src/capabilities.ts. A
//                            stale manifest is a shipped lie about helper coverage, so it fails
//                            here. Test it directly with --manifest <path>.
//   catalog-planhash         the generated catalog is stale (planHash mismatch)
//   searchable-resource-parity  a search tool advertises a resource whose `?search=` the vendor ignores
//                            (the plan, the projected `resources` enum and the generated SEARCH_RESOURCES
//                            table must name the same set) — an advertised resource that does not filter
//                            is a false-match generator for every query
//   help-mode-documents-resources  the generated help payload does not document every declared mode, the
//                            fields that mode honours, complete/degraded semantics, or does not derive the
//                            resources table from the plan
//   mode-honours-fields      a mode claims a field it refuses, advertises a field no mode honours, or a
//                            field only one mode honours does not say so in its description
//   catalog-reachability     a registry operation has no catalog row, or has no tool and no reason
//   catalog-op-exists        a catalog row names an unknown operation, or a tool that is not curated
//   invoke-refusals          an operation excluded by the projection rule is not refused with a reason
//   core-workflow-coverage   CORE misses a group-A read entry, a META tool, or a cross-resource helper
//   core-budget              the CORE tools/list payload exceeds its budget (~8k tokens)
//   emission-missing         capabilities.json / capabilities.schema.json / src/capabilities.ts absent
//   include-groups           an operation whose SDK surface accepts relation include-groups does not
//                            publish them (or the four group names) in its input schema, or publishes
//                            `include` without the include-expanded output variants it advertises
//                            (`itemVariants` for the list-shaped calls, `includeVariants` for
//                            `assets.search`)
//
// Warnings (never failures): a public source method in neither the plan nor the registry
// (unplanned surface), a record with purpose:null, a destructive row without requiresApproval,
// a read row with dryRun:true.
//
// Exit 1 on any failure. Prints every failure with its reason and the offending JSON path, then a
// PASS/FAIL summary with counts.
//
// Flags: --group <A|B|C|D|operations>  --ship  --plan <path>  --registry <path>  --manifest <path>

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const DEFAULT_PLAN = 'capabilities.plan.json';
const PLAN_ARG = argValue('--plan', DEFAULT_PLAN);
const PLAN_PATH = path.resolve(ROOT, PLAN_ARG);
const IS_DEFAULT_PLAN = path.resolve(ROOT, PLAN_ARG) === path.resolve(ROOT, DEFAULT_PLAN);
const GROUP = argValue('--group', null);
const SHIP = argv.includes('--ship');
const REGISTRY_PATH = path.resolve(ROOT, argValue('--registry', 'src/capabilities.ts'));
const MANIFEST_PATH = path.resolve(ROOT, argValue('--manifest', 'MCP_TOOL_MANIFEST.md'));
const failures = [];
const warnings = [];
// Non-failing, non-warning: prose that mentions a name which is not an exposed tool but IS callable
// (through hudu_invoke, or as a documented SDK method). Counted in the summary; listed with --verbose.
const mentions = [];
const VERBOSE = argv.includes('--verbose');
function fail(rule, jsonPath, reason) {
  failures.push({ rule, path: jsonPath, reason });
}
function warn(rule, jsonPath, reason) {
  warnings.push({ rule, path: jsonPath, reason });
}

// ---------------------------------------------------------------- plan
if (!existsSync(PLAN_PATH)) {
  console.error(`capabilities:check: plan not found at ${PLAN_PATH}`);
  process.exit(1);
}
const planBytes = readFileSync(PLAN_PATH);
const planHash = createHash('sha256').update(planBytes).digest('hex');
let plan;
try {
  plan = JSON.parse(planBytes.toString('utf8'));
} catch (err) {
  console.error(`capabilities:check: plan is not valid JSON: ${err.message}`);
  process.exit(1);
}
const operations = Array.isArray(plan.operations) ? plan.operations : [];
const ROW_KEYS = ['endpoint', 'primitive', 'specialOp', 'vendorFilters', 'search', 'helper', 'helperBasis', 'helperRationale', 'effect', 'flags', 'dryRun', 'metadata', 'compact', 'resolution', 'staleCheck', 'redaction', 'errors', 'tests', 'group', 'status'];

// ---------------------------------------------------------------- source index
function loadDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
    .map((n) => ({ file: path.join(abs, n), rel: path.posix.join(rel, n), text: readFileSync(path.join(abs, n), 'utf8') }));
}
const sourceModules = new Map(); // module name -> { rel, methods:Set, paginated }
function indexModule(f) {
  const key = path.basename(f.file, '.ts');
  if (key === 'index' || key === 'base') return;
  const sf = ts.createSourceFile(f.file, f.text, ts.ScriptTarget.Latest, true);
  const methods = new Set();
  let paginated = null;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'super') {
      const m = /paginated:\s*(true|false)/.exec(node.getText());
      if (m) paginated = m[1] === 'true';
    }
    if (ts.isClassDeclaration(node) && node.name) {
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m) || !m.name) continue;
        const name = m.name.getText();
        if (name === 'constructor') continue;
        const mods = (m.modifiers ?? []).map((x) => x.getText());
        if (mods.includes('private') || mods.includes('protected')) continue;
        methods.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  sourceModules.set(key, { rel: f.rel, methods, paginated });
}
for (const f of loadDir('src/resources')) indexModule(f);
for (const f of loadDir('src/operations')) indexModule(f);

function sourceMethod(opName) {
  const parts = opName.split('.');
  const resource = parts[0];
  const method = parts.slice(1).join('.');
  const mod = sourceModules.get(resource);
  if (!mod) return { ok: false, why: `no module src/resources/${resource}.ts (or src/operations/${resource}.ts)` };
  if (!mod.methods.has(method)) return { ok: false, why: `no public method ${method}() in ${mod.rel}` };
  return { ok: true, mod };
}

// Prose fields are agent-facing guidance: they are projected verbatim into the MCP tool
// descriptions an LLM reads, so every operation they tell an agent to call must be callable.
// The `X.method` shape is the same one the prose uses throughout; a reference to a resource the
// client does not expose at all is reported too ("no module ..."). sourceMethod() is reused rather
// than re-implemented: one answer to "does the client have this?".
const PROSE_FIELDS = ['purpose', 'usage', 'preferredWhen'];
const PROSE_REF = /\b([a-z_]+)\.([a-zA-Z][A-Za-z0-9_]*)\b/g;
function checkProseRefs(text, jsonPath, opName, field) {
  if (typeof text !== 'string' || text.length === 0) return;
  for (const m of text.matchAll(PROSE_REF)) {
    const ref = `${m[1]}.${m[2]}`;
    const src = sourceMethod(ref);
    if (src.ok) continue;
    fail('prose-dangling', jsonPath, `${opName}: ${field} tells an agent to call "${ref}", which the client cannot call — ${src.why}`);
  }
}

// ---------------------------------------------------------------- registry
function literalToValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalToValue);
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : p.name.getText();
      out[key] = literalToValue(p.initializer);
    }
    return out;
  }
  return undefined;
}
let registry = null;
let registryProblem = null;
if (!existsSync(REGISTRY_PATH)) {
  registryProblem = `registry file ${path.relative(ROOT, REGISTRY_PATH)} does not exist — run \`npm run capabilities:build\``;
} else {
  const text = readFileSync(REGISTRY_PATH, 'utf8');
  const sf = ts.createSourceFile(REGISTRY_PATH, text, ts.ScriptTarget.Latest, true);
  // unwrap `... as const satisfies Record<...>` so the object literal is reachable
  const unwrap = (node) => {
    let n = node;
    while (n && (ts.isSatisfiesExpression(n) || ts.isAsExpression(n) || ts.isParenthesizedExpression(n))) n = n.expression;
    return n;
  };
  let found = null;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === 'CAPABILITY_REGISTRY' && node.initializer) {
      const init = unwrap(node.initializer);
      if (init && ts.isObjectLiteralExpression(init)) found = init;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) {
    registryProblem = `could not read CAPABILITY_REGISTRY from ${path.relative(ROOT, REGISTRY_PATH)} (is it hand-edited?)`;
  } else {
    registry = new Map();
    for (const p of found.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = ts.isStringLiteral(p.name) ? p.name.text : p.name.getText();
      registry.set(name, literalToValue(p.initializer));
    }
  }
}

// ---------------------------------------------------------------- declared type names (src/types/**)
const declaredTypes = new Set();
(function scanTypes() {
  // Cross-resource helper shapes belong to the operations module, so both trees are scanned.
  for (const dir of [path.join(ROOT, 'src', 'types'), path.join(ROOT, 'src', 'operations')]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(path.join(dir, name), 'utf8');
      const re = /export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/g;
      let m;
      while ((m = re.exec(text))) declaredTypes.add(m[1]);
    }
  }
})();

// ---------------------------------------------------------------- test titles
const testTitles = new Map(); // rel path -> Set<title>
function walkTests(dir) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return;
  for (const entry of readdirSync(abs)) {
    const p = path.join(abs, entry);
    if (statSync(p).isDirectory()) { walkTests(path.join(dir, entry)); continue; }
    if (!entry.endsWith('.test.ts')) continue;
    const text = readFileSync(p, 'utf8');
    const titles = new Set();
    const re = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = re.exec(text))) titles.add(m[2]);
    testTitles.set(path.posix.join(dir, entry), titles);
  }
}
walkTests('test');
function titleExists(file, title) {
  const inFile = testTitles.get(file);
  if (!inFile) return { ok: false, why: `test file ${file} does not exist` };
  if (!inFile.has(title)) return { ok: false, why: `no test titled "${title}" in ${file}` };
  return { ok: true };
}

// ---------------------------------------------------------------- row helpers
function opNameOf(row) {
  const hasPrimitive = typeof row.primitive === 'string' && row.primitive.length > 0;
  const hasHelper = typeof row.helper === 'string' && row.helper.length > 0;
  if (hasPrimitive === hasHelper) return null;
  return hasPrimitive ? row.primitive : row.helper;
}
function isMutation(row) { return row.effect === 'write' || row.effect === 'destructive'; }
function hasDryRunTest(row) {
  return (row.tests ?? []).some((t) => `${t.id ?? ''} ${t.title ?? ''}`.toLowerCase().includes('dry-run') || `${t.id ?? ''} ${t.title ?? ''}`.toLowerCase().includes('dryrun'));
}
const UPDATE_METHODS = new Set(['update', 'updatePositions', 'moveLayout', 'archive', 'unarchive', 'duplicate']);

const scoped = operations
  .map((row, idx) => ({ row, jsonPath: `operations[${idx}]` }))
  .filter(({ row }) => !GROUP || row.group === GROUP);

// Resources that carry at least one helper row: those resources have a choice to make, so every
// one of their rows must say when it is preferred.
const resourcesWithHelpers = new Set();
for (const row of operations) {
  if (typeof row.helper === 'string' && row.helper.length) resourcesWithHelpers.add(row.helper.split('.')[0]);
}
const registryNameSet = registry ? new Set(registry.keys()) : new Set();
const RELATED_ALLOWED = registryNameSet.size ? registryNameSet : new Set(operations.map((r) => (typeof r.primitive === 'string' && r.primitive) || (typeof r.helper === 'string' && r.helper) || '').filter(Boolean));

// ---------------------------------------------------------------- per-row rules
const planNames = new Set();
const endpointIndex = new Map(); // resource + normalised endpoint -> rows
for (const { row, jsonPath } of operations.map((row, idx) => ({ row, jsonPath: `operations[${idx}]` }))) {
  for (const key of ROW_KEYS) {
    if (!(key in row)) fail('missing-key', jsonPath, `row is missing the required key "${key}" (every key is present on every row; null is the explicit "none")`);
  }
  const name = opNameOf(row);
  if (!name) {
    fail('malformed-row', jsonPath, `exactly one of primitive/helper must be non-null — got primitive=${JSON.stringify(row.primitive)}, helper=${JSON.stringify(row.helper)}`);
    continue;
  }
  planNames.add(name);
  // Prose is checked for EVERY row, not only the scoped ones: a prose field that names a method
  // the client does not have is wrong whatever group gate is being run.
  for (const field of PROSE_FIELDS) {
    checkProseRefs(row.metadata ? row.metadata[field] : null, `${jsonPath}.metadata.${field}`, name, field);
  }
  if (row.endpoint) {
    const ep = `${row.endpoint.split(' ')[0]} ${row.endpoint.split(' ').slice(1).join(' ')}`.replace(/\s+/g, ' ').replace(/\/\d+/g, '/{id}');
    const key = `${name.split('.')[0]}#${ep}`;
    if (!endpointIndex.has(key)) endpointIndex.set(key, []);
    endpointIndex.get(key).push({ name, jsonPath });
  }
}

for (const { row, jsonPath } of scoped) {
  const name = opNameOf(row);
  if (!name) continue; // already reported as malformed-row
  const built = row.status === 'implemented' || row.status === 'tested';

  // coverage / registration
  if (built) {
    const src = sourceMethod(name);
    if (!src.ok) fail('coverage-source-missing', jsonPath, `${name}: ${src.why}`);
    if (registry && !registry.has(name)) fail('coverage-registry', jsonPath, `${name} is ${row.status} but has no record in ${path.relative(ROOT, REGISTRY_PATH)}`);
  } else if (row.status !== 'planned') {
    warn('unknown-status', jsonPath, `${name}: status="${row.status}" is not one of planned|implemented|tested`);
  }

  // batch / ship status
  if (SHIP) {
    if (row.status !== 'tested') fail('ship-status', jsonPath, `${name}: status="${row.status}" — under --ship every row must be "tested"`);
  } else if (GROUP === null && row.status === 'planned') {
    // tolerated by design: the coordinator sanity check runs while later groups are still planned
  } else if (row.status === 'planned') {
    fail('batch-status', jsonPath, `${name}: status="planned"${GROUP ? ` in group ${GROUP}` : ''} — a batch gate requires "implemented" or "tested"`);
  }

  // mutation safety
  if (isMutation(row)) {
    if (!row.effect) fail('mutation-effect', jsonPath, `${name}: a mutation has no effect`);
    if (row.dryRun !== true) fail('mutation-dryRun', jsonPath, `${name}: a mutation needs dryRun:true, got ${JSON.stringify(row.dryRun)}`);
    if (row.staleCheck === null || row.staleCheck === undefined || row.staleCheck === '') {
      fail('staleCheck', jsonPath, `${name}: a mutation needs a staleCheck value — the field name it checks, or the explicit "unavailable"`);
    }
    if (row.effect === 'destructive') {
      if (!hasDryRunTest(row)) fail('impact-bound', jsonPath, `${name}: destructive operation with no recorded impact bound — declare a dry-run test row that asserts { affected, scope, reversible }`);
      if (!(row.flags ?? []).includes('requiresApproval')) warn('impact-flag', jsonPath, `${name}: destructive without the requiresApproval flag (§7.1 classifies deletes as requiresApproval)`);
    }
    const method = name.split('.').slice(1).join('.');
    if (UPDATE_METHODS.has(method) && !hasDryRunTest(row)) {
      fail('dryrun-shape', jsonPath, `${name}: dry-run of an update must record the warnings/diff contract — no dry-run test row declared`);
    }
  } else if (row.effect === 'read' && row.dryRun === true) {
    warn('read-dryRun', jsonPath, `${name}: read operation with dryRun:true (policy: dryRun is false for reads)`);
  }

  // classification: redaction vocabulary
  if (row.redaction !== 'none' && row.redaction !== 'credentials') {
    fail('redaction-value', `${jsonPath}.redaction`, `${name}: redaction must be exactly "none" or "credentials", got ${JSON.stringify(row.redaction)}`);
  }

  // resolution: a cap must exist, on both bases
  if (row.resolution !== null && row.resolution !== undefined) {
    const res = row.resolution;
    const badCap = !Number.isFinite(Number(res.maxScanRecords)) || Number(res.maxScanRecords) <= 0
      || !Number.isFinite(Number(res.maxScanPages)) || Number(res.maxScanPages) <= 0;
    if (res.basis === 'client-scan' && badCap) {
      fail('resolution-caps', `${jsonPath}.resolution`, `${name}: a client-scan needs maxScanRecords and maxScanPages > 0, got ${JSON.stringify(res)}`);
    } else if (res.basis === 'server-filter' && badCap) {
      fail('resolution-caps', `${jsonPath}.resolution`, `${name}: a server-filter resolution must still declare its caps (maxScanRecords, maxScanPages), got ${JSON.stringify(res)}`);
    } else if (res.basis !== 'server-filter' && res.basis !== 'client-scan') {
      // `composite` / `workflow` helpers compose calls instead of scanning; they carry no scan cap.
      warn('resolution-basis', `${jsonPath}.resolution.basis`, `${name}: basis ${JSON.stringify(res.basis)} is neither "server-filter" nor "client-scan"`);
    }
  }

  // errors: vocabulary + the codes the SDK raises for this shape
  const rowErrors = Array.isArray(row.errors) ? row.errors : [];
  rowErrors.forEach((code, i) => {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code)) {
      fail('errors-vocabulary', `${jsonPath}.errors[${i}]`, `${name}: "${code}" is not SCREAMING_SNAKE`);
    }
  });
  if (!rowErrors.includes('CONFIG_ERROR')) {
    fail('errors-vocabulary', `${jsonPath}.errors`, `${name}: CONFIG_ERROR is missing — the SDK raises it for every operation shape`);
  }
  if (row.staleCheck === 'updated_at' && !rowErrors.includes('STALE_OBJECT')) {
    fail('errors-vocabulary', `${jsonPath}.errors`, `${name}: staleCheck is updated_at, so the row must list STALE_OBJECT`);
  }

  // compact: a shape name must be a declared exported type
  if (row.compact !== null && row.compact !== undefined && !declaredTypes.has(String(row.compact))) {
    fail('compact-shape-unknown', `${jsonPath}.compact`, `${name}: compact names "${row.compact}", which is not an exported interface/type in src/types/**`);
  }

  // related: no dangling edges
  const related = row.metadata && Array.isArray(row.metadata.related) ? row.metadata.related : [];
  related.forEach((target, i) => {
    if (!RELATED_ALLOWED.has(target)) {
      fail('related-dangling', `${jsonPath}.metadata.related[${i}]`, `${name}: related names "${target}", which has no registry record`);
    }
  });

  // preferredWhen: a resource with a helper has a choice to make on every one of its rows
  const owningResource = name.split('.')[0];
  if (resourcesWithHelpers.has(owningResource) && !(row.metadata && row.metadata.preferredWhen)) {
    fail('preferredWhen-required', `${jsonPath}.metadata.preferredWhen`, `${name}: ${owningResource} has helper operations, so this row must record when it is preferred`);
  }

  // metadata completeness on the row
  const isHelper = typeof row.helper === 'string' && row.helper.length > 0;
  if (isHelper) {
    if (!row.helperRationale) fail('helper-rationale', jsonPath, `${name}: helper has no helperRationale (the admission rule requires one)`);
    if (!Array.isArray(row.tests) || row.tests.length === 0) fail('helper-tests', jsonPath, `${name}: helper has no test rows`);
    const usage = row.metadata ? row.metadata.usage : null;
    if (!usage) fail('helper-usage', jsonPath, `${name}: helper has no usage guidance`);
  }
  const testRows = Array.isArray(row.tests) ? row.tests : [];
  if (row.status === 'implemented' && testRows.length === 0) {
    fail('implemented-tests', jsonPath, `${name}: status="implemented" with an empty tests array (rows must be declared before the Tests stage)`);
  }
  testRows.forEach((t, i) => {
    if (!t || !t.id || !t.file || !t.title) fail('test-row', `${jsonPath}.tests[${i}]`, `${name}: test row must be {id, file, title}`);
  });
  if (row.status === 'tested') {
    if (testRows.length === 0) fail('implemented-tests', jsonPath, `${name}: status="tested" with no test rows`);
    testRows.forEach((t, i) => {
      if (!t || !t.file || !t.title) return;
      const r = titleExists(t.file, t.title);
      if (!r.ok) fail('test-title', `${jsonPath}.tests[${i}]`, `${name}: ${r.why} (a row at "tested" must have a test with that exact title)`);
    });
  }

  // preferredWhen: siblings share a normalised endpoint
  if (row.endpoint) {
    const ep = `${row.endpoint.split(' ')[0]} ${row.endpoint.split(' ').slice(1).join(' ')}`.replace(/\s+/g, ' ').replace(/\/\d+/g, '/{id}');
    const siblings = endpointIndex.get(`${name.split('.')[0]}#${ep}`) ?? [];
    if (siblings.length > 1 && !row.metadata?.preferredWhen) {
      fail('preferredWhen', jsonPath, `${name}: shares its endpoint with ${siblings.filter((s) => s.name !== name).map((s) => s.name).join(', ')} but records no preferredWhen`);
    }
  }
}

// ---------------------------------------------------------------- registry rules
if (registry) {
  for (const [name, rec] of registry) {
    if (!planNames.has(name)) fail('registry-orphan', `CAPABILITY_REGISTRY['${name}']`, `record names an operation that is not in the plan (${path.relative(ROOT, PLAN_PATH)})`);
    if (!rec || typeof rec !== 'object') continue;
    if (!Array.isArray(rec.examples) || rec.examples.length === 0) fail('record-examples', `CAPABILITY_REGISTRY['${name}'].examples`, 'every operation has at least one realistic call');
    if (typeof rec.permissions !== 'string' || rec.permissions.length === 0) fail('record-permissions', `CAPABILITY_REGISTRY['${name}'].permissions`, 'permissions is missing or empty — the literal "unknown" is acceptable, an absent field is not');
    if (rec.purpose === null) warn('record-purpose', `CAPABILITY_REGISTRY['${name}'].purpose`, 'purpose is null (Architect judgement column unfilled)');
    const planRow = operations.find((r) => r.primitive === name || r.helper === name);
    // errors vocabulary is gated on the EMITTED record too: the registry is what consumers read.
    const recErrors = Array.isArray(rec.errors) ? rec.errors : [];
    recErrors.forEach((code, i) => {
      if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(code)) {
        fail('errors-vocabulary', `CAPABILITY_REGISTRY['${name}'].errors[${i}]`, `${name}: "${code}" is not SCREAMING_SNAKE`);
      }
    });
    if (!recErrors.includes('CONFIG_ERROR')) {
      fail('errors-vocabulary', `CAPABILITY_REGISTRY['${name}'].errors`, `${name}: the emitted record omits CONFIG_ERROR, which the SDK raises for every operation shape`);
    }
    if (planRow && planRow.staleCheck === 'updated_at' && !recErrors.includes('STALE_OBJECT')) {
      fail('errors-vocabulary', `CAPABILITY_REGISTRY['${name}'].errors`, `${name}: staleCheck is updated_at, so the emitted record must list STALE_OBJECT`);
    }
    // prose references are gated on the EMITTED record too: the record is what the MCP projection
    // and the consumers read, so a hand-edited generated file must not smuggle a bad name back in.
    for (const field of PROSE_FIELDS) {
      checkProseRefs(rec[field], `CAPABILITY_REGISTRY['${name}'].${field}`, name, field);
    }
    // related edges are gated on the EMITTED record too.
    const recRelated = Array.isArray(rec.related) ? rec.related : [];
    recRelated.forEach((target, i) => {
      if (!registryNameSet.has(target)) {
        fail('related-dangling', `CAPABILITY_REGISTRY['${name}'].related[${i}]`, `${name}: the emitted record points at "${target}", which has no registry record`);
      }
    });
    // The same rule, driven by the PLAN's `inputSchemaOmit`: a field the operation cannot honour
    // must not survive into the emitted record (magic_dash.create's `company_id`, a GET-only filter
    // the vendor answers with HTTP 500 on a write). Checking the EMITTED schema too means a
    // hand-edited generated file cannot smuggle the field back in.
    const omitFields = Array.isArray(planRow?.inputSchemaOmit) ? planRow.inputSchemaOmit : [];
    for (const omitted of omitFields) {
      if (typeof omitted !== 'string' || omitted.length === 0) {
        fail('inputSchema-conditional-field', `operations[...] ${name}`, `${name}: inputSchemaOmit entries must be non-empty field names, got ${JSON.stringify(omitted)}`);
        continue;
      }
      if (JSON.stringify(rec.inputSchema ?? {}).includes(`"name":"${omitted}"`)) {
        fail('inputSchema-conditional-field', `CAPABILITY_REGISTRY['${name}'].inputSchema`, `${name}: still advertises \`${omitted}\`, which the plan row marks as not honourable by this operation (inputSchemaOmit)`);
      }
    }
    // an operation-conditional field must not be advertised by an operation that rejects it.
    if (JSON.stringify(rec.inputSchema ?? {}).includes('expectedUpdatedAt')) {
      const method = name.split('.').slice(1).join('.');
      const updateShaped = rec.kind === 'helper' ? /^(update|set|patch|move)[A-Za-z0-9_]*$/.test(method) : method === 'update';
      if (!updateShaped) {
        fail('inputSchema-conditional-field', `CAPABILITY_REGISTRY['${name}'].inputSchema`, `${name}: advertises expectedUpdatedAt, which base.ts assertNoExpectedUpdatedAt rejects outside an update operation`);
      }
    }
    // examples must show calls that work: only an update row may pass expectedUpdatedAt, because
    // BaseResource.assertNoExpectedUpdatedAt throws CONFIG_ERROR before the dry-run branch.
    if (Array.isArray(rec.examples)) {
      rec.examples.forEach((ex, i) => {
        if (typeof ex === 'string' && ex.includes('expectedUpdatedAt')) {
          const isUpdate = name.endsWith('.update') && planRow && planRow.staleCheck === 'updated_at';
          if (!isUpdate) {
            fail('example-expectedUpdatedAt', `CAPABILITY_REGISTRY['${name}'].examples[${i}]`, `${name}: the example passes expectedUpdatedAt, which throws CONFIG_ERROR for every primitive except an update row with staleCheck updated_at`);
          }
        }
      });
    }
    // pagination: present, and never "page" + nonPaginated at once
    const pag = rec.pagination;
    if (!pag || typeof pag !== 'object') {
      fail('pagination', `CAPABILITY_REGISTRY['${name}'].pagination`, `${name}: a record must carry a pagination object`);
    } else {
      if (pag.nonPaginated === true && pag.mode === 'page') {
        fail('pagination', `CAPABILITY_REGISTRY['${name}'].pagination`, `${name}: nonPaginated is true while mode is "page" — the two cannot both hold`);
      }
      if (name.endsWith('.list') && !pag.mode) {
        fail('pagination', `CAPABILITY_REGISTRY['${name}'].pagination.mode`, `${name}: a list primitive must state its pagination mode`);
      }
      if (pag.nonPaginated === false && !(Number(pag.maxPageSize) > 0)) {
        fail('pagination', `CAPABILITY_REGISTRY['${name}'].pagination.maxPageSize`, `${name}: a paginated operation needs a positive maxPageSize bound`);
      }
      // A bound must say WHERE it came from: a vendor-declared maximum and a self-imposed client
      // cap must never be confusable.
      if (pag.mode === 'page') {
        if (pag.maxPageSizeSource !== 'api-docs' && pag.maxPageSizeSource !== 'default') {
          fail('pagination', `CAPABILITY_REGISTRY['${name}'].pagination.maxPageSizeSource`, `${name}: maxPageSize needs a source label ("api-docs" | "default"), got ${JSON.stringify(pag.maxPageSizeSource)}`);
        }
        if (pag.maxPageSizeSource === 'api-docs' && !(Number(pag.maxPageSize) > 0)) {
          fail('pagination', `CAPABILITY_REGISTRY['${name}'].pagination.maxPageSize`, `${name}: the source claims api-docs but the bound is ${JSON.stringify(pag.maxPageSize)}`);
        }
      }
    }
    // every inputSchema field object carries the `name` key CapabilityField declares
    const walkFields = (node, jsonPath, key) => {
      if (Array.isArray(node)) { node.forEach((v, i) => walkFields(v, `${jsonPath}[${i}]`, key)); return; }
      if (!node || typeof node !== 'object') return;
      if (key !== 'items' && key !== 'additionalProperties' && ('type' in node || 'typeName' in node || 'fields' in node)) {
        if (typeof node.name !== 'string' || node.name.length === 0) {
          fail('inputSchema-name', `${jsonPath}${key ? '.' + key : ''}`, `${name}: an inputSchema field object omits the \`name\` key (CapabilityField declares name: string)`);
        }
      }
      for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walkFields(v, jsonPath, k);
    };
    for (const [fieldName, fieldNode] of Object.entries(rec.inputSchema ?? {})) {
      walkFields(fieldNode, `CAPABILITY_REGISTRY['${name}'].inputSchema`, fieldName);
    }
    // An unresolvable object must never be published in a public inputSchema (F5/SEC-1): the
    // invoke validator would refuse exactly the shape the schema tells a caller to pass. Three
    // visible markers: (1) an `items` node that carries a typeName — the generator's item
    // projection keeps a name only when resolution failed, so a named object item IS an
    // unresolvable-and-named emission; (2) any node the generator marked resolved:false; (3) a
    // DETAIL-LESS object item OUTSIDE the record payload, which is the shape the reproduced defect
    // actually emitted (`items: {"type":"object"}` with the name dropped, which markers 1-2 cannot
    // see — the projection is exactly what lost the evidence). An authored position carries no
    // legitimate bare object item: either the type resolved (then its fields are known) or it did
    // not (then the caller is told to pass an object the validator cannot check).
    // `.inputSchema.data` is excluded: that subtree is the vendor's RECORD payload, where a
    // free-form object item is the vendor's own shape (13 such items are shipped today). The
    // exclusion costs nothing for the defect class: an UNRESOLVABLE ARRAY ITEM carries its
    // typeName wherever it sits, so marker (1) still catches it inside `.data`; marker (3) exists
    // for the case where the item projection regresses and drops that evidence again.
    // Platform binary names are excluded, mirroring the generator's opaqueSchemaNodes policy.
    const UNRESOLVED_PLATFORM_OPAQUE = new Set(['Blob', 'File', 'Buffer', 'ArrayBuffer', 'ReadableStream', 'Uint8Array', 'Date']);
    const walkUnresolved = (node, jsonPath, key) => {
      if (!node || typeof node !== 'object') return;
      // Arrays keep the key so reported paths stay precise (`...fields.0.items`, not `...fields`);
      // the `.data` exclusion works either way, because a `.data` node is never itself an array.
      const here = key === undefined || key === '' ? jsonPath : `${jsonPath}.${key}`;
      const named = typeof node.typeName === 'string' && node.typeName.length > 0
        && !node.typeName.startsWith('{') && !node.typeName.startsWith('(');
      const platformOpaque = named && UNRESOLVED_PLATFORM_OPAQUE.has(node.typeName);
      const marked = node.resolved === false;
      const unresolvedItem = key === 'items' && node.type === 'object' && named && !platformOpaque;
      // A bare `items`/`additionalProperties` object node outside the vendor payload: no name, no
      // fields, no enum, no nested shape — nothing a caller or the validator can act on.
      const bareObjectNode = (key === 'items' || key === 'additionalProperties') && node.type === 'object';
      const bareAuthoredItem = bareObjectNode && !named
        && node.enum === undefined && node.fields === undefined && node.additionalProperties === undefined
        && !/\.inputSchema\.data(\.|$)/.test(here);
      if (unresolvedItem || marked || bareAuthoredItem) {
        const detail = bareAuthoredItem
          ? 'a detail-less object item OUTSIDE the record payload — an authored parameter position cannot legitimately advertise an untyped object, so the item projection dropped the resolution evidence'
          : `a named unresolvable object (typeName=${JSON.stringify(node.typeName ?? null)})`;
        fail('inputSchema-unresolved-item', here,
          `${name}: a published inputSchema ${key === 'items' ? 'item' : 'node'} is ${detail} — the invoke validator would refuse the shape the schema advertises`);
      }
      for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walkUnresolved(v, here, k);
    };
    for (const [fieldName, fieldNode] of Object.entries(rec.inputSchema ?? {})) {
      walkUnresolved(fieldNode, `CAPABILITY_REGISTRY['${name}'].inputSchema`, fieldName);
    }
    const outSchema = rec.outputSchema && typeof rec.outputSchema === 'object' ? rec.outputSchema : {};
    const claimsDrops = 'drops' in outSchema || 'dropsUnresolved' in outSchema;
    if (rec.compact) {
      if (outSchema.dropsUnresolved === true) {
        fail('helper-compact-drops', `CAPABILITY_REGISTRY['${name}'].outputSchema.dropsUnresolved`, `compact shape "${rec.compact}" is declared but the full record type could not be resolved — drops cannot be named honestly`);
      } else if (!Array.isArray(outSchema.drops)) {
        fail('helper-compact-drops', `CAPABILITY_REGISTRY['${name}'].outputSchema.drops`, `compact shape "${rec.compact}" must carry a drops array (an empty array is valid when the compact shape keeps every field)`);
      }
    } else if (claimsDrops) {
      fail('helper-compact-drops', `CAPABILITY_REGISTRY['${name}'].outputSchema`, 'compact is null but the record carries a drops claim — a record without a compact shape makes no drops claim');
    }
  }
}

// ---------------------------------------------------------------- unplanned surface (warning)
const registryNames = registry ? new Set(registry.keys()) : new Set();
for (const [mod, info] of sourceModules) {
  for (const method of info.methods) {
    const opName = `${mod}.${method}`;
    if (!planNames.has(opName) && !registryNames.has(opName)) {
      warn('unplanned-surface', `${info.rel} → ${opName}`, 'public method appears in neither the plan nor the registry — unplanned surface');
    }
  }
}

// ---------------------------------------------------------------- emission rules
if (IS_DEFAULT_PLAN) {
  const capJson = path.join(ROOT, 'capabilities.json');
  if (!existsSync(capJson)) {
    fail('emission-missing', 'capabilities.json', 'not emitted — run `npm run capabilities:build`');
  } else {
    let emitted = null;
    try { emitted = JSON.parse(readFileSync(capJson, 'utf8')); } catch (err) { fail('emission-json', 'capabilities.json', `not valid JSON: ${err.message}`); }
    if (emitted && emitted.planHash !== planHash) {
      fail('emission-planhash', 'capabilities.json.planHash', `stale: emitted ${emitted.planHash}, plan is ${planHash} — re-run \`npm run capabilities:build\``);
    }
  }
  if (!existsSync(path.join(ROOT, 'capabilities.schema.json'))) fail('emission-missing', 'capabilities.schema.json', 'not emitted — run `npm run capabilities:build`');
  if (registryProblem) fail('emission-missing', 'src/capabilities.ts', registryProblem);

  // The MCP projection pins the planHash and a record count at generation time, so it goes stale
  // silently whenever the registry is rebuilt. Gate it: a stale manifest tells an integrator that
  // helpers are unbuilt when they exist (and vice versa).
  const manifestRel = path.relative(ROOT, MANIFEST_PATH);
  if (!existsSync(MANIFEST_PATH)) {
    fail('manifest-planhash', manifestRel, 'not emitted — run `npm run mcp:project`');
  } else {
    const manifestText = readFileSync(MANIFEST_PATH, 'utf8');
    const hashMatch = /planHash\s+`([0-9a-f]{64})`/.exec(manifestText);
    if (!hashMatch) {
      fail('manifest-planhash', `${manifestRel} (header)`, 'carries no planHash — regenerate with `npm run mcp:project`');
    } else if (hashMatch[1] !== planHash) {
      fail('manifest-planhash', `${manifestRel} (header planHash)`, `stale: manifest pins ${hashMatch[1]}, plan is ${planHash} — re-run \`npm run mcp:project\``);
    }
    const countMatch = /registry records:\s*(\d+)/.exec(manifestText);
    const registryRecordCount = registry ? registry.size : null;
    if (!countMatch) {
      fail('manifest-planhash', `${manifestRel} (record count)`, 'states no registry record count — regenerate with `npm run mcp:project`');
    } else if (registryRecordCount !== null && Number(countMatch[1]) !== registryRecordCount) {
      fail('manifest-planhash', `${manifestRel} (record count)`, `claims ${countMatch[1]} registry records but the registry holds ${registryRecordCount} — the projection is stale, re-run \`npm run mcp:project\``);
    }
  }
} else {
  console.log(`capabilities:check — --plan ${PLAN_ARG}: emission rules (planHash comparison, emitted-file presence) are SKIPPED by design so a fixture can exercise the other rules.`);
}

// ---------------------------------------------------------------- progressive disclosure (catalog / core profile)
// Build-order step 4. The generated catalog (`src/mcp/catalog.generated.ts`, written by
// `scripts/build-tool-catalog.mjs` from the projection) is what makes every registry operation
// discoverable, and the CORE profile is what a client actually pays for on every turn. Both rot
// silently unless they are gated, so they are gated here:
//   catalog-planhash        the generated catalog is stale (planHash mismatch) — it was built from
//                           a different plan than the registry this gate holds
//   catalog-reachability    a registry operation has no catalog row, or a row with no tool and no
//                           reason (an unexposed capability indistinguishable from a missing one)
//   catalog-op-exists       a catalog row names an operation that is not a registry key, an exposed
//                           tool that is not in the curated projection, or a refusal for an
//                           operation that is in fact exposed
//   invoke-refusals         an operation excluded by the projection rule (unbounded read, binary
//                           surface) is not refused with a reason, so the escape hatch could call it
//   core-workflow-coverage  CORE misses a read entry for a group-A workflow resource, or misses the
//                           META tools / the cross-resource helpers (measured today: 9/9 resources)
//   core-budget             the CORE tools/list payload exceeds its token budget (the whole point
//                           of the profile: it cannot creep back to the flat 147-tool surface)
const CATALOG_PATH = path.resolve(ROOT, argValue('--catalog', 'src/mcp/catalog.generated.ts'));
const CORE_BUDGET_BYTES = 32000; // ~8,000 tokens at the measured ratio; today's CORE is far under it
const catalogRel = path.relative(ROOT, CATALOG_PATH);
let catalogData = null;
if (!existsSync(CATALOG_PATH)) {
  fail('catalog-reachability', catalogRel, 'not emitted — run `node scripts/build-tool-catalog.mjs`');
} else {
  const text = readFileSync(CATALOG_PATH, 'utf8');
  const sf = ts.createSourceFile(CATALOG_PATH, text, ts.ScriptTarget.Latest, true);
  const found = {};
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (['CATALOG', 'CATALOG_PLAN_HASH', 'EXPOSED', 'REFUSALS', 'CORE_TOOLS', 'META_TOOLS', 'CORE_RULE', 'SEARCH_MODES', 'SEARCH_RESOURCES', 'SEARCH_HELP', 'TOOL_DESCRIPTIONS'].includes(node.name.text)) {
        found[node.name.text] = literalToValue(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const missing = ['CATALOG', 'CATALOG_PLAN_HASH', 'EXPOSED', 'REFUSALS', 'CORE_TOOLS', 'META_TOOLS'].filter((k) => found[k] === undefined);
  if (missing.length) {
    fail('catalog-reachability', catalogRel, `the generated catalog is missing ${missing.join(', ')} — regenerate with \`node scripts/build-tool-catalog.mjs\``);
  } else {
    catalogData = found;
  }
}
// The curated projection, as the manifest publishes it (machine-readable block). One source: the
// gate never re-derives the projection, it reads what `npm run mcp:project` emitted.
const projectionRows = (() => {
  if (!existsSync(MANIFEST_PATH)) return [];
  const text = readFileSync(MANIFEST_PATH, 'utf8');
  const at = text.indexOf('## Machine-readable projection');
  if (at === -1) return [];
  const fence = text.indexOf('```json', at);
  if (fence === -1) return [];
  const body = text.slice(fence + '```json'.length, text.indexOf('```', fence + 7));
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();
if (catalogData) {
  if (!projectionRows.length) {
    fail('catalog-op-exists', path.relative(ROOT, MANIFEST_PATH), 'no machine-readable projection block — regenerate with `npm run mcp:project`');
  }
  if (catalogData.CATALOG_PLAN_HASH !== planHash) {
    fail('catalog-planhash', `${catalogRel} (planHash)`, `stale: pins ${catalogData.CATALOG_PLAN_HASH}, plan is ${planHash} — re-run \`node scripts/build-tool-catalog.mjs\``);
  }
  const registryNames = registry ? new Set(registry.keys()) : new Set();
  const projectedNames = new Set(projectionRows.map((r) => r.name));
  const projectedByOperation = new Map(projectionRows.map((r) => [r.backingOperation, r]));
  const catalogOps = new Set();
  for (const row of catalogData.CATALOG) {
    catalogOps.add(row.op);
    if (!registryNames.has(row.op)) {
      fail('catalog-op-exists', `${catalogRel} (CATALOG)`, `${row.op}: not a CAPABILITY_REGISTRY key`);
      continue;
    }
    if (row.tool !== null && !projectedNames.has(row.tool)) {
      fail('catalog-op-exists', `${catalogRel} (CATALOG)`, `${row.op}: names tool ${row.tool}, which is not in the curated projection`);
    }
    if (projectedByOperation.has(row.op) && row.tool === null) {
      fail('catalog-op-exists', `${catalogRel} (CATALOG)`, `${row.op}: has no tool, but the projection exposes ${projectedByOperation.get(row.op).name} for it`);
    }
    if (row.tool === null && (typeof row.reason !== 'string' || row.reason.length === 0)) {
      fail('catalog-reachability', `${catalogRel} (CATALOG)`, `${row.op}: no tool and no reason — an unexposed capability must say why it is reachable, or be refused with a reason`);
    }
    if (row.dry_run !== (row.effect !== 'read')) {
      fail('catalog-reachability', `${catalogRel} (CATALOG)`, `${row.op}: dry_run=${row.dry_run} disagrees with effect=${row.effect}`);
    }
  }
  for (const name of registryNames) {
    if (!catalogOps.has(name)) {
      fail('catalog-reachability', `${catalogRel} (CATALOG)`, `${name}: no catalog row — an operation with no row is indistinguishable from one that does not exist`);
    }
  }
  for (const [op, tool] of Object.entries(catalogData.EXPOSED)) {
    if (!registryNames.has(op)) fail('catalog-op-exists', `${catalogRel} (EXPOSED)`, `${op}: not a CAPABILITY_REGISTRY key`);
    if (!projectedNames.has(tool)) fail('catalog-op-exists', `${catalogRel} (EXPOSED)`, `${op} -> ${tool}: not in the curated projection`);
    const row = catalogData.CATALOG.find((r) => r.op === op);
    if (!row || row.tool !== tool) fail('catalog-op-exists', `${catalogRel} (EXPOSED)`, `${op} -> ${tool}: CATALOG does not agree (row tool=${row ? row.tool : '<no row>'})`);
  }
  // invoke refusals: every operation the projection excludes BY RULE must be refused, with a reason
  for (const [op, refusal] of Object.entries(catalogData.REFUSALS)) {
    if (!registryNames.has(op)) fail('catalog-op-exists', `${catalogRel} (REFUSALS)`, `${op}: not a CAPABILITY_REGISTRY key`);
    if (refusal.reachable !== false) fail('invoke-refusals', `${catalogRel} (REFUSALS)`, `${op}: a refusal must carry reachable: false`);
    if (typeof refusal.reason !== 'string' || refusal.reason.length === 0) fail('invoke-refusals', `${catalogRel} (REFUSALS)`, `${op}: refused with no reason`);
    if (projectedNames.has(catalogData.EXPOSED[op])) fail('invoke-refusals', `${catalogRel} (REFUSALS)`, `${op}: refused, but it IS exposed as a tool`);
    const row = catalogData.CATALOG.find((r) => r.op === op);
    if (row && row.reachable !== false) fail('invoke-refusals', `${catalogRel} (CATALOG)`, `${op}: refused in REFUSALS but reachable in CATALOG`);
  }
  // the projection rule itself: unbounded reads and binary surfaces are never exposed, so they must
  // always be refused through invoke — otherwise the escape hatch bypasses the rule.
  const excludedByProjectionRule = projectionRows.length
    ? [...registryNames].filter((op) => !projectedNames.has(op) && (op.split('.').slice(1).join('.').match(/^(listAll|listPages)$/) || ['photos', 'public_photos', 'uploads', 'exports', 's3_exports'].includes(op.split('.')[0])))
    : [];
  for (const op of excludedByProjectionRule) {
    if (catalogData.REFUSALS[op] === undefined) {
      fail('invoke-refusals', `${catalogRel} (REFUSALS)`, `${op}: excluded by the projection rule (unbounded read / binary surface) but not refused through the escape hatch`);
    }
  }
  // CORE profile
  const coreNames = catalogData.CORE_TOOLS;
  const metaNames = catalogData.META_TOOLS.map((m) => m.name);
  if (coreNames.length === 0) fail('core-workflow-coverage', `${catalogRel} (CORE_TOOLS)`, 'empty CORE profile');
  for (const meta of metaNames) {
    if (!coreNames.includes(meta)) fail('core-workflow-coverage', `${catalogRel} (CORE_TOOLS)`, `${meta}: the META tools are R1 of the core rule and must be in CORE`);
    if (projectedNames.has(meta)) fail('core-workflow-coverage', `${catalogRel} (META_TOOLS)`, `${meta}: a META tool name collides with a curated tool`);
    const spec = catalogData.META_TOOLS.find((m) => m.name === meta);
    if (typeof spec.description !== 'string' || spec.description.length < 40) fail('core-workflow-coverage', `${catalogRel} (META_TOOLS)`, `${meta}: no usable description`);
  }
  if (!/SUBSET/.test(JSON.stringify(catalogData.META_TOOLS))) {
    fail('core-workflow-coverage', `${catalogRel} (META_TOOLS)`, 'no META tool description states that the tool list is a SUBSET of the registry — the honesty contract of the catalog');
  }
  const groupAResources = [...new Set(operations.filter((row) => row.group === 'A').map((row) => String(row.primitive ?? '').split('.')[0]))].filter((r) => r && r !== 'undefined');
  for (const resource of groupAResources) {
    const covered = coreNames.some((name) => {
      const row = projectionRows.find((r) => r.name === name);
      return row && row.effect === 'read' && String(row.backingOperation).split('.')[0] === resource;
    });
    if (!covered) {
      fail('core-workflow-coverage', `${catalogRel} (CORE_TOOLS)`, `${resource}: group A (workflow resource) has no read entry in CORE`);
    }
  }
  const crossResource = coreNames.some((name) => {
    const row = projectionRows.find((r) => r.name === name);
    return row && String(row.backingOperation).startsWith('operations.');
  });
  if (!crossResource) fail('core-workflow-coverage', `${catalogRel} (CORE_TOOLS)`, 'no cross-resource helper in CORE (rule R3)');
  // core budget: the client-visible tools/list payload for the core profile
  const corePayload = coreNames.map((name) => {
    const row = projectionRows.find((r) => r.name === name);
    if (row) return { name: row.name, description: row.description, inputSchema: row.inputSchema, outputSchema: row.outputSchema, annotations: row.annotations };
    const meta = catalogData.META_TOOLS.find((m) => m.name === name);
    return meta ? { name: meta.name, title: meta.title, description: meta.description, inputSchema: meta.inputSchema } : null;
  });
  const unknownCoreTools = coreNames.filter((name) => corePayload[coreNames.indexOf(name)] === null);
  for (const name of unknownCoreTools) {
    fail('core-budget', `${catalogRel} (CORE_TOOLS)`, `${name}: not a curated tool and not a META tool`);
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify(corePayload.filter((r) => r !== null)));
  if (payloadBytes > CORE_BUDGET_BYTES) {
    fail('core-budget', `${catalogRel} (CORE_TOOLS)`, `the CORE tools/list payload is ${payloadBytes} bytes (> ${CORE_BUDGET_BYTES} ≈ 8k tokens) — the profile is creeping back toward the flat surface`);
  } else {
    console.log(`capabilities:check — CORE profile: ${coreNames.length} tools, tools/list payload ${payloadBytes} bytes (budget ${CORE_BUDGET_BYTES}; the curated surface a client would otherwise carry is ${Buffer.byteLength(JSON.stringify(projectionRows))} bytes / ${projectionRows.length} tools)`);
  }
}


// ---------------------------------------------------------------- prose vs the PROJECTION
//   prose-dangling-projection  prose that reaches an MCP client names a tool or an operation no
//                            client can call. A name that IS callable another way (through
//                            hudu_invoke, or as a documented SDK method of this package) is
//                            COUNTED, not warned — a tool description saying what it wraps is not a
//                            defect (measured: warning on it added 189 lines to every run). Two surfaces are scanned, because both are text an
//                            agent actually reads:
//                              (1) the curated projection's OWN tool descriptions (the
//                                  machine-readable block of MCP_TOOL_MANIFEST.md) — the text a
//                                  client lists, and the only place a `hudu_*` tool NAME appears;
//                              (2) the plan rows' and registry records' prose fields
//                                  (purpose/usage/preferredWhen), which the generated catalog
//                                  (`when`/`summary`) and `hudu_describe` republish.
//                            A reference is either a `hudu_*` tool name or a `resource.method`
//                            operation name. Verdicts:
//                              FAIL  a `hudu_*` name no projected tool has (a `*`/`<...>`/`_`
//                                    shape is a PATTERN, not a name, and is skipped);
//                              FAIL  an operation the generated catalog REFUSES
//                                    (`reachable: false`): hudu_invoke refuses it too, so no client
//                                    can call it at all;
//                              FAIL  an operation neither the client nor the catalog knows — the
//                                    client-side `prose-dangling` rule scans the plan and the
//                                    registry records only, so a description override's text is
//                                    otherwise unchecked;
//                              WARN  an operation that exists but has no tool of its own (curated
//                                    out as a duplicate outcome, reachable through `hudu_invoke`):
//                                    a real capability whose NAME is not a tool name;
//                              WARN  a client method with no registry record at all (not a
//                                    capability, only reachable from SDK code).
//                            Composition with `prose-dangling`: that rule asks "does the CLIENT have
//                            this method" over plan+registry prose; this one asks "can a CLIENT call
//                            this tool/operation" and also covers the projection's own text. Neither
//                            subsumes the other, and a name can pass one and fail the other.
const TOOL_NAME_REF = /\bhudu_[a-z0-9_]+\b/g;
const REF_PATTERN_TAIL = new Set(['<', '*', '_']);
if (catalogData) {
  const projectedToolNames = new Set(projectionRows.map((r) => r.name));
  const catalogByOp = new Map(catalogData.CATALOG.map((r) => [r.op, r]));
  const manifestRel = path.relative(ROOT, MANIFEST_PATH);
  function nameIsPattern(text, m) {
    if (m[0].endsWith('_')) return true;
    return REF_PATTERN_TAIL.has(text[m.index + m[0].length] ?? '');
  }
  function refAgainstProjection(ref) {
    const row = catalogByOp.get(ref);
    if (row) {
      if (row.reachable === false) return { verdict: 'fail', why: `the generated catalog REFUSES it (${row.reason}) and hudu_invoke refuses it too, so no MCP client can call it` };
      // Curated out as a duplicate outcome: the capability is real and `hudu_invoke` reaches it, so
      // naming it is not a lie — only its SHAPE (a method name, not a tool name) is worth counting.
      if (row.tool === null) return { verdict: 'mention', note: 'no tool of its own (curated out as a duplicate outcome) — callable through hudu_invoke' };
      return { verdict: 'ok' };
    }
    if (sourceMethod(ref).ok) return { verdict: 'mention', note: 'a documented SDK method of this package with no registry record' };
    return { verdict: 'fail', why: 'it is neither a client method nor a registry operation' };
  }
  // Is this mention a CALL TARGET (an instruction to call it), or a passing reference? A caller is
  // only MISLED by the former, and a bare mention ("backed by X", "preferred over X") is informative
  // prose, not a defect. Contrasts are checked first: every one of them contains a directive verb.
  const CONTRAST_BEFORE = /(?:\bover|\brather than|\binstead of|\bnot|\bnever|\bavoid|\bdo not|\bdon't|\bwithout|\bother than|\bversus|\bvs\.?|\bcompared (?:to|with))\s+(?:calling\s+|call\s+|use\s+|using\s+)?$/;
  const DIRECTIVE_BEFORE = /(?:\bcall|\bcalls|\bcalling|\buse|\buses|\busing|\bprefer|\bprefers|\binvoke|\bswitch to|\breach for|\btry)\s+(?:the\s+|a\s+)?$/;
  function presentedAsCallTarget(text, index) {
    const before = text.slice(Math.max(0, index - 40), index).toLowerCase().replace(/\s+/g, ' ');
    if (CONTRAST_BEFORE.test(before)) return false;
    return DIRECTIVE_BEFORE.test(before);
  }
  function checkProseProjection(text, jsonPath, label, field) {
    if (typeof text !== 'string' || text.length === 0) return;
    for (const m of text.matchAll(TOOL_NAME_REF)) {
      if (projectedToolNames.has(m[0]) || nameIsPattern(text, m)) continue;
      fail('prose-dangling-projection', jsonPath, `${label}: ${field} tells an agent to call the tool "${m[0]}", which the curated projection does not expose — no client can select it`);
    }
    for (const m of text.matchAll(PROSE_REF)) {
      const ref = `${m[1]}.${m[2]}`;
      // Only a real client module can start an operation reference: `meta.complete` is a response
      // field path, not an operation, and `sourceModules` is the same index sourceMethod() uses.
      if (!sourceModules.has(m[1])) continue;
      if (projectedToolNames.has(ref)) continue;
      const v = refAgainstProjection(ref);
      if (v.verdict === 'ok') continue;
      // FAIL unchanged: a name no client can call is a defect whether it is a mention or an
      // instruction. The mention class is COUNTED, never warned: it is callable another way, so
      // warning on it buried the 66 meaningful unplanned-surface warnings under 189 lines of
      // "this tool's description says what it wraps" (measured before this change).
      if (v.verdict === 'mention') {
        mentions.push({ jsonPath, label, field, ref, directive: presentedAsCallTarget(text, m.index), note: v.note });
        continue;
      }
      fail('prose-dangling-projection', jsonPath, `${label}: ${field} names "${ref}", which no client can call — ${v.why}`);
    }
  }

  for (const row of projectionRows) {
    checkProseProjection(row.description, `${manifestRel} (${row.name})`, row.name, 'description');
  }
  for (const row of operations) {
    const name = opNameOf(row);
    if (!name) continue;
    for (const field of PROSE_FIELDS) {
      checkProseProjection(row.metadata ? row.metadata[field] : null, `${PLAN_ARG}.metadata.${field}`, name, field);
    }
  }
  if (registry) {
    for (const [name, rec] of registry) {
      for (const field of PROSE_FIELDS) {
        checkProseProjection(rec[field], `CAPABILITY_REGISTRY['${name}'].${field}`, name, field);
      }
    }
  }
}


// ---------------------------------------------------------------- the one search tool's contract
// Three rules for `hudu_search` (single-search-tool design, section 5.3). They are
// mechanical, they read the SAME artifacts the tool is built from (the plan, the projected schema,
// the generated catalog), and each of them was proven non-vacuous by injecting the violation it
// names and watching this checker exit 1.
const searchManifestRel = path.relative(ROOT, MANIFEST_PATH);
const planSearchRows = operations.filter((r) => r.search === 'search');
const planSearchSet = new Set(
  planSearchRows.map((r) => String(r.primitive || '').split('.')[0]).filter((x) => x.length > 0),
);
const planResourceCovers = (plan.resources && typeof plan.resources === 'object') ? plan.resources : {};
const searchToolRow = projectionRows.find((r) => r.backingOperation === 'operations.searchKnowledge') || null;
const planSearchRow = operations.find((r) => r.helper === 'operations.searchKnowledge') || null;
const searchModeTable = (planSearchRow && planSearchRow.metadata && planSearchRow.metadata.modes) || null;
const advertisedFields = (() => {
  if (searchToolRow === null || searchToolRow.inputSchema === null || typeof searchToolRow.inputSchema !== 'object') return [];
  return Object.values(searchToolRow.inputSchema).filter((f) => f && typeof f === 'object' && typeof f.name === 'string');
})();

// 1. `searchable-resource-parity` - a search tool may only advertise resources whose `?search=`
// the vendor actually filters. Three copies must agree: the plan (the source), the projected
// `resources` enum, and the generated `mode:"resources"` table.
if (searchToolRow === null) {
  fail('searchable-resource-parity', `${searchManifestRel} (projection)`, 'operations.searchKnowledge is not projected as a tool, so its advertised resource set cannot be checked');
} else {
  const resourcesField = advertisedFields.find((f) => f.name === 'resources') || null;
  const advertisedSet = new Set(
    resourcesField && resourcesField.items && Array.isArray(resourcesField.items.enum) ? resourcesField.items.enum : [],
  );
  const generatedSet = new Set(((catalogData && catalogData.SEARCH_RESOURCES && catalogData.SEARCH_RESOURCES.searchable) || []).map((r) => r.resource));
  const cmp = (label, got) => {
    const missing = [...planSearchSet].filter((x) => !got.has(x));
    const extra = [...got].filter((x) => !planSearchSet.has(x));
    if (missing.length || extra.length) {
      fail('searchable-resource-parity', label,
        `advertises ${JSON.stringify([...got].sort())} but the plan declares ${JSON.stringify([...planSearchSet].sort())} `
        + `(missing: ${missing.join(', ') || 'none'}; advertises a resource whose ?search= the vendor ignores: ${extra.join(', ') || 'none'}). `
        + 'A resource without a declared search filter returns an unfiltered page, so advertising it would make the tool promise a search it cannot perform.');
    }
  };
  if (!advertisedSet.size && planSearchSet.size) {
    fail('searchable-resource-parity', `${searchManifestRel} (hudu_search.inputSchema.resources)`,
      `the tool advertises NO resource enum while the plan declares ${planSearchSet.size} searchable resource(s) - the contract would be unchecked`);
  } else {
    cmp(`${searchManifestRel} (hudu_search.inputSchema.resources.enum)`, advertisedSet);
  }
  cmp(`${path.relative(ROOT, CATALOG_PATH)} (SEARCH_RESOURCES.searchable)`, generatedSet);
  for (const r of planSearchSet) {
    const covers = planResourceCovers[r] && planResourceCovers[r].searchCovers;
    if (typeof covers !== 'string' || covers.length === 0) {
      fail('searchable-resource-parity', `capabilities.plan.json (resources.${r}.searchCovers)`,
        `${r} declares a search vendor filter but the plan records no prose for what that filter covers — mode="resources" would have to invent it`);
    }
  }
}

// 2. `help-mode-documents-resources` - the help payload must document the modes, the fields each
// one honours and the degradation semantics, and the resources payload must be GENERATED.
if (searchModeTable === null) {
  fail('help-mode-documents-resources', 'capabilities.plan.json (operations.searchKnowledge.metadata.modes)',
    'the tool declares no mode table, so nothing can hold help to the modes it documents');
} else if (!catalogData || !catalogData.SEARCH_HELP || !catalogData.SEARCH_HELP.text) {
  fail('help-mode-documents-resources', `${catalogRel} (SEARCH_HELP)`,
    'the generated help payload is missing — a hand-written help would drift from the tool it describes');
} else {
  const help = catalogData.SEARCH_HELP.text;
  const modeNames = Object.keys(searchModeTable);
  for (const mode of modeNames) {
    if (typeof help.modes !== 'string' || help.modes.indexOf(`mode="${mode}"`) === -1) {
      fail('help-mode-documents-resources', `${catalogRel} (SEARCH_HELP.text.modes)`, `mode "${mode}" is not documented in the help payload`);
    }
    const spec = searchModeTable[mode] || {};
    for (const field of Array.isArray(spec.fields) ? spec.fields : []) {
      if (typeof help.modes !== 'string' || help.modes.indexOf(field) === -1) {
        fail('help-mode-documents-resources', `${catalogRel} (SEARCH_HELP.text.modes)`, `mode "${mode}" honours "${field}" but the help payload never names it`);
      }
    }
  }
  for (const word of ['complete', 'degraded', 'body-not-indexed', 'vendor-only', 'meta.reasons']) {
    if (typeof help.degradation !== 'string' || help.degradation.indexOf(word) === -1) {
      fail('help-mode-documents-resources', `${catalogRel} (SEARCH_HELP.text.degradation)`,
        `the help payload does not explain "${word}" — complete:false and a degraded answer are the two facts an agent must not miss`);
    }
  }
  const searchSpec = searchModeTable.search || null;
  for (const field of searchSpec && Array.isArray(searchSpec.fields) ? searchSpec.fields : []) {
    if (typeof help.limits !== 'string' || help.limits.indexOf(field) === -1) {
      fail('help-mode-documents-resources', `${catalogRel} (SEARCH_HELP.text.limits)`,
        `mode "search" honours "${field}" but the limits section never states its default or bound`);
    }
  }
  if (!catalogData.SEARCH_RESOURCES || typeof catalogData.SEARCH_RESOURCES.derivedFrom !== 'string'
      || catalogData.SEARCH_RESOURCES.derivedFrom.indexOf('capabilities.plan.json') === -1) {
    fail('help-mode-documents-resources', `${catalogRel} (SEARCH_RESOURCES.derivedFrom)`,
      'the resources payload does not say it is derived from the plan — a hand-written table in a model\'s context is a wrong-answer generator');
  }
}

// 3. `mode-honours-fields` - every advertised field must be honoured by at least one mode, no mode
// may claim a field it refuses, and a field only one mode honours must say so in its description.
if (searchModeTable !== null) {
  const honoured = new Set();
  for (const mode of Object.keys(searchModeTable)) {
    const spec = searchModeTable[mode] || {};
    const fields = Array.isArray(spec.fields) ? spec.fields : [];
    for (const field of fields) honoured.add(field);
    for (const field of Array.isArray(spec.rejects) ? spec.rejects : []) {
      if (fields.indexOf(field) !== -1) {
        fail('mode-honours-fields', `capabilities.plan.json (modes.${mode})`, `mode "${mode}" both honours and refuses "${field}"`);
      }
    }
  }
  for (const field of advertisedFields) {
    if (!honoured.has(field.name)) {
      fail('mode-honours-fields', `${searchManifestRel} (hudu_search.inputSchema.${field.name})`,
        `"${field.name}" is advertised by the tool but no mode honours it — the schema would advertise a field nothing can act on`);
    }
  }
  for (const field of honoured) {
    if (!advertisedFields.some((f) => f.name === field)) {
      fail('mode-honours-fields', `capabilities.plan.json (operations.searchKnowledge.metadata.modes)`,
        `a mode claims to honour "${field}", which the curated schema does not advertise`);
    }
  }
  const owningModes = (field) => Object.keys(searchModeTable).filter((m) => ((searchModeTable[m] || {}).fields || []).indexOf(field) !== -1);
  for (const field of advertisedFields) {
    const owners = owningModes(field.name);
    if (owners.length !== 1) continue;
    const text = typeof field.description === 'string' ? field.description : '';
    if (text.indexOf(owners[0]) === -1) {
      fail('mode-honours-fields', `${searchManifestRel} (hudu_search.inputSchema.${field.name}.description)`,
        `"${field.name}" is honoured by mode "${owners[0]}" alone, but its description never names that mode — a caller cannot tell when the field applies`);
    }
  }
}


// ---------------------------------------------------------------- include-group schema content
// The relation include-groups (assets) are declared in the SDK's overloads AND published in the
// registry: an operation that accepts `include` must say so, naming the four groups, and a
// list-shaped one must advertise the include-expanded record shape as an output variant. A revert
// that drops either half leaves callers (and the MCP projection, which is generated FROM this
// registry) with no way to request includes, so the contract is asserted here.
// The REGISTRY models endpoint-shaped operations, so it carries the three that accept groups
// (`assets.list`, `assets.listAcrossCompanies`, `assets.search`). The helper-tier forms
// (`listAll`/`listPages`/`listAllAcrossCompanies`/`listAcrossCompaniesPages`) are not registry records
// by design — they are client-side collectors — and their include surface is pinned by the compile-time
// assertions in `src/type-assertions.ts` instead.
const INCLUDE_GROUPS = ['layout', 'expirations', 'relations', 'photos'];
// `expanded` names the output half this operation publishes: a list-shaped call advertises the
// include-expanded record variants (`itemVariants`), while `assets.search` carries its own
// `includeVariants` collection (summaries and full records). Both are checked — an operation that
// advertises `include` while its expanded shapes silently disappear is the same lie as one that never
// published the parameter.
const INCLUDE_OPERATIONS = [
  {
    name: 'assets.list',
    at: (rec) => rec.inputSchema && rec.inputSchema.params && rec.inputSchema.params.fields,
    expanded: ['AssetWithIncludes'],
    readVariants: (rec) => ((rec.outputSchema && rec.outputSchema.itemVariants) || []).map((v) => v && v.typeName),
  },
  {
    name: 'assets.listAcrossCompanies',
    at: (rec) => rec.inputSchema && [rec.inputSchema.include],
    expanded: ['AssetWithIncludes'],
    readVariants: (rec) => ((rec.outputSchema && rec.outputSchema.itemVariants) || []).map((v) => v && v.typeName),
  },
  {
    name: 'assets.search',
    at: (rec) => rec.inputSchema && rec.inputSchema.opts && rec.inputSchema.opts.fields,
    expanded: ['AssetSummaryWithIncludes', 'AssetWithIncludes'],
    readVariants: (rec) => ((rec.outputSchema && rec.outputSchema.includeVariants) || []).map((v) => v && v.typeName),
  },
];
for (const spec of INCLUDE_OPERATIONS) {
  if (!registry) break;
  const rec = registry.get(spec.name);
  const where = `CAPABILITY_REGISTRY['${spec.name}']`;
  if (rec === undefined) {
    fail('include-groups', where, `${spec.name}: the operation that accepts include groups is not in the registry`);
    continue;
  }
  const fields = spec.at(rec);
  const include = Array.isArray(fields) ? fields.find((f) => f && f.name === 'include') : undefined;
  if (include === undefined) {
    fail('include-groups', `${where}.inputSchema`, `${spec.name}: accepts include groups in the SDK but publishes no \`include\` input, so its tool schema cannot express them`);
    continue;
  }
  const enumValues = include.items && Array.isArray(include.items.enum) ? include.items.enum : null;
  if (enumValues === null || enumValues.length !== INCLUDE_GROUPS.length || !INCLUDE_GROUPS.every((g) => enumValues.includes(g))) {
    fail('include-groups', `${where}.inputSchema.include`, `${spec.name}: include must publish the ${INCLUDE_GROUPS.length} group names ${INCLUDE_GROUPS.join(', ')}; got ${JSON.stringify(enumValues)}`);
  }
  const publishedVariants = spec.readVariants(rec);
  for (const expected of spec.expanded) {
    if (!publishedVariants.includes(expected)) {
      fail('include-groups', `${where}.outputSchema`, `${spec.name}: publishes \`include\` but not the expanded output variant "${expected}" (got ${JSON.stringify(publishedVariants)}), so a caller cannot see what the groups add`);
    }
  }
}

// ---------------------------------------------------------------- report
const scopeLabel = SHIP ? 'ship gate (all groups, every row tested)' : GROUP ? `batch gate, group ${GROUP}` : 'all groups (planned tolerated)';
console.log(`capabilities:check — plan ${PLAN_ARG} planHash=${planHash}; rows=${operations.length}; scoped=${scoped.length}; scope=${scopeLabel}`);
if (registry) console.log(`capabilities:check — registry ${path.relative(ROOT, REGISTRY_PATH)} records=${registry.size}`);
// Signal-to-noise: a rule that fires 66 times on a healthy tree is a rule nobody reads. Every WARNING
// is still shown — as a per-rule COUNT with a few examples, with the full list under --verbose — so a
// 66-line dump cannot bury the one line that changed. Failures are never grouped away.
const EXAMPLES = VERBOSE ? Infinity : 3;
if (warnings.length) {
  const byWarnRule = new Map();
  for (const w of warnings) {
    const bucket = byWarnRule.get(w.rule) ?? [];
    bucket.push(w);
    byWarnRule.set(w.rule, bucket);
  }
  console.log(`\nWARNINGS (${warnings.length}) — not failures${VERBOSE ? '' : ' (first 3 per rule; --verbose for every line)'}:`);
  for (const [rule, list] of byWarnRule) {
    console.log(`  ! [${rule}] ${list.length} warning(s)`);
    for (const w of list.slice(0, EXAMPLES)) console.log(`      ${w.path}: ${w.reason}`);
  }
}
if (mentions.length) {
  // Informational, never a warning: prose that names a capability reachable another way (through
  // hudu_invoke) or a documented SDK method. Counted so the drift stays measurable, quiet so it does
  // not compete with a real warning.
  const byNote = new Map();
  for (const m of mentions) byNote.set(m.note, (byNote.get(m.note) ?? 0) + 1);
  const asTargets = mentions.filter((m) => m.directive).length;
  console.log(`\nINFO: ${mentions.length} prose mention(s) of a non-tool name that is callable another way (${asTargets} as a call target) — not warnings:`);
  for (const [note, count] of byNote) console.log(`      ${count} x ${note}`);
  for (const m of mentions.slice(0, EXAMPLES)) console.log(`      e.g. ${m.label} ${m.field} -> ${m.ref}${m.directive ? ' (told to call it)' : ' (passing mention)'}`);
  if (!VERBOSE) console.log('      (--verbose lists every mention)');
  if (VERBOSE) for (const m of mentions) console.log(`      [${m.jsonPath}] ${m.label} ${m.field} -> ${m.ref}${m.directive ? ' (target)' : ''}`);
}
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  ✗ [${f.rule}] ${f.path}: ${f.reason}`);
  const byRule = {};
  for (const f of failures) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  console.log(`\nFAIL — ${failures.length} failure(s) in ${Object.keys(byRule).length} distinct rule(s): ${Object.entries(byRule).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  process.exit(1);
}
console.log(`\nPASS — 0 failures; rows=${operations.length} scoped=${scoped.length} registryRecords=${registry ? registry.size : 0} warnings=${warnings.length} info=${mentions.length}`);
process.exit(0);

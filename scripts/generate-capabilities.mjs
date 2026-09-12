// MACHINE-GENERATED ARTIFACT GENERATOR — scripts/generate-capabilities.mjs
//
// `npm run capabilities:build`
//
// Reads capabilities.plan.json (the authored source) plus the TypeScript sources, and emits:
//   - src/capabilities.ts        the runtime registry (plain object literals, ZERO runtime deps,
//                                no zod, no imports, importable with no side effects)
//   - capabilities.json          machine-readable data for non-TS consumers
//   - capabilities.schema.json   JSON Schema for the above
// All three carry header fields: generatedAt + planHash (sha256 of the exact bytes of the plan).
//
// Policy: api-node-squad references/agent-execution-layer.md §4.1 (registry fields) and §4.2
// (emission rules). Judgement columns (helper, helperBasis, helperRationale, flags, metadata,
// compact, resolution, staleCheck, redaction) belong to the Architect: this script copies them
// and tolerates null. It NEVER fills or rewrites them.
//
// Row shapes handled (both are normative; every row has EXACTLY ONE of primitive/helper set):
//   (a) primitive rows: endpoint/primitive non-null, helper null
//   (b) helper rows:    endpoint null, primitive null, helper "<resource>.<name>" non-null
//
// A record is emitted only when the row's status is "implemented" or "tested" AND the named
// method really exists in src/resources/<resource>.ts (or src/operations/<module>.ts for
// group "operations"). Planned rows and helper rows whose method is absent from the source are
// reported on stdout as coverage gaps; the registry never claims a method the SDK does not have.
//
// Flags:
//   --plan <path>   plan to read          (default: capabilities.plan.json)
//   --out <dir>     output directory      (default: repo root; src/capabilities.ts always src/)
//   --no-src        do not write src/capabilities.ts (verification aid)
//
// Exit codes: 0 ok, 1 plan missing/unreadable or emission failed, 2 malformed plan.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
}
const PLAN_PATH = path.resolve(ROOT, argValue('--plan', 'capabilities.plan.json'));
const OUT_DIR = path.resolve(ROOT, argValue('--out', '.'));
const WRITE_SRC = !argv.includes('--no-src');

// ---------------------------------------------------------------- plan
if (!existsSync(PLAN_PATH)) {
  console.error(`capabilities:build: plan not found at ${PLAN_PATH}`);
  console.error('capabilities:build: run `npm run plan:derive` first (it is not this script\'s job).');
  process.exit(1);
}
const planBytes = readFileSync(PLAN_PATH);
const planHash = createHash('sha256').update(planBytes).digest('hex');
let plan;
try {
  plan = JSON.parse(planBytes.toString('utf8'));
} catch (err) {
  console.error(`capabilities:build: plan is not valid JSON: ${err.message}`);
  process.exit(2);
}
const operations = Array.isArray(plan.operations) ? plan.operations : [];
if (!operations.length) {
  console.error('capabilities:build: plan has no operations[] rows');
  process.exit(2);
}
const generatedAt = new Date().toISOString();

// ---------------------------------------------------------------- TS source index
// Parse src/types/*.ts, src/resources/*.ts and (when present) src/operations/*.ts with the
// TypeScript compiler API (typescript is a devDependency; nothing here is a runtime dep).
const sfByFile = new Map();
function loadDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const file = path.join(abs, name);
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sfByFile.set(file, sf);
    out.push({ file, rel: path.posix.join(rel, name), sf, text });
  }
  return out;
}
const typeFiles = loadDir('src/types');
const resourceFiles = loadDir('src/resources');
const operationFiles = loadDir('src/operations');
const allFiles = [...typeFiles, ...resourceFiles, ...operationFiles];

// interface / type-alias property tables, by type name
const typeProps = new Map();   // name -> [{name, type, optional, enumValues}]
const typeDeclKind = new Map();// name -> 'interface' | 'alias'
const aliasText = new Map();   // name -> underlying type text, for wrapped aliases

function propRecord(member) {
  if (!ts.isPropertySignature(member) || !member.name) return null;
  const name = member.name.getText();
  if (name.startsWith('[')) return null; // index signature: not a field
  const optional = !!member.questionToken;
  const t = member.type;
  const out = { name, type: t ? t.getText() : 'unknown', optional, enumValues: null };
  if (t && ts.isUnionTypeNode(t)) {
    const lits = t.types.filter((x) => ts.isLiteralTypeNode(x));
    if (lits.length === t.types.length && lits.length) out.enumValues = lits.map((x) => x.literal.getText());
  }
  return out;
}
function propsOfNode(node) {
  const out = [];
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
    for (const m of node.members) {
      const p = propRecord(m);
      if (p) out.push(p);
    }
  } else if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    for (const m of node.type.members) {
      const p = propRecord(m);
      if (p) out.push(p);
    }
  }
  return out;
}
for (const f of allFiles) {
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node)) {
      typeProps.set(node.name.text, propsOfNode(node));
      typeDeclKind.set(node.name.text, 'interface');
    } else if (ts.isTypeAliasDeclaration(node)) {
      const p = propsOfNode(node);
      if (p.length) {
        typeProps.set(node.name.text, p);
        typeDeclKind.set(node.name.text, 'alias');
      } else {
        // a wrapped alias, e.g. `type CompanyCreate = Partial<Omit<Company, ...>>`
        aliasText.set(node.name.text, node.type.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(f.sf);
}

// public methods of exported classes, by module
// moduleKey -> { file, rel, className, paginated(boolean|null), methods: Map }
function basePaginated(sf) {
  // find `super(http, {... paginated: X ...})`
  let val = null;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === 'super') {
      const text = node.getText();
      const m = /paginated:\s*(true|false)/.exec(text);
      if (m) val = m[1] === 'true';
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return val;
}
const modules = new Map();
for (const f of [...resourceFiles, ...operationFiles]) {
  const key = path.basename(f.file, '.ts');
  if (key === 'index' || key === 'base') continue;
  const methods = new Map();
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m) || !m.name) continue;
        const name = m.name.getText();
        if (name === 'constructor') continue;
        // skip private/protected members: they are not the public surface
        const mods = (m.modifiers ?? []).map((x) => x.getText());
        if (mods.includes('private') || mods.includes('protected')) continue;
        const params = m.parameters.map((p) => ({
          name: p.name.getText(),
          type: p.type ? p.type.getText() : 'unknown',
          optional: !!p.questionToken || !!p.initializer,
        }));
        let ret = m.type ? m.type.getText() : 'unknown';
        let stream = false;
        const am = /^AsyncIterable<(.+)>$/.exec(ret);
        if (am) { ret = am[1]; stream = true; }
        const pm = /^Promise<(.+)>$/.exec(ret);
        if (pm) { ret = pm[1]; }
        const jsdoc = (m.jsDoc ?? []).map((d) => (typeof d.comment === 'string' ? d.comment : '')).join(' ').trim();
        methods.set(name, { name, params, returnType: ret.trim(), stream, jsdoc });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(f.sf);
  modules.set(key, { file: f.file, rel: f.rel, className: null, paginated: basePaginated(f.sf), methods });
}

// ---------------------------------------------------------------- schema derivation
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'unknown', 'any', 'void', 'null']);
function jsonType(typeText) {
  const t = typeText.replace(/\s+/g, ' ');
  const m = /^['"`](.*)['"`]$/.exec(t);
  if (m) return { type: 'string', enum: [m[1]] };
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2);
    const it = jsonType(inner);
    return { type: 'array', items: { type: it.type, ...(it.enum ? { enum: it.enum } : {}) } };
  }
  const arr = /^Array<(.+)>$/.exec(t);
  if (arr) {
    const it = jsonType(arr[1]);
    return { type: 'array', items: { type: it.type, ...(it.enum ? { enum: it.enum } : {}) } };
  }
  const rec = /^Record<(.+),\s*(.+)>$/.exec(t);
  if (rec) return { type: 'object', additionalProperties: { type: jsonType(rec[2]).type }, keyType: jsonType(rec[1]).type };
  if (t.includes('|')) {
    const parts = t.split('|').map((s) => s.trim());
    if (parts.length && parts.every((p) => /^['"`].*['"`]$/.test(p))) {
      return { type: 'string', enum: parts.map((p) => p.replace(/^['"`]|['"`]$/g, '')) };
    }
    return { type: 'union', anyOf: parts.map((p) => jsonType(p).type) };
  }
  if (PRIMITIVES.has(t)) return { type: t === 'any' ? 'unknown' : t };
  if (t === 'Date') return { type: 'string', format: 'date-time' };
  if (resolveProps(t)) return { type: 'object', typeName: t, resolved: true };
  return { type: 'object', typeName: t, resolved: false };
}
// Resolve a named type, including the utility wrappers the SDK uses
// (Partial<T>, Omit<T, keys>, Pick<T, keys>, Required<T>). Returns null when the
// declaration is not in the sources — the caller then emits an explicit
// `{ type: name, resolved: false }` instead of omitting the field.
function resolveProps(typeText) {
  const t = typeText.replace(/\s+/g, ' ').trim();
  const simple = /^(Partial|Required)<(.+)>$/.exec(t);
  if (simple) {
    const inner = resolveProps(simple[2]);
    if (!inner) return null;
    return inner.map((p) => ({ ...p, optional: simple[1] === 'Partial' ? true : false }));
  }
  const omit = /^(Omit|Pick)<(.+),\s*(.+)>$/.exec(t);
  if (omit) {
    const inner = resolveProps(omit[2].trim());
    if (!inner) return null;
    const keys = omit[3].split('|').map((k) => k.trim().replace(/^['"`]|['"`]$/g, ''));
    return inner.filter((p) => (omit[1] === 'Omit' ? !keys.includes(p.name) : keys.includes(p.name)));
  }
  if (typeProps.has(t)) return typeProps.get(t);
  if (aliasText.has(t) && aliasText.get(t) !== t) {
    const inner = resolveProps(aliasText.get(t));
    if (inner) return inner;
  }
  return null;
}
function fieldsForType(typeText) {
  const t = typeText.replace(/\s+/g, ' ');
  const resolved = resolveProps(t);
  if (resolved) {
    return resolved.map((p) => {
      const base = jsonType(p.type);
      return { name: p.name, ...base, required: !p.optional, ...(p.enumValues ? { enum: p.enumValues.map((e) => e.replace(/^['"`]|['"`]$/g, '')) } : {}) };
    });
  }
  return null;
}
function paramFields(text) {
  // a type literal seen inline in the signature, e.g. { integration_slug: string; ... }
  const sf = ts.createSourceFile('inline.ts', `type __T = ${text};`, ts.ScriptTarget.Latest, true);
  let out = null;
  sf.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n)) {
      const p = propsOfNode(n);
      if (p.length) {
        out = p.map((x) => ({ name: x.name, ...jsonType(x.type), required: !x.optional, ...(x.enumValues ? { enum: x.enumValues.map((e) => e.replace(/^['"`]|['"`]$/g, '')) } : {}) }));
      }
    }
  });
  return out;
}
function paramInfo(method) {
  return method.params.map((p) => {
    const fields = fieldsForType(p.type) ?? paramFields(p.type);
    return { name: p.name, type: p.type, required: !p.optional, fields };
  });
}
function inputSchema(method) {
  const schema = {};
  for (const p of paramInfo(method)) {
    if (p.fields && p.fields.length) {
      for (const f of p.fields) schema[f.name] = f;
    } else {
      schema[p.name] = { ...jsonType(p.type), required: p.required };
    }
  }
  return schema;
}
function sampleValue(field) {
  if (field.enum && field.enum.length) return JSON.stringify(field.enum[0]);
  if (field.type === 'number') return '1';
  if (field.type === 'boolean') return 'true';
  if (field.type === 'array') return '[]';
  if (field.type === 'object') return '{}';
  return "'example'";
}
function exampleFor(row, method, resource) {
  if (!method) return `await hudu.${resource}.<method>()`;
  const args = paramInfo(method).map((p) => {
    if (!p.fields || !p.fields.length) {
      return p.required ? sampleValue({ type: jsonType(p.type).type }) : undefined;
    }
    const shown = p.fields.slice(0, 4).map((f) => `${f.name}: ${sampleValue(f)}`);
    const rest = p.fields.length > 4 ? ', /* ... */' : '';
    return `{ ${shown.join(', ')}${rest} }`;
  }).filter((a) => a !== undefined);
  return `await hudu.${resource}.${method.name}(${args.join(', ')})`;
}
function outputSchema(row, method) {
  const rt = method ? method.returnType : 'unknown';
  if (!method) return { type: rt, unresolved: true };
  if (method.stream) {
    const item = jsonType(rt);
    return { type: 'AsyncIterable', itemType: item.typeName ?? item.type, note: 'streams items one page at a time' };
  }
  const jt = jsonType(rt);
  if (row.compact) {
    const compactName = String(row.compact);
    const compactProps = resolveProps(compactName) ? resolveProps(compactName).map((p) => p.name) : null;
    const fullProps = resolveProps(rt) ? resolveProps(rt).map((p) => p.name) : null;
    let drops = [];
    let dropsUnresolved = false;
    if (compactProps && fullProps) {
      drops = fullProps.filter((n) => !compactProps.includes(n));
    } else {
      dropsUnresolved = true;
    }
    return {
      type: compactName,
      drops,
      dropsUnresolved,
      fields: compactProps ? fieldsForType(compactName) : null,
      fullType: rt,
      expand: 'expand: true returns the full typed record',
    };
  }
  const fields = fieldsForType(rt);
  return { type: jt.typeName ?? jt.type, ...(fields ? { fields } : {}) };
}

// pagination — policy §4.1 plus the coordinator's contract:
//   non-list primitives      -> { mode: 'none', nonPaginated: true }
//   list primitives          -> { mode: 'page', defaultPageSize: 25, maxPageSize, nonPaginated }
// defaultPageSize comes from src/config.ts DEFAULT_PAGE_SIZE; nonPaginated is derived from the
// resource source (BaseResource `paginated: false`) and cross-checked against the spec list.
const CONFIG_TEXT = existsSync(path.join(ROOT, 'src/config.ts')) ? readFileSync(path.join(ROOT, 'src/config.ts'), 'utf8') : '';
const DEFAULT_PAGE_SIZE = Number((/DEFAULT_PAGE_SIZE\s*=\s*(\d+)/.exec(CONFIG_TEXT) ?? []) [1] ?? 25);
const SPEC_NON_PAGINATED = ['/ip_addresses', '/lists', '/networks', '/procedure_tasks', '/rack_storage_items', '/rack_storages', '/vlan_zones', '/vlans', '/exports'];
const LIST_METHODS = new Set(['list', 'listAll', 'listPages']);
function paginationFor(row, method, mod) {
  const isList = row.primitive && LIST_METHODS.has(String(row.primitive).split('.').slice(1).join('.')) ;
  if (!isList) return { mode: 'none', defaultPageSize: null, maxPageSize: null, nonPaginated: true };
  const sourceSays = mod ? mod.paginated : null;
  const specSays = row.endpoint ? SPEC_NON_PAGINATED.includes('/' + String(row.endpoint).split(' ')[1].replace(/^\//, '').split('/')[0]) : false;
  // `nonPaginated: true` and `mode: "page"` cannot both be true — a mode of "page" means the
  // endpoint takes page/page_size, which is exactly what a non-paginated endpoint does not do.
  // When nonPaginated, mode is "none" and both page-size fields are null; otherwise mode is
  // "page" with the SDK's default page size (maxPageSize stays null: the vendor spec declares no
  // enforced maximum, and a fabricated bound would be worse than an explicit null).
  const nonPaginated = sourceSays === false || (sourceSays === null && specSays);
  return {
    mode: nonPaginated ? 'none' : 'page',
    defaultPageSize: nonPaginated ? null : DEFAULT_PAGE_SIZE,
    maxPageSize: null,
    nonPaginated,
    sourcePaginated: sourceSays,
    specSaysNonPaginated: specSays,
    crossCheck: sourceSays === null ? 'unresolved' : (sourceSays === !specSays ? 'agrees' : 'DISAGREES: source vs spec list'),
  };
}

// ---------------------------------------------------------------- emit records
const records = [];
const gaps = [];
const warnings = [];
for (const [idx, row] of operations.entries()) {
  const jsonPath = `operations[${idx}]`;
  const hasPrimitive = typeof row.primitive === 'string' && row.primitive.length > 0;
  const hasHelper = typeof row.helper === 'string' && row.helper.length > 0;
  if (hasPrimitive === hasHelper) {
    warnings.push(`${jsonPath}: malformed row — exactly one of primitive/helper must be non-null (primitive=${JSON.stringify(row.primitive)}, helper=${JSON.stringify(row.helper)})`);
    continue;
  }
  const name = hasPrimitive ? row.primitive : row.helper;
  const resource = name.split('.')[0];
  const methodName = name.split('.').slice(1).join('.');
  const mod = modules.get(resource);
  const method = mod ? mod.methods.get(methodName) : undefined;
  const status = row.status;
  const built = status === 'implemented' || status === 'tested';
  if (!built) {
    gaps.push(`${name} (${jsonPath}) not emitted: status="${status}" — coverage gap, no registry record`);
    continue;
  }
  if (!mod) {
    gaps.push(`${name} (${jsonPath}) not emitted: no module src/resources/${resource}.ts (or src/operations/${resource}.ts) — coverage gap`);
    continue;
  }
  if (!method) {
    gaps.push(`${name} (${jsonPath}) not emitted: no public method ${methodName}() in ${mod.rel} — ${hasHelper ? 'helper planned but not implemented' : 'primitive planned but not implemented'}`);
    continue;
  }
  const effects = row.effect;
  if (!effects) warnings.push(`${jsonPath} (${name}): effect is null — the Architect judgement column is unfilled`);
  const flags = Array.isArray(row.flags) ? row.flags : [];
  const isMutation = effects === 'write' || effects === 'destructive';
  const retry = {
    retryableStatuses: [429, 500, 502, 503, 504],
    backoff: 'exponential',
    baseDelayMs: 200,
    maxDelayMs: 30000,
    jitter: 'up-to-25%-of-delay',
    idempotencySupport: flags.includes('idempotent') ? 'vendor-native' : 'none',
  };
  const record = {
    name,
    kind: hasHelper ? 'helper' : 'primitive',
    resource,
    purpose: row.metadata && typeof row.metadata.purpose === 'string' ? row.metadata.purpose : null,
    inputSchema: inputSchema(method, row),
    outputSchema: outputSchema(row, method),
    examples: [exampleFor(row, method, resource)],
    effect: effects ?? null,
    flags,
    dryRun: isMutation,
    permissions: 'unknown',
    pagination: paginationFor(row, method, mod),
    resolution: row.resolution ?? null,
    retry,
    errors: Array.isArray(row.errors) ? row.errors : [],
    related: row.metadata && Array.isArray(row.metadata.related) ? row.metadata.related : [],
    preferredWhen: row.metadata ? row.metadata.preferredWhen ?? null : null,
    usage: row.metadata && typeof row.metadata.usage === 'string' ? row.metadata.usage : null,
    compact: row.compact ?? null,
  };
  if (record.purpose === null) warnings.push(`${jsonPath} (${name}): metadata.purpose is null — record emitted with purpose:null (Architect column unfilled)`);
  if (record.compact && record.outputSchema.dropsUnresolved) {
    gaps.push(`${name}: compact shape "${record.compact}" is not declared in src/types — outputSchema.drops emitted as [] with dropsUnresolved:true (checker will fail this helper rule until the compact type exists)`);
  }
  records.push(record);
}
records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

// ---------------------------------------------------------------- emissions
const headerComment = `// MACHINE-GENERATED by scripts/generate-capabilities.mjs — DO NOT HAND-EDIT.
// Regenerate with: npm run capabilities:build
// Source of truth: capabilities.plan.json (planHash ${planHash})
// generatedAt: ${generatedAt}
// spec: ${plan.spec ? `${plan.spec.source} v${plan.spec.version}` : 'unknown'}`;

const registryTs = `${headerComment}
//
// The runtime registry: plain object literals, no imports, no zod, no side effects.
// Tree-shakeable: consumers import { CAPABILITY_REGISTRY } and bundlers drop unused records.
// One record per operation the SDK actually implements (plan status implemented|tested).

export interface CapabilityField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly [key: string]: unknown;
}

export interface CapabilityRecord {
  readonly name: string;
  readonly kind: 'primitive' | 'helper';
  readonly resource: string;
  readonly purpose: string | null;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly examples: readonly string[];
  readonly effect: 'read' | 'write' | 'destructive' | null;
  readonly flags: readonly string[];
  readonly dryRun: boolean;
  readonly permissions: string;
  readonly pagination: Readonly<Record<string, unknown>>;
  readonly resolution: Readonly<Record<string, unknown>> | null;
  readonly retry: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
  readonly related: readonly string[];
  readonly preferredWhen: string | null;
  readonly usage: string | null;
  readonly compact: string | null;
}

export const CAPABILITIES_PLAN_HASH = '${planHash}';

export const CAPABILITIES_GENERATED_AT = '${generatedAt}';

export const CAPABILITY_REGISTRY = {
${records.map((r) => `  '${r.name}': ${JSON.stringify(r)},`).join('\n')}
} as const satisfies Record<string, CapabilityRecord>;

export type CapabilityName = keyof typeof CAPABILITY_REGISTRY;

export const CAPABILITY_NAMES = Object.keys(CAPABILITY_REGISTRY) as CapabilityName[];

/** Look up one operation's metadata, or undefined when the SDK does not implement it. */
export function getCapability(name: string): CapabilityRecord | undefined {
  return (CAPABILITY_REGISTRY as Record<string, CapabilityRecord>)[name];
}
`;

const dataDoc = {
  generatedAt,
  planHash,
  spec: plan.spec ?? null,
  operationCount: records.length,
  operations: records,
};
const schemaDoc = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/msoukhomlinov/node-hudu/capabilities.schema.json',
  title: 'node-hudu capability registry (generated)',
  type: 'object',
  required: ['generatedAt', 'planHash', 'operations'],
  properties: {
    generatedAt: { type: 'string', format: 'date-time' },
    planHash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'sha256 of the exact bytes of capabilities.plan.json' },
    spec: { type: ['object', 'null'], properties: { source: { type: 'string' }, version: { type: 'string' } } },
    operationCount: { type: 'integer', minimum: 0 },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'resource', 'purpose', 'inputSchema', 'outputSchema', 'examples', 'effect', 'flags', 'dryRun', 'permissions', 'pagination', 'resolution', 'retry', 'errors', 'related', 'preferredWhen', 'usage', 'compact'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9_]+\\.[A-Za-z0-9_]+$' },
          kind: { enum: ['primitive', 'helper'] },
          resource: { type: 'string' },
          purpose: { type: ['string', 'null'] },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          examples: { type: 'array', minItems: 1, items: { type: 'string' } },
          effect: { enum: ['read', 'write', 'destructive', null] },
          flags: { type: 'array', items: { enum: ['sensitive', 'idempotent', 'requiresApproval'] } },
          dryRun: { type: 'boolean' },
          permissions: { type: 'string', minLength: 1, description: 'scope names, or the literal "unknown"' },
          pagination: { type: 'object' },
          resolution: { type: ['object', 'null'] },
          retry: { type: 'object' },
          errors: { type: 'array', items: { type: 'string' } },
          related: { type: 'array', items: { type: 'string' } },
          preferredWhen: { type: ['string', 'null'] },
          usage: { type: ['string', 'null'] },
          compact: { type: ['string', 'null'] },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- write
function writeJson(file, doc) {
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
}
// capabilities.json keeps the header readable and writes one operation per line: the file is
// machine-generated and diffed by hash, and full pretty-printing triples it for no reader gain.
function writeDataJson(file, doc) {
  const head = JSON.stringify({ ...doc, operations: [] }, null, 2).replace(/\n\}$/, ',\n');
  const body = doc.operations.map((r) => '    ' + JSON.stringify(r)).join(',\n');
  writeFileSync(file, head + '  "operations": [\n' + body + '\n  ]\n}\n');
}
if (WRITE_SRC) {
  writeFileSync(path.join(ROOT, 'src', 'capabilities.ts'), registryTs);
}
mkdirSync(OUT_DIR, { recursive: true });
writeDataJson(path.join(OUT_DIR, 'capabilities.json'), dataDoc);
writeJson(path.join(OUT_DIR, 'capabilities.schema.json'), schemaDoc);

console.log(`capabilities:build — plan ${path.relative(ROOT, PLAN_PATH)} planHash=${planHash}`);
console.log(`capabilities:build — spec ${plan.spec ? plan.spec.source + ' v' + plan.spec.version : 'unknown'}; rows=${operations.length}; records emitted=${records.length}`);
console.log(`capabilities:build — wrote ${WRITE_SRC ? 'src/capabilities.ts, ' : ''}${path.relative(ROOT, path.join(OUT_DIR, 'capabilities.json'))}, ${path.relative(ROOT, path.join(OUT_DIR, 'capabilities.schema.json'))}`);
if (gaps.length) {
  console.log(`coverage gaps (${gaps.length}) — no registry record emitted:`);
  for (const g of gaps) console.log('  - ' + g);
} else {
  console.log('coverage gaps: none');
}
if (warnings.length) {
  console.log(`warnings (${warnings.length}):`);
  for (const w of warnings) console.log('  ! ' + w);
}

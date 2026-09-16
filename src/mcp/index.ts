/**
 * `node-hudu/mcp` — the generated MCP tool catalog, as a compiled subpath export.
 *
 * WHY THIS SUBPATH EXISTS: the catalog is what a host needs to stand up an MCP server on top of
 * this SDK — the CORE profile, the three META tool specs, the curated tool descriptions, the
 * `hudu_search` contract, and one catalog row per registry operation so a capability with no tool
 * of its own is DISCOVERABLE rather than indistinguishable from a missing one. It used to be
 * emitted into `examples/` and published as raw TypeScript, which a compiled consumer could not
 * import; it now lives in `src/`, so tsup compiles it to ESM + CJS + .d.ts like every other entry
 * point and `import { CORE_TOOLS } from 'node-hudu/mcp'` works from a plain tarball install.
 *
 * WHAT IT IS NOT: this module carries DATA and a schema reader, never a second validator and never
 * a second write governor. Validation and governance live in exactly ONE place — the SDK's
 * `operations.invoke` / `planInvoke` (`node-hudu/operations`), which the reference server in
 * `examples/mcp-server.ts` calls. A second implementation here would be a second chance to be
 * wrong. The helpers below are MCP-agnostic and take the registry record they need as an argument,
 * so a host passes `getCapability(op)` from `node-hudu/capabilities` and nothing can drift.
 *
 * `./catalog.generated.ts` is MACHINE-WRITTEN by `scripts/build-tool-catalog.mjs` from
 * `capabilities.json` + `MCP_TOOL_OVERRIDES.json`. Never hand-edit it; `npm run capabilities:check`
 * fails on a stale copy.
 */
export {
  CATALOG,
  CATALOG_PLAN_HASH,
  CORE_RULE,
  CORE_TOOLS,
  DEFAULT_CATALOG_LIMIT,
  EXPOSED,
  MAX_CATALOG_LIMIT,
  META_TOOLS,
  REFUSALS,
  SEARCH_HELP,
  SEARCH_MODES,
  SEARCH_RESOURCES,
  TOOL_DESCRIPTIONS,
  WORKFLOW_RESOURCES,
  catalogPage,
  catalogRow,
  configError,
  describeOperation,
  inputFields,
  nearestKeys,
  requireCatalogRow,
} from './catalog.generated.js';
export type { CatalogPageOptions, CatalogRow } from './catalog.generated.js';

/**
 * `node-hudu/operations` — the cross-resource helpers of the agent execution layer.
 *
 * Exported subpath for callers that do not want the whole client barrel:
 * `searchAcrossResources(query)` and `resolveAny(identifier)`, plus the hit, candidate and
 * option types the capability registry publishes. Both helpers are reads; neither can write.
 */
export { Operations } from './operations.js';
export {
  invokeOperation,
  planInvoke,
  resolveInvokeTarget,
  validateInvokeInput,
  auditSchemaVocabulary,
  inputFields,
  nearestOperations,
  INVOKE_REFUSED_RESOURCES,
  SCHEMA_FIELD_KEYS,
  SCHEMA_FIELD_TYPES,
} from './invoke.js';
export type { InvokeOptions, InvokePlan, InvokeProblem, InvokeVerdict } from './invoke.js';
export type {
  ResolveAnyOptions,
  ResolveAnyResult,
  ResolutionCandidateHit,
  ResolutionCandidateHitMap,
  ResolutionCandidateHitUnion,
  SearchAcrossResourcesOptions,
  SearchHit,
  SearchHitExpanded,
  SearchHitExpandedMap,
  SearchHitExpandedUnion,
  SearchHitMap,
  SearchHitUnion,
  SearchableRecord,
  SearchableRecordMap,
  SearchableResource,
  SearchableRow,
  SearchableSummary,
  SearchableSummaryMap,
} from './types.js';

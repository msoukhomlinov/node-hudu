/**
 * node-hudu — fully-typed TypeScript SDK for the Hudu IT documentation API.
 * Built for building MCP servers and integrations.
 */
export { HuduClient } from './client.js';
export type { HuduConfig, ResolvedConfig, RateLimitConfig, ResolutionConfig } from './config.js';
export { resolveConfig, DEFAULT_BASE_PATH, DEFAULT_TIMEOUT_MS, DEFAULT_RATE_LIMIT_PER_MINUTE, DEFAULT_MAX_RETRIES, DEFAULT_PAGE_SIZE, DEFAULT_MAX_SCAN_RECORDS, DEFAULT_MAX_SCAN_PAGES, DEFAULT_CONCURRENCY } from './config.js';

export { HttpClient } from './http.js';
export { unwrapByKey, unwrapList } from './http.js';
export type { RequestOptions, DryRunRequest } from './http.js';

export { buildAuthHeaders, withAuth, API_KEY_HEADER } from './auth.js';

export {
  HuduError, HuduConfigError, HuduNetworkError, BadRequestError, UnauthorizedError,
  ForbiddenError, NotFoundError, MethodNotAllowedError, NotAcceptableError,
  UnprocessableEntityError, RateLimitError, ServerError, errorFromStatus, isHuduError,
  // Agent-execution-layer additions (additive: no existing code value changed).
  ConflictError, StaleObjectError, ValidationFailedError, DuplicateFoundError,
  ResolutionError, PolicyDeniedError,
} from './errors.js';
export type { ErrorCategory, ResolutionErrorCode, HuduErrorOptions } from './errors.js';

export type { Page, ListParams } from './pagination.js';
export { paginate, paginateItems, collectAll, toArray } from './pagination.js';

export { isRecord } from './utils.js';

export type { Logger } from './logger.js';
export { NOOP_LOGGER, redact, isCredentialKey, REDACTED, REDACTED_KEYS } from './logger.js';

export type * from './types/index.js';
// Agent-execution-layer shared types (operation metadata, dry-run, resolution, audit).
export type * from './types/common.js';

export {
  BaseResource,
  ActivityLogsResource, ApiInfoResource, ArticlesResource, AssetLayoutsResource,
  AssetPasswordsResource, AssetsResource, CardsResource, CompaniesResource,
  ExpirationsResource, ExportsResource, FlagTypesResource, FlagsResource,
  FoldersResource, GroupsResource, IpAddressesResource, LabelTypesResource,
  LabelsResource, ListsResource, MagicDashResource, MatchersResource,
  NetworksResource, PasswordFoldersResource, PhotosResource,
  ProcedureTasksResource, ProceduresResource, PublicPhotosResource,
  RackStorageItemsResource, RackStoragesResource, RelationsResource,
  S3ExportsResource, UploadsResource, UsersResource, VlanZonesResource,
  VlansResource, WebsitesResource,
} from './resources/index.js';
export type * from './resources/index.js';

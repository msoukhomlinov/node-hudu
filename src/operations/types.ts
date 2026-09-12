/**
 * Public types of the cross-resource operations (`src/operations/`, policy §4.1/§5/§9).
 *
 * One writer per shape: `SearchHit`, `ResolutionCandidateHit`, the option bags and the result
 * envelope are declared here and re-exported from `./index.js`, so the `./operations` subpath and
 * the capability registry read the same declarations.
 *
 * The resource -> row maps below are the single source of truth for which resources a
 * cross-resource helper can reach. A name that is not a key of `SearchableSummaryMap` cannot be
 * passed at all (type error) and is rejected at runtime with `CONFIG_ERROR` naming the supported
 * set — never silently skipped, which would read as "no record there".
 */
import type { Article, ArticleSummary } from '../types/article.js';
import type { Asset, AssetSummary } from '../types/asset.js';
import type { AssetPassword, AssetPasswordSummary } from '../types/asset_password.js';
import type { Company, CompanySummary } from '../types/company.js';
import type { Group, GroupSummary } from '../types/group.js';
import type { PasswordFolder, PasswordFolderSummary } from '../types/password_folder.js';
import type { User, UserSummary } from '../types/user.js';
import type { Website, WebsiteSummary } from '../types/website.js';

/**
 * The eight resources that expose a helper-tier text `search`, mapped to the compact shape that
 * helpers return (policy §5/§9). `asset_passwords` and `password_folders` use the vendor's own
 * resource names, so a name here matches the resource path and the registry operation prefix.
 */
export interface SearchableSummaryMap {
  companies: CompanySummary;
  articles: ArticleSummary;
  assets: AssetSummary;
  websites: WebsiteSummary;
  asset_passwords: AssetPasswordSummary;
  password_folders: PasswordFolderSummary;
  groups: GroupSummary;
  users: UserSummary;
}

/** The same eight resources mapped to their full record type (`expand: true`). */
export interface SearchableRecordMap {
  companies: Company;
  articles: Article;
  assets: Asset;
  websites: Website;
  asset_passwords: AssetPassword;
  password_folders: PasswordFolder;
  groups: Group;
  users: User;
}

/** A resource name a cross-resource helper accepts, derived from the resource -> row maps. */
export type SearchableResource = keyof SearchableSummaryMap;

/** The compact row union of every searchable resource. */
export type SearchableSummary = SearchableSummaryMap[SearchableResource];

/** The full-record row union of every searchable resource. */
export type SearchableRecord = SearchableRecordMap[SearchableResource];

/** Any row a cross-resource helper can label: a compact summary or a full record. */
export type SearchableRow = SearchableSummary | SearchableRecord;

/**
 * One hit of `searchAcrossResources`.
 *
 * `R` stays correlated with `item`, so `SearchHit<'companies'>` carries a `CompanySummary` and
 * `SearchHit<'users'>` carries a `UserSummary` — the union is not a bag of unrelated fields.
 */
export interface SearchHit<R extends SearchableResource = SearchableResource> {
  /** Which resource produced the hit: the discriminator of the union. */
  resource: R;
  /** The record id inside that resource. */
  id: number;
  /** Human-readable label (the record's `name`, else a user's `email`, else `#<id>`). */
  label: string;
  /** The compact summary the resource's own `search` returned. */
  item: SearchableSummaryMap[R];
}

/** The resource -> hit map; indexing it yields the discriminated union `SearchHitUnion`. */
export type SearchHitMap = { [K in SearchableResource]: SearchHit<K> };

/** `SearchHit` distributed over every resource: `hit.resource` narrows `hit.item`. */
export type SearchHitUnion = SearchHitMap[SearchableResource];

/** One hit of `searchAcrossResources({ expand: true })`, carrying the full record. */
export interface SearchHitExpanded<R extends SearchableResource = SearchableResource> {
  /** Which resource produced the hit: the discriminator of the union. */
  resource: R;
  /** The record id inside that resource. */
  id: number;
  /** Human-readable label (the record's `name`, else a user's `email`, else `#<id>`). */
  label: string;
  /** The full typed record, not the compact summary. */
  item: SearchableRecordMap[R];
}

/** The resource -> expanded-hit map; indexing it yields `SearchHitExpandedUnion`. */
export type SearchHitExpandedMap = { [K in SearchableResource]: SearchHitExpanded<K> };

/** `SearchHitExpanded` distributed over every resource. */
export type SearchHitExpandedUnion = SearchHitExpandedMap[SearchableResource];

/** Options of `searchAcrossResources`. */
export interface SearchAcrossResourcesOptions {
  /** Which resources to search; default all eight, in the documented fan-out order. */
  resources?: SearchableResource[];
  /** Per-resource limit; default 25, maximum 100 (above it the call fails, never clamps). */
  limit?: number;
  /** Return the full records instead of the compact summaries. */
  expand?: boolean;
}

/**
 * One candidate of `resolveAny`: a record one of the requested resources matched.
 *
 * `item` is the compact summary the resource's own `resolve` returned. It is `null` only when the
 * resource could report candidate ids without a single decided record (it matched several records
 * and refused to choose) — the id and label are still real, and `null` never means "no match".
 */
export interface ResolutionCandidateHit<R extends SearchableResource = SearchableResource> {
  /** Which resource matched. */
  resource: R;
  /** The matched record's id inside that resource. */
  id: number;
  /** Label for the candidate: the resource's own disambiguation label, else a name/email, else `#<id>`. */
  label: string;
  /** The compact summary, or `null` when the resource decided only by candidate ids. */
  item: SearchableSummaryMap[R] | null;
}

/** The resource -> candidate map; indexing it yields `ResolutionCandidateHitUnion`. */
export type ResolutionCandidateHitMap = { [K in SearchableResource]: ResolutionCandidateHit<K> };

/** `ResolutionCandidateHit` distributed over every resource. */
export type ResolutionCandidateHitUnion = ResolutionCandidateHitMap[SearchableResource];

/** Options of `resolveAny`. */
export interface ResolveAnyOptions {
  /** Which resources to try; default all eight, in the documented fan-out order. */
  resources?: SearchableResource[];
  /** Per-resource scan limit passed through to each `resolve`; default 25, maximum 100. */
  limit?: number;
}

/**
 * What `resolveAny` found, across every requested resource.
 *
 * An empty `hits` array is a complete answer, not an error: every requested resource finished a
 * bounded scan and none held the identifier. `truncated` names the resources whose scan stopped at
 * the resolution cap, so a partial answer is never mistakable for a complete one.
 */
export interface ResolveAnyResult {
  /** Every match found, in resource order; empty when nothing matched. */
  hits: ResolutionCandidateHit[];
  /** Resources whose bounded scan hit the cap, so their contribution is undecided. */
  truncated: SearchableResource[];
  /** Records the requested resources reported examining (an id they do not hold counts as 1). */
  scanned: number;
}

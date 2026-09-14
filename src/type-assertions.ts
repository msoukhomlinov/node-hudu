/**
 * Compile-time contract assertions for the public surface.
 *
 * This file contains NO runtime code: the function below is never called (and nothing imports it), it
 * exists so the type checker evaluates real call expressions. `tsc --noEmit` is gate 1, so these
 * assertions run on every gate pass — an inference that loosens, inverts or silently widens fails the
 * build instead of shipping.
 *
 * Why the include surface is pinned here. Each asset list-shaped call and `assets.search` take an
 * `include` array, and the honest return type depends on what the compiler can PROVE about that array:
 *
 *   - a literal (`include: ['expirations']`), an `as const` tuple, or a typed `AssetIncludeGroup[]`
 *     means the named groups ARE attached → the expanded records;
 *   - anything the compiler cannot narrow — `string[]`, a readonly string array, or an OPTIONAL widened
 *     property (`{ include?: string[] }`, which may be absent at runtime) — means includes MAY be
 *     attached → the union of the plain and expanded shapes;
 *   - no `include` at all, or an explicit `undefined` → the plain records.
 *
 * The optional case is why one generic overload replaced the earlier pair: a widened overload that
 * REQUIRED the property could not match `{ include?: string[] }`, which then fell through to a plain
 * overload via `ListParams`' index signature and inferred the plain shape while the runtime fetched the
 * includes the array held.
 *
 * LIMIT, stated so nobody reads more into it: the union documents that includes MAY be present; it cannot
 * stop a caller from annotating the result as the plain shape, because `AssetWithIncludes` only ADDS
 * OPTIONAL group fields to `Asset`, making the two mutually assignable. What is guaranteed is the
 * INFERENCE: it cannot silently collapse back to a single member without failing this file.
 */
import type { HuduClient } from './client.js';
import type {
  Asset, AssetWithIncludes, AssetSummary, AssetSummaryWithIncludes, AssetIncludeGroup,
} from './types/asset.js';
import type { Page } from './pagination.js';

/** True only when A and B are the same type (the standard invariant-function test). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Fails to compile unless T is exactly `true`. */
type Expect<T extends true> = T;

/** The union a widened/optional `include` resolves to on a list-shaped call. */
type MaybeIncludes<T> = T | AssetWithIncludes[];

/**
 * One call per shape, returned as a tuple so the assertions below can address them by position. The
 * inputs are declared (never executed) values, so no runtime dependency exists.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used via `typeof` (compile-time only)
function includeSurface(client: HuduClient) {
  const cfgOptional: { include?: string[] } = {};
  const widened: string[] = ['expirations'];
  const declaredGroups = [] as unknown as AssetIncludeGroup[];

  const listAllLiteral = client.assets.listAll(1, { include: ['expirations'] });
  const listAllWidened = client.assets.listAll(1, { include: widened });
  const listAllNone = client.assets.listAll(1);
  const listAllOtherParam = client.assets.listAll(1, { archived: true });
  const listAllOptionalWidened = client.assets.listAll(1, cfgOptional);
  const listAllExplicitUndefined = client.assets.listAll(1, { include: undefined });
  const listAllTypedGroups = client.assets.listAll(1, { include: declaredGroups });
  const listAllAsConst = client.assets.listAll(1, { include: ['photos'] as const });
  const listAllUnionTyped = client.assets.listAll(1, { include: undefined as string[] | undefined });

  const streamedLiteral = client.assets.list(1, { include: ['photos'] });
  const streamedWidened = client.assets.list(1, { include: widened });
  const pagesOptional = client.assets.listPages(1, cfgOptional);
  const accountAllAsConst = client.assets.listAllAcrossCompanies({ include: ['layout'] as const });
  const accountStreamWidened = client.assets.listAcrossCompanies(cfgOptional);

  const searchExpandLiteral = client.assets.search('x', { expand: true, include: ['expirations'] });
  const searchLiteral = client.assets.search('x', { include: ['expirations'] });
  const searchExpandWidened = client.assets.search('x', { expand: true, include: widened });
  const searchWidened = client.assets.search('x', { include: widened });
  const searchExpandOnly = client.assets.search('x', { expand: true });
  const searchPlain = client.assets.search('x', { limit: 5 });
  const searchNoOpts = client.assets.search('x');
  const searchOptionalWidened = client.assets.search('x', cfgOptional);

  return [
    listAllLiteral, listAllWidened, listAllNone, listAllOtherParam, listAllOptionalWidened,
    listAllExplicitUndefined, listAllTypedGroups, listAllAsConst, listAllUnionTyped,
    streamedLiteral, streamedWidened, pagesOptional, accountAllAsConst, accountStreamWidened,
    searchExpandLiteral, searchLiteral, searchExpandWidened, searchWidened, searchExpandOnly,
    searchPlain, searchNoOpts, searchOptionalWidened,
  ] as const;
}

/** Resolved type of call `n` in the tuple above. */
type Call<N extends number> = Awaited<ReturnType<typeof includeSurface>[N]>;

/**
 * One assertion per call: literal input → the expanded shape; widened or optional → the union;
 * no include / undefined → the plain shape; and `search`'s `expand` flag still selects between
 * summaries and full records.
 */
export type IncludeSurfaceAssertions = [
  Expect<Equal<Call<0>, AssetWithIncludes[]>>,
  Expect<Equal<Call<1>, MaybeIncludes<Asset[]>>>,
  Expect<Equal<Call<2>, Asset[]>>,
  Expect<Equal<Call<3>, Asset[]>>,
  Expect<Equal<Call<4>, MaybeIncludes<Asset[]>>>,
  Expect<Equal<Call<5>, Asset[]>>,
  Expect<Equal<Call<6>, AssetWithIncludes[]>>,
  Expect<Equal<Call<7>, AssetWithIncludes[]>>,
  Expect<Equal<Call<8>, MaybeIncludes<Asset[]>>>,
  Expect<Equal<Call<9>, AsyncIterable<AssetWithIncludes>>>,
  Expect<Equal<Call<10>, AsyncIterable<Asset | AssetWithIncludes>>>,
  Expect<Equal<Call<11>, AsyncIterable<Page<Asset> | Page<AssetWithIncludes>>>>,
  Expect<Equal<Call<12>, AssetWithIncludes[]>>,
  Expect<Equal<Call<13>, AsyncIterable<Asset | AssetWithIncludes>>>,
  Expect<Equal<Call<14>, AssetWithIncludes[]>>,
  Expect<Equal<Call<15>, AssetSummaryWithIncludes[]>>,
  Expect<Equal<Call<16>, Asset[] | AssetWithIncludes[]>>,
  Expect<Equal<Call<17>, AssetSummary[] | Asset[] | AssetSummaryWithIncludes[] | AssetWithIncludes[]>>,
  Expect<Equal<Call<18>, Asset[]>>,
  Expect<Equal<Call<19>, AssetSummary[]>>,
  Expect<Equal<Call<20>, AssetSummary[]>>,
  Expect<Equal<Call<21>, AssetSummary[] | Asset[] | AssetSummaryWithIncludes[] | AssetWithIncludes[]>>,
];

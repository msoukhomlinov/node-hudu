/**
 * Compile-time contract assertions for the public surface.
 *
 * This file contains NO runtime code: the functions below are never called (and nothing imports them),
 * they exist so the type checker evaluates real call expressions. `tsc --noEmit` is part of the gate
 * chain, so these assertions run on every gate pass — a change that loosens or inverts an inferred type
 * fails the build instead of silently shipping.
 *
 * The include-group surface is pinned here because it has two overload shapes per method (a literal
 * array of group names, and everything else) and the `ListParams` index signature used to let the plain
 * overload swallow a widened array, making the type claim `Asset` while the runtime fetched includes.
 *
 * LIMIT, stated so nobody reads more into it: the widened case returns `Asset[] | AssetWithIncludes[]`,
 * and because `AssetWithIncludes` only ADDS OPTIONAL group fields to `Asset`, the two members are
 * mutually assignable — so the union documents that includes may be present, but it cannot stop a
 * caller from annotating the result `Asset[]`. What these assertions guarantee is that the inference
 * itself cannot silently revert to a single member.
 */
import type { HuduClient } from './client.js';
import type { Asset, AssetWithIncludes, AssetSummary, AssetSummaryWithIncludes } from './types/asset.js';
import type { Page } from './pagination.js';

/** True only when A and B are the same type (the standard invariant-function test). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Fails to compile unless T is exactly `true`. */
type Expect<T extends true> = T;

/**
 * Calls whose inferred return types are asserted below. Never executed: the function exists only so the
 * type checker evaluates real call expressions, which is why it is referenced through `typeof` alone.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used via `typeof` (compile-time only)
function includeSurface(client: HuduClient) {
  const literal = client.assets.listAll(1, { include: ['expirations'] });
  const none = client.assets.listAll(1);
  const widenedInput: string[] = ['expirations', 'layout'];
  const widened = client.assets.listAll(1, { include: widenedInput });
  const streamed = client.assets.list(1, { include: ['photos'] });
  const searchedLiteral = client.assets.search('x', { include: ['relations'] });
  const searchedWidened = client.assets.search('x', { include: widenedInput });
  const pages = client.assets.listAcrossCompaniesPages({ include: widenedInput });
  // A TUPLE (not an object): `Surface[n]` below addresses each call by position.
  return [literal, none, widened, streamed, searchedLiteral, searchedWidened, pages] as const;
}

type Surface = ReturnType<typeof includeSurface>;

/**
 * One assertion per shape. `Awaited<Surface[n]>` is the resolved value of call n:
 *   0 literal include  -> the expanded records
 *   1 no include       -> the plain records
 *   2 widened include  -> the union (the caller cannot know statically)
 *   3 literal, streamed-> the expanded records, as an AsyncIterable
 *   4 literal on search-> the expanded summaries
 *   5 widened on search-> the union of every search shape
 *   6 widened on pages -> a union of page types
 */
export type IncludeSurfaceAssertions = [
  Expect<Equal<Awaited<Surface[0]>, AssetWithIncludes[]>>,
  Expect<Equal<Awaited<Surface[1]>, Asset[]>>,
  Expect<Equal<Awaited<Surface[2]>, Asset[] | AssetWithIncludes[]>>,
  Expect<Equal<Awaited<Surface[3]>, AsyncIterable<AssetWithIncludes>>>,
  Expect<Equal<Awaited<Surface[4]>, AssetSummaryWithIncludes[]>>,
  Expect<Equal<Awaited<Surface[5]>, AssetSummary[] | Asset[] | AssetSummaryWithIncludes[] | AssetWithIncludes[]>>,
  Expect<Equal<Awaited<Surface[6]>, AsyncIterable<Page<Asset> | Page<AssetWithIncludes>>>>,
];


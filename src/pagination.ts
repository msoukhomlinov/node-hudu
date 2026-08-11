/**
 * Pagination helpers.
 */
import { HuduConfigError } from './errors.js';
const MAX_PAGES = 100_000;
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  hasMore: boolean;
}

/** Parameters understood by every list method. */
export interface ListParams {
  page?: number;
  page_size?: number;
  [key: string]: unknown;
}

type PageFetcher<T> = (page: number, pageSize: number) => Promise<Page<T>>;

export interface PaginateOptions {
  /** Starting page (default 1). */
  page?: number;
  /** Page size (default 25). */
  page_size?: number;
  /**
   * Throw when a full, hasMore:true page is returned whose ITEM CONTENT is
   * identical to the previous continuing page — i.e. a server that ignores
   * `page` and repeats the same full page (infinite duplicates). Detection is
   * by a content fingerprint, not the requested page number, so it also fires
   * when the requested number advances but the payload does not. Terminal
   * (short / hasMore:false) pages are never affected. Opt-in: off by default
   * because it imposes a contract on the fetcher; the SDK's own bundled
   * pagination enables it (runaway-loop guard).
   */
  guardNoProgress?: boolean;
}

/** Yield pages one at a time until hasMore is false or a page is short. */
export async function* paginate<T>(fetchPage: PageFetcher<T>, opts: PaginateOptions = {}): AsyncGenerator<Page<T>> {
  let page = opts.page ?? 1;
  const pageSize = opts.page_size ?? 25;
  // page_size:0 would make hasMore (length === page_size) always true and the
  // short-page break (length < page_size) always false -> an infinite loop (A12).
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new HuduConfigError(`page_size must be a positive integer, got "${String(opts.page_size)}"`);
  }
  // Non-integer (1.5) and non-positive (0/-N) `page` are invalid — symmetric
  // with page_size (F8).
  if (!Number.isInteger(page) || page < 1) {
    throw new HuduConfigError(`page must be a positive integer, got "${String(opts.page)}"`);
  }
  const guardNoProgress = opts.guardNoProgress ?? false;
  let pages = 0;
  // Signature of the previous "continuing" full page's items, used by the
  // no-progress guard. We compare RESPONSE CONTENT rather than the requested
  // page number because the SDK's own BaseResource reports the requested page
  // (which monotonically advances even when a server ignores `page`). Content
  // fingerprints catch a server returning the same full page every time
  // regardless of the page number it was asked for (codex [4]/[6]).
  let prevSignature: string | null = null;
  while (true) {
    if (pages >= MAX_PAGES) {
      throw new HuduConfigError(`Pagination exceeded ${MAX_PAGES} pages; refusing to continue (possible runaway loop)`);
    }
    const p = await fetchPage(page, pageSize);
    // The no-progress guard exists solely to catch a server that IGNORES `page`
    // and keeps returning the same full, hasMore:true page forever (infinite
    // duplicates). It therefore only fires when this page genuinely indicates
    // continuation — a full page with hasMore set. A short/final page is
    // terminal and MUST always be yielded, never thrown (codex [4]).
    const continuing = p.hasMore && p.items.length >= pageSize;
    if (guardNoProgress && continuing) {
      const signature = pageSignature(p.items);
      if (prevSignature !== null && signature === prevSignature) {
        throw new HuduConfigError(
          'Pagination made no progress: server returned the same full page content repeatedly; ' +
            'is the endpoint ignoring the `page` parameter?',
        );
      }
      prevSignature = signature;
    }
    yield p;
    pages++;
    if (!p.hasMore || p.items.length < pageSize) break;
    page++;
  }
}

/**
 * Cheap, stable fingerprint of a page's items for no-progress detection.
 * Prefers `id` when items carry one (the SDK's models do); falls back to a
 * JSON token for arbitrary T. Never serialises the whole array as one blob.
 */
function pageSignature<T>(items: T[]): string {
  const tokens = items.map((item) => {
    if (item !== null && typeof item === 'object' && 'id' in item) {
      return `i:${String((item as { id: unknown }).id)}`;
    }
    return `v:${JSON.stringify(item)}`;
  });
  return `${tokens.length}:${tokens.join(',')}`;
}

export async function* paginateItems<T>(fetchPage: PageFetcher<T>, opts: PaginateOptions = {}): AsyncGenerator<T> {
  for await (const page of paginate(fetchPage, opts)) {
    for (const item of page.items) yield item;
  }
}

/** Collect every item across all pages into an array. */
export async function collectAll<T>(fetchPage: PageFetcher<T>, opts: PaginateOptions = {}): Promise<T[]> {
  const all: T[] = [];
  // paginate() already terminates on the last page, so no duplicate break here (C10).
  for await (const page of paginate(fetchPage, opts)) {
    all.push(...page.items);
  }
  return all;
}

/** Materialise an async iterator of items into an array. */
export async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

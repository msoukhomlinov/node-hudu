/**
 * Pagination helpers.
 */
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

/** Yield pages one at a time until hasMore is false or a page is short. */
export async function* paginate<T>(fetchPage: PageFetcher<T>): AsyncGenerator<Page<T>> {
  let page = 1;
  const pageSize = 25;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const p = await fetchPage(page, pageSize);
    yield p;
    if (!p.hasMore || p.items.length < pageSize) break;
    page++;
  }
}

/** Yield items one at a time across pages. */
export async function* paginateItems<T>(fetchPage: PageFetcher<T>): AsyncGenerator<T> {
  for await (const page of paginate(fetchPage)) {
    for (const item of page.items) yield item;
  }
}

/** Collect every item across all pages into an array. */
export async function collectAll<T>(fetchPage: PageFetcher<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const page of paginate(fetchPage)) {
    all.push(...page.items);
    if (!page.hasMore || page.items.length < page.page_size) break;
  }
  return all;
}

/** Materialise an async iterator of items into an array. */
export async function toArray<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

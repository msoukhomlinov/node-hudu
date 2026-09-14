/**
 * The in-memory postings index behind `operations.searchKnowledge`.
 *
 * Design of record: `engine-design.md` S1/S2/S5 (search design doc, kept outside this repo).
 * INTERNAL module, zero dependencies, nothing on disk.
 *
 * Shape: one postings list per (field, token) — NOT a per-document scan. The design measured a
 * document-loop scorer at 18.4 s for one exact query and 229 s for a two-token query over 5,000
 * documents, against 4.5 ms / 310 ms for the postings-driven form; that gap is the reason every
 * candidate here is generated from the inverted index or from the field's vocabulary, never from
 * a loop over `docs`.
 *
 * Honesty rules carried by this file:
 *   - a body longer than `maxDocBytes` of RAW HTML is truncated and the document is flagged
 *     `longTruncated`, so a term past the cut is reported as not found rather than found;
 *   - extracted text is capped at `maxIndexTextBytes`; over the cap the least-recently-used
 *     document drops its TEXT as a UNIT — `longText` and the field string that holds the same
 *     text (`body` for an article, `cfield` for an asset) are released together, because keeping
 *     the field string keeps the whole text alive (the eviction would free nothing) and lets the
 *     index claim a body it no longer holds. Body RECALL goes with the text, and that cost is
 *     REPORTED rather than hidden: the document is flagged `longTruncated` (so a query that would
 *     have matched its body is answered without it, and the answer says so through
 *     `bodiesTruncated`/the `body-truncated` reason). Keeping the tokens instead would be no
 *     cheaper than keeping the text — a measured token array costs several times the text it came
 *     from — so the bound would be a claim, not a limit;
 *   - `maxDocs` is applied in `updated_at` descending order, so the documents that are indexed
 *     are the freshest ones, and `partial` is reported rather than implied.
 */
import { tokenizeField, ngramsOf, diceCoefficient, editDistanceAtMost, editBudget } from './tokenize.js';
import {
  MAX_FUZZY_CANDIDATES, MIN_FUZZY_CHARS, MIN_FUZZY_BODY_CHARS, DICE_MIN_CHARS, DICE_FLOOR,
} from './tokenize.js';

/** The indexed fields, in the order the match report lists them. */
export type IndexField = 'title' | 'slug' | 'ident' | 'cfield' | 'cflabel' | 'body';

/** Per-field BM25 weight (design S3.1). */
export const FIELD_WEIGHTS: Record<IndexField, number> = {
  title: 3.0,
  cflabel: 1.8,
  ident: 1.6,
  cfield: 1.6,
  slug: 1.2,
  body: 1.0,
};

export const INDEX_FIELDS: readonly IndexField[] = ['title', 'slug', 'ident', 'cfield', 'cflabel', 'body'];

/** Where a document's long text came from — the snippet's `source`. */
export type LongTextSource = 'article.content' | 'asset.fields' | 'title';

/**
 * The field that holds the same string as `longText` for each long-text source. Eviction and
 * re-index must treat the two as one unit: a document cannot hold its body text in a field while
 * claiming no body text is held.
 */
const LONG_TEXT_FIELD: Partial<Record<LongTextSource, IndexField>> = {
  'article.content': 'body',
  'asset.fields': 'cfield',
};

/** One indexed document (a record, reduced to what search needs). */
export interface SearchDoc {
  resource: string;
  id: number;
  title: string;
  slug: string;
  url: string;
  company_id: number | null;
  company_name: string | null;
  updated_at: string;
  /** Raw text per indexed field; a missing key means the document has no such field. */
  fields: Partial<Record<IndexField, string>>;
  /** The long text a snippet may be sliced from (article body / asset field text). */
  longText: string | null;
  longSource: LongTextSource;
  /** True when the long text was cut at `maxDocBytes`, so recall past the cut is lost. */
  longTruncated: boolean;
}

/** Bounds that bite, all reported by the engine when they do. */
export interface IndexBounds {
  maxDocBytes: number;
  maxIndexTextBytes: number;
  maxDocs: number;
}

export const DEFAULT_INDEX_BOUNDS: IndexBounds = {
  maxDocBytes: 256 * 1024,
  maxIndexTextBytes: 64 * 1024 * 1024,
  maxDocs: 20_000,
};

/** One postings list: parallel arrays, so 6 bytes per posting instead of an object map. */
export interface Posting {
  ids: number[];
  tfs: number[];
}

/** BM25 field statistics. */
export interface FieldStats {
  /** Documents with this field indexed (BM25's N_f). */
  n: number;
  /** Mean field length in tokens. */
  avgLen: number;
}

/** UTF-8 byte length of a string, without a Buffer dependency in the query path. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) as number;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else {
      bytes += 4;
      i += 1;
    }
  }
  return bytes;
}

/** The in-memory index. Documents are added, then `finalize()` rebuilds the derived structures. */
export class KnowledgeIndex {
  /**
   * Documents, in index order (which is `updated_at` descending for a capped walk).
   *
   * The ARRAY IS REPLACED (never reordered in place) by `retain`/`capDocs`: a reader that
   * captured this reference — a search that scored rows against it and then awaited the vendor
   * tier — keeps a consistent snapshot, so a numerical `docIndex` can never address a different
   * document after a concurrent build. Appends (`upsert` of a new key) leave existing indices
   * untouched, so they stay compatible with an in-flight reader.
   */
  docs: SearchDoc[] = [];
  /**
   * Changes to the document set/contents, monotonically. A reader compares it to tell whether the
   * data it scored is still what the index holds — a BUILD counter would miss a build that mutated
   * the index and then failed, and would also miss a bare eviction.
   */
  private contentVersion = 0;

  /** Live snapshot readers; while one is live the array is detached before any in-place write. */
  private readers = 0;
  /** True when `docs` was already copied away from the readers currently holding it. */
  private detachedForReaders = false;
  /** `resource:id` -> document index. */
  private readonly byKey = new Map<string, number>();
  private readonly postings = new Map<IndexField, Map<string, Posting>>();
  private readonly vocab = new Map<IndexField, Map<string, number>>();
  private readonly sortedVocab = new Map<IndexField, string[]>();
  private readonly trigramMap = new Map<IndexField, Map<string, string[]>>();
  private readonly docLens = new Map<IndexField, number[]>();
  private readonly fieldN = new Map<IndexField, number>();
  private readonly fieldAvg = new Map<IndexField, number>();
  private readonly accessClock = new Map<number, number>();
  private clock = 0;
  private textBytes = 0;
  private dirty = true;

  constructor(readonly bounds: IndexBounds = DEFAULT_INDEX_BOUNDS) {}

  /**
   * Hand out the current document array and keep it STABLE for the caller until `endRead`.
   *
   * A reader (a search that scored rows against these coordinates and may await a vendor call
   * before hydrating them) must never see an element of its snapshot replaced by a newer revision
   * of the same record: the row it scored described the revision it scored. While any reader is
   * live, the next in-place write copies the array first, so one array copy per write-batch keeps
   * every reader consistent.
   *
   * MEMORY. A live reader pins the documents of the generation it scored, so peak held text is the
   * index account plus one generation per in-flight search — the revision each search is answering
   * from, released when it calls `endRead` (the engine does that in a `finally`, so a reader's
   * lifetime is one search call). Those pinned generations are deliberately NOT charged to the text
   * budget: they cannot be freed while the reader lives, so charging them would evict live index text
   * to pay for bytes the eviction does not own.
   *
   * The account itself is normally at or below `maxIndexTextBytes`. It can stay ABOVE the bound when
   * no document remains whose text can be released (every remaining long text is one the account
   * cannot free): the loop then stops, because there is nothing left to evict. The bound is a limit
   * on what eviction may take, not a promise that unreleasable text disappears.
   */
  beginRead(): readonly SearchDoc[] {
    this.readers += 1;
    // The array handed out now has a reader, so the NEXT in-place write must detach again — even if a
    // previous write already copied it away from an earlier reader.
    this.detachedForReaders = false;
    return this.docs;
  }

  /** Release a snapshot handed out by `beginRead`. */
  endRead(): void {
    this.readers = Math.max(0, this.readers - 1);
    if (this.readers === 0) this.detachedForReaders = false;
  }

  /** Copy `docs` away from its live readers before a write that would otherwise change it in place. */
  private detachForReaders(): void {
    if (this.readers === 0 || this.detachedForReaders) return;
    this.docs = [...this.docs];
    this.detachedForReaders = true;
  }

  /** Monotonic version of the document contents (see `contentVersion`). */
  get version(): number {
    return this.contentVersion;
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.length;
  }

  /** Total extracted text held in memory, in bytes. */
  get textBytesHeld(): number {
    return this.textBytes;
  }

  /** Documents whose long text was dropped to stay inside `maxIndexTextBytes`. */
  get evicted(): number {
    return this.evictedDocs.size;
  }

  /** Insert or replace a document (`resource:id` is the key), then mark the index dirty. */
  upsert(doc: SearchDoc): void {
    const key = `${doc.resource}:${doc.id}`;
    const existing = this.byKey.get(key);
    this.detachForReaders();
    if (existing !== undefined) {
      const previous = this.docs[existing] as SearchDoc;
      // The replaced object leaves the index without being touched: a reader may still hold it, and
      // its text stays accounted for that reader's benefit until the object is collected.
      this.releaseTextAccount(previous);
      this.evictedDocs.delete(previous);
      this.docs[existing] = doc;
    } else {
      this.byKey.set(key, this.docs.length);
      this.docs.push(doc);
    }
    this.holdText(doc);
    this.dirty = true;
    this.contentVersion += 1;
  }

  /** True when a document is present under `resource:id`. */
  has(resource: string, id: number): boolean {
    return this.byKey.has(`${resource}:${id}`);
  }

  /**
   * Keep only the documents whose key is in `keys` (a full re-walk's delete detection).
   *
   * `only`, when given, restricts the delete-by-absence to the resources named in it: absence from
   * `keys` proves a deletion only for a resource whose walk actually completed. A capped walk that
   * never reached a resource's older records must NOT be read as "every record outside the walk is
   * gone" — that purges live documents.
   */
  retain(keys: ReadonlySet<string>, only?: ReadonlySet<string>): number {
    const kept: SearchDoc[] = [];
    const removed: string[] = [];
    for (const doc of this.docs) {
      const key = `${doc.resource}:${doc.id}`;
      const absenceProvesDeletion = keys.has(key) ? false : only === undefined || only.has(doc.resource);
      if (absenceProvesDeletion) removed.push(key);
      else kept.push(doc);
    }
    if (removed.length === 0) return 0;
    this.replaceDocs(kept);
    return removed.length;
  }

  /** Enforce `maxDocs` in `updated_at` descending order. Returns the number dropped. */
  capDocs(): number {
    if (this.docs.length <= this.bounds.maxDocs) return 0;
    const sorted = [...this.docs].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    const kept = sorted.slice(0, this.bounds.maxDocs);
    const dropped = this.docs.length - kept.length;
    this.replaceDocs(kept);
    return dropped;
  }

  /**
   * Swap in a new document array and re-derive the per-document bookkeeping (key map, held-text
   * total, LRU clock). The array is REPLACED so a reader holding the previous reference keeps a
   * consistent snapshot; documents that left the index are forgotten by the eviction set, which
   * would otherwise pin them (and their text) for the lifetime of the index.
   */
  private replaceDocs(next: readonly SearchDoc[]): void {
    this.docs = [...next];
    // A fresh array is unshared, so the next in-place write must detach again for the readers that
    // are still holding the PREVIOUS one.
    this.detachedForReaders = false;
    this.byKey.clear();
    this.textBytes = 0;
    this.accessClock.clear();
    this.dirty = true;
    this.contentVersion += 1;
    this.pruneEvicted();
    this.docs.forEach((doc, index) => {
      this.byKey.set(`${doc.resource}:${doc.id}`, index);
      this.holdText(doc);
    });
  }

  /** Forget evicted documents that are no longer part of the index (they would pin their objects). */
  private pruneEvicted(): void {
    if (this.evictedDocs.size === 0) return;
    const present = new Set(this.docs);
    for (const doc of [...this.evictedDocs]) {
      if (!present.has(doc)) this.evictedDocs.delete(doc);
    }
  }

  /** Rebuild postings, vocabulary and statistics from the documents. */
  finalize(): void {
    this.postings.clear();
    this.vocab.clear();
    this.sortedVocab.clear();
    this.trigramMap.clear();
    this.docLens.clear();
    this.fieldN.clear();
    this.fieldAvg.clear();
    for (const field of INDEX_FIELDS) {
      this.postings.set(field, new Map());
      this.vocab.set(field, new Map());
      this.trigramMap.set(field, new Map());
      this.docLens.set(field, new Array<number>(this.docs.length).fill(0));
    }
    for (let i = 0; i < this.docs.length; i += 1) {
      const doc = this.docs[i] as SearchDoc;
      for (const field of INDEX_FIELDS) {
        const text = doc.fields[field];
        // An evicted long field has no text and therefore no postings; the document is in
        // `evictedDocs` (see `withoutText`), which is how the lost recall is reported.
        const { tokens, compact } = text !== undefined && text.length > 0
          ? tokenizeField(text)
          : { tokens: [] as string[], compact: null as string | null };
        if (tokens.length === 0) continue;
        const lengths = this.docLens.get(field) as number[];
        lengths[i] = tokens.length;
        const list = this.postings.get(field) as Map<string, Posting>;
        const df = this.vocab.get(field) as Map<string, number>;
        const counts = new Map<string, number>();
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
        if (compact !== null) counts.set(compact, (counts.get(compact) ?? 0) + 1);
        for (const [token, tf] of counts) {
          const posting = list.get(token);
          if (posting) {
            posting.ids.push(i);
            posting.tfs.push(tf);
          } else {
            list.set(token, { ids: [i], tfs: [tf] });
          }
          df.set(token, (df.get(token) ?? 0) + 1);
          if (token.length >= MIN_FUZZY_CHARS - 1) {
            const tg = this.trigramMap.get(field) as Map<string, string[]>;
            for (const gram of ngramsOf(token)) {
              const bucket = tg.get(gram);
              if (bucket) bucket.push(token);
              else tg.set(gram, [token]);
            }
          }
        }
      }
    }
    for (const field of INDEX_FIELDS) {
      const df = this.vocab.get(field) as Map<string, number>;
      this.sortedVocab.set(field, [...df.keys()].sort());
      const lengths = this.docLens.get(field) as number[];
      let n = 0;
      let total = 0;
      for (const len of lengths) {
        if (len > 0) {
          n += 1;
          total += len;
        }
      }
      this.fieldN.set(field, n);
      this.fieldAvg.set(field, n === 0 ? 0 : total / n);
    }
    this.dirty = false;
  }

  /** Ensure the derived structures are current. */
  ensureFinalized(): void {
    if (this.dirty) this.finalize();
  }

  /** BM25 statistics of a field. */
  stats(field: IndexField): FieldStats {
    return { n: this.fieldN.get(field) ?? 0, avgLen: this.fieldAvg.get(field) ?? 0 };
  }

  /** Document length in tokens for one field. */
  lengthOf(docIndex: number, field: IndexField): number {
    return (this.docLens.get(field) ?? [])[docIndex] ?? 0;
  }

  /** Document frequency of a token in a field (0 when unknown). */
  documentFrequency(field: IndexField, token: string): number {
    return (this.vocab.get(field) ?? new Map()).get(token) ?? 0;
  }

  /** The postings list of a token in a field, if any. */
  posting(field: IndexField, token: string): Posting | undefined {
    return (this.postings.get(field) ?? new Map()).get(token);
  }

  /** Tokens of a field that start with `prefix`, in vocabulary order, capped at `limit`. */
  prefixTokens(field: IndexField, prefix: string, limit: number): string[] {
    if (prefix.length === 0 || limit <= 0) return [];
    const sorted = this.sortedVocab.get(field) ?? [];
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((sorted[mid] as string) < prefix) low = mid + 1;
      else high = mid;
    }
    const out: string[] = [];
    for (let i = low; i < sorted.length && out.length < limit; i += 1) {
      const token = sorted[i] as string;
      if (!token.startsWith(prefix)) break;
      if (token !== prefix) out.push(token);
    }
    return out;
  }

  /** Every vocabulary token of a field (used by the perf test to prove vocabulary-vs-corpus cost). */
  vocabularySize(field: IndexField): number {
    return (this.vocab.get(field) ?? new Map()).size;
  }

  /**
   * Fuzzy candidates for a token in a field: trigram-Dice candidate generation from the field's
   * VOCABULARY (never from the documents), then bounded Levenshtein re-scoring. The cost therefore
   * scales with the vocabulary, not with the corpus.
   */
  fuzzyTokens(field: IndexField, token: string, allowBody: boolean): { token: string; distance: number; dice: number }[] {
    if (token.length < MIN_FUZZY_CHARS) return [];
    if (field === 'body' && (!allowBody || token.length < MIN_FUZZY_BODY_CHARS)) return [];
    const budget = editBudget(token);
    const tg = this.trigramMap.get(field) ?? new Map<string, string[]>();
    const candidates = new Set<string>();
    for (const gram of ngramsOf(token)) {
      for (const candidate of tg.get(gram) ?? []) candidates.add(candidate);
    }
    const kept: { token: string; distance: number; dice: number }[] = [];
    for (const candidate of candidates) {
      if (candidate === token) continue;
      if (Math.abs(candidate.length - token.length) > budget) continue;
      const distance = editDistanceAtMost(token, candidate, budget);
      if (distance > budget) continue;
      const dice = diceCoefficient(token, candidate);
      if (token.length >= DICE_MIN_CHARS && dice < DICE_FLOOR) continue;
      kept.push({ token: candidate, distance, dice });
    }
    kept.sort((a, b) => (b.dice - a.dice) || (a.token < b.token ? -1 : 1));
    return kept.slice(0, MAX_FUZZY_CANDIDATES);
  }

  /** Note that a document was read (LRU order for text eviction). */
  touch(docIndex: number): void {
    this.clock += 1;
    this.accessClock.set(docIndex, this.clock);
  }

  /**
   * Note that a document was read, addressed by KEY.
   *
   * A coordinate belongs to the generation it was scored in: after a rebuild reorders or caps the
   * array, touching that number would mark a DIFFERENT document as recently used, and the next
   * eviction would then drop the body of the document the caller actually received. A document that
   * is no longer in the index is simply not touched.
   */
  touchDocument(resource: string, id: number): void {
    const docIndex = this.byKey.get(`${resource}:${id}`);
    if (docIndex !== undefined) this.touch(docIndex);
  }

  private holdText(doc: SearchDoc): void {
    if (doc.longText !== null) this.textBytes += utf8Bytes(doc.longText);
    this.ensureTextBudget();
  }

  /**
   * Return a document with its long text released, and take the released bytes out of the account.
   *
   * The document OBJECT a reader holds is never mutated: a snapshot must be trustworthy field by
   * field, not only in its order, so the index stores the returned copy instead of editing the
   * original (which a live reader may still be reading).
   *
   * The long text and its field string are the SAME string: dropping only `longText` keeps the
   * whole text reachable (the eviction frees nothing) while `bodiesIndexed` keeps counting a body
   * the index no longer holds. Release both — and with the recall that text carried: the document
   * joins `evictedDocs`, which the engine reports as `bodiesEvicted` + the `body-evicted` reason.
   */
  private withoutText(doc: SearchDoc, evict: boolean): SearchDoc {
    const freed = doc.longText === null ? 0 : utf8Bytes(doc.longText);
    // Only an EVICTABLE document may come through here (the caller's predicate guarantees it), and the
    // field mapping is what makes the release real: a long text with no field of its own would leave
    // the string reachable while the account claimed it was freed.
    this.textBytes -= freed;
    if (this.textBytes < 0) this.textBytes = 0;
    const copy: SearchDoc = { ...doc, longText: null, fields: { ...doc.fields } };
    const longField = LONG_TEXT_FIELD[doc.longSource];
    if (longField !== undefined) {
      const text = copy.fields[longField];
      if (text !== undefined) delete copy.fields[longField];
    }
    // `longTruncated` keeps its own meaning (the raw input was cut at `maxDocBytes`), so eviction is
    // reported through its own signal instead of overloading that flag: a caller who raises
    // `maxDocBytes` cannot restore what the TEXT budget took away.
    if (evict) this.evictedDocs.add(copy);
    return copy;
  }

  /** Take a document that is LEAVING the index out of the text account (it is not mutated). */
  private releaseTextAccount(doc: SearchDoc): void {
    if (doc.longText === null) return;
    this.textBytes -= utf8Bytes(doc.longText);
    if (this.textBytes < 0) this.textBytes = 0;
  }

  /**
   * Documents whose long text was evicted under `maxIndexTextBytes`. They keep their postings for
   * the fields they still hold (title, slug, custom-field labels), but a BODY term no longer reaches
   * them, so the engine reports the count (`bodiesEvicted`) and the reason (`body-evicted`) instead
   * of leaving a caller to infer the gap from an answer that quietly misses a match.
   */
  readonly evictedDocs = new Set<SearchDoc>();

  /**
   * True when this document's long text is held in a field of its own, so releasing it really frees
   * memory. A `longSource` outside `LONG_TEXT_FIELD` (the declared `'title'`) holds no separate
   * string, and evicting it would decrement the account without releasing anything.
   */
  private static isEvictable(doc: SearchDoc): boolean {
    return doc.longText !== null && LONG_TEXT_FIELD[doc.longSource] !== undefined;
  }

  /**
   * Drop the least-recently-read documents' TEXT until the account is back inside
   * `maxIndexTextBytes`. The text is what the bound measures and what the eviction really frees;
   * the recall that goes with it is recorded in `evictedDocs` and reported by the engine.
   */
  private ensureTextBudget(): void {
    while (this.textBytes > this.bounds.maxIndexTextBytes) {
      const victim = this.leastRecentlyRead((doc) => KnowledgeIndex.isEvictable(doc));
      if (victim < 0) return;
      // The index keeps the TEXT-FREE COPY; the evicted object a reader may be holding keeps its text.
      this.docs[victim] = this.withoutText(this.docs[victim] as SearchDoc, true);
    }
  }

  /** Index of the least-recently-read document matching `predicate`, or -1 when none does. */
  private leastRecentlyRead(predicate: (doc: SearchDoc) => boolean): number {
    let victim = -1;
    let oldest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.docs.length; i += 1) {
      const doc = this.docs[i] as SearchDoc;
      if (!predicate(doc)) continue;
      const at = this.accessClock.get(i) ?? -1;
      if (at < oldest) {
        oldest = at;
        victim = i;
      }
    }
    return victim;
  }
}

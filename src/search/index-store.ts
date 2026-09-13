/**
 * The in-memory postings index behind `operations.searchKnowledge`.
 *
 * Design of record: `.run/design/search/engine-design.md` S1/S2/S5. INTERNAL module, zero
 * dependencies, nothing on disk.
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
 *     document drops its TEXT (so a snippet is unavailable with reason `evicted`) but keeps its
 *     postings (so body recall still works);
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
  /** Documents, in index order (which is `updated_at` descending for a capped walk). */
  readonly docs: SearchDoc[] = [];
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
    if (existing !== undefined) {
      this.dropText(this.docs[existing] as SearchDoc, false);
      this.docs[existing] = doc;
    } else {
      this.byKey.set(key, this.docs.length);
      this.docs.push(doc);
    }
    this.holdText(doc);
    this.dirty = true;
  }

  /** True when a document is present under `resource:id`. */
  has(resource: string, id: number): boolean {
    return this.byKey.has(`${resource}:${id}`);
  }

  /** Keep only the documents whose key is in `keys` (a full re-walk's delete detection). */
  retain(keys: ReadonlySet<string>): number {
    const kept: SearchDoc[] = [];
    const removed: string[] = [];
    for (const doc of this.docs) {
      const key = `${doc.resource}:${doc.id}`;
      if (keys.has(key)) kept.push(doc);
      else removed.push(key);
    }
    if (removed.length === 0) return 0;
    this.docs.length = 0;
    this.byKey.clear();
    this.textBytes = 0;
    this.accessClock.clear();
    this.dirty = true;
    for (const doc of kept) {
      this.byKey.set(`${doc.resource}:${doc.id}`, this.docs.length);
      this.docs.push(doc);
      this.holdText(doc);
    }
    return removed.length;
  }

  /** Enforce `maxDocs` in `updated_at` descending order. Returns the number dropped. */
  capDocs(): number {
    if (this.docs.length <= this.bounds.maxDocs) return 0;
    const sorted = [...this.docs].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    const kept = sorted.slice(0, this.bounds.maxDocs);
    const dropped = this.docs.length - kept.length;
    this.docs.length = 0;
    this.byKey.clear();
    this.textBytes = 0;
    this.accessClock.clear();
    this.dirty = true;
    for (const doc of kept) {
      this.byKey.set(`${doc.resource}:${doc.id}`, this.docs.length);
      this.docs.push(doc);
      this.holdText(doc);
    }
    return dropped;
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
        if (text === undefined || text.length === 0) continue;
        const { tokens, compact } = tokenizeField(text);
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

  private holdText(doc: SearchDoc): void {
    if (doc.longText !== null) this.textBytes += utf8Bytes(doc.longText);
    this.ensureTextBudget();
  }

  private dropText(doc: SearchDoc, evict: boolean): void {
    if (doc.longText !== null) {
      this.textBytes -= utf8Bytes(doc.longText);
      if (this.textBytes < 0) this.textBytes = 0;
      doc.longText = null;
      if (evict) this.evictedDocs.add(doc);
    }
  }

  /** Documents that lost their text (they keep postings, so they still rank). */
  readonly evictedDocs = new Set<SearchDoc>();

  /** Drop the least-recently-read documents' text until `maxIndexTextBytes` is satisfied. */
  private ensureTextBudget(): void {
    while (this.textBytes > this.bounds.maxIndexTextBytes) {
      let victim = -1;
      let oldest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.docs.length; i += 1) {
        const doc = this.docs[i] as SearchDoc;
        if (doc.longText === null) continue;
        const at = this.accessClock.get(i) ?? -1;
        if (at < oldest) {
          oldest = at;
          victim = i;
        }
      }
      if (victim < 0) return;
      this.dropText(this.docs[victim] as SearchDoc, true);
    }
  }
}

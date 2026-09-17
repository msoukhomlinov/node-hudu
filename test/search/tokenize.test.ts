/**
 * Tokeniser, index and config-bound unit tests.
 *
 * These cover the primitives the engine depends on and the design's specific normalisation rules
 * (the camelCase boundary that `7GH2K83` depends on, CJK bigrams, the compact token, the plural
 * fold and the trigram/Levenshtein gates).
 */
import { describe, it, expect } from 'vitest';
import {
  normaliseText, tokenizeText, tokenizeField, splitQueryTerms, compactOfQuery, pluralVariants,
  ngramsOf, diceCoefficient, editDistanceAtMost, editBudget, STOPWORDS,
} from '../../src/search/tokenize.js';
import { KnowledgeIndex, DEFAULT_INDEX_BOUNDS, utf8Bytes, type SearchDoc } from '../../src/search/index-store.js';
import { resolveConfig, DEFAULT_SEARCH_CONFIG } from '../../src/config.js';
import { HuduConfigError } from '../../src/errors.js';

describe('tokeniser', () => {
  it('folds accents, splits camelCase on lower->upper only, and drops punctuation', () => {
    expect(normaliseText('Café Müller')).toBe('cafe muller');
    expect(normaliseText('onboarding-checklist')).toBe('onboarding checklist');
    expect(normaliseText('FortiGate VPN site-to-site')).toBe('forti gate vpn site to site');
    // The digit-adjacent rule is deliberately NOT a boundary: 7GH2K83 is one code, not three tokens.
    expect(tokenizeText('7GH2K83')).toEqual(['7gh2k83']);
    expect(tokenizeText('onboardingChecklist')).toEqual(['onboarding', 'checklist']);
  });

  it('emits bigrams for a CJK run and keeps short runs whole', () => {
    expect(tokenizeText('日本語')).toEqual(['日本', '本語']);
    expect(tokenizeText('日本')).toEqual(['日本']);
  });

  it('emits a compact token and falls back to raw tokens when a query is all stopwords', () => {
    expect(tokenizeField('Onboarding checklist')).toEqual({ tokens: ['onboarding', 'checklist'], compact: 'onboardingchecklist' });
    expect(tokenizeField('Single').compact).toBeNull();
    expect(tokenizeField('').tokens).toEqual([]);
    expect(compactOfQuery(['onboarding', 'checklist'])).toBe('onboardingchecklist');
    expect(compactOfQuery(['one'])).toBeNull();
    const stopwords = splitQueryTerms('not connecting vpn');
    expect(stopwords.terms).toEqual(['connecting', 'vpn']);
    expect(stopwords.dropped).toEqual(['not']);
    // Dropping stopwords must never empty the query: an all-stopword query keeps its raw tokens.
    expect(splitQueryTerms('the and of').terms).toEqual(['the', 'and', 'of']);
    expect(splitQueryTerms('the and of').dropped).toEqual([]);
    expect(splitQueryTerms('the onboarding').dropped).toEqual(['the']);
    expect(STOPWORDS.has('the')).toBe(true);
  });

  it('folds plurals, trigrams and edit distance within the design gates', () => {
    expect(pluralVariants('licences')).toEqual(['licence']);
    expect(pluralVariants('licence')).toEqual(['licences']);
    expect(pluralVariants('is')).toEqual([]);
    expect(ngramsOf('ab')).toEqual(['ab']);
    // Bigrams below 6 characters: a 3-character token has one trigram, so one typo would share none.
    expect(ngramsOf('vps')).toEqual(['vp', 'ps']);
    expect(ngramsOf('abcdef')).toEqual(['abc', 'bcd', 'cde', 'def']);
    expect(diceCoefficient('vps', 'vpn')).toBeCloseTo(0.5, 2);
    expect(diceCoefficient('onboardng', 'onboarding')).toBeCloseTo(0.667, 2);
    expect(diceCoefficient('', 'x')).toBe(0);
    expect(editDistanceAtMost('vps', 'vpn', 1)).toBe(1);
    expect(editDistanceAtMost('vps', 'zzzz', 1)).toBe(2);
    expect(editDistanceAtMost('same', 'same', 1)).toBe(0);
    expect(editDistanceAtMost('kitten', 'sitting', 2)).toBe(3);
    expect(editBudget('short')).toBe(1);
    expect(editBudget('sevente')).toBe(2);
  });
});

describe('knowledge index', () => {
  const doc = (id: number, name: string, body?: string): SearchDoc => ({
    resource: 'articles' as const,
    id,
    title: name,
    slug: `slug-${id}`,
    url: '',
    company_id: 1,
    company_name: null,
    updated_at: `2026-01-0${id}T00:00:00.000Z`,
    fields: { title: name, slug: `slug-${id}`, ...(body ? { body } : {}) },
    longText: body ?? null,
    longSource: 'article.content',
    longTruncated: false,
  });

  it('answers from postings and exposes its own statistics', () => {
    const index = new KnowledgeIndex(DEFAULT_INDEX_BOUNDS);
    index.upsert(doc(1, 'Onboarding checklist', 'assign the licence'));
    index.upsert(doc(2, 'Printer toner', 'replace the cartridge'));
    index.finalize();
    expect(index.size).toBe(2);
    expect(index.has('articles', 1)).toBe(true);
    expect(index.has('articles', 9)).toBe(false);
    expect(index.documentFrequency('title', 'onboarding')).toBe(1);
    expect(index.posting('title', 'onboarding')?.ids).toEqual([0]);
    expect(index.stats('title')).toEqual({ n: 2, avgLen: 2 });
    expect(index.lengthOf(0, 'body')).toBe(3);
    expect(index.prefixTokens('title', 'onb', 10)).toEqual(['onboarding', 'onboardingchecklist']);
    expect(index.prefixTokens('title', '', 10)).toEqual([]);
    expect(index.vocabularySize('title')).toBeGreaterThan(0);
    const fuzzy = index.fuzzyTokens('title', 'onboardng', false);
    expect(fuzzy[0]?.token).toBe('onboarding');
    expect(index.fuzzyTokens('title', 'ab', false)).toEqual([]);
    // Body prose only tolerates typos from 6 characters, and only when the flag allows it.
    expect(index.fuzzyTokens('body', 'licenc', false)).toEqual([]);
    expect(index.fuzzyTokens('body', 'licences', true).some((c) => c.token === 'licence')).toBe(true);
    expect(index.ensureFinalized()).toBeUndefined();
    expect(utf8Bytes('é')).toBe(2);
  });

  it('gives every reader its own stable document array', () => {
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 1024 * 1024, maxDocs: 10 });
    index.upsert(doc(1, 'one', 'body one'));
    const first = index.beginRead();
    index.upsert(doc(2, 'two', 'body two')); // detaches the array from `first`
    const second = index.beginRead(); // the SECOND reader gets the current array
    index.upsert(doc(2, 'two revised', 'body two')); // must detach again, from `second`

    // A stale detach latch would let this write reach the second reader's array.
    expect((second[1] as SearchDoc).title).toBe('two');
    expect(second).toHaveLength(2);
    // The first reader's array is the earlier snapshot: it never grew and never changed.
    expect(first).toHaveLength(1);
    expect((first[0] as SearchDoc).title).toBe('one');
    expect((index.docs[1] as SearchDoc).title).toBe('two revised');
    index.endRead();
    index.endRead();
  });

  it('retains and caps documents, and evicts text as a unit with its recall reported', () => {
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 1024 * 1024, maxDocs: 1 });
    index.upsert(doc(1, 'Kept article', 'body text'));
    index.upsert(doc(2, 'Dropped article', 'body text'));
    index.finalize();
    expect(index.capDocs()).toBe(1);
    expect(index.size).toBe(1);
    // maxDocs keeps the FRESHEST documents, so the 2026-01-02 record survives, not the 01-01 one.
    expect(index.has('articles', 2)).toBe(true);
    expect(index.has('articles', 1)).toBe(false);
    expect(index.retain(new Set(['articles:1']))).toBe(1);
    expect(index.size).toBe(0);
    expect(index.retain(new Set(['articles:1']))).toBe(0);

    const small = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 1, maxDocs: 10 });
    const evictedDoc = doc(1, 'Evicted article', 'a long body that will not fit in one byte');
    small.upsert(evictedDoc);
    small.finalize();
    expect(small.textBytesHeld).toBe(0);
    expect(small.evicted).toBe(1);
    // The eviction releases the TEXT as one unit: `longText` and the `body` field string that holds
    // the same string go together, because keeping the field string would keep the whole text alive —
    // which is exactly what the eviction exists to free. The tokenised form is not kept instead: a
    // measured token array costs several times the text it came from, so it would make the bound a
    // claim rather than a limit. The cost is the body recall, and the flag reports it.
    const held = small.docs[0] as SearchDoc;
    expect(held.longText).toBeNull();
    expect(held.fields.body).toBeUndefined();
    // Eviction is NOT the byte cap: `longTruncated` keeps that meaning, and the eviction is reported
    // through its own count so a caller who raises `maxDocBytes` is not told it will help.
    expect(held.longTruncated).toBe(false);
    // The object the CALLER still holds is untouched: eviction stores a text-free copy, so a reader
    // that captured the document never loses a field under it (the snapshot invariant).
    expect(evictedDoc.longText).not.toBeNull();
    expect(small.posting('body', 'long')).toBeUndefined();
    small.touch(0);
    expect(small.evictedDocs.size).toBe(1);
  });
});

describe('search config bounds', () => {
  it('resolves the index bounds, rejects a non-positive bound and keeps the defaults', () => {
    const base = resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k' });
    expect(base.search).toEqual(DEFAULT_SEARCH_CONFIG);
    const custom = resolveConfig({
      baseUrl: 'https://hudu.example.com',
      apiKey: 'k',
      search: { maxDocs: 5, fuzzyBody: false, maxIndexPages: 2 },
    });
    expect(custom.search.maxDocs).toBe(5);
    expect(custom.search.fuzzyBody).toBe(false);
    expect(custom.search.maxIndexPages).toBe(2);
    expect(custom.search.maxDocBytes).toBe(DEFAULT_SEARCH_CONFIG.maxDocBytes);
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', search: { maxDocs: 0 } })).toThrow(HuduConfigError);
    expect(() => resolveConfig({ baseUrl: 'https://hudu.example.com', apiKey: 'k', search: { fuzzyBody: 'yes' as never } })).toThrow(
      /fuzzyBody must be a boolean/,
    );
  });
});

describe('text shares per declared long-text source (issue #46)', () => {
  /** A single long-text source gets the whole bound, not its own share: no half-cut for one resource. */
  const articleDoc = (id: number, bytes: number): SearchDoc => {
    const body = 'a'.repeat(bytes);
    return {
      resource: 'articles', id, title: `Article ${id}`, slug: `article-${id}`, url: '', company_id: 1,
      company_name: null, updated_at: `2026-01-0${id}T00:00:00.000Z`,
      fields: { title: `Article ${id}`, body }, longText: body, longSource: 'article.content', longTruncated: false,
    };
  };
  const assetDoc = (id: number, bytes: number): SearchDoc => {
    const value = 'b'.repeat(bytes);
    return {
      resource: 'assets', id, title: `Asset ${id}`, slug: `asset-${id}`, url: '', company_id: 1,
      company_name: null, updated_at: `2026-02-0${id}T00:00:00.000Z`,
      fields: { title: `Asset ${id}`, cfield: value }, longText: value, longSource: 'asset.fields', longTruncated: false,
    };
  };
  /** A `title` long source has no field of its own: it holds no separate string and is never a victim. */
  const titleLongDoc = (id: number, bytes: number): SearchDoc => {
    const text = 'c'.repeat(bytes);
    return {
      resource: 'articles', id, title: text, slug: `title-${id}`, url: '', company_id: 1,
      company_name: null, updated_at: `2026-03-0${id}T00:00:00.000Z`,
      fields: { title: text, body: text }, longText: text, longSource: 'title', longTruncated: false,
    };
  };
  const heldTextDocs = (index: KnowledgeIndex) => index.docs.filter((doc) => doc.longText !== null);

  it('charges an overflow to the resource that holds MORE than its limit, not to one inside its share', () => {
    // 2000 bytes of budget: 1000 per declared long-text source. The article body fits its share, so
    // every asset that pushes the account over the bound pays with asset text of its own.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    index.upsert(articleDoc(1, 800));
    index.upsert(assetDoc(1, 800));
    index.upsert(assetDoc(2, 800)); // account 2400 > 2000, and only the ASSETS are over their limit
    index.upsert(assetDoc(3, 800));

    expect(index.docs[0]?.longText).not.toBeNull();
    expect(index.docs[0]?.fields.body).toBeDefined();
    expect(index.textBytesHeld).toBe(1600); // 800 article + 800 asset, never 0 + 1600
    expect(heldTextDocs(index).length).toBe(2);
    expect(index.docs.filter((doc) => doc.resource === 'assets' && doc.longText === null).length).toBe(2);
  });

  it('reclaims an article body inserted last by evicting an ASSET that was borrowing the article share', () => {
    // HEAD satisfies this one too, and only by index order: the article is inserted LAST, so HEAD's
    // empty-clock tie-break (lowest index wins) also lands on an asset. Kept as the plain
    // borrow/reclaim guard - the staged-read test at the end of this block is the same property with
    // that coincidence removed.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    // Assets alone borrow the unused article share: with no article text, `limit(assets)` is the
    // whole bound, so three 800-byte texts leave the account at 1600 (above the 1000-byte share).
    index.upsert(assetDoc(1, 800));
    index.upsert(assetDoc(2, 800));
    index.upsert(assetDoc(3, 800));
    expect(index.textBytesHeld).toBe(1600);

    index.upsert(articleDoc(1, 800)); // 2400 > 2000 -> the article is inside its limit; an ASSET pays
    expect(index.docs.find((doc) => doc.resource === 'articles')?.longText).not.toBeNull();
    expect(index.docs.find((doc) => doc.resource === 'articles')?.fields.body).toBeDefined();
    expect(index.docs.filter((doc) => doc.resource === 'assets' && doc.longText === null).length).toBe(2);
    expect(index.textBytesHeld).toBe(1600);
  });

  it('never cuts a single-resource tenant to its own share', () => {
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    index.upsert(assetDoc(1, 800));
    index.upsert(assetDoc(2, 800));
    index.upsert(assetDoc(3, 800));

    // limit(assets) = share + the WHOLE unused article share = 2000 = the bound, so two of the three
    // texts stay. Cutting the resource to its own 1000-byte share would leave 800. HEAD satisfies
    // this as well: a REVERSIBILITY guard on the borrowing rule, not evidence for the fix.
    expect(index.textBytesHeld).toBe(1600);
    expect(index.textBytesHeld).toBeGreaterThan(index.bounds.maxIndexTextBytes / 2);
    expect(index.evicted).toBe(1);
  });

  it('still evicts an article corpus that overflows the bound on its own, and touches no asset text', () => {
    // HEAD satisfies this as well: a guard that the narrowed predicate did not turn into "never
    // evict the inserting source", not evidence for the fix.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    index.upsert(articleDoc(1, 800));
    index.upsert(articleDoc(2, 800));
    index.upsert(articleDoc(3, 800));

    expect(index.textBytesHeld).toBe(1600);
    expect(index.evicted).toBe(1);
    expect(heldTextDocs(index).length).toBe(2);
    expect(heldTextDocs(index).every((doc) => doc.fields.body !== undefined)).toBe(true);
  });

  it('never evicts unreleasable `title` long text, and lets the account stay above the bound when it is the only text left', () => {
    // HEAD satisfies this as well - it also never evicted an undeclared source. It pins the
    // undeclared-source branch of the accounting (`creditText` charges it to no share), not the
    // victim rule.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 100, maxDocs: 10 });
    index.upsert(titleLongDoc(1, 500)); // no separate field string: evicting it would free nothing
    index.upsert(assetDoc(1, 800));

    // The asset is the only releasable text, so it pays for the overflow; what remains is 500 bytes
    // of text no eviction can free, which is exactly the state the bound documents rather than hides.
    expect(index.textBytesHeld).toBe(500);
    expect(index.docs[0]?.longText).not.toBeNull();
    expect(index.docs[0]?.fields.title).toBeDefined();
    expect(index.evicted).toBe(1);
  });

  it('does not double-count a two-phase re-hold, and matches a fresh index built from the same documents', () => {
    // HEAD satisfies this as well: it pins the `replaceDocs` accounting site of the per-source
    // account (the fourth site that must move with `textBytes`), not the victim rule.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    index.upsert(articleDoc(1, 800));
    index.upsert(assetDoc(1, 800));
    index.upsert(assetDoc(2, 800));

    // `retain` swaps the array and RE-HOLDS every surviving document: each held text is released
    // again first, so neither account may end up counting a document twice.
    const removed = index.retain(new Set(['articles:1', 'assets:1']));
    expect(removed).toBe(1);
    expect(index.textBytesHeld).toBe(800);

    const fresh = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    for (const doc of index.docs) fresh.upsert(doc);
    expect(fresh.textBytesHeld).toBe(index.textBytesHeld);
  });

  it('keeps the in-resource LRU order: a touched document is not the next victim', () => {
    // HEAD satisfies this by design: it pins D5 - the order INSIDE the eligible set is unchanged, so
    // the rule that decides which over-limit document goes first is the one HEAD already had.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2400, maxDocs: 10 });
    index.upsert(articleDoc(1, 800));
    index.upsert(articleDoc(2, 800));
    index.upsert(articleDoc(3, 800)); // 2400 == bound, nothing evicted yet
    expect(index.evicted).toBe(0);

    index.touchDocument('articles', 3); // document 3 (index 2) was read: it is now the newest
    index.upsert(articleDoc(4, 800)); // 3200 > 2400 -> one victim, by the LRU clock

    // The clock is only advanced by a read, so the empty-clock tie-break (lowest index) still applies
    // inside the resource: index 0 goes first, and index 2 - the touched document - is kept.
    expect(index.docs[0]?.longText).toBeNull();
    expect(index.docs[2]?.longText).not.toBeNull();
    expect(index.docs[3]?.longText).not.toBeNull();
    expect(index.evicted).toBe(1);
  });

  it('pays for an article insert from the OVER-LIMIT source even when the article is what an empty clock would pick', () => {
    // HEAD's only rule is "least recently read over EVERY evictable document", and a document that
    // was never read has no clock entry at all (it counts as -1, the oldest possible), so a document
    // inserted last is the FIRST victim unless something else was read. Here the two surviving assets
    // are marked read first, exactly as a search hit would mark them (`touchDocument`, the documented
    // LRU path), so on HEAD the freshly inserted article body is the victim. The share rule must
    // refuse it: the article holds less than its limit, and the ASSETS are the source over theirs.
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    index.upsert(assetDoc(1, 800));
    index.upsert(assetDoc(2, 800));
    index.upsert(assetDoc(3, 800)); // 2400 > 2000 -> one asset pays, and both rules agree so far
    expect(index.evicted).toBe(1);
    expect(index.textBytesHeld).toBe(1600);
    index.touchDocument('assets', 2);
    index.touchDocument('assets', 3);

    index.upsert(articleDoc(1, 800)); // 2400 > 2000 again, with the article indexed LAST

    expect(index.docs[3]?.longText).not.toBeNull();
    expect(index.docs[3]?.fields.body).toBeDefined();
    expect(index.textBytesHeld).toBe(1600); // the asset paid, and the account is back inside the bound
    expect(index.docs.filter((doc) => doc.resource === 'assets' && doc.longText === null).length).toBe(2);
  });

  it('does not evict a body that is inside its share to pay for UNCHARGED `title` text', () => {
    // `'title'` holds no field string of its own: it is charged to no share and can never be a
    // victim, which makes it the ONE thing that can leave the account above the bound (the engine
    // emits no such document - `articleDoc`/`assetDoc` use the two declared sources). A source inside
    // its limit must not be drained to compensate for text eviction cannot free; HEAD drains it,
    // because its rule saw only "evictable".
    const index = new KnowledgeIndex({ maxDocBytes: 1024, maxIndexTextBytes: 2000, maxDocs: 10 });
    index.upsert(titleLongDoc(1, 1500));
    // A DIFFERENT id: `articles:1` is already the key of the uncharged document above, and a repeat
    // key would REPLACE it (releasing its text) instead of adding a second document.
    index.upsert(articleDoc(2, 900)); // 900 bytes of article body, inside the 1000-byte article share

    // ABOVE the 2000-byte bound, and honestly so: nothing left in the index may be released.
    expect(index.textBytesHeld).toBe(2400);
    expect(index.docs[1]?.longText).not.toBeNull();
    expect(index.docs[1]?.fields.body).toBeDefined();
    expect(index.evicted).toBe(0);
  });
});

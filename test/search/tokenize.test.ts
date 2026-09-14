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
    expect(held.longTruncated).toBe(true);
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

# HTML -> clean text -> snippet pipeline (design)

Status: DESIGN ONLY. No file under `src/`, `test/` or `scripts/` was modified. Evidence: live Hudu 2.45.1 sandbox.
Builds on `PROPOSAL.md` (amendment 11.1/11.2), `engine-design.md` (§1.1 ingestion, §1.3 memory, §4.1 snippet honesty).

## 0. Summary / decisions at a glance
TODO

## 1. Evidence: what real Hudu article HTML contains
### 1.1 Baseline articles (16-19), markup family inventory
TODO
### 1.2 Specimen created by this agent (id 33): what the API stores and returns
TODO
### 1.3 What the vendor does with the markup (sanitisation check)
TODO

## 2. The extractor: in-repo, zero-dependency HTML -> text
### 2.1 Output contract and normalisation rules
TODO
### 2.2 Scanner structure (why one pass, not regexes)
TODO
### 2.3 Entity decoding
TODO
### 2.4 Malformed / unclosed markup
TODO
### 2.5 Complexity and pathological behaviour
TODO
### 2.6 What we deliberately do NOT handle
TODO
### 2.7 Where naive approaches fail (measured)
TODO

## 3. Snippets
### 3.1 Offset contract (explicit)
TODO
### 3.2 Match location through the fold (index map)
TODO
### 3.3 Windowing, word-boundary expansion, truncation
TODO
### 3.4 Multi-term matches in different places
TODO
### 3.5 Match only in a field we do not show
TODO
### 3.6 Verbatim proof
TODO

## 4. Honesty + budget
### 4.1 Extracted text is derived; raw HTML is a follow-up `get`
TODO
### 4.2 Bound per document
TODO
### 4.3 Updated memory maths (maxDocBytes / maxIndexTextBytes)
TODO

## 5. Before / after examples on real HTML
### 5.1 Article 16 (9,136 bytes) raw -> extracted -> snippet
TODO
### 5.2 Specimen article 33 (awkward markup) raw -> extracted -> snippet
TODO

## 6. Open questions / UNVERIFIED
TODO

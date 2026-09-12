/**
 * Article — Hudu API model
 */
export interface Article {
  id: number; // The unique ID of the article.
  slug: string; // The url slug of the article.
  name: string; // The name of the article.
  draft: boolean; // A flag that signifies if the article is a draft.
  content: string; // The HTML content of the article.
  url: string; // The url of the article.
  object_type: string; // The object type is Article.
  folder_id: number; // The unique folder ID where the article lives.
  enable_sharing: boolean; // A flag that signifies if the article is shareable.
  share_url: string; // A url for shareable articles.
  company_id: number; // The unique company ID for non-global articles.
  created_at: string; // The date and time when the article was created.
  updated_at: string; // The date and time when the article was last updated.
  public_photos: string[]; // A list of public photos.
}

/**
 * Input for creating a Article.
 * All fields are optional unless the API requires them; see docs.
 */
export type ArticleCreate = Partial<Omit<Article, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Article.
 */
import type { Company, CompanySummary } from './company.js';
import type { Folder } from './folder.js';

export type ArticleUpdate = Partial<Article>;


/**
 * Compact agent-facing projection of `Article` (policy §9, SCOPING decision 6).
 *
 * Keeps: id, name, slug, company_id, folder_id, draft, enable_sharing, updated_at.
 * Drops (recorded in the registry `outputSchema.drops`): content, url, share_url,
 * public_photos, object_type, created_at.
 */
export interface ArticleSummary {
  id: number;
  name: string;
  slug: string;
  company_id: number;
  folder_id: number;
  draft: boolean;
  enable_sharing: boolean;
  updated_at: string;
}

/** Identifier kinds `articles.resolve` understands (policy §7). */
export interface ArticleIdentifier {
  id?: number;
  name?: string;
  slug?: string;
  company_id?: number;
}

/** Bounded context bundle returned by `articles.getContext` (policy §9). */
export interface ArticleContext {
  article: ArticleSummary;
  company: CompanySummary | null;
  folder: Folder | null;
}

/** `articles.getContext(id, { expand: true })` — the article is the full typed record. */
export interface ArticleContextExpand {
  article: Article;
  company: Company | null;
  folder: Folder | null;
}

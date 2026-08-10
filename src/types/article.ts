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
export type ArticleUpdate = Partial<Article>;

/**
 * ArticlesResource — Hudu "articles" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Article, ArticleCreate, ArticleUpdate } from '../types/index.js';

export interface ArticlesListParams extends ListParams {
  name?: string;
  company_id?: number;
  draft?: boolean;
  enable_sharing?: boolean;
  slug?: string;
  search?: string;
  updated_at?: string;
}

export class ArticlesResource extends BaseResource<Article> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'articles', singleKey: 'article', listKey: 'articles', createType: 'raw', paginated: true });
  }

  /** Get a articles by id. */
  async get(id: number): Promise<Article> {
    return this.getOne<Article>(id);
  }
  /** Stream articles across pages. */
  list(params?: ArticlesListParams): AsyncIterable<Article> {
    return this.items(params ?? {});
  }
  /** Get every articles. MCP-preferred read. */
  async listAll(params?: ArticlesListParams): Promise<Article[]> {
    return this.all(params ?? {});
  }
  async create(data: ArticleCreate): Promise<Article> {
    return this.createOne<Article>(data);
  }
  async update(id: number, data: ArticleUpdate): Promise<Article> {
    return this.updateOne<Article>(id, data);
  }
  async delete(id: number): Promise<void> {
    return this.deleteOne(id);
  }
  async archive(id: number): Promise<void> {
    return this.setArchived(id, true);
  }
  async unarchive(id: number): Promise<void> {
    return this.setArchived(id, false);
  }

  listPages(params?: ArticlesListParams): AsyncIterable<Page<Article>> {
    return this.pageIter(params ?? {});
  }


}

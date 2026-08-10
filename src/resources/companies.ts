/**
 * CompaniesResource — Hudu "companies" resource.
 */
import type { HttpClient } from '../http.js';
import { BaseResource } from './base.js';
import type { ListParams, Page } from '../pagination.js';
import type { Company, CompanyCreate, CompanyUpdate } from '../types/index.js';

export interface CompaniesListParams extends ListParams {
  name?: string;
  phone_number?: string;
  website?: string;
  city?: string;
  id_number?: string;
  state?: string;
  slug?: string;
  search?: string;
  id_in_integration?: string;
  updated_at?: string;
}

export class CompaniesResource extends BaseResource<Company> {
  constructor(http: HttpClient) {
    super(http, { resourcePath: 'companies', singleKey: 'company', listKey: 'companies', createType: 'raw', paginated: true });
  }

  /** Get a companies by id. */
  async get(id: number): Promise<Company> {
    return this.getOne<Company>(id);
  }
  /** Stream companies across pages. */
  list(params?: CompaniesListParams): AsyncIterable<Company> {
    return this.items(params ?? {});
  }
  /** Get every companies. MCP-preferred read. */
  async listAll(params?: CompaniesListParams): Promise<Company[]> {
    return this.all(params ?? {});
  }
  async create(data: CompanyCreate): Promise<Company> {
    return this.createOne<Company>(data);
  }
  async update(id: number, data: CompanyUpdate): Promise<Company> {
    return this.updateOne<Company>(id, data);
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

  /**
   * GET /companies/jump — follows the 302 redirect and returns the final location URL.
   */
  async jump(params: { integration_slug: string; integration_id?: string; integration_identifier?: string }): Promise<string> {
    return this.followRedirect('/companies/jump', params);
  }

  listPages(params?: CompaniesListParams): AsyncIterable<Page<Company>> {
    return this.pageIter(params ?? {});
  }


}

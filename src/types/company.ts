/**
 * Company — Hudu API model
 */
export interface Company {
  id: number; // The unique identifier of the company.
  slug: string; // The URL-friendly identifier of the company.
  name: string; // The full name of the company.
  nickname: string | null; // The nickname or short name of the company. Can be null.
  address_line_1: string; // The first line of the company's address.
  address_line_2: string | null; // The second line of the company's address. Can be null.
  city: string; // The city where the company is located.
  state: string; // The state or province where the company is located.
  zip: string; // The zip or postal code of the company's location.
  country_name: string | null; // The name of the country where the company is located. Can be null.
  phone_number: string; // The company's phone number.
  company_type: string | null; // The type of the company. Can be null.
  parent_company_id: number | null; // The unique identifier of the parent company. Can be null.
  parent_company_name: string | null; // The name of the parent company. Can be null.
  fax_number: string; // The company's fax number.
  website: string; // The company's website URL.
  notes: string | null; // Additional notes or information about the company. Can be null.
  archived: boolean; // Indicates if the company has been archived.
  object_type: string; // The type of the object, in this case, "Company".
  id_number: string; // A custom set identificaiton number.
  url: string; // The URL path of the company within the application.
  full_url: string; // The full URL of the company within the application.
  passwords_url: string; // The URL for the company's passwords within the application.
  knowledge_base_url: string; // The URL for the company's knowledge base within the application.
  created_at: string; // The date and time when the company was created.
  updated_at: string; // The date and time when the company was last updated.
  integrations: CompanyIntegration[]; // A list of integrations associated with the company.
}

/**
 * Input for creating a Company.
 * All fields are optional unless the API requires them; see docs.
 */
export type CompanyCreate = Partial<Omit<Company, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Company.
 */
import type { CompanyIntegration } from './company_integration.js';
import type { Article, ArticleSummary } from './article.js';
import type { Asset, AssetSummary } from './asset.js';
import type { AssetPassword, AssetPasswordSummary } from './asset_password.js';
import type { Website } from './website.js';

export type CompanyUpdate = Partial<Company>;


/**
 * Compact agent-facing projection of `Company` (policy §9, SCOPING decision 6).
 *
 * Keeps: id, name, nickname, slug, website, phone_number, city, state, id_number,
 * archived, url, updated_at.
 * Drops (recorded in the registry `outputSchema.drops`): address_line_1,
 * address_line_2, zip, country_name, company_type, parent_company_id,
 * parent_company_name, fax_number, notes, object_type, full_url, passwords_url,
 * knowledge_base_url, created_at, integrations.
 */
export interface CompanySummary {
  id: number;
  name: string;
  nickname: string | null;
  slug: string;
  website: string;
  phone_number: string;
  city: string;
  state: string;
  id_number: string;
  archived: boolean;
  url: string;
  updated_at: string;
}

/**
 * Identifier kinds `companies.resolve` understands (policy §7). A bare value is
 * read in the documented order: numeric id, slug, exact name, domain.
 */
export interface CompanyIdentifier {
  id?: number;
  name?: string;
  slug?: string;
  website?: string;
  domain?: string;
}

/** Bounded context bundle returned by `companies.getContext` (policy §9). */
export interface CompanyContext {
  company: CompanySummary;
  assets: AssetSummary[];
  articles: ArticleSummary[];
  /** `websites` has no Group-A compact shape, so the full typed record is returned. */
  websites: Website[];
  assetPasswords: AssetPasswordSummary[];
}

/** `companies.getContext(id, { expand: true })` — every member is the full typed record. */
export interface CompanyContextExpand {
  company: Company;
  assets: Asset[];
  articles: Article[];
  websites: Website[];
  assetPasswords: AssetPassword[];
}

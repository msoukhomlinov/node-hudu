/**
 * Company — Hudu API model
 */
export interface Company {
  id: number; // The unique identifier of the company.
  slug: string; // The URL-friendly identifier of the company.
  name: string; // The full name of the company.
  nickname: string; // The nickname or short name of the company. Can be null.
  address_line_1: string; // The first line of the company's address.
  address_line_2: string; // The second line of the company's address. Can be null.
  city: string; // The city where the company is located.
  state: string; // The state or province where the company is located.
  zip: string; // The zip or postal code of the company's location.
  country_name: string; // The name of the country where the company is located. Can be null.
  phone_number: string; // The company's phone number.
  company_type: string; // The type of the company. Can be null.
  parent_company_id: number; // The unique identifier of the parent company. Can be null.
  parent_company_name: string; // The name of the parent company. Can be null.
  fax_number: string; // The company's fax number.
  website: string; // The company's website URL.
  notes: string; // Additional notes or information about the company. Can be null.
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

export type CompanyUpdate = Partial<Company>;

/**
 * Expiration — Hudu API model
 */
export interface Expiration {
  id: number; // The unique identifier for the expiration
  date: string; // The expiration date
  expirationable_type: string; // The type of object associated with the expiration (e.g., Website)
  expirationable_id: number; // The ID of the object associated with the expiration
  account_id: number; // The account ID associated with the expiration
  company_id: number; // The company ID associated with the expiration
  asset_layout_field_id: number | null; // The asset layout field ID associated with the expiration (if any), Can be null.
  sync_id: number | null; // The sync ID associated with the expiration (if any). Can be null
  archived_at: string | null; // The timestamp when the expiration was archived (if any). Can be null.
  created_at: string; // The timestamp when the expiration was created
  updated_at: string; // The timestamp when the expiration was last updated
  expiration_type: string; // The type of expiration (e.g., domain)
  asset_field_id: number | null; // The asset field ID associated with the expiration (if any). Can be null.
}

/**
 * Input for creating a Expiration.
 * All fields are optional unless the API requires them; see docs.
 */
export type ExpirationCreate = Partial<Omit<Expiration, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Expiration.
 */
export type ExpirationUpdate = Partial<Expiration>;

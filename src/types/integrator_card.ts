/**
 * Integrator_Card — Hudu API model
 */
export interface IntegratorCard {
  id: number; // The unique identifier of the Integrator Card.
  integrator_id: number; // The unique identifier of the associated external integrator.
  integrator_name: string; // The name of the associated external integrator.
  link: string; // The URL to access the integrated external system.
  primary_field: string; // The primary field associated with the Integrator Card, if any. Can be null.
  data: Record<string, unknown>; // A JSON object containing additional data about the integrated entity.
  office_365_assigned_products: string[]; // A list of Office 365 products assigned to the user or entity.
  exchange_license_assign_date: string; // The date when the Exchange license was assigned, formatted as 'Mon DD, YYYY'.
  onedrive_license_assign_date: string; // The date when the OneDrive license was assigned, formatted as 'Mon DD, YYYY'.
  sharepoint_license_assign_date: string; // The date when the SharePoint license was assigned, formatted as 'Mon DD, YYYY'.
  skype_for_business_license_assign_date: string; // The date when the Skype for Business license was assigned, formatted as 'Mon DD, YYYY'.
  sync_type: string; // The type of synchronization with the external system.
  sync_id: number; // The unique identifier of the synchronized entity in the external system.
  sync_identifier: string; // The unique identifier or name of the synchronized entity in the external system, if any. Can be null.
}

/**
 * Input for creating a Integrator_Card.
 * All fields are optional unless the API requires them; see docs.
 */
export type IntegratorCardCreate = Partial<Omit<IntegratorCard, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Integrator_Card.
 */
export type IntegratorCardUpdate = Partial<IntegratorCard>;

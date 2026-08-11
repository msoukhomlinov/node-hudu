/**
 * Company_Integration — Hudu API model
 */
export interface CompanyIntegration {
  id: number; // The unique identifier of the integration.
  integrator_id: number; // The unique identifier of the integrator.
  integrator_name: string; // The name of the integrator.
  sync_id: number; // The unique identifier for the synchronization.
  identifier: string | null; // The identifier of the integration. Can be null.
  name: string; // The name of the integration.
  potential_company_id: number | null; // The unique identifier of the potential company associated with the integration. Can be null.
  company_id: number; // The unique identifier of the company associated with the integration.
  company_name: string; // The name of the company associated with the integration.
}

/**
 * Input for creating a Company_Integration.
 * All fields are optional unless the API requires them; see docs.
 */
export type CompanyIntegrationCreate = Partial<Omit<CompanyIntegration, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Company_Integration.
 */
export type CompanyIntegrationUpdate = Partial<CompanyIntegration>;

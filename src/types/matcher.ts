/**
 * Matcher — Hudu API model
 */
export interface Matcher {
  id: number;
  integrator_id: number;
  integrator_name: string;
  sync_id: number;
  identifier: string; // Can be null.
  name: string;
  potential_company_id: number; // Can be null.
  company_id: number; // Can be null.
  company_name: string; // Can be null.
}

/**
 * Input for creating a Matcher.
 * All fields are optional unless the API requires them; see docs.
 */
export type MatcherCreate = Partial<Omit<Matcher, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Matcher.
 */
export type MatcherUpdate = Partial<Matcher>;

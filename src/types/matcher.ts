/**
 * Matcher — Hudu API model
 */
export interface Matcher {
  id: number;
  integrator_id: number;
  integrator_name: string;
  sync_id: number;
  identifier: string | null; // Can be null.
  name: string;
  potential_company_id: number | null; // Can be null.
  company_id: number | null; // Can be null.
  company_name: string | null; // Can be null.
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

/**
 * Identifier accepted by `matchers.resolve` (policy §6). The vendor requires
 * `integration_id` on `GET /matchers`, so every kind is resolved inside one
 * integration: an id by bounded client scan (there is no `GET /matchers/{id}`), a
 * `sync_id` or an `identifier` through the vendor filters.
 */
export interface MatcherIdentifier {
  id?: number;
  sync_id?: number;
  identifier?: string;
  integration_id?: number;
}

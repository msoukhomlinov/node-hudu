/**
 * Relation — Hudu API model
 */
export interface Relation {
  id: number; // The unique identifier of the relation.
  description: string | null; // The description of the relation (optional). Can Be null.
  is_inverse: boolean; // Indicates whether the relation is inverse or not.
  name: string; // The name of the relation.
  fromable_id: number; // The ID of the origin entity involved in the relation.
  fromable_type: string; // The type of the origin entity involved in the relation.
  fromable_url: string; // The URL of the origin entity involved in the relation.
  toable_id: number; // The ID of the destination entity involved in the relation.
  toable_type: string; // The type of the destination entity involved in the relation.
  toable_url: string; // The URL of the destination entity involved in the relation.
  created_at: string; // The date and time the relation was created, in ISO 8601 format.
  updated_at: string; // The date and time the relation was last updated, in ISO 8601 format.
}

/**
 * Input for creating a Relation.
 * All fields are optional unless the API requires them; see docs.
 */
export type RelationCreate = Partial<Omit<Relation, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Relation.
 */
export type RelationUpdate = Partial<Relation>;

/** One side of a relation, as the vendor's `fromable_*` / `toable_*` filters describe it. */
export interface RelationEndpoint {
  /** Vendor record type, e.g. "Asset", "Company", "Website". */
  type: string;
  id: number;
}

/**
 * Compact projection of {@link Relation} (policy §9, helper tier).
 *
 * Keeps: id, name, description, is_inverse, fromable_id, fromable_type, fromable_url,
 * toable_id, toable_type, toable_url.
 * Drops (recorded in the capability registry `outputSchema.drops`): created_at, updated_at.
 *
 * `id` and `name` are kept; the endpoints are kept whole because they are what a caller reasons
 * about to decide whether two records are related.
 */
export interface RelationSummary {
  id: number;
  name: string;
  description: string | null;
  is_inverse: boolean;
  fromable_id: number;
  fromable_type: string;
  fromable_url: string;
  toable_id: number;
  toable_type: string;
  toable_url: string;
}

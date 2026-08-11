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

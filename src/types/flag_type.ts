/**
 * FlagType — Hudu API model
 */
export interface FlagType {
  id: number; // The unique ID of the flag type.
  name: string; // The name of the flag type.
  color: "Red" | "Blue" | "Green" | "Yellow" | "Purple" | "Orange" | "LightPink" | "LightBlue" | "LightGreen" | "LightPurple" | "LightOrange" | "LightYellow" | "White" | "Grey"; // The color name for the flag type. Must be one of the predefined color options.
  slug: string; // The URL-friendly slug for the flag type.
  created_at: string; // The date and time when the flag type was created.
  updated_at: string; // The date and time when the flag type was last updated.
}

/**
 * Input for creating a FlagType.
 * All fields are optional unless the API requires them; see docs.
 */
export type FlagTypeCreate = Partial<Omit<FlagType, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a FlagType.
 */
export type FlagTypeUpdate = Partial<FlagType>;

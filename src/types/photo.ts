/**
 * Photo — Hudu API model
 */
export interface Photo {
  id: number; // Unique identifier for the photo
  company_id: number; // ID of the company this photo belongs to
  folder_id: number; // ID of the folder this photo is in (null if not in a folder)
  photoable_type: string; // The type of record this photo is attached to (Company, Asset, Article, etc.)
  photoable_id: number; // The ID of the record this photo is attached to
  caption: string; // Caption/title of the photo
  pinned: boolean; // Whether the photo is pinned
  archived: boolean; // Whether the photo is archived (soft-deleted)
  created_at: string; // When the photo was created
  updated_at: string; // When the photo was last updated
}

/**
 * Input for creating a Photo.
 * All fields are optional unless the API requires them; see docs.
 */
export type PhotoCreate = Partial<Omit<Photo, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Photo.
 */
export type PhotoUpdate = Partial<Photo>;

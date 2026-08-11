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
 * Input for creating a Photo (multipart). `file` and `caption` are required (spec).
 */
export interface PhotoCreate {
  /** The image file to upload. */
  file: Blob | File;
  /** Caption/title of the photo. Required (spec). */
  caption: string;
  /** ID of the company this photo belongs to. */
  company_id?: number;
  /** The type of record this photo is attached to (Company, Asset, Article, etc.). */
  photoable_type?: string;
  /** The ID of the record this photo is attached to. */
  photoable_id?: number;
  /** ID of the folder this photo is in. */
  folder_id?: number;
  /** Whether the photo is pinned. */
  pinned?: boolean;
}

/**
 * Input for updating a Photo.
 */
export type PhotoUpdate = Partial<Photo>;

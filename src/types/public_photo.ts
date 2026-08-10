/**
 * PublicPhoto — Hudu API model
 */
export interface PublicPhoto {
  id: string; // The unique slug identifier of the public photo (e.g., 'a1b2c3d4e5f6'). This is used in URLs and API calls. **Changed**: Previously this was a numeric ID, now it's a slug for improved security.
  numeric_id: number; // The original numeric database ID of the public photo. **New field**: Added for backward compatibility. Use this if you need the original numeric identifier.
  url: string; // The URL of the public photo using the slug-based path (e.g., '/public_photo/a1b2c3d4e5f6').
  record_type: string; // The type of record the public photo is associated with (e.g., Article).
  record_id: number; // The ID of the record the public photo is associated with.
  file_name: string; // The original filename of the photo.
  file_size: number; // The size of the photo file in bytes.
}

/**
 * Input for creating a PublicPhoto.
 * All fields are optional unless the API requires them; see docs.
 */
export type PublicPhotoCreate = Partial<Omit<PublicPhoto, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a PublicPhoto.
 */
export type PublicPhotoUpdate = Partial<PublicPhoto>;

/**
 * Upload — Hudu API model
 */
export interface Upload {
  id: number; // Unique identifier of the upload
  url: string; // URL where the file can be accessed
  name: string; // Name of the file
  ext: string; // File extension
  mime: string; // MIME type of the file
  size: string; // Size of the file
  created_date: string; // Date when the file was uploaded
  archived_at: string; // Date when the file was archived. Null if the file is not archived.
  uploadable_id: number; // ID of the object the file is associated with
  uploadable_type: string; // Type of the object the file is associated with
}

/**
 * Input for creating a Upload.
 * All fields are optional unless the API requires them; see docs.
 */
export type UploadCreate = Partial<Omit<Upload, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Upload.
 */
export type UploadUpdate = Partial<Upload>;

/**
 * Folder — Hudu API model
 */
export interface Folder {
  id: number; // The unique identifier of the folder
  company_id: number; // The ID of the associated company, if any. Can be null.
  icon: string; // The icon associated with the folder. Can be null
  description: string; // A brief description of the folder
  name: string; // The name of the folder
  parent_folder_id: number; // The ID of the parent folder, if any. Can be null.
  folder_type: "article" | "photo"; // The type of folder - 'article' for article folders or 'photo' for photo folders. This field is immutable after creation.
  created_at: string; // The timestamp of folder creation
  updated_at: string; // The timestamp of the last folder update
}

/**
 * Input for creating a Folder.
 * All fields are optional unless the API requires them; see docs.
 */
export type FolderCreate = Partial<Omit<Folder, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Folder.
 */
export type FolderUpdate = Partial<Folder>;

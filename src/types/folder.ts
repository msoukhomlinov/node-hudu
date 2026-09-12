/**
 * Folder — Hudu API model
 */
export interface Folder {
  id: number; // The unique identifier of the folder
  company_id: number | null; // The ID of the associated company, if any. Can be null.
  icon: string | null; // The icon associated with the folder. Can be null
  description: string; // A brief description of the folder
  name: string; // The name of the folder
  parent_folder_id: number | null; // The ID of the parent folder, if any. Can be null.
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

/**
 * Compact projection used by the folder helper tier (`folders.resolve`).
 * Drops `description` and `created_at`; never drops `id` or `name`.
 */
export interface FolderSummary {
  id: number;
  name: string;
  company_id: number | null;
  parent_folder_id: number | null;
  folder_type: "article" | "photo";
  icon: string | null;
  updated_at: string;
}

/**
 * Object identifier accepted by `folders.resolve`. `company_id` and `folder_type`
 * narrow the lookup with the vendor's own filters instead of scanning the account.
 */
export interface FolderIdentifier {
  id?: number;
  name?: string;
  company_id?: number | null;
  companyId?: number | null;
  folder_type?: "article" | "photo";
  folderType?: "article" | "photo";
}

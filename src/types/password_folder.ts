/**
 * Password_Folder — Hudu API model
 */
export interface PasswordFolder {
  id: number; // The unique identifier of the password folder
  company_id: number | null; // The ID of the associated company, if any. Can Be null.
  description: string; // A brief description of the password folder
  name: string; // The name of the password folder
  slug: string; // A slug representing the password folder.
  security: "all_users" | "specific"; // Who has permission to see the folder
  allowed_groups: number[]; // Group IDs with access when security = specific
  created_at: string; // The timestamp of password folder creation
  updated_at: string; // The timestamp of the last password folder update
}

/**
 * Input for creating a Password_Folder.
 * All fields are optional unless the API requires them; see docs.
 */
export type PasswordFolderCreate = Partial<Omit<PasswordFolder, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Password_Folder.
 */
export type PasswordFolderUpdate = Partial<PasswordFolder>;

/**
 * Compact projection used by the password-folder helper tier. Drops
 * `allowed_groups`, `description` and `created_at`; never drops `id` or `name`.
 */
export interface PasswordFolderSummary {
  id: number;
  name: string;
  company_id: number | null;
  slug: string;
  security: "all_users" | "specific";
  updated_at: string;
}

/**
 * Object identifier accepted by `password_folders.resolve`. `company_id` narrows
 * the lookup with the vendor's own filter.
 */
export interface PasswordFolderIdentifier {
  id?: number;
  name?: string;
  company_id?: number | null;
  companyId?: number | null;
}

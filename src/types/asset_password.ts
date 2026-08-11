/**
 * Asset_Password — Hudu API model
 */
export interface AssetPassword {
  id: number; // Unique identifier of the asset password
  passwordable_id: number | null; // ID of the related object (e.g., 'Website') for the password. Can be null.
  passwordable_type: string; // Type of the related object for the password (e.g., 'Asset', 'Website')
  company_id: number; // Identifier of the company to which the password belongs
  name: string; // Name of the password
  username: string; // Username associated with the password
  slug: string; // URL-friendly identifier for the password
  description: string; // Description or notes related to the password
  password: string; // The actual password string
  otp_secret: string; // Secret key for one-time passwords (OTP), if used
  password_type: string | null; // Type or category of the password. Can be null.
  url: string; // URL related to the password, if applicable
  created_at: string; // Timestamp when the password was created
  updated_at: string; // Timestamp when the password was last updated
  password_folder_id: number | null; // ID of the folder in which the password is stored, if any. Can be null.
  password_folder_name: string | null; // Name of the folder in which the password is stored, if any. Can be null.
  login_url: string | null; // URL for the login page associated with the password. Can be null.
}

/**
 * Input for creating a Asset_Password.
 * All fields are optional unless the API requires them; see docs.
 */
export type AssetPasswordCreate = Partial<Omit<AssetPassword, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Asset_Password.
 */
export type AssetPasswordUpdate = Partial<AssetPassword>;

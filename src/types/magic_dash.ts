/**
 * MagicDash — Hudu API model
 */
export interface MagicDash {
  id: number; // The unique identifier for the MagicDash item
  title: string; // The title of the MagicDash item
  message: string; // The message content of the MagicDash item
  shade: string; // The background shade of the MagicDash item (optional). Can Be null.
  content_link: string; // The link associated with the MagicDash item's content (optional). Can Be null.
  content: string; // The MagicDash item's content (optional). Can Be null.
  icon: string; // The icon associated with the MagicDash item (optional). Can Be null.
  image_url: string; // The URL of the image associated with the MagicDash item (optional). Can Be null.
  company_id: number; // The unique identifier of the associated company
  company_name: string; // The name of the associated company
  position: number; // The position/order of the Magic Dash Item
}

/**
 * Input for creating a MagicDash.
 * All fields are optional unless the API requires them; see docs.
 */
export type MagicDashCreate = Partial<Omit<MagicDash, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a MagicDash.
 */
export type MagicDashUpdate = Partial<MagicDash>;

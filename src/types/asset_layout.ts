/**
 * Asset_Layout — Hudu API model
 */
export interface AssetLayout {
  id: number;
  slug: string;
  name: string;
  icon: string;
  color: string;
  icon_color: string;
  sidebar_folder_id: number; // Can be null.
  active: boolean;
  include_passwords: boolean;
  include_photos: boolean;
  include_comments: boolean;
  include_files: boolean;
  created_at: string;
  updated_at: string;
  fields: AssetLayoutField[];
}

/**
 * Input for creating a Asset_Layout.
 * All fields are optional unless the API requires them; see docs.
 */
export type AssetLayoutCreate = Partial<Omit<AssetLayout, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Asset_Layout.
 */
import type { AssetLayoutField } from './asset_layout_field.js';

export type AssetLayoutUpdate = Partial<AssetLayout>;

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
  sidebar_folder_id: number | null; // Can be null.
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


/**
 * Compact agent-facing projection of `AssetLayout` (policy §9, SCOPING decision 6).
 *
 * Keeps: id, name, slug, active, icon, color.
 * Drops (recorded in the registry `outputSchema.drops`): fields, include_passwords,
 * include_photos, include_comments, include_files, sidebar_folder_id, icon_color,
 * created_at, updated_at.
 */
export interface AssetLayoutSummary {
  id: number;
  name: string;
  slug: string;
  active: boolean;
  icon: string;
  color: string;
}

/** Identifier kinds `asset_layouts.resolve` understands (policy §7). */
export interface AssetLayoutIdentifier {
  id?: number;
  name?: string;
  slug?: string;
}

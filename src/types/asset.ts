/**
 * Asset — Hudu API model
 */
export interface Asset {
  id: number; // The unique identifier of the asset
  company_id: number; // The identifier of the company to which the asset belongs
  asset_layout_id: number; // The identifier of the asset layout associated with the asset
  slug: string; // The URL slug used to identify the asset
  name: string; // The name of the asset
  primary_serial: string; // The primary serial number of the asset (if available)
  primary_mail: string; // The primary email associated with the asset (if available)
  primary_model: string; // The primary model of the asset (if available)
  primary_manufacturer: string; // The primary manufacturer of the asset (if available)
  company_name: string; // The name of the company to which the asset belongs
  object_type: string; // The type of object the asset represents
  asset_type: string; // The category of the asset
  archived: boolean; // Indicates whether the asset is archived or not
  url: string; // The URL of the asset page
  created_at: string; // The date and time when the asset was created
  updated_at: string; // The date and time when the asset was last updated
  fields: {
    
  id: number;
      value: boolean;
      label: string;
      position: number;
  }[]; // A list of fields associated with the asset
  cards: IntegratorCard[]; // A list of cards associated with the asset (if available)
}

/**
 * Input for creating a Asset.
 * All fields are optional unless the API requires them; see docs.
 */
export type AssetCreate = Partial<Omit<Asset, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Asset.
 */
import type { IntegratorCard } from './integrator_card.js';

export type AssetUpdate = Partial<Asset>;

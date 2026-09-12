/**
 * Website — Hudu API model
 */
export interface Website {
  id: number; // The unique identifier of the website
  name: string; // The URL of the website
  code: number; // The HTTP response code of the website
  message: string; // A message related to the website's status
  slug: string; // The URL slug for the website
  keyword: string; // A keyword associated with the website (optional)
  monitor_type: number; // The type of monitoring performed on the website
  status: string; // The status of the website (e.g., 'ready', 'processing')
  monitoring_status: string; // The monitoring status of the website (e.g., 'up', 'down')
  refreshed_at: string; // The timestamp when the website was last refreshed
  monitored_at: string; // The timestamp when the website was last monitored
  headers: Record<string, unknown>; // HTTP headers associated with the website (optional)
  paused: boolean; // Indicates whether the monitoring of the website is paused
  sent_notifications: boolean; // Indicates whether notifications related to the website have been sent
  account_id: number; // The ID of the associated account
  asset_field_id: number; // The ID of the related asset field (optional)
  company_id: number; // The ID of the associated company
  discarded_at: string; // The timestamp when the website was discarded (optional)
  disable_ssl: boolean; // Indicates whether SSL checks are disabled for the website
  disable_whois: boolean; // Indicates whether WHOIS checks are disabled for the website
  disable_dns: boolean; // Indicates whether DNS checks are disabled for the website
  enable_dmarc_tracking: boolean; // Indicates whether DMARC checks are enabled for the website
  enable_dkim_tracking: boolean; // Indicates whether DKIM checks are enabled for the website
  enable_spf_tracking: boolean; // Indicates whether SPF checks are enabled for the website
  notes: string; // Additional notes related to the website
  object_type: string; // The type of the object, in this case, 'Website'
  icon: string; // The FontAwesome icon related to the website
  asset_type: string; // The type of the asset, in this case, 'Website'
  company_name: string; // The name of the associated company
  archived: boolean; // Indicates whether the website is archived
  url: string; // The URL path of the website within the application
}

/**
 * Input for creating a Website.
 * All fields are optional unless the API requires them; see docs.
 */
export type WebsiteCreate = Partial<Omit<Website, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Website.
 */
export type WebsiteUpdate = Partial<Website>;

/**
 * Object identifier accepted by `websites.resolve`. The vendor filters `slug` and
 * `name`; there is no domain/company filter on `/websites`.
 */
export interface WebsiteIdentifier {
  id?: number;
  slug?: string;
  name?: string;
}

/**
 * The compact projection of a website record. Drops: headers, account_id, asset_field_id,
 * discarded_at, disable_ssl, disable_whois, disable_dns, enable_dmarc_tracking, enable_dkim_tracking,
 * enable_spf_tracking, keyword, message, monitor_type, code, sent_notifications, icon, asset_type,
 * refreshed_at, monitored_at, notes, object_type, created_at.
 * The `Website` type declares no `updated_at`, so it cannot be kept.
 */
export interface WebsiteSummary {
  id: number;
  name: string;
  slug?: string;
  company_id?: number;
  company_name?: string;
  status?: string;
  monitoring_status?: string;
  paused?: boolean;
  archived?: boolean;
  url?: string;
}

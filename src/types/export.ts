/**
 * Export — Hudu API model
 */
export interface Export {
  id?: number;
  account_id?: number;
  status?: string;
  is_pdf?: boolean;
  created_at?: string;
  updated_at?: string;
  download_url?: string;
  file_name?: string;
  file_size?: number;
}
export type ExportCreate = {
  /** Required: the export format. */
  format: 'pdf' | 'csv';
  /** Required: the ID of the company to export. */
  company_id: number;
  /** Required: whether to include passwords in the export. */
  include_passwords: boolean;
  /** Required: whether to include websites in the export. */
  include_websites: boolean;
  /** PDF only: include knowledge base articles. Defaults to false. */
  include_articles?: boolean;
  /** PDF only: include archived articles. */
  include_archived_articles?: boolean;
  include_archived_passwords?: boolean;
  include_archived_websites?: boolean;
  include_archived_assets?: boolean;
  /** Restrict the export to these asset layout ids (PDF only). */
  asset_layout_ids?: number[];
  [key: string]: unknown;
};
export type ExportUpdate = Partial<Export>;

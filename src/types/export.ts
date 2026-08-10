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
  export_type?: string;
  company_id?: number;
  [key: string]: unknown;
};
export type ExportUpdate = Partial<Export>;

/**
 * Activity Log — Hudu API model
 */
export interface ActivityLog {
  id?: number;
  user_id?: number;
  user_email?: string;
  resource_id?: number;
  resource_type?: string;
  action_message?: string;
  created_at?: string;
  updated_at?: string;
}

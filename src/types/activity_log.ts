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

/**
 * Identifier accepted by `activity_logs.resolve` (policy §6). Hudu exposes no
 * `GET /activity_logs/{id}`, so an id is resolved by a bounded client scan, which the
 * optional resource filters narrow.
 */
export interface ActivityLogIdentifier {
  id?: number;
  resource_type?: string;
  resource_id?: number;
}

/**
 * Compact projection of an ActivityLog (policy §9). Keeps who did what to which record
 * and when; never drops `id`.
 *
 * Drops: updated_at.
 */
export interface ActivityLogSummary {
  id?: number;
  user_id?: number;
  user_email?: string;
  resource_id?: number;
  resource_type?: string;
  action_message?: string;
  created_at?: string;
}

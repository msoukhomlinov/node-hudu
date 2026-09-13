/**
 * Group — Hudu API model
 */
export interface Group {
  id: number; // The unique identifier of the group.
  name: string; // The name of the group.
  slug: string; // A slug representing the group.
  url: string; // The URL to view the group in the web interface.
  default: boolean; // Indicates if this is the default group for new users.
  created_at: string; // The timestamp when the group was created.
  updated_at: string; // The timestamp of the last group update.
  member_count: number; // The number of members in the group (excludes admins and super admins).
  members: GroupMember[]; // List of group members (excludes admins and super admins).
}

/**
 * Input for creating a Group.
 * All fields are optional unless the API requires them; see docs.
 */
export type GroupCreate = Partial<Omit<Group, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Group.
 */
import type { GroupMember } from './group_member.js';

export type GroupUpdate = Partial<Group>;

/**
 * Compact projection used by the group helper tier. Drops `members`, `url` and
 * `created_at`; never drops `id`, `name` or `slug`.
 */
export interface GroupSummary {
  id: number;
  name: string;
  slug: string;
  default: boolean;
  member_count: number;
  updated_at: string;
}

/** Object identifier accepted by `groups.resolve`. */
export interface GroupIdentifier {
  id?: number;
  slug?: string;
  name?: string;
}

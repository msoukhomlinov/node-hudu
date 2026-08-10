/**
 * GroupMember — Hudu API model
 */
export interface GroupMember {
  id: number; // The unique identifier of the user.
  first_name: string; // The first name of the user.
  last_name: string; // The last name of the user.
  email: string; // The email address of the user.
  security_level: string; // Security level assigned to the user.
  slug: string; // A slug representing the user.
}

/**
 * Input for creating a GroupMember.
 * All fields are optional unless the API requires them; see docs.
 */
export type GroupMemberCreate = Partial<Omit<GroupMember, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a GroupMember.
 */
export type GroupMemberUpdate = Partial<GroupMember>;

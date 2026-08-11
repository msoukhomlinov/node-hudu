/**
 * User — Hudu API model
 */
export interface User {
  id: number; // The unique identifier of the user.
  email: string; // The email address of the user.
  otp_required_for_login: boolean; // Indicates if OTP is required for logging in.
  security_level: string; // Security level assigned to the user.
  first_name: string; // The first name of the user.
  last_name: string; // The last name of the user.
  phone_number: string; // The phone number of the user.
  slug: string; // A slug representing the user.
  time_zone: string; // The time zone of the user.
  accepted_invite: boolean; // Indicates if the user has accepted an invite.
  sign_in_count: number; // The number of times the user has signed in.
  currently_signed_in: boolean; // Indicates if the user is currently signed in.
  last_sign_in_at: string; // Timestamp of the last sign-in.
  last_sign_in_ip: string; // IP address from the last sign-in.
  created_at: string; // The timestamp when the user was created.
  updated_at: string; // The timestamp of the last user update.
  archived: boolean; // Indicates if the user is archived (discarded).
  portal_member_company_id: number | null; // The ID of the associated company, if the user is a portal member. Can Be null.
  score_30_days: number; // The user's score over the past 30 days.
  score_all_time: number; // The user's all-time score.
  score_90_days: number; // The user's score over the past 90 days.
}

/**
 * Input for creating a User.
 * All fields are optional unless the API requires them; see docs.
 */
export type UserCreate = Partial<Omit<User, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a User.
 */
export type UserUpdate = Partial<User>;

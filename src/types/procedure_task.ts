/**
 * ProcedureTask — Hudu API model
 */
export interface ProcedureTask {
  id: number; // The unique ID of the procedure task.
  name: string; // The name of the procedure task.
  description: string; // The description of the task (base64 encoded).
  position: number; // The position of the task in the procedure.
  priority: "unsure" | "low" | "normal" | "high" | "urgent"; // The priority level of the task.
  completed: boolean; // Indicates whether the task is completed.
  completed_date: string; // Formatted date and time when the task was completed.
  completion_notes: string; // Notes about the completion of the task.
  due_date: string; // The due date for the task.
  formatted_due_date: string; // Formatted due date string.
  user_id?: number; // The ID of the user who completed the task, if any.
  user_name: string; // The name of the user who completed the task.
  assigned_users: number[]; // Array of user IDs assigned to this task.
  first_assigned_user_id: number; // The ID of the first assigned user.
  first_assigned_user_name: string; // The name of the first assigned user.
  first_assigned_user_initials: string; // The initials of the first assigned user.
  procedure_id: number; // The ID of the procedure (process or run) this task belongs to.
  optional: boolean; // Whether the task is optional. Optional tasks don't need to be completed for the procedure to be considered complete.
  parent_task_id: number | null; // The ID of the parent task if this is a subtask, null otherwise.
  subtask_ids: number[]; // Array of IDs of subtasks belonging to this task.
  subtask_count: number; // The number of subtasks this task has.
  has_subtasks: boolean; // Whether this task has any subtasks.
  url: string; // The URL to view this task in the application.
  created_at: string; // The date and time when the task was created.
  updated_at: string; // The date and time when the task was last updated.
}

/**
 * Input for creating a ProcedureTask.
 * All fields are optional unless the API requires them; see docs.
 */
export type ProcedureTaskCreate = Partial<Omit<ProcedureTask, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a ProcedureTask.
 */
export type ProcedureTaskUpdate = Partial<ProcedureTask>;

/**
 * Identifier accepted by `procedure_tasks.resolve` (policy §6). An id resolves
 * directly; a name resolves through the vendor `name` list filter, optionally narrowed
 * with `procedure_id` or `company_id`.
 */
export interface ProcedureTaskIdentifier {
  id?: number;
  name?: string;
  procedure_id?: number;
  company_id?: number;
}

/**
 * Compact projection of a ProcedureTask (policy §9). Keeps identity, position, the
 * completion state and the assignee NAME — enough to report progress without the base64
 * description or the raw id arrays. Never drops `id`/`name`.
 *
 * Drops: description, completion_notes, formatted_due_date, user_id, user_name,
 * assigned_users, first_assigned_user_id, first_assigned_user_initials, subtask_ids,
 * created_at.
 */
export interface ProcedureTaskSummary {
  id: number;
  name: string;
  position: number;
  priority: 'unsure' | 'low' | 'normal' | 'high' | 'urgent';
  completed: boolean;
  completed_date: string;
  due_date: string;
  procedure_id: number;
  optional: boolean;
  parent_task_id: number | null;
  has_subtasks: boolean;
  subtask_count: number;
  first_assigned_user_name: string;
  url: string;
  updated_at: string;
}

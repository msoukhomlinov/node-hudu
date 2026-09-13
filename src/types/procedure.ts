/**
 * Procedure — Hudu API model
 */
export interface Procedure {
  id: number; // The unique identifier of the process or run.
  slug: string; // The URL-friendly unique identifier of the process or run.
  name: string; // The name of the process or run.
  description: string | null; // A brief description of the process or run. Can Be null.
  total: number; // The total number of tasks in the process or run.
  completed: number; // The number of completed tasks in the process or run.
  url: string; // The URL for accessing the process or run.
  object_type: string; // The type of object (always 'Process').
  company_id: number; // The unique identifier of the company this process or run belongs to.
  company_name: string; // The name of the associated company.
  completion_percentage: string; // The completion percentage of the process or run.
  created_at: string; // The date and time when the process or run was created.
  updated_at: string; // The date and time when the process or run was last updated.
  parent_procedure: string | null; // The parent process, if any. Can Be null.
  run: boolean; // Indicates if this is a run (true) or a process (false). Runs are active instances of a process.
  parent_process_id: number | null; // The ID of the parent process (for runs only). Null for processes.
  process_type: "global" | "company" | null; // The scope of the process: 'global' (available to all companies) or 'company' (company-specific). Null for runs.
  status: "Not Started" | "In Progress" | "Completed" | "Cancelled"; // The current status of the process or run: 'Not Started', 'In Progress', 'Completed', or 'Cancelled'.
  asset: string | null; // The associated asset, if any. Can Be null.
  share_url: string; // The URL for sharing the process or run.
  procedure_tasks_attributes: Record<string, unknown>[]; // A list of attributes for the tasks associated with the process or run.
}

/**
 * Input for creating a Procedure.
 * All fields are optional unless the API requires them; see docs.
 */
export type ProcedureCreate = Partial<Omit<Procedure, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a Procedure.
 */
export type ProcedureUpdate = Partial<Procedure>;

import type { ProcedureTask, ProcedureTaskSummary } from './procedure_task.js';

/**
 * Identifier accepted by `procedures.resolve` (policy §6). Every kind here maps onto
 * a real lookup the vendor supports: an id (`GET /procedures/{id}`), the `slug` list
 * filter and the `name` list filter (optionally narrowed with `company_id`).
 */
export interface ProcedureIdentifier {
  id?: number;
  slug?: string;
  name?: string;
  company_id?: number;
}

/**
 * Compact projection of a Procedure (policy §9). Keeps the identity, the company, the
 * completion counters and the URL an agent reports on; never drops `id`/`name`, the
 * fields a caller resolves by.
 *
 * Drops: description, object_type, created_at, parent_procedure, run, parent_process_id,
 * asset, share_url, procedure_tasks_attributes.
 */
export interface ProcedureSummary {
  id: number;
  name: string;
  slug: string;
  company_id: number;
  company_name: string;
  status: 'Not Started' | 'In Progress' | 'Completed' | 'Cancelled';
  total: number;
  completed: number;
  completion_percentage: string;
  process_type: 'global' | 'company' | null;
  url: string;
  updated_at: string;
}

/**
 * Result of `procedures.getWithTasks` (compact, policy §9): the procedure summary plus
 * its tasks. `task_count` is everything the fetch returned, so `tasks.length <
 * task_count` tells the caller the list was bounded before `limit`.
 */
export interface ProcedureWithTasks {
  procedure: ProcedureSummary;
  tasks: ProcedureTaskSummary[];
  task_count: number;
}

/** `getWithTasks(id, { expand: true })`: the full procedure and its full task records. */
export interface ProcedureWithTasksFull {
  procedure: Procedure;
  tasks: ProcedureTask[];
  task_count: number;
  /** The effective task bound applied (default 25, maximum 100). */
  limit: number;
}

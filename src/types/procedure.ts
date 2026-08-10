/**
 * Procedure — Hudu API model
 */
export interface Procedure {
  id: number; // The unique identifier of the process or run.
  slug: string; // The URL-friendly unique identifier of the process or run.
  name: string; // The name of the process or run.
  description: string; // A brief description of the process or run. Can Be null.
  total: number; // The total number of tasks in the process or run.
  completed: number; // The number of completed tasks in the process or run.
  url: string; // The URL for accessing the process or run.
  object_type: string; // The type of object (always 'Process').
  company_id: number; // The unique identifier of the company this process or run belongs to.
  company_name: string; // The name of the associated company.
  completion_percentage: string; // The completion percentage of the process or run.
  created_at: string; // The date and time when the process or run was created.
  updated_at: string; // The date and time when the process or run was last updated.
  parent_procedure: string; // The parent process, if any. Can Be null.
  run: boolean; // Indicates if this is a run (true) or a process (false). Runs are active instances of a process.
  parent_process_id: number; // The ID of the parent process (for runs only). Null for processes.
  process_type: "global" | "company" | "None"; // The scope of the process: 'global' (available to all companies) or 'company' (company-specific). Null for runs.
  status: "Not Started" | "In Progress" | "Completed" | "Cancelled"; // The current status of the process or run: 'Not Started', 'In Progress', 'Completed', or 'Cancelled'.
  asset: string; // The associated asset, if any. Can Be null.
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

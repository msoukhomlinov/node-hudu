/**
 * List — Hudu API model
 */
export interface List {
  id: number; // The unique ID of the list.
  name: string; // The name of the list.
  created_at: string; // The date and time when the list was created.
  updated_at: string; // The date and time when the list was last updated.
  list_items: ListItem[]; // The items belonging to this list.
}

/**
 * Input for creating a List.
 * All fields are optional unless the API requires them; see docs.
 */
export type ListCreate = Partial<Omit<List, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a List.
 */
import type { ListItem } from './list_item.js';

export type ListUpdate = Partial<List>;

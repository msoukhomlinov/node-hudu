/**
 * ListItem — Hudu API model
 */
export interface ListItem {
  id: number; // The unique ID of the list item.
  name: string; // The name of the list item.
}

/**
 * Input for creating a ListItem.
 * All fields are optional unless the API requires them; see docs.
 */
export type ListItemCreate = Partial<Omit<ListItem, 'id' | 'created_at' | 'updated_at' | 'url' | 'full_url'>>;

/**
 * Input for updating a ListItem.
 */
export type ListItemUpdate = Partial<ListItem>;

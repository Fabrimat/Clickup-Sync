/** ClickUp status definition (as returned by space/list endpoints) */
export interface StatusDef {
  id?: string;
  status: string;
  color: string;
  type: "open" | "custom" | "closed";
  orderindex: number;
}

/** Minimal space info */
export interface SpaceInfo {
  id: string;
  name: string;
  statuses?: StatusDef[];
}

/** Minimal folder info */
export interface FolderInfo {
  id: string;
  name: string;
}

/** Minimal list info with optional folder and statuses */
export interface ListInfo {
  id: string;
  name: string;
  folder?: { id: string; name: string; hidden?: boolean };
  statuses?: StatusDef[];
}

/** ClickUp task status object (returned inside task data) */
export interface TaskStatus {
  status: string;
  color: string;
  type: string;
  orderindex: number;
}

/** Full task data as returned by ClickUp API */
export interface TaskData {
  id: string;
  name: string;
  description?: string;
  status: TaskStatus;
  tags: { name: string }[];
  due_date: string | null;
  start_date: string | null;
  time_estimate: number | null;
  date_updated: string;
  date_created: string;
  assignees: { id: number; username?: string; email?: string }[];
  space: { id: string };
  folder: { id: string; name?: string; hidden?: boolean };
  list: { id: string; name?: string };
  custom_fields?: CustomField[];
}

/** ClickUp custom field */
export interface CustomField {
  id: string;
  name?: string;
  type?: string;
  value: any;
}

/** Database sync record */
export interface SyncRecord {
  source_task_id: string;
  source_list_id: string;
  source_team_id: string;
  dest_task_id: string;
  dest_list_id: string;
  last_synced_status: string;
  last_sync_at: number;
}

import { AxiosInstance } from "axios";
import { config } from "./config";
import { createClient } from "./client";
import { syncDB } from "./db";
import {
  SpaceInfo,
  FolderInfo,
  ListInfo,
  StatusDef,
  TaskData,
} from "./types";

// ─── Per-cycle caches (cleared each sync cycle) ───────────────────────────

let spaceCache = new Map<string, SpaceInfo>(); // spaceId → SpaceInfo (with name + statuses)
let listCache = new Map<string, ListInfo>(); // listId → ListInfo (with folder + statuses)

function clearCaches(): void {
  spaceCache.clear();
  listCache.clear();
}

// ─── User ID initialisation ───────────────────────────────────────────────

async function initUsers(): Promise<void> {
  // Destination user
  const destClient = createClient(config.dest.key);
  const destRes = await destClient.get<{ user: { id: number } }>("/user");
  config.dest.userId = Number(destRes.data.user.id);
  console.log(`[INIT] Dest user ID: ${config.dest.userId}`);

  // Source users
  for (const src of config.sources) {
    const srcClient = createClient(src.key);
    const srcRes = await srcClient.get<{ user: { id: number } }>("/user");
    src.userId = Number(srcRes.data.user.id);
    console.log(`[INIT] Source user ID for team ${src.teamId}: ${src.userId}`);
  }
}

// ─── Detail fetchers (cached per cycle) ───────────────────────────────────

async function getSpaceDetail(
  client: AxiosInstance,
  spaceId: string,
): Promise<SpaceInfo> {
  const cached = spaceCache.get(spaceId);
  if (cached) return cached;

  const res = await client.get<SpaceInfo>(`/space/${spaceId}`);
  const info: SpaceInfo = {
    id: res.data.id,
    name: res.data.name,
    statuses: res.data.statuses,
  };
  spaceCache.set(spaceId, info);
  return info;
}

async function getListDetail(
  client: AxiosInstance,
  listId: string,
): Promise<ListInfo> {
  const cached = listCache.get(listId);
  if (cached) return cached;

  const res = await client.get<ListInfo>(`/list/${listId}`);
  const info: ListInfo = {
    id: res.data.id,
    name: res.data.name,
    folder: res.data.folder,
    statuses: res.data.statuses,
  };
  listCache.set(listId, info);
  return info;
}

// ─── Fetch assigned tasks (using team-level filtered endpoint) ────────────

async function fetchAssignedTasks(
  apiKey: string,
  teamId: string,
  userId: number,
): Promise<TaskData[]> {
  const client = createClient(apiKey);
  const tasks: TaskData[] = [];
  let page = 0;

  console.log(`[FETCH] Fetching tasks for user ${userId} in team ${teamId}`);

  while (true) {
    const res = await client.get<{ tasks: TaskData[] }>(
      `/team/${teamId}/task`,
      {
        params: {
          "assignees[]": userId,
          include_closed: true,
          subtasks: true,
          page,
        },
      },
    );
    if (!res.data.tasks || res.data.tasks.length === 0) break;
    tasks.push(...res.data.tasks);
    page++;
  }

  console.log(`[FETCH] Found ${tasks.length} tasks in team ${teamId}`);
  return tasks;
}

// ─── Structure management (ensure space/folder/list in aggregator) ────────

/**
 * Ensure a space exists in the aggregator with matching statuses.
 * If the space already exists, sync any missing statuses from source.
 */
async function ensureSpace(
  name: string,
  sourceStatuses?: StatusDef[],
): Promise<SpaceInfo> {
  const client = createClient(config.dest.key);

  const res = await client.get<{ spaces: SpaceInfo[] }>(
    `/team/${config.dest.teamId}/space`,
  );
  const found = res.data.spaces.find((s) => s.name === name);

  if (found) {
    // Sync missing statuses from source into existing dest space
    if (sourceStatuses?.length) {
      const destSpace = await getSpaceDetail(client, found.id);
      const destNames = new Set(
        (destSpace.statuses || []).map((s) => s.status.toLowerCase()),
      );

      for (const srcSt of sourceStatuses) {
        if (!destNames.has(srcSt.status.toLowerCase())) {
          try {
            await client.post(`/space/${found.id}/status`, {
              status: srcSt.status,
              color: srcSt.color,
            });
            console.log(
              `[STRUCTURE] Added status "${srcSt.status}" to space "${name}"`,
            );
          } catch (err: any) {
            console.warn(
              `[STRUCTURE] Failed to add status "${srcSt.status}" to space "${name}":`,
              err?.response?.data || err.message,
            );
          }
        }
      }
    }
    return found;
  }

  // Create new space with source statuses
  const createPayload: any = {
    name,
    multiple_assignees: true,
    features: {
      due_dates: {
        enabled: true,
        start_date: true,
        remap_due_dates: true,
        remap_closed_due_date: true,
      },
      time_tracking: { enabled: true },
      tags: { enabled: true },
      time_estimates: { enabled: true },
      checklists: { enabled: true },
      custom_fields: { enabled: true },
      remap_dependencies: { enabled: true },
      dependency_warning: { enabled: true },
      portfolios: { enabled: true },
    },
  };

  if (sourceStatuses?.length) {
    createPayload.statuses = sourceStatuses.map((s) => ({
      status: s.status,
      color: s.color,
      type: s.type,
    }));
  }

  const createRes = await client.post<SpaceInfo>(
    `/team/${config.dest.teamId}/space`,
    createPayload,
  );
  console.log(`[STRUCTURE] Created space "${name}" (${createRes.data.id})`);
  return createRes.data;
}

async function ensureFolder(
  spaceId: string,
  name: string,
): Promise<FolderInfo> {
  const client = createClient(config.dest.key);
  const res = await client.get<{ folders: FolderInfo[] }>(
    `/space/${spaceId}/folder`,
  );
  const found = res.data.folders.find((f) => f.name === name);
  if (found) return found;

  const createRes = await client.post<FolderInfo>(
    `/space/${spaceId}/folder`,
    { name },
  );
  console.log(`[STRUCTURE] Created folder "${name}" (${createRes.data.id})`);
  return createRes.data;
}

async function ensureList(
  spaceId: string,
  name: string,
  folderName?: string,
): Promise<ListInfo> {
  const client = createClient(config.dest.key);

  if (folderName) {
    const folder = await ensureFolder(spaceId, folderName);
    const res = await client.get<{ lists: ListInfo[] }>(
      `/folder/${folder.id}/list`,
    );
    const found = res.data.lists.find((l) => l.name === name);
    if (found) return found;

    const createRes = await client.post<ListInfo>(
      `/folder/${folder.id}/list`,
      { name, content: "" },
    );
    console.log(`[STRUCTURE] Created list "${name}" in folder "${folderName}"`);
    return createRes.data;
  }

  const res = await client.get<{ lists: ListInfo[] }>(
    `/space/${spaceId}/list`,
  );
  const found = res.data.lists.find((l) => l.name === name);
  if (found) return found;

  const createRes = await client.post<ListInfo>(`/space/${spaceId}/list`, {
    name,
    content: "",
  });
  console.log(`[STRUCTURE] Created list "${name}" in space ${spaceId}`);
  return createRes.data;
}

// ─── Find dest task (DB-first, then API fallback) ─────────────────────────

/**
 * Search for a destination task matching the source task by custom fields.
 * Scans a specific dest list.
 */
async function findDestTaskByCustomFields(
  destListId: string,
  sourceTaskId: string,
  sourceListId: string,
): Promise<TaskData | null> {
  const client = createClient(config.dest.key);
  let page = 0;

  while (true) {
    const res = await client.get<{ tasks: TaskData[] }>(
      `/list/${destListId}/task`,
      {
        params: { page, include_closed: true },
      },
    );
    if (!res.data.tasks || res.data.tasks.length === 0) break;

    for (const task of res.data.tasks) {
      const cfTask = task.custom_fields?.find(
        (cf) => cf.id === config.customFields.sourceTaskId,
      );
      const cfList = task.custom_fields?.find(
        (cf) => cf.id === config.customFields.sourceListId,
      );
      if (
        cfTask?.value === sourceTaskId &&
        cfList?.value === sourceListId
      ) {
        return task;
      }
    }
    page++;
  }
  return null;
}

// ─── Status matching ──────────────────────────────────────────────────────

/**
 * Find the exact status name in a list of available statuses (case-insensitive).
 * Returns the correctly-cased name, or null if not found.
 */
function matchStatus(
  statusName: string,
  availableStatuses: StatusDef[],
): string | null {
  const match = availableStatuses.find(
    (s) => s.status.toLowerCase() === statusName.toLowerCase(),
  );
  return match?.status ?? null;
}

// ─── Core sync logic for a single task ────────────────────────────────────

async function syncTask(
  sourceTask: TaskData,
  sourceKey: string,
  sourceTeamId: string,
  sourceUserId: number,
): Promise<void> {
  const srcClient = createClient(sourceKey);
  const destClient = createClient(config.dest.key);

  // 1. Fetch full source task details
  const srcDetailRes = await srcClient.get<TaskData>(
    `/task/${sourceTask.id}`,
  );
  const src = srcDetailRes.data;

  // 2. Get source space and list details (cached)
  const srcSpace = await getSpaceDetail(srcClient, src.space.id);
  const srcList = await getListDetail(srcClient, src.list.id);

  // 3. Ensure aggregator structure (space with copied statuses, folder, list)
  const destSpace = await ensureSpace(srcSpace.name, srcSpace.statuses);
  const folderName =
    srcList.folder && !srcList.folder.hidden ? srcList.folder.name : undefined;
  const destList = await ensureList(destSpace.id, srcList.name, folderName);

  // 4. Extract source status name
  const sourceStatus = src.status.status;

  // 5. Find existing dest task (DB first, API fallback)
  let destTaskId = syncDB.getDestTaskId(src.id, src.list.id);
  let destTask: TaskData | null = null;

  if (destTaskId) {
    try {
      const res = await destClient.get<TaskData>(`/task/${destTaskId}`);
      destTask = res.data;
    } catch {
      // Task was deleted from aggregator; clear DB record
      syncDB.deleteRecord(src.id, src.list.id);
      destTaskId = null;
    }
  }

  if (!destTaskId) {
    // API fallback: search by custom fields
    destTask = await findDestTaskByCustomFields(
      destList.id,
      src.id,
      src.list.id,
    );
    if (destTask) {
      destTaskId = destTask.id;
      // Rebuild DB record
      syncDB.upsert({
        source_task_id: src.id,
        source_list_id: src.list.id,
        source_team_id: sourceTeamId,
        dest_task_id: destTaskId,
        dest_list_id: destList.id,
        last_synced_status: destTask.status.status,
        last_sync_at: Date.now(),
      });
    }
  }

  if (!destTaskId) {
    // ── CREATE new task in aggregator ──────────────────────────────────
    const payload: any = {
      name: src.name,
      description: src.description || "",
      status: sourceStatus,
      due_date: src.due_date ? Number(src.due_date) : null,
      start_date: src.start_date ? Number(src.start_date) : null,
      time_estimate: src.time_estimate ?? null,
      assignees: [config.dest.userId],
      custom_fields: [
        { id: config.customFields.sourceTaskId, value: src.id },
        { id: config.customFields.sourceListId, value: src.list.id },
      ],
    };

    const createRes = await destClient.post<{ id: string }>(
      `/list/${destList.id}/task`,
      payload,
    );
    destTaskId = createRes.data.id;

    syncDB.upsert({
      source_task_id: src.id,
      source_list_id: src.list.id,
      source_team_id: sourceTeamId,
      dest_task_id: destTaskId,
      dest_list_id: destList.id,
      last_synced_status: sourceStatus,
      last_sync_at: Date.now(),
    });

    console.log(
      `[SYNC] Created: "${src.name}" (src=${src.id} → dest=${destTaskId})`,
    );
    return;
  }

  // ── UPDATE existing task ──────────────────────────────────────────────
  const destStatus = destTask!.status.status;

  // Bidirectional status resolution
  const record = syncDB.getRecord(src.id, src.list.id);
  let resolvedStatus: string = sourceStatus;
  let updateSource = false;
  let updateDest = false;

  if (record) {
    const last = record.last_synced_status;

    const srcChanged = sourceStatus.toLowerCase() !== last.toLowerCase();
    const destChanged = destStatus.toLowerCase() !== last.toLowerCase();

    if (srcChanged && !destChanged) {
      // Source changed → push to aggregator
      resolvedStatus = sourceStatus;
      updateDest = true;
    } else if (!srcChanged && destChanged) {
      // Aggregator changed → push to source
      resolvedStatus = destStatus;
      updateSource = true;
    } else if (srcChanged && destChanged) {
      // Both changed → source wins
      resolvedStatus = sourceStatus;
      updateDest = true;
      console.warn(
        `[SYNC] Status conflict on "${src.name}": source="${sourceStatus}" dest="${destStatus}" last="${last}" → source wins`,
      );
    }
    // else: neither changed → no status update
  } else {
    // No DB record → fallback to date_updated
    if (sourceStatus.toLowerCase() !== destStatus.toLowerCase()) {
      const srcUpdated = Number(src.date_updated || 0);
      const destUpdated = Number(destTask!.date_updated || 0);

      if (destUpdated > srcUpdated) {
        resolvedStatus = destStatus;
        updateSource = true;
        console.log(
          `[SYNC] No DB record, date_updated fallback → aggregator wins for "${src.name}"`,
        );
      } else {
        resolvedStatus = sourceStatus;
        updateDest = true;
        console.log(
          `[SYNC] No DB record, date_updated fallback → source wins for "${src.name}"`,
        );
      }
    }
  }

  // Update aggregator task (always push name, desc, dates; conditionally status)
  const destPayload: any = {
    name: src.name,
    description: src.description || "",
    due_date: src.due_date ? Number(src.due_date) : null,
    start_date: src.start_date ? Number(src.start_date) : null,
    time_estimate: src.time_estimate ?? null,
  };

  if (updateDest) {
    // Validate status exists in aggregator before setting
    const destListDetail = await getListDetail(destClient, destList.id);
    const destStatuses = destListDetail.statuses || [];
    const matched = matchStatus(resolvedStatus, destStatuses);
    if (matched) {
      destPayload.status = matched;
    } else if (destStatuses.length > 0) {
      console.warn(
        `[SYNC] Status "${resolvedStatus}" not found in dest list "${destList.name}". Skipping status update.`,
      );
      updateDest = false;
    } else {
      // No status info available, try raw
      destPayload.status = resolvedStatus;
    }
  }

  await destClient.put(`/task/${destTaskId}`, destPayload);

  // Push status back to source if aggregator changed
  if (updateSource) {
    const srcStatuses = srcList.statuses || [];
    const matchedSrc = matchStatus(resolvedStatus, srcStatuses);
    if (matchedSrc) {
      await srcClient.put(`/task/${src.id}`, { status: matchedSrc });
      console.log(
        `[SYNC] Pushed status "${matchedSrc}" back to source "${src.name}" (${src.id})`,
      );
    } else if (srcStatuses.length > 0) {
      console.warn(
        `[SYNC] Status "${resolvedStatus}" not found in source list. Skipping source status update.`,
      );
      // Keep the source status as the resolved one for DB
      resolvedStatus = sourceStatus;
    } else {
      await srcClient.put(`/task/${src.id}`, { status: resolvedStatus });
      console.log(
        `[SYNC] Pushed status "${resolvedStatus}" back to source "${src.name}" (${src.id})`,
      );
    }
  }

  // Update DB
  syncDB.upsert({
    source_task_id: src.id,
    source_list_id: src.list.id,
    source_team_id: sourceTeamId,
    dest_task_id: destTaskId,
    dest_list_id: destList.id,
    last_synced_status: resolvedStatus,
    last_sync_at: Date.now(),
  });

  console.log(
    `[SYNC] Updated: "${src.name}" (src=${src.id} → dest=${destTaskId})`,
  );
}

// ─── Cleanup: remove aggregator assignments for unassigned source tasks ───

async function cleanupUnassigned(
  syncedSourceTaskIds: Set<string>,
): Promise<void> {
  const allRecords = syncDB.getAllRecords();
  if (allRecords.length === 0) {
    console.log("[CLEANUP] No DB records, skipping DB-based cleanup");
    return;
  }

  const destClient = createClient(config.dest.key);

  for (const record of allRecords) {
    // Skip tasks we just synced (they are still assigned)
    if (syncedSourceTaskIds.has(record.source_task_id)) continue;

    // Find the source config for this task's team
    const source = config.sources.find(
      (s) => s.teamId === record.source_team_id,
    );
    if (!source) {
      // Source workspace removed from config → clean up
      await removeDestAssignment(destClient, record);
      continue;
    }

    // Check if still assigned in source
    let stillAssigned = false;
    const srcClient = createClient(source.key);
    try {
      const res = await srcClient.get<TaskData>(
        `/task/${record.source_task_id}`,
      );
      stillAssigned = res.data.assignees.some(
        (a) => Number(a.id) === source.userId,
      );
    } catch {
      // Task not found or API error → not assigned
    }

    if (!stillAssigned) {
      await removeDestAssignment(destClient, record);
    }
  }
}

async function removeDestAssignment(
  destClient: AxiosInstance,
  record: { dest_task_id: string; source_task_id: string; source_list_id: string },
): Promise<void> {
  try {
    await destClient.put(`/task/${record.dest_task_id}`, {
      assignees: { rem: [config.dest.userId] },
    });
    syncDB.deleteRecord(record.source_task_id, record.source_list_id);
    console.log(
      `[CLEANUP] Removed assignment from dest ${record.dest_task_id}`,
    );
  } catch (err: any) {
    console.warn(
      `[CLEANUP] Failed to remove assignment from ${record.dest_task_id}:`,
      err?.response?.data || err.message,
    );
  }
}

// ─── Fallback cleanup: full dest scan (for when DB was lost/rebuilt) ──────

async function fullDestScanCleanup(
  syncedSourceTaskIds: Set<string>,
): Promise<void> {
  console.log("[CLEANUP] Running full dest scan cleanup");
  const destClient = createClient(config.dest.key);
  let page = 0;

  while (true) {
    const res = await destClient.get<{ tasks: TaskData[] }>(
      `/team/${config.dest.teamId}/task`,
      {
        params: {
          "assignees[]": config.dest.userId,
          include_closed: true,
          page,
        },
      },
    );
    if (!res.data.tasks || res.data.tasks.length === 0) break;

    for (const dt of res.data.tasks) {
      const cfTask = dt.custom_fields?.find(
        (cf) => cf.id === config.customFields.sourceTaskId,
      );
      const cfList = dt.custom_fields?.find(
        (cf) => cf.id === config.customFields.sourceListId,
      );
      if (!cfTask?.value || !cfList?.value) continue;

      const sourceTaskId = cfTask.value as string;
      if (syncedSourceTaskIds.has(sourceTaskId)) continue;

      // Already in DB? Skip (DB cleanup handles it)
      if (syncDB.getRecord(sourceTaskId, cfList.value as string)) continue;

      // Check all source workspaces
      let stillAssigned = false;
      for (const source of config.sources) {
        const srcClient = createClient(source.key);
        try {
          const detail = await srcClient.get<TaskData>(
            `/task/${sourceTaskId}`,
          );
          if (detail.data.list.id !== cfList.value) continue;
          stillAssigned = detail.data.assignees.some(
            (a) => Number(a.id) === source.userId,
          );
          if (stillAssigned) break;
        } catch {
          // task not found in this source
        }
      }

      if (!stillAssigned) {
        try {
          await destClient.put(`/task/${dt.id}`, {
            assignees: { rem: [config.dest.userId] },
          });
          console.log(
            `[CLEANUP-SCAN] Removed assignment from dest ${dt.id} (${dt.name})`,
          );
        } catch {
          // ignore
        }
      }
    }
    page++;
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────

let syncCycleCount = 0;

export async function syncAll(): Promise<void> {
  const startTime = Date.now();
  console.log(`[SYNC] Cycle ${++syncCycleCount} started`);
  clearCaches();

  try {
    await initUsers();

    const syncedSourceTaskIds = new Set<string>();

    for (const source of config.sources) {
      const tasks = await fetchAssignedTasks(
        source.key,
        source.teamId,
        source.userId,
      );

      for (const task of tasks) {
        try {
          await syncTask(task, source.key, source.teamId, source.userId);
          syncedSourceTaskIds.add(task.id);
        } catch (err: any) {
          console.error(
            `[SYNC] Error syncing task "${task.name}" (${task.id}):`,
            err?.response?.data || err.message,
          );
        }
      }
    }

    // Cleanup
    await cleanupUnassigned(syncedSourceTaskIds);

    // Full dest scan every 10 cycles (catches orphans when DB was rebuilt)
    if (syncCycleCount % 10 === 1) {
      await fullDestScanCleanup(syncedSourceTaskIds);
    }
  } catch (err: any) {
    console.error(
      "[SYNC] Cycle error:",
      err?.response?.data || err.message || err,
    );
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[SYNC] Cycle ${syncCycleCount} completed in ${elapsed}s`);
}

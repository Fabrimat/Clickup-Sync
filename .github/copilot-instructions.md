# ClickUp Sync - AI Agent Instructions

## Architecture Overview

This is a **one-way synchronization service** that mirrors tasks assigned to source ClickUp users into a single destination ClickUp workspace. The entire application is a single TypeScript file (`clickup-sync.ts`) that runs continuously via `setInterval`.

**Key Design Decisions:**

- **Multi-source, single-destination**: Supports multiple source ClickUp workspaces (each with its own API key) syncing to one destination workspace
- **Custom field linking**: Uses two custom fields (`CUSTOM_FIELD_SOURCE_TASK_ID` and `CUSTOM_FIELD_SOURCE_LIST_ID`) to track relationships between source and destination tasks
- **User-centric sync**: Only syncs tasks assigned to the authenticated source users
- **Structure replication**: Automatically creates matching Spaces, Folders, and Lists in the destination

## Critical Environment Variables

All configuration is in `.env` (not committed to git):

- `SOURCE_KEYS` - Comma-separated API keys (e.g., `pk_123,pk_456`)
- `SOURCE_TEAM_IDS` - Comma-separated team IDs (must match length of SOURCE_KEYS)
- `DEST_KEY` - Single destination API key
- `DEST_TEAM_ID` - Destination team ID
- `CUSTOM_FIELD_SOURCE_TASK_ID` - Custom field ID for storing source task reference
- `CUSTOM_FIELD_SOURCE_LIST_ID` - Custom field ID for storing source list reference
- `SYNC_INTERVAL_MS` - Sync frequency (default: 300000 = 5 minutes)

**Setup requirement**: Custom fields must be manually created in destination ClickUp before first run.

## Development Workflow

**Run locally:**

```powershell
# Install dependencies
npm install

# Run with ts-node
npx ts-node clickup-sync.ts
```

**Docker workflow:**

```powershell
# Build and run
docker-compose up -d

# View logs (includes [DEBUG] output)
docker-compose logs -f

# Stop
docker-compose down
```

## Code Patterns & Conventions

### 1. API Client Pattern

- Use `createClient(apiKey)` factory for all ClickUp API calls
- All clients have request logging via interceptors
- Timeout is 10 seconds for all requests

### 2. Status Mapping (Critical Business Logic)

The sync uses a **simplified two-state model**:

```typescript
function mapStatus(srcStatus: any): "to do" | "complete";
```

- Source "complete" → Destination "complete"
- All other source statuses → Destination "to do"
- Status updates are **one-directional**: changes in destination are not synced back

### 3. Hierarchical Structure Sync

ClickUp hierarchy: `Team > Space > Folder (optional) > List > Task`

The sync uses "ensure" pattern for idempotent creation:

- `ensureSpace(name)` - Creates space if missing, returns existing if found
- `ensureFolder(spaceId, name)` - Same for folders
- `ensureList(spaceId, name, folderName?)` - Handles both foldered and folderless lists

### 4. Task Identification Strategy

Tasks are matched using **double custom field lookup**:

```typescript
await findDestTaskId(listId, sourceTaskId, sourceListId);
```

This prevents duplicates when source tasks move between lists (both IDs must match).

### 5. Cleanup Logic

`cleanupDestAssignments()` removes destination user from tasks that:

- Source task no longer exists, OR
- Source task is no longer assigned to source user, OR
- Source task moved to different list

## Logging Convention

All debug output uses `console.debug("[DEBUG] ...")` prefix. Production logs use `console.log()`. Errors use `console.error()`.

Example debug pattern:

```typescript
console.debug(`[DEBUG] syncSourceTask start=${task.id}`);
// ... work ...
console.debug(`[DEBUG] syncSourceTask end=${task.id}`);
```

## Common Modifications

**Adding new task fields to sync:**

1. Add to `TaskData` interface
2. Include in `syncSourceTask` payload (both create and update)

**Changing sync frequency:**
Update `SYNC_INTERVAL_MS` environment variable (value in milliseconds)

**Supporting additional status states:**
Modify `mapStatus()` function - note this will affect all synced tasks

## Dependencies

- `axios` - ClickUp API v2 client
- `dotenv` - Environment configuration
- `ts-node` - Direct TypeScript execution (no build step)
- Express is listed but **not used** in current implementation

## Testing Approach

Currently no automated tests. Manual verification checklist:

1. Task creation (new source assignment)
2. Task updates (name, description, dates)
3. Task cleanup (unassignment in source)
4. Folder structure replication
5. Multi-source aggregation in single destination

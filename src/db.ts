import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "./config";
import { SyncRecord } from "./types";

class SyncDB {
  private db: Database.Database | null = null;

  constructor() {
    this.init();
  }

  private init(): void {
    try {
      const dir = path.dirname(config.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      this.db = new Database(config.dbPath);
      this.db.pragma("journal_mode = WAL");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
          source_task_id  TEXT NOT NULL,
          source_list_id  TEXT NOT NULL,
          source_team_id  TEXT NOT NULL,
          dest_task_id    TEXT NOT NULL,
          dest_list_id    TEXT NOT NULL,
          last_synced_status TEXT NOT NULL,
          last_sync_at    INTEGER NOT NULL,
          PRIMARY KEY (source_task_id, source_list_id)
        )
      `);

      console.log("[DB] SQLite initialized at", config.dbPath);
    } catch (err) {
      console.error(
        "[DB] Failed to initialize SQLite, falling back to date_updated",
        err,
      );
      this.db = null;
    }
  }

  /** Whether the DB is operational */
  isAvailable(): boolean {
    return this.db !== null;
  }

  /** Get a single sync record */
  getRecord(
    sourceTaskId: string,
    sourceListId: string,
  ): SyncRecord | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM sync_state WHERE source_task_id = ? AND source_list_id = ?",
        )
        .get(sourceTaskId, sourceListId) as SyncRecord | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /** Find record by dest task ID */
  getRecordByDestId(destTaskId: string): SyncRecord | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare("SELECT * FROM sync_state WHERE dest_task_id = ?")
        .get(destTaskId) as SyncRecord | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /** Get all sync records */
  getAllRecords(): SyncRecord[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare("SELECT * FROM sync_state")
        .all() as SyncRecord[];
    } catch {
      return [];
    }
  }

  /** Insert or update a sync record */
  upsert(record: SyncRecord): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sync_state
           (source_task_id, source_list_id, source_team_id, dest_task_id, dest_list_id, last_synced_status, last_sync_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.source_task_id,
          record.source_list_id,
          record.source_team_id,
          record.dest_task_id,
          record.dest_list_id,
          record.last_synced_status,
          record.last_sync_at,
        );
    } catch (err) {
      console.error("[DB] upsert failed", err);
    }
  }

  /** Delete a sync record */
  deleteRecord(sourceTaskId: string, sourceListId: string): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          "DELETE FROM sync_state WHERE source_task_id = ? AND source_list_id = ?",
        )
        .run(sourceTaskId, sourceListId);
    } catch {
      // ignore
    }
  }

  /** Get the dest task ID for a source task (fast lookup) */
  getDestTaskId(sourceTaskId: string, sourceListId: string): string | null {
    const rec = this.getRecord(sourceTaskId, sourceListId);
    return rec?.dest_task_id ?? null;
  }

  /** Close the database connection */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export const syncDB = new SyncDB();

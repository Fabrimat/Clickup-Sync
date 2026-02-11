import dotenv from "dotenv";

dotenv.config();

export interface SourceConfig {
  key: string;
  teamId: string;
  userId: number;
}

export interface Config {
  sources: SourceConfig[];
  dest: {
    key: string;
    teamId: string;
    userId: number;
  };
  customFields: {
    sourceTaskId: string;
    sourceListId: string;
  };
  syncIntervalMs: number;
  dbPath: string;
}

function requireEnv(name: string): string {
  const val = process.env[name]?.trim();
  if (!val) {
    console.error(`Error: ${name} not set`);
    process.exit(1);
  }
  return val;
}

function loadConfig(): Omit<Config, "sources" | "dest"> & {
  sources: Omit<SourceConfig, "userId">[];
  dest: Omit<Config["dest"], "userId">;
} {
  const sourceKeys = requireEnv("SOURCE_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const sourceTeamIds = requireEnv("SOURCE_TEAM_IDS")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (sourceKeys.length !== sourceTeamIds.length) {
    console.error(
      "Error: SOURCE_KEYS and SOURCE_TEAM_IDS must have the same length",
    );
    process.exit(1);
  }

  return {
    sources: sourceKeys.map((key, i) => ({ key, teamId: sourceTeamIds[i] })),
    dest: {
      key: requireEnv("DEST_KEY"),
      teamId: requireEnv("DEST_TEAM_ID"),
    },
    customFields: {
      sourceTaskId: requireEnv("CUSTOM_FIELD_SOURCE_TASK_ID"),
      sourceListId: requireEnv("CUSTOM_FIELD_SOURCE_LIST_ID"),
    },
    syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 5 * 60 * 1000,
    dbPath: process.env.DB_PATH?.trim() || "./data/sync.db",
  };
}

// Config is loaded without userIds; they are populated at runtime via initUsers()
export const config = loadConfig() as unknown as Config;

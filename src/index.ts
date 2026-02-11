import { config } from "./config";
import { syncAll } from "./sync";

console.log(
  `[START] ClickUp Sync starting — interval: ${config.syncIntervalMs / 60000} min, sources: ${config.sources.length}`,
);

syncAll();
setInterval(syncAll, config.syncIntervalMs);

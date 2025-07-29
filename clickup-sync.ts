import axios, { AxiosInstance } from "axios";
import dotenv from "dotenv";

dotenv.config();

// Configurazione da .env
const SOURCE_KEYS: string[] =
	process.env.SOURCE_KEYS?.split(",").map((k) => k.trim()) || [];
const SOURCE_TEAM_IDS: string[] =
	process.env.SOURCE_TEAM_IDS?.split(",").map((t) => t.trim()) || [];
const DEST_KEY: string = process.env.DEST_KEY?.trim() || "";
const DEST_TEAM_ID: string = process.env.DEST_TEAM_ID?.trim() || "";
// ID del custom field in ClickUp destinazione usato per memorizzare l'ID task sorgente
const CUSTOM_FIELD_SOURCE_TASK_ID: string =
	process.env.CUSTOM_FIELD_SOURCE_TASK_ID?.trim() || "";
const CUSTOM_FIELD_SOURCE_LIST_ID: string =
	process.env.CUSTOM_FIELD_SOURCE_LIST_ID?.trim() || "";
const SYNC_INTERVAL_MS: number =
	Number(process.env.SYNC_INTERVAL_MS) || 5 * 60 * 1000;

// Validazione variabili d'ambiente
if (!SOURCE_KEYS.length) {
	console.error("Error: SOURCE_KEYS non impostato");
	process.exit(1);
}
if (!SOURCE_TEAM_IDS.length) {
	console.error("Error: SOURCE_TEAM_IDS non impostato");
	process.exit(1);
}
if (SOURCE_KEYS.length !== SOURCE_TEAM_IDS.length) {
	console.error(
		"Error: SOURCE_KEYS e SOURCE_TEAM_IDS devono avere stessa lunghezza",
	);
	process.exit(1);
}
if (!DEST_KEY) {
	console.error("Error: DEST_KEY non impostato");
	process.exit(1);
}
if (!DEST_TEAM_ID) {
	console.error("Error: DEST_TEAM_ID non impostato");
	process.exit(1);
}
if (!CUSTOM_FIELD_SOURCE_TASK_ID) {
	console.error("Error: CUSTOM_FIELD_SOURCE_TASK_ID non impostato");
	process.exit(1);
}
if (!CUSTOM_FIELD_SOURCE_LIST_ID) {
	console.error("Error: CUSTOM_FIELD_SOURCE_LIST_ID non impostato");
	process.exit(1);
}

console.debug(
	`[DEBUG] ENV: sources=${SOURCE_KEYS.length}, teams=${SOURCE_TEAM_IDS.join(
		",",
	)}, destTeam=${DEST_TEAM_ID}, field=${CUSTOM_FIELD_SOURCE_TASK_ID}, interval=${SYNC_INTERVAL_MS}ms`,
);

// Factory per client Axios con log
function createClient(apiKey: string): AxiosInstance {
	const instance = axios.create({
		baseURL: "https://api.clickup.com/api/v2",
		timeout: 10000,
		headers: { Authorization: apiKey },
	});
	instance.interceptors.request.use((cfg) => {
		console.debug(
			`[DEBUG] ${cfg.method?.toUpperCase()} ${cfg.baseURL}${cfg.url}`,
		);
		return cfg;
	});
	return instance;
}

// ID numerico utente destinazione
let DEST_USER_ID: number;
async function initDestUser(): Promise<void> {
	const client = createClient(DEST_KEY);
	const res = await client.get<{ user: { id: string } }>(`/user`);
	DEST_USER_ID = Number(res.data.user.id);
	console.debug(`[DEBUG] DEST_USER_ID=${DEST_USER_ID}`);
}

// Nuove variabili per userId sorgenti
let SOURCE_USER_IDS: number[] = [];

// Inizializza tutti gli userId dai SOURCE_KEYS
async function initSourceUsers(): Promise<void> {
	for (let i = 0; i < SOURCE_KEYS.length; i++) {
		const client = createClient(SOURCE_KEYS[i]);
		const res = await client.get<{ user: { id: string } }>(`/user`);
		SOURCE_USER_IDS[i] = Number(res.data.user.id);
	}
}

// Tipi dati rilevanti
interface SpaceInfo {
	id: string;
	name: string;
}
interface FolderInfo {
	id: string;
	name: string; // aggiunto per poter leggere f.name in ensureFolder
}
interface ListInfo {
	id: string;
	name: string;
}
interface TaskData {
	id: string;
	name: string;
	description?: string;
	status: string;
	tags: { name: string }[];
	due_date?: number;
	start_date?: number;
	assignees: { id: string }[];
	space: { id: string; name: string };
	list: { id: string; name: string };
	custom_fields?: { id: string; value: any }[];
}

// Estrai liste da uno Space
async function fetchListsForSpace(
	client: AxiosInstance,
	spaceId: string,
): Promise<string[]> {
	const listIds: string[] = [];
	const directRes = await client.get<{ lists: ListInfo[] }>(
		`/space/${spaceId}/list`,
	);
	directRes.data.lists.forEach((l) => listIds.push(l.id));

	const folderRes = await client.get<{ folders: FolderInfo[] }>(
		`/space/${spaceId}/folder`,
	);
	for (const folder of folderRes.data.folders) {
		const underRes = await client.get<{ lists: ListInfo[] }>(
			`/folder/${folder.id}/list`,
		);
		underRes.data.lists.forEach((l) => listIds.push(l.id));
	}
	return listIds;
}

// Recupera tutte le task assegnate all'utente sorgente
async function fetchAssignedTasks(
	apiKey: string,
	teamId: string,
): Promise<TaskData[]> {
	const client = createClient(apiKey);
	const tasks: TaskData[] = [];
	console.debug(`[DEBUG] fetchAssignedTasks start team=${teamId}`);

	// Ottieni userId sorgente
	const userRes = await client.get<{ user: { id: string } }>(`/user`);
	const sourceUserId = Number(userRes.data.user.id);
	console.debug(`[DEBUG] sourceUserId=${sourceUserId}`);

	// Itera spaces -> lists -> tasks
	const spacesRes = await client.get<{ spaces: SpaceInfo[] }>(
		`/team/${teamId}/space`,
	);
	for (const space of spacesRes.data.spaces) {
		console.debug(`[DEBUG] space=${space.id} name=${space.name}`);
		const listIds = await fetchListsForSpace(client, space.id);
		for (const listId of listIds) {
			let page = 0;
			while (true) {
				const res = await client.get<{ tasks: TaskData[] }>(
					`/list/${listId}/task?assignees[]=${sourceUserId}&page=${page}`,
				);
				if (!res.data.tasks.length) break;
				tasks.push(...res.data.tasks);
				page++;
			}
		}
	}
	console.debug(`[DEBUG] fetchAssignedTasks end total=${tasks.length}`);
	return tasks;
}

// Mappa stato sorgente->dest (solo due stati)
function mapStatus(srcStatus: any): "to do" | "complete" {
	let statusStr: string;
	if (typeof srcStatus === "string") {
		statusStr = srcStatus;
	} else {
		console.debug(
			`[DEBUG] mapStatus: non-string srcStatus (type=${typeof srcStatus}), value=`,
			srcStatus,
		);
		statusStr = (srcStatus?.status as string) || "";
	}
	return statusStr.toLowerCase() === "complete" ? "complete" : "to do";
}

// Assicura che uno Space esista in destinazione
async function ensureSpace(name: string): Promise<SpaceInfo> {
	const client = createClient(DEST_KEY);
	const res = await client.get<{ spaces: SpaceInfo[] }>(
		`/team/${DEST_TEAM_ID}/space`,
	);
	const found = res.data.spaces.find((s) => s.name === name);
	if (found) return found;
	const createRes = await client.post<SpaceInfo>(
		`/team/${DEST_TEAM_ID}/space`,
		{
			name,
			multiple_assignees: true,
			features: {
				due_dates: {
					enabled: true,
					start_date: true,
					remap_due_dates: true,
					remap_closed_due_date: true,
				},
				time_tracking: {
					enabled: true,
				},
				tags: {
					enabled: true,
				},
				time_estimates: {
					enabled: true,
				},
				checklists: {
					enabled: true,
				},
				custom_fields: {
					enabled: true,
				},
				remap_dependencies: {
					enabled: true,
				},
				dependency_warning: {
					enabled: true,
				},
				portfolios: {
					enabled: true,
				},
			},
		},
	);
	return createRes.data;
}

// Assicura che una Folder esista in destinazione
async function ensureFolder(
	spaceId: string,
	name: string,
): Promise<FolderInfo> {
	const client = createClient(DEST_KEY);
	const res = await client.get<{ folders: FolderInfo[] }>(
		`/space/${spaceId}/folder`,
	);
	const found = res.data.folders.find((f) => f.name === name);
	if (found) return found;
	const createRes = await client.post<FolderInfo>(`/space/${spaceId}/folder`, {
		name,
	});
	return createRes.data;
}

// Assicura che una List esista nel Space o nella Folder destinazione
async function ensureList(
	spaceId: string,
	name: string,
	folderName?: string,
): Promise<ListInfo> {
	const client = createClient(DEST_KEY);
	if (folderName) {
		const folder = await ensureFolder(spaceId, folderName);
		const res = await client.get<{ lists: ListInfo[] }>(
			`/folder/${folder.id}/list`,
		);
		const found = res.data.lists.find((l) => l.name === name);
		if (found) return found;
		const createRes = await client.post<ListInfo>(`/folder/${folder.id}/list`, {
			name,
			content: "",
		});
		return createRes.data;
	}
	const res = await client.get<{ lists: ListInfo[] }>(`/space/${spaceId}/list`);
	const found = res.data.lists.find((l) => l.name === name);
	if (found) return found;
	const createRes = await client.post<ListInfo>(`/space/${spaceId}/list`, {
		name,
		content: "",
	});
	return createRes.data;
}

// Trova task destinazione tramite doppio custom‐field (taskId + listId)
async function findDestTaskId(
	listId: string,
	sourceTaskId: string,
	sourceListId: string,
): Promise<string | undefined> {
	const client = createClient(DEST_KEY);
	const res = await client.get<{ tasks: TaskData[] }>(
		`/list/${listId}/task?custom_field=${sourceTaskId}`,
	);
	const found = res.data.tasks.find(
		(task) =>
			task.custom_fields?.some(
				(cf) =>
					cf.id === CUSTOM_FIELD_SOURCE_TASK_ID && cf.value === sourceTaskId,
			) &&
			task.custom_fields?.some(
				(cf) =>
					cf.id === CUSTOM_FIELD_SOURCE_LIST_ID && cf.value === sourceListId,
			),
	);
	return found?.id;
}

// Sincronizza singola task
async function syncSourceTask(task: TaskData, srcKey: string): Promise<void> {
	console.debug(`[DEBUG] syncSourceTask start=${task.id}`);
	const clientSrc = createClient(srcKey);
	const detail = await clientSrc.get<TaskData>(`/task/${task.id}`);
	const t = detail.data;

	// Assicura Space e List in destinazione
	const spaceInfo = await clientSrc.get<{ name: string }>(
		`/space/${t.space.id}`,
	);
	const space = await ensureSpace(spaceInfo.data.name);

	// recupera il nome della folder sorgente (se esiste)
	const listDetail = await clientSrc.get<{
		folder?: { id: string; name: string };
	}>(`/list/${t.list.id}`);
	const folderName = listDetail.data.folder?.name;
	const list = await ensureList(space.id, t.list.name, folderName);

	// Determina status
	const destStatus = mapStatus(t.status);
	const clientDest = createClient(DEST_KEY);

	// Cerca copia esistente (ora con listId)
	let destId = await findDestTaskId(list.id, t.id, t.list.id);

	if (!destId) {
		// Crea nuova task con doppio custom‐field
		const payload = {
			name: t.name,
			description: t.description,
			status: destStatus,
			due_date: t.due_date,
			start_date: t.start_date,
			assignees: [DEST_USER_ID],
			custom_fields: [
				{ id: CUSTOM_FIELD_SOURCE_TASK_ID, value: t.id },
				{ id: CUSTOM_FIELD_SOURCE_LIST_ID, value: t.list.id },
			],
		};
		const createRes = await clientDest.post<{ id: string }>(
			`/list/${list.id}/task`,
			payload,
		);
		destId = createRes.data.id;
		console.debug(`[DEBUG] created dest=${destId}`);
	} else {
		// Aggiorna campi (nome, descrizione, tag, date) senza modificare lo status
		const payload = {
			name: t.name,
			description: t.description,
			due_date: t.due_date,
			start_date: t.start_date,
		};
		await clientDest.put(`/task/${destId}`, payload);
		console.debug(`[DEBUG] updated dest=${destId} fields`);
	}

	console.debug(`[DEBUG] syncSourceTask end=${t.id}`);
}

// Rimuove assignees su task di destinazione non più presenti o assegnati nel sorgente
async function cleanupDestAssignments(): Promise<void> {
	const clientDest = createClient(DEST_KEY);
	const spacesRes = await clientDest.get<{ spaces: SpaceInfo[] }>(
		`/team/${DEST_TEAM_ID}/space`,
	);
	for (const space of spacesRes.data.spaces) {
		const listIds = await fetchListsForSpace(clientDest, space.id);
		for (const listId of listIds) {
			let page = 0;
			while (true) {
				const res = await clientDest.get<{ tasks: TaskData[] }>(
					`/list/${listId}/task?page=${page}`,
				);
				if (!res.data.tasks.length) break;
				for (const dt of res.data.tasks) {
					const cfTask = dt.custom_fields?.find(
						(cf) => cf.id === CUSTOM_FIELD_SOURCE_TASK_ID,
					);
					const cfList = dt.custom_fields?.find(
						(cf) => cf.id === CUSTOM_FIELD_SOURCE_LIST_ID,
					);
					if (!cfTask || !cfList) continue;
					const sourceTaskId = cfTask.value as string;
					const sourceListId = cfList.value as string;

					let stillAssigned = false;
					for (let i = 0; i < SOURCE_KEYS.length; i++) {
						const clientSrc = createClient(SOURCE_KEYS[i]);
						try {
							const sourceDetail = await clientSrc.get<TaskData>(
								`/task/${sourceTaskId}`,
							);
							// verifica list sorgente
							if (sourceDetail.data.list.id !== sourceListId) continue;

							const isAssigned = sourceDetail.data.assignees.some(
								(a) => Number(a.id) === SOURCE_USER_IDS[i],
							);
							if (isAssigned) {
								stillAssigned = true;
								break;
							}
						} catch {
							// task non trovata in questo source
						}
					}
					if (!stillAssigned) {
						await clientDest.put(`/task/${dt.id}`, {
							assignees: {
								rem: [DEST_USER_ID],
							},
						});
						console.debug(
							`[DEBUG] removed assignees on dest=${dt.id} name=${dt.name}`,
						);
					}
				}
				page++;
			}
		}
	}
}

// Ciclo principale di sincronizzazione
async function syncAll(): Promise<void> {
	console.debug(`[DEBUG] syncAll start`);
	try {
		await initDestUser();
		await initSourceUsers();
		for (let i = 0; i < SOURCE_KEYS.length; i++) {
			const key = SOURCE_KEYS[i];
			const team = SOURCE_TEAM_IDS[i];
			const tasks = await fetchAssignedTasks(key, team);
			for (const task of tasks) {
				await syncSourceTask(task, key);
			}
		}
		console.log(`[${new Date().toISOString()}] Sync completed`);
		await cleanupDestAssignments();
	} catch (err) {
		console.error("Sync error:", err);
	}
	console.debug(`[DEBUG] syncAll end`);
}

// Avvia sincronizzazione periodica
console.log(`Avvio sincronizzazione ogni ${SYNC_INTERVAL_MS / 60000} minuti`);
syncAll();
setInterval(syncAll, SYNC_INTERVAL_MS);

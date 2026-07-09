import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname } from "node:os";

const SYNC_FILE = "state/sync.json";

/**
 * Read the current sync state.
 */
export async function readSyncState() {
  try {
    const raw = await readFile(SYNC_FILE, "utf8");
    return {
      lastSyncedAt: null,
      devices: {},
      ...JSON.parse(raw),
    };
  } catch {
    return { lastSyncedAt: null, devices: {} };
  }
}

/**
 * Write the sync state to disk.
 */
export async function writeSyncState(state) {
  await mkdir(dirname(SYNC_FILE), { recursive: true });
  await writeFile(SYNC_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function recordSyncStatus(kind, status, details = {}) {
  const state = await readSyncState();
  const now = new Date().toISOString();
  state.server = details.server || state.server || null;
  state.lastStatusAt = now;
  state.lastMessage = details.message || null;
  state.lastError = details.error || null;
  if (kind === "push") {
    state.lastPushStatus = status;
    state.lastPushMessage = details.message || null;
    state.lastPushError = details.error || null;
    if (status === "success") state.lastPushAt = now;
  } else if (kind === "pull") {
    state.lastPullStatus = status;
    state.lastPullMessage = details.message || null;
    state.lastPullError = details.error || null;
    if (status === "success" || status === "partial") state.lastPullAt = now;
  }
  await writeSyncState(state);
  return state;
}

/**
 * Pull snapshots from a remote server and store them locally.
 *
 * Flow:
 * 1. GET /api/devices to get the list of remote devices.
 * 2. For each device, GET /api/snapshot/:deviceId to fetch its snapshot.
 * 3. Write each snapshot to state/<deviceId>.json.
 * 4. Record sync metadata in state/sync.json.
 *
 * @param {string} serverUrl e.g. "http://your-server:34777"
 * @returns {{ synced: string[], failed: {deviceId: string, error: string}[], message: string }}
 */
export async function pullFromServer(serverUrl) {
  const baseUrl = String(serverUrl).replace(/\/+$/, "");
  const synced = [];
  const failed = [];
  await recordSyncStatus("pull", "running", { server: baseUrl, message: "Pulling from server..." });

  // 1. Fetch device list
  let devices;
  try {
    const res = await fetch(`${baseUrl}/api/devices`);
    if (!res.ok) {
      const message = `Failed to fetch device list: HTTP ${res.status}`;
      await recordSyncStatus("pull", "failed", { server: baseUrl, error: message });
      return { synced, failed, message };
    }
    devices = await res.json();
  } catch (err) {
    const message = `Failed to connect to ${baseUrl}: ${err.message}`;
    await recordSyncStatus("pull", "failed", { server: baseUrl, error: message });
    return { synced, failed, message };
  }

  if (!Array.isArray(devices)) {
    const message = "Remote server returned an invalid device list";
    await recordSyncStatus("pull", "failed", { server: baseUrl, error: message });
    return { synced, failed, message };
  }

  // 2. Clean up local orphan snapshots (not on server anymore)
  const remoteIds = new Set(devices.map((d) => d.device_id));
  const { readDeviceStates } = await import("./state.js");
  const localDevices = await readDeviceStates();
  for (const [localId] of localDevices) {
    if (localId === hostname()) continue; // keep self
    if (!remoteIds.has(localId)) {
      const { removeDeviceState } = await import("./state.js");
      await removeDeviceState(localId);
      console.log(`[sync] removed orphaned local cache: ${localId}`);
    }
  }

  if (devices.length === 0) {
    const message = "No remote devices found";
    await recordSyncStatus("pull", "success", { server: baseUrl, message });
    return { synced, failed, message };
  }

  // 3. Fetch each device's snapshot (skip self)
  const localId = hostname();
  for (const device of devices) {
    const deviceId = device.device_id;
    if (deviceId === localId) {
      console.log(`[sync] skipping local device: ${deviceId}`);
      continue;
    }
    try {
      const res = await fetch(`${baseUrl}/api/snapshot/${deviceId}`);
      if (!res.ok) {
        failed.push({ deviceId, error: `HTTP ${res.status}` });
        continue;
      }
      const snapshot = await res.json();
      const deviceName = device.device_name || deviceId;

      // Write to state/<deviceId>.json (inline to avoid importing writeDeviceState
      // which would also store _device_id/_device_name — we import it for reuse)
      const { writeDeviceState } = await import("./state.js");
      await writeDeviceState(deviceId, deviceName, snapshot);

      // Compute today's tokens from the snapshot
      const todayTokens = snapshot.today?.totalTokens || 0;

      synced.push(deviceId);

      // 3. Record sync metadata
      const syncState = await readSyncState();
      syncState.lastSyncedAt = new Date().toISOString();
      syncState.devices = syncState.devices || {};
      syncState.devices[deviceId] = {
        lastSyncedAt: syncState.lastSyncedAt,
        todayTokens,
      };
      await writeSyncState(syncState);
    } catch (err) {
      failed.push({ deviceId, error: err.message });
    }
  }

  const message = synced.length > 0
    ? `Synced ${synced.length} device(s) from ${baseUrl}`
    : "No devices were synced";
  const status = failed.length > 0 ? "partial" : "success";
  const error = failed.length > 0
    ? failed.map((f) => `${f.deviceId}: ${f.error}`).join("; ")
    : null;
  await recordSyncStatus("pull", status, { server: baseUrl, message, error });

  return { synced, failed, message };
}

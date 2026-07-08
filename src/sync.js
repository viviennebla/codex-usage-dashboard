import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

const SYNC_FILE = "state/sync.json";

/**
 * Read the current sync state.
 */
export async function readSyncState() {
  try {
    const raw = await readFile(SYNC_FILE, "utf8");
    return JSON.parse(raw);
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

  // 1. Fetch device list
  let devices;
  try {
    const res = await fetch(`${baseUrl}/api/devices`);
    if (!res.ok) {
      return { synced, failed, message: `Failed to fetch device list: HTTP ${res.status}` };
    }
    devices = await res.json();
  } catch (err) {
    return { synced, failed, message: `Failed to connect to ${baseUrl}: ${err.message}` };
  }

  if (!Array.isArray(devices) || devices.length === 0) {
    return { synced, failed, message: "No remote devices found" };
  }

  // 2. Fetch each device's snapshot
  for (const device of devices) {
    const deviceId = device.device_id;
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

  return { synced, failed, message };
}

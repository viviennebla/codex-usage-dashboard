import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { hostname } from "node:os";

const SYNC_FILE = "state/sync.json";

function snapshotTime(snapshot) {
  const value = Date.parse(snapshot?.generated_at || "");
  return Number.isFinite(value) ? value : null;
}

export function shouldReplaceSnapshot(existing, incoming) {
  if (!existing) return true;
  const existingTime = snapshotTime(existing);
  const incomingTime = snapshotTime(incoming);
  if (incomingTime === null) return false;
  if (existingTime === null) return true;
  return incomingTime > existingTime;
}

export function shouldFetchRemoteSnapshot(existing, remoteDevice) {
  if (!existing) return true;
  const existingTime = snapshotTime(existing);
  const remoteTime = Date.parse(remoteDevice?.generated_at || "");
  if (!Number.isFinite(remoteTime)) return true;
  if (existingTime === null) return true;
  return remoteTime > existingTime;
}

/**
 * Read the current sync state.
 */
export async function readSyncState() {
  try {
    const raw = await readFile(SYNC_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastSyncedAt: null,
      devices: {},
      disabledDevices: {},
      ...parsed,
      devices: parsed.devices && typeof parsed.devices === "object" ? parsed.devices : {},
      disabledDevices: parsed.disabledDevices && typeof parsed.disabledDevices === "object"
        ? parsed.disabledDevices
        : {},
    };
  } catch {
    return { lastSyncedAt: null, devices: {}, disabledDevices: {} };
  }
}

/**
 * Write the sync state to disk.
 */
export async function writeSyncState(state) {
  await mkdir(dirname(SYNC_FILE), { recursive: true });
  await writeFile(SYNC_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function updateDeviceSyncPreference(state, deviceId, enabled, details = {}) {
  const next = {
    ...state,
    devices: { ...(state?.devices || {}) },
    disabledDevices: { ...(state?.disabledDevices || {}) },
  };
  if (enabled) {
    delete next.disabledDevices[deviceId];
  } else {
    next.disabledDevices[deviceId] = {
      deviceName: details.deviceName || deviceId,
      generatedAt: details.generatedAt || null,
      totalTokens: Number(details.totalTokens || 0),
      disabledAt: details.disabledAt || new Date().toISOString(),
    };
    delete next.devices[deviceId];
  }
  return next;
}

export function isDeviceSyncDisabled(state, deviceId) {
  return Boolean(state?.disabledDevices?.[deviceId]);
}

export async function setDeviceSyncEnabled(deviceId, enabled, details = {}) {
  const state = await readSyncState();
  const next = updateDeviceSyncPreference(state, deviceId, enabled, details);
  await writeSyncState(next);
  return next;
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
 * @returns {{ synced: string[], skipped: {deviceId: string, reason: string}[], failed: {deviceId: string, error: string}[], message: string }}
 */
export async function pullFromServer(serverUrl) {
  const baseUrl = String(serverUrl).replace(/\/+$/, "");
  const synced = [];
  const skipped = [];
  const failed = [];
  const syncedDeviceMeta = [];
  await recordSyncStatus("pull", "running", { server: baseUrl, message: "Pulling from server..." });
  const syncState = await readSyncState();

  // 1. Fetch device list
  let devices;
  try {
    const res = await fetch(`${baseUrl}/api/devices`);
    if (!res.ok) {
      const message = `Failed to fetch device list: HTTP ${res.status}`;
      await recordSyncStatus("pull", "failed", { server: baseUrl, error: message });
      return { synced, skipped, failed, message };
    }
    devices = await res.json();
  } catch (err) {
    const message = `Failed to connect to ${baseUrl}: ${err.message}`;
    await recordSyncStatus("pull", "failed", { server: baseUrl, error: message });
    return { synced, skipped, failed, message };
  }

  if (!Array.isArray(devices)) {
    const message = "Remote server returned an invalid device list";
    await recordSyncStatus("pull", "failed", { server: baseUrl, error: message });
    return { synced, skipped, failed, message };
  }

  // 2. Clean up local orphan snapshots (not on server anymore)
  const remoteIds = new Set(devices.map((d) => d.device_id));
  const { readDeviceStates } = await import("./state.js");
  const localDevices = await readDeviceStates();
  for (const [localId] of localDevices) {
    if (localId === hostname()) continue; // keep self
    if (isDeviceSyncDisabled(syncState, localId)) {
      const { removeDeviceState } = await import("./state.js");
      await removeDeviceState(localId);
      continue;
    }
    if (!remoteIds.has(localId)) {
      const { removeDeviceState } = await import("./state.js");
      await removeDeviceState(localId);
      console.log(`[sync] removed orphaned local cache: ${localId}`);
    }
  }

  if (devices.length === 0) {
    const message = "No remote devices found";
    await recordSyncStatus("pull", "success", { server: baseUrl, message });
    return { synced, skipped, failed, message };
  }

  // 3. Fetch changed device snapshots only (skip self)
  const localId = hostname();
  for (const device of devices) {
    const deviceId = device.device_id;
    if (isDeviceSyncDisabled(syncState, deviceId)) {
      skipped.push({ deviceId, reason: "device_sync_disabled" });
      continue;
    }
    if (deviceId === localId) {
      console.log(`[sync] skipping local device: ${deviceId}`);
      continue;
    }
    const existing = localDevices.get(deviceId)?.snapshot || null;
    if (!shouldFetchRemoteSnapshot(existing, device)) {
      skipped.push({ deviceId, reason: "remote_snapshot_not_newer" });
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
      if (!shouldReplaceSnapshot(existing, snapshot)) {
        skipped.push({ deviceId, reason: "local_snapshot_is_newer_or_remote_timestamp_missing" });
        continue;
      }

      // Write to state/<deviceId>.json (inline to avoid importing writeDeviceState
      // which would also store _device_id/_device_name — we import it for reuse)
      const { writeDeviceState } = await import("./state.js");
      await writeDeviceState(deviceId, deviceName, snapshot);

      // Compute today's tokens from the snapshot
      const todayTokens = snapshot.today?.totalTokens || 0;

      synced.push(deviceId);
      syncedDeviceMeta.push({ deviceId, todayTokens });
    } catch (err) {
      failed.push({ deviceId, error: err.message });
    }
  }

  if (syncedDeviceMeta.length) {
    const syncState = await readSyncState();
    const now = new Date().toISOString();
    syncState.lastSyncedAt = now;
    syncState.devices = syncState.devices || {};
    for (const { deviceId, todayTokens } of syncedDeviceMeta) {
      syncState.devices[deviceId] = { lastSyncedAt: now, todayTokens };
    }
    await writeSyncState(syncState);
  }

  const messageParts = [];
  const disabledCount = skipped.filter((item) => item.reason === "device_sync_disabled").length;
  const unchangedCount = skipped.length - disabledCount;
  if (synced.length > 0) messageParts.push(`Synced ${synced.length} device(s)`);
  if (unchangedCount > 0) messageParts.push(`skipped ${unchangedCount} unchanged/newer snapshot(s)`);
  if (disabledCount > 0) messageParts.push(`ignored ${disabledCount} locally disabled device(s)`);
  const message = messageParts.length > 0
    ? `${messageParts.join("; ")} from ${baseUrl}`
    : "No devices were synced";
  const status = failed.length > 0 ? "partial" : "success";
  const error = failed.length > 0
    ? failed.map((f) => `${f.deviceId}: ${f.error}`).join("; ")
    : null;
  await recordSyncStatus("pull", status, { server: baseUrl, message, error });

  return { synced, skipped, failed, message };
}

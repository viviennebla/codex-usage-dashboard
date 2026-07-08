import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { basename, dirname, join, extname } from "node:path";

export const DEFAULT_STATE_PATH = "state/latest.json";

const RESERVED_STATE_FILES = new Set([
  "latest.json",
  "sync.json",
]);

function isSnapshotState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(
    value.schema_version ||
    value.generated_at ||
    value.totals ||
    value.today ||
    value.recent_days ||
    value.activity_days ||
    value.top_sessions
  );
}

export async function writeStateFile(snapshot, path = DEFAULT_STATE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function readStateFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List all device state files in a directory.
 * Returns a Map of deviceId → { path, snapshot }.
 */
export async function readDeviceStates(stateDir = "state") {
  const devices = new Map();
  let entries;
  try {
    entries = await readdir(stateDir, { withFileTypes: true });
  } catch {
    return devices;
  }

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".json") continue;
    if (RESERVED_STATE_FILES.has(entry.name)) continue;
    const deviceId = basename(entry.name, ".json");
    const path = join(stateDir, entry.name);
    const snapshot = await readStateFile(path);
    if (isSnapshotState(snapshot)) {
      devices.set(deviceId, {
        deviceId,
        deviceName: snapshot._device_name || deviceId,
        path,
        snapshot,
      });
    }
  }
  return devices;
}

/**
 * Write a device snapshot to state/<deviceId>.json.
 * Stores device metadata inside the snapshot for round-trip safety.
 */
export async function writeDeviceState(deviceId, deviceName, snapshot, stateDir = "state") {
  await mkdir(stateDir, { recursive: true });
  const payload = {
    ...snapshot,
    _device_id: deviceId,
    _device_name: deviceName,
    _received_at: new Date().toISOString(),
  };
  const path = join(stateDir, `${deviceId}.json`);
  await writeStateFile(payload, path);
  return path;
}

/**
 * Remove a device's state file.
 */
export async function removeDeviceState(deviceId, stateDir = "state") {
  const path = join(stateDir, `${deviceId}.json`);
  try {
    await unlink(path);
  } catch {
    // file already gone — fine
  }
}

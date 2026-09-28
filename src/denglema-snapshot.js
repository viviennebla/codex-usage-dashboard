import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

export const DENGLEMA_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

function envOf(dependencies = {}) {
  return dependencies.env || process.env;
}

export function resolveDenglemaDataDir(options = {}, dependencies = {}) {
  const env = envOf(dependencies);
  return options.dataDir
    || env.PLUGIN_DATA
    || env.CLAUDE_PLUGIN_DATA
    || join(homedir(), ".codex-usage", "denglema");
}

export function snapshotPaths(options = {}, dependencies = {}) {
  const dataDir = resolveDenglemaDataDir(options, dependencies);
  return {
    dataDir,
    latest: join(dataDir, "latest.json"),
    uploadState: join(dataDir, "upload-state.json"),
    notificationState: join(dataDir, "notification-state.json"),
    collectLock: join(dataDir, "collect.lock"),
  };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(tmp, path);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await rm(path, { force: true });
    await rename(tmp, path);
  }
}

export async function readLatestDenglemaSnapshot(options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  return readJson(paths.latest);
}

export async function readDenglemaUploadState(options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  return readJson(paths.uploadState);
}

export async function readDenglemaNotificationState(options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  return readJson(paths.notificationState);
}

export function isDenglemaSnapshotDue(snapshot, now = new Date(), intervalMs = DENGLEMA_SNAPSHOT_INTERVAL_MS) {
  if (!snapshot?.observed_at || !snapshot?.date) return true;
  const observedAt = Date.parse(snapshot.observed_at);
  if (!Number.isFinite(observedAt)) return true;

  const nowDate = optionsDayKey(now, snapshot.timezone);
  if (snapshot.date !== nowDate) return true;
  return now.getTime() - observedAt >= intervalMs;
}

function optionsDayKey(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function snapshotUploadStatus(snapshot, uploadState) {
  if (!snapshot) return "missing";
  const snapshotVersion = snapshot.schema_version === 2 ? 2 : 1;
  const uploadedVersion = uploadState?.schema_version === 2 ? 2 : 1;
  if (
    uploadState?.date === snapshot.date
    && uploadedVersion >= snapshotVersion
    && Number(uploadState?.total_tokens) >= Number(snapshot.total_tokens)
  ) {
    return "uploaded";
  }
  return "pending";
}

export async function getLatestDenglemaSnapshot(options = {}, dependencies = {}) {
  const [snapshot, uploadState] = await Promise.all([
    readLatestDenglemaSnapshot(options, dependencies),
    readDenglemaUploadState(options, dependencies),
  ]);
  if (!snapshot) {
    return {
      exists: false,
      upload_status: "missing",
      snapshot: null,
      last_uploaded_at: uploadState?.uploaded_at || null,
      last_uploaded_total: uploadState?.total_tokens ?? null,
    };
  }
  return {
    exists: true,
    upload_status: snapshotUploadStatus(snapshot, uploadState),
    snapshot,
    last_uploaded_at: uploadState?.uploaded_at || null,
    last_uploaded_total: uploadState?.total_tokens ?? null,
    last_uploaded_schema_version: uploadState?.schema_version === 2 ? 2 : (uploadState ? 1 : null),
  };
}

export async function writeLatestDenglemaSnapshot(snapshot, options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  await writeJsonAtomic(paths.latest, snapshot);
  return snapshot;
}

export async function writeDenglemaUploadState(state, options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  await writeJsonAtomic(paths.uploadState, state);
  return state;
}

export async function writeDenglemaNotificationState(state, options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  await writeJsonAtomic(paths.notificationState, state);
  return state;
}

async function releaseLock(path) {
  await rm(path, { recursive: true, force: true }).catch(() => {});
}

export async function acquireDenglemaCollectLock(options = {}, dependencies = {}) {
  const paths = snapshotPaths(options, dependencies);
  await mkdir(paths.dataDir, { recursive: true });

  try {
    await mkdir(paths.collectLock);
    return { acquired: true, release: () => releaseLock(paths.collectLock) };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  try {
    const info = await stat(paths.collectLock);
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs > 5 * 60 * 1000) {
      await releaseLock(paths.collectLock);
      await mkdir(paths.collectLock);
      return { acquired: true, release: () => releaseLock(paths.collectLock) };
    }
  } catch {}

  return { acquired: false, release: async () => {} };
}

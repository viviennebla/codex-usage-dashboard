import { dirname, join } from "node:path";
import { hostname } from "node:os";

import { loadAllReports } from "./loader.js";
import { buildSnapshot } from "./snapshot.js";
import {
  DEFAULT_STATE_PATH,
  readStateFile,
  writeStateFile,
  readDeviceStates,
  writeDeviceState,
  removeDeviceState,
} from "./state.js";
import {
  addDirectory,
  readConfig,
  resolveSyncConnection,
} from "./config.js";
import { discoverSourceDiagnostics } from "./sources.js";
import {
  pullFromServer,
  readSyncState,
  recordSyncStatus,
  setDeviceSyncEnabled as setDeviceSyncEnabledState,
} from "./sync.js";
import { preserveLoggedRateLimits, readCodexStatusRateLimits } from "./status.js";
import { mergeWithDeviceStates } from "./headless.js";
import { dayKey } from "./time.js";

export const SNAPSHOT_REFRESH_POLICIES = Object.freeze({
  CACHED: "if-stale",
  FORCE: "force",
  STALE_WHILE_REVALIDATE: "stale-while-revalidate",
});

function pathsFor(options = {}) {
  const statePath = options.state || (options.stateDir
    ? join(options.stateDir, "latest.json")
    : DEFAULT_STATE_PATH);
  const stateDir = options.stateDir || dirname(statePath) || "state";
  return { statePath, stateDir };
}

function currentDayKey(date = new Date()) {
  return dayKey(date);
}

function statusEvent(onProgress, event) {
  if (typeof onProgress === "function") onProgress(event);
}

async function persistStatus(recordStatus, kind, status, details, stateDir) {
  try {
    return await recordStatus(kind, status, details, stateDir);
  } catch {
    return null;
  }
}

/**
 * Shared application boundary for local usage snapshots and device sync.
 * Adapters (Web, TUI, and one-shot CLI) choose a policy and render results;
 * they do not own loading, caching, merging, or network orchestration.
 */
export function createUsageService(defaultOptions = {}, dependencies = {}) {
  const loadReports = dependencies.loadAllReports || loadAllReports;
  const build = dependencies.buildSnapshot || buildSnapshot;
  const readState = dependencies.readStateFile || readStateFile;
  const writeState = dependencies.writeStateFile || writeStateFile;
  const readDevices = dependencies.readDeviceStates || readDeviceStates;
  const writeDevice = dependencies.writeDeviceState || writeDeviceState;
  const removeDevice = dependencies.removeDeviceState || removeDeviceState;
  const recordStatus = dependencies.recordSyncStatus || recordSyncStatus;
  const readSyncStateFn = dependencies.readSyncState || readSyncState;
  const setDeviceSyncEnabledFn = dependencies.setDeviceSyncEnabled || setDeviceSyncEnabledState;
  const mergeDevices = dependencies.mergeWithDeviceStates || mergeWithDeviceStates;
  const readConfigFn = dependencies.readConfig || readConfig;
  const pullFromServerFn = dependencies.pullFromServer || pullFromServer;
  const statusReader = dependencies.readCodexStatusRateLimits || readCodexStatusRateLimits;
  const preserveLimits = dependencies.preserveLoggedRateLimits || preserveLoggedRateLimits;
  const maxSnapshotAgeMs = dependencies.maxSnapshotAgeMs ?? 5 * 60_000;
  const cache = new Map();
  const refreshInFlight = new Map();
  const refreshControllers = new Map();
  const limitsInFlight = new Map();
  const fileCaches = new Set(defaultOptions.fileCache ? [defaultOptions.fileCache] : []);

  function optionsFor(options = {}) {
    const resolved = { ...defaultOptions, ...options };
    if (resolved.fileCache) fileCaches.add(resolved.fileCache);
    return resolved;
  }

  function snapshotIsStale(snapshot, loadedAt = null) {
    const generatedAt = Date.parse(snapshot?.generated_at || "");
    return snapshot?.today?.date !== currentDayKey()
      || !Number.isFinite(generatedAt)
      || Date.now() - (loadedAt || generatedAt) >= maxSnapshotAgeMs;
  }

  async function refreshSnapshot(options = {}, { onProgress } = {}) {
    const resolved = optionsFor(options);
    const { statePath } = pathsFor(resolved);
    const existing = refreshInFlight.get(statePath);
    if (existing) return existing;
    const controller = new AbortController();
    const operation = refreshSnapshotUnshared({
      ...resolved,
      signal: resolved.signal || controller.signal,
    }, onProgress);
    refreshInFlight.set(statePath, operation);
    refreshControllers.set(statePath, controller);
    try {
      return await operation;
    } finally {
      if (refreshInFlight.get(statePath) === operation) refreshInFlight.delete(statePath);
      if (refreshControllers.get(statePath) === controller) refreshControllers.delete(statePath);
    }
  }

  async function refreshSnapshotUnshared(resolved, onProgress) {
    const { statePath } = pathsFor(resolved);
    statusEvent(onProgress, { kind: "snapshot", status: "running", message: "Refreshing usage snapshot..." });
    try {
      const reports = await loadReports(resolved);
      const built = build(reports, resolved);
      const snapshot = {
        ...built,
        limit_source: built.limits ? "codex_jsonl" : "unavailable",
        limit_error: null,
      };
      await writeState(snapshot, statePath);
      const entry = { snapshot, loadedAt: Date.now() };
      cache.set(statePath, entry);
      statusEvent(onProgress, { kind: "snapshot", status: "success", message: "Usage snapshot refreshed.", snapshot });
      return snapshot;
    } catch (error) {
      statusEvent(onProgress, {
        kind: "snapshot",
        status: "failed",
        message: error?.message || String(error),
        error: error?.message || String(error),
      });
      throw error;
    }
  }

  async function getLocalSnapshot(options = {}, { policy = SNAPSHOT_REFRESH_POLICIES.CACHED, onProgress } = {}) {
    const resolved = optionsFor(options);
    const { statePath } = pathsFor(resolved);
    const entry = cache.get(statePath);
    let snapshot = entry?.snapshot || await readState(statePath);
    if (policy === SNAPSHOT_REFRESH_POLICIES.FORCE || !snapshot) {
      return refreshSnapshot(resolved, { onProgress });
    }
    const generatedAt = Date.parse(snapshot.generated_at || "");
    const loadedAt = entry?.loadedAt || generatedAt || Date.now();
    const stale = snapshotIsStale(snapshot, loadedAt);
    cache.set(statePath, { snapshot, loadedAt });
    if (policy === SNAPSHOT_REFRESH_POLICIES.STALE_WHILE_REVALIDATE && stale) {
      void refreshSnapshot(resolved, { onProgress }).catch(() => {});
      return snapshot;
    }
    if (policy === SNAPSHOT_REFRESH_POLICIES.CACHED && stale) {
      return refreshSnapshot(resolved, { onProgress });
    }
    return snapshot;
  }

  async function getSnapshot(options = {}, request = {}) {
    const resolved = optionsFor(options);
    const { stateDir } = pathsFor(resolved);
    const policy = request.policy || SNAPSHOT_REFRESH_POLICIES.CACHED;
    const local = await getLocalSnapshot(resolved, { ...request, policy });
    if (request.merge === false) return local;
    return mergeDevices(local, { stateDir });
  }

  async function refreshRateLimits(options = {}, { onProgress } = {}) {
    const resolved = optionsFor(options);
    const { statePath } = pathsFor(resolved);
    const existing = limitsInFlight.get(statePath);
    if (existing) return existing;
    const operation = (async () => {
      const pendingSnapshot = refreshInFlight.get(statePath);
      if (pendingSnapshot) await pendingSnapshot;
      const entry = cache.get(statePath);
      const snapshot = entry?.snapshot || await readState(statePath);
      if (!snapshot) return { ok: false, status: "failed", error: "No usage snapshot is available" };
      statusEvent(onProgress, { kind: "limits", status: "running", message: "Refreshing rate limits..." });
      try {
        const live = await statusReader({ timeoutMs: 5000 });
        const updated = {
          ...snapshot,
          limits: live.limits,
          limit_updated_at: live.limit_updated_at,
          limit_source: live.source,
          limit_error: null,
        };
        await writeState(updated, statePath);
        cache.set(statePath, { snapshot: updated, loadedAt: entry?.loadedAt || Date.now() });
        const result = { ok: true, status: "success", snapshot: updated };
        statusEvent(onProgress, { kind: "limits", ...result, message: "Rate limits refreshed." });
        return result;
      } catch (error) {
        const updated = preserveLimits(snapshot, error);
        await writeState(updated, statePath);
        cache.set(statePath, { snapshot: updated, loadedAt: entry?.loadedAt || Date.now() });
        const result = { ok: false, status: "failed", snapshot: updated, error: error?.message || String(error) };
        statusEvent(onProgress, { kind: "limits", ...result });
        return result;
      }
    })();
    limitsInFlight.set(statePath, operation);
    try {
      return await operation;
    } finally {
      if (limitsInFlight.get(statePath) === operation) limitsInFlight.delete(statePath);
    }
  }

  async function push(options = {}, { onProgress } = {}) {
    const resolved = optionsFor(options);
    const stateDir = pathsFor(resolved).stateDir;
    let server = null;
    try {
      const config = await readConfigFn();
      const connection = resolveSyncConnection(resolved, config, dependencies.env || process.env);
      if (!connection.server) {
        const result = { ok: false, status: "failed", error: "No sync server is configured" };
        await persistStatus(recordStatus, "push", result.status, { error: result.error }, stateDir);
        statusEvent(onProgress, { kind: "push", ...result });
        return result;
      }
      const deviceId = resolved.device || hostname();
      server = String(connection.server).replace(/\/+$/, "");
      const snapshot = await getLocalSnapshot(resolved, {
        policy: SNAPSHOT_REFRESH_POLICIES.FORCE,
        merge: false,
        onProgress,
      });
      statusEvent(onProgress, { kind: "push", status: "running", message: "Pushing local snapshot..." });
      await persistStatus(recordStatus, "push", "running", { server, message: "Pushing local snapshot..." }, stateDir);
      const headers = { "content-type": "application/json" };
      if (connection.token) headers.authorization = `Bearer ${connection.token}`;
      const response = await (dependencies.fetch || fetch)(`${server}/api/push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ device_id: deviceId, device_name: deviceId, snapshot }),
      });
      if (!response.ok) {
        const error = `HTTP ${response.status} — ${await response.text()}`;
        await persistStatus(recordStatus, "push", "failed", { server, error }, stateDir);
        const result = { ok: false, status: "failed", error, httpStatus: response.status };
        statusEvent(onProgress, { kind: "push", ...result });
        return result;
      }
      const payload = await response.json();
      await persistStatus(recordStatus, "push", "success", { server, message: `Pushed as ${payload.device_id}` }, stateDir);
      const result = { ...payload, ok: true, status: "success" };
      statusEvent(onProgress, { kind: "push", ...result, message: "Usage snapshot pushed." });
      return result;
    } catch (error) {
      const result = {
        ok: false,
        status: error?.code === "ERR_CLI_CANCELLED" ? "cancelled" : "failed",
        error: error?.message || String(error),
      };
      await persistStatus(recordStatus, "push", result.status, { server, error: result.error }, stateDir);
      statusEvent(onProgress, { kind: "push", ...result });
      return result;
    }
  }

  async function pull(options = {}, { onProgress } = {}) {
    const resolved = optionsFor(options);
    const stateDir = pathsFor(resolved).stateDir;
    let result;
    try {
      const config = await readConfigFn();
      const connection = resolveSyncConnection(resolved, config, dependencies.env || process.env);
      if (!connection.server) {
        const missing = { ok: false, status: "failed", synced: [], skipped: [], failed: [], message: "No sync server is configured" };
        await persistStatus(recordStatus, "pull", missing.status, { error: missing.message }, stateDir);
        statusEvent(onProgress, { kind: "pull", ...missing });
        return missing;
      }
      result = await pullFromServerFn(connection.server, {
        stateDir,
        onProgress: (event) => {
          if (!["success", "partial", "failed", "cancelled"].includes(event?.status)) {
            statusEvent(onProgress, event);
          }
        },
      });
    } catch (error) {
      const status = error?.code === "ERR_CLI_CANCELLED" ? "cancelled" : "failed";
      const failure = { ok: false, status, synced: [], skipped: [], failed: [], message: error?.message || String(error) };
      await persistStatus(recordStatus, "pull", status, { error: failure.message }, stateDir);
      statusEvent(onProgress, { kind: "pull", ...failure });
      return failure;
    }
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const status = result.status || (failed.length ? "partial" : result.ok === false ? "failed" : "success");
    result = { synced: [], skipped: [], failed: [], ...result, status, ok: status === "success" };
    statusEvent(onProgress, { kind: "pull", ...result });
    // Pulled device state invalidates only the merged view; local replica stays untouched.
    cache.delete(pathsFor(resolved).statePath);
    return result;
  }

  async function importSource(source, options = {}) {
    const path = source.normalized_path || source.path;
    if (!path) throw new Error("Source path is required");
    const result = await (dependencies.addDirectory || addDirectory)(
      path,
      source.type === "claude" ? "claude" : source.type === "skills" ? "skills" : "codex",
      source.display_name || source.detected_name || options.label || null,
    );
    return { ...result, source: { ...source, path } };
  }

  async function discoverSources(options = {}) {
    const config = await readConfigFn();
    const directories = Object.hasOwn(options, "directories") ? options.directories : config.directories;
    return (await (dependencies.discoverSourceDiagnostics || discoverSourceDiagnostics)(directories || []));
  }

  async function pullDevice(deviceId, serverUrl, options = {}) {
    if (!deviceId || !serverUrl) return { ok: false, status: "failed", error: "Missing server or device ID" };
    const resolved = optionsFor(options);
    const remoteUrl = String(serverUrl).replace(/\/+$/, "");
    const onProgress = options.onProgress;
    statusEvent(onProgress, { kind: "pull", status: "running", message: `Pulling device ${deviceId}...` });
    try {
      const response = await (dependencies.fetch || fetch)(`${remoteUrl}/api/snapshot/${encodeURIComponent(deviceId)}`);
      if (!response.ok) {
        const result = { ok: false, status: "failed", error: `Remote error: ${response.status}` };
        statusEvent(onProgress, { kind: "pull", ...result });
        return result;
      }
      const snapshot = await response.json();
      await writeDevice(deviceId, deviceId, snapshot, pathsFor(resolved).stateDir);
      cache.delete(pathsFor(resolved).statePath);
      const result = { ok: true, status: "success", device_id: deviceId };
      statusEvent(onProgress, { kind: "pull", ...result, message: `Pulled ${deviceId}.` });
      return result;
    } catch (error) {
      const result = { ok: false, status: "failed", error: `Failed to fetch device: ${error.message}` };
      statusEvent(onProgress, { kind: "pull", ...result });
      return result;
    }
  }

  async function readDeviceSnapshot(deviceId, options = {}) {
    const safeId = String(deviceId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
    return readState(join(pathsFor(optionsFor(options)).stateDir, `${safeId}.json`));
  }

  async function syncState(options = {}) {
    return readSyncStateFn(pathsFor(optionsFor(options)).stateDir);
  }

  async function setDeviceSyncEnabled(deviceId, enabled, details = {}, options = {}) {
    return setDeviceSyncEnabledFn(
      deviceId,
      enabled,
      details,
      pathsFor(optionsFor(options)).stateDir,
    );
  }

  function cacheStatus(options = {}) {
    const resolved = optionsFor(options);
    const { statePath } = pathsFor(resolved);
    const entry = cache.get(statePath);
    return {
      cached: Boolean(entry?.snapshot),
      stale: entry?.snapshot ? snapshotIsStale(entry.snapshot, entry.loadedAt) : null,
      refreshing: refreshInFlight.has(statePath),
      refreshingLimits: limitsInFlight.has(statePath),
      fileCache: resolved.fileCache?.stats?.() || null,
    };
  }

  function close() {
    for (const controller of refreshControllers.values()) controller.abort();
    refreshControllers.clear();
    cache.clear();
    for (const fileCache of fileCaches) fileCache.clear?.();
    fileCaches.clear();
  }

  return {
    paths: (options = {}) => pathsFor(optionsFor(options)),
    refreshSnapshot,
    refresh: refreshSnapshot,
    refreshUsage: refreshSnapshot,
    getLocalSnapshot,
    getSnapshot,
    getUsageSnapshot: getSnapshot,
    refreshRateLimits,
    push,
    pushSnapshot: push,
    pull,
    pullSnapshots: pull,
    importSource,
    importDetectedSource: importSource,
    discoverSources,
    pullDevice,
    syncState,
    setDeviceSyncEnabled,
    cacheStatus,
    close,
    readDeviceStates: (options = {}) => readDevices(pathsFor(optionsFor(options)).stateDir),
    readDeviceSnapshot,
    writeDeviceState: (id, name, snapshot, options = {}) => writeDevice(id, name, snapshot, pathsFor(optionsFor(options)).stateDir),
    removeDeviceState: (id, options = {}) => removeDevice(id, pathsFor(optionsFor(options)).stateDir),
  };
}

export const createApplicationService = createUsageService;

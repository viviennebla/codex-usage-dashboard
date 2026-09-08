import { hostname } from "node:os";

import { readConfig } from "./config.js";
import { mergeSnapshots } from "./merge.js";
import { readDeviceStates } from "./state.js";

export async function mergeWithDeviceStates(snapshot, options = {}) {
  const localName = options.localName || hostname();
  const remoteDevices = options.remoteDevices
    ? new Map(options.remoteDevices)
    : await readDeviceStates(options.stateDir || "state");
  remoteDevices.delete(localName);
  if (remoteDevices.size === 0) return snapshot;

  const allDevices = new Map(remoteDevices);
  allDevices.set(localName, { deviceName: localName, snapshot });
  const config = options.config || await readConfig();
  const merged = mergeSnapshots(allDevices, config);

  // Account/session state belongs to the active machine. Remote snapshots may
  // be stale or use another account, so only aggregate portable usage fields.
  merged.skills = snapshot.skills || [];
  merged.limits = snapshot.limits || null;
  merged.limit_updated_at = snapshot.limit_updated_at || null;
  merged.limit_source = snapshot.limit_source || null;
  merged.limit_error = snapshot.limit_error || null;
  merged.burn_rate = snapshot.burn_rate || null;
  merged.active_session = snapshot.active_session || null;
  merged.devices = Object.values(merged.source_devices || {});

  const mergedSourceStatus = {};
  for (const [, { snapshot: deviceSnapshot }] of allDevices) {
    const sourceStatus = deviceSnapshot?.source_status;
    if (!sourceStatus) continue;
    for (const [source, info] of Object.entries(sourceStatus)) {
      if (!mergedSourceStatus[source]) {
        mergedSourceStatus[source] = { ...info };
      } else {
        mergedSourceStatus[source].today_events += info.today_events || 0;
        mergedSourceStatus[source].today_tokens += info.today_tokens || 0;
        mergedSourceStatus[source].total_events += info.total_events || 0;
        if (info.last_activity && (!mergedSourceStatus[source].last_activity || info.last_activity > mergedSourceStatus[source].last_activity)) {
          mergedSourceStatus[source].last_activity = info.last_activity;
        }
      }
    }
  }

  const now = options.now || new Date();
  for (const source of Object.values(mergedSourceStatus)) {
    const hoursSince = source.last_activity
      ? Math.round((now - new Date(source.last_activity)) / 3600000 * 10) / 10
      : Infinity;
    source.hours_since_last = hoursSince === Infinity ? null : hoursSince;
    source.status = hoursSince <= 1 ? "active"
      : hoursSince <= 24 ? "recent"
      : hoursSince <= 48 ? "idle"
      : hoursSince <= 168 ? "stale"
      : "expired";
  }
  merged.source_status = mergedSourceStatus;
  return merged;
}

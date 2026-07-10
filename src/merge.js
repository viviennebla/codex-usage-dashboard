import { priceModelUsage, pricingTableUpdatedAt } from "./pricing.js";

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function blankAggregate() {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUSD: null,
    models: {},
    eventCount: 0,
    firstActivity: null,
    lastActivity: null,
  };
}

function addCost(target, value) {
  if (value === null || value === undefined || value === "") return;
  if (!Number.isFinite(Number(value))) return;
  target.costUSD = (target.costUSD || 0) + Number(value);
}

function repriceAggregate(row, config) {
  if (!row || !row.models || typeof row.models !== "object") {
    return row ? { ...row, costUSD: null } : row;
  }

  const models = {};
  let costUSD = 0;
  let priced = false;
  for (const [model, usage] of Object.entries(row.models)) {
    // Aggregated snapshots do not retain an agent per model. Only the explicit
    // Codex product labels may use the Codex fallback; an "unknown" model is
    // left unpriced instead of possibly billing Claude usage as GPT-5.5.
    const source = String(model).toLowerCase().startsWith("codex-") ? "codex" : "claude";
    const price = priceModelUsage(model, usage, config, source);
    models[model] = {
      ...usage,
      costUSD: price?.costUSD ?? null,
      costPricingModel: price?.costPricingModel,
      costPricingFallback: Boolean(price?.costPricingFallback),
    };
    if (price) {
      costUSD += price.costUSD;
      priced = true;
    }
  }

  return { ...row, models, costUSD: priced ? costUSD : null };
}

function repriceSnapshot(snapshot, config) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const repriceRows = (rows) => Array.isArray(rows)
    ? rows.map((row) => repriceAggregate(row, config))
    : rows;
  const trendViews = Array.isArray(snapshot.trend_views)
    ? snapshot.trend_views.map((view) => ({
      ...view,
      today: repriceAggregate(view.today, config),
      totals: repriceAggregate(view.totals, config),
      recent_days: repriceRows(view.recent_days),
    }))
    : snapshot.trend_views;

  return {
    ...snapshot,
    today: repriceAggregate(snapshot.today, config),
    totals: repriceAggregate(snapshot.totals, config),
    models: repriceAggregate({ models: snapshot.models }, config).models,
    recent_days: repriceRows(snapshot.recent_days),
    activity_days: repriceRows(snapshot.activity_days),
    top_sessions: repriceRows(snapshot.top_sessions),
    top_projects: repriceRows(snapshot.top_projects),
    active_session: repriceAggregate(snapshot.active_session, config),
    trend_views: trendViews,
  };
}

function sumModels(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [model, usage] of Object.entries(source)) {
    target[model] ||= {
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      eventCount: 0,
      costUSD: null,
      isFallback: false,
    };
    target[model].inputTokens += number(usage.inputTokens);
    target[model].cacheCreationTokens += number(usage.cacheCreationTokens);
    target[model].cacheReadTokens += number(usage.cacheReadTokens);
    target[model].outputTokens += number(usage.outputTokens);
    target[model].reasoningOutputTokens += number(usage.reasoningOutputTokens);
    target[model].totalTokens += number(usage.totalTokens);
    addCost(target[model], usage.costUSD);
    target[model].eventCount += number(usage.eventCount);
    target[model].isFallback = target[model].isFallback || Boolean(usage.isFallback);
    target[model].costPricingFallback = target[model].costPricingFallback || Boolean(usage.costPricingFallback);
    if (usage.costPricingModel) target[model].costPricingModel = usage.costPricingModel;
  }
}

function addToAggregate(target, row) {
  target.inputTokens += number(row.inputTokens);
  target.cacheCreationTokens += number(row.cacheCreationTokens);
  target.cacheReadTokens += number(row.cacheReadTokens);
  target.outputTokens += number(row.outputTokens);
  target.reasoningOutputTokens += number(row.reasoningOutputTokens);
  target.totalTokens += number(row.totalTokens);
  addCost(target, row.costUSD);
  target.eventCount += number(row.eventCount);
  if (row.models) sumModels(target.models, row.models);

  target.firstActivity = earliest(target.firstActivity, row.firstActivity);
  target.lastActivity = latest(target.lastActivity, row.lastActivity);
}

function earliest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function mergeDaily(deviceEntries, field) {
  const byDate = new Map();
  for (const [, { snapshot }] of deviceEntries) {
    const rows = snapshot?.[field];
    if (!rows || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const date = row.date;
      if (!date) continue;
      if (!byDate.has(date)) {
        byDate.set(date, { ...blankAggregate(), date });
      }
      addToAggregate(byDate.get(date), row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function mergeActivityDays(deviceEntries) {
  const byDate = new Map();
  for (const [, { snapshot }] of deviceEntries) {
    const rows = snapshot?.activity_days || snapshot?.recent_days;
    if (!rows || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const date = row.date;
      if (!date) continue;
      if (!byDate.has(date)) {
        byDate.set(date, { ...blankAggregate(), date });
      }
      addToAggregate(byDate.get(date), row);
    }
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function mergeTotals(deviceEntries) {
  const totals = blankAggregate();
  for (const [, { snapshot }] of deviceEntries) {
    if (snapshot?.totals) addToAggregate(totals, snapshot.totals);
  }
  return totals;
}

function mergeToday(deviceEntries) {
  const today = blankAggregate();
  for (const [, { snapshot }] of deviceEntries) {
    if (snapshot?.today) addToAggregate(today, snapshot.today);
  }
  return today;
}

function mergeModels(deviceEntries) {
  const models = {};
  for (const [, { snapshot }] of deviceEntries) {
    if (snapshot?.models) sumModels(models, snapshot.models);
  }
  return models;
}

function mergeTopItems(deviceEntries, field) {
  const items = [];
  for (const [deviceId, { deviceName, snapshot }] of deviceEntries) {
    const rows = snapshot?.[field];
    if (!rows || !Array.isArray(rows)) continue;
    for (const row of rows) {
      items.push({
        ...row,
        device_id: deviceId,
        device_name: deviceName || deviceId,
      });
    }
  }
  items.sort((a, b) => number(b.totalTokens) - number(a.totalTokens));
  return items.slice(0, 24);
}

function buildTrendViews(deviceEntries, mergedRecentDays, mergedToday, mergedTotals) {
  const views = [{
    id: "total",
    label: "total",
    display_name: "total",
    recent_days: mergedRecentDays,
    today: mergedToday,
    totals: mergedTotals,
  }];

  for (const [deviceId, { deviceName, snapshot }] of deviceEntries) {
    const labelPrefix = deviceName || deviceId;
    const subViews = Array.isArray(snapshot?.trend_views) ? snapshot.trend_views : [];
    const usableSubViews = subViews.filter((view) => view?.id && view.id !== "total");
    if (usableSubViews.length > 0) {
      for (const view of usableSubViews) {
        const label = view.display_name || view.label || labelPrefix;
        views.push({
          ...view,
          id: `${deviceId}:${view.id}`,
          device_id: deviceId,
          device_name: labelPrefix,
          label,
          display_name: label,
        });
      }
      continue;
    }

    views.push({
      id: `${deviceId}:total`,
      device_id: deviceId,
      device_name: labelPrefix,
      label: labelPrefix,
      display_name: labelPrefix,
      recent_days: snapshot?.recent_days || [],
      today: snapshot?.today || null,
      totals: snapshot?.totals || null,
    });
  }

  return views;
}

function buildDeviceSummary(deviceId, deviceName, snapshot) {
  return {
    device_id: deviceId,
    device_name: deviceName || deviceId,
    generated_at: snapshot?.generated_at || null,
    today_tokens: number(snapshot?.today?.totalTokens),
    total_tokens: number(snapshot?.totals?.totalTokens),
    session_count: snapshot?.top_sessions?.length || 0,
    active_session: snapshot?.active_session || null,
    limits: snapshot?.limits || null,
    burn_rate: snapshot?.burn_rate || null,
    status: snapshot?.status || null,
  };
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function buildOverallStatus(deviceEntries) {
  const statuses = [...deviceEntries]
    .map(([, { snapshot }]) => snapshot?.status?.code)
    .filter((c) => c !== undefined && c !== null);

  if (statuses.length === 0) return { label: "no_data", code: 30 };
  const worst = Math.max(...statuses);
  const labelMap = { 0: "ok", 1: "near_limit", 2: "limit_hit", 20: "no_today_data", 30: "no_data" };
  return { label: labelMap[worst] || "unknown", code: worst };
}

/**
 * Merge snapshots from multiple devices into a unified view.
 *
 * @param {Map<string, {deviceName: string, snapshot: object}>} deviceEntries
 *        Map of deviceId → { deviceName, snapshot }
 * @returns {object} Merged snapshot with per-device drill-down
 */
export function mergeSnapshots(deviceEntries, config = {}) {
  if (deviceEntries.size === 0) {
    return {
      schema_version: "0.3",
      generated_at: new Date().toISOString(),
      device_count: 0,
      source_devices: {},
      today: null,
      totals: null,
      models: {},
      recent_days: [],
      top_sessions: [],
      top_projects: [],
      per_device: {},
      status: { label: "no_data", code: 30 },
    };
  }

  const repricedEntries = new Map(
    [...deviceEntries].map(([deviceId, entry]) => [
      deviceId,
      { ...entry, snapshot: repriceSnapshot(entry.snapshot, config) },
    ]),
  );
  const sourceDevices = {};
  const perDevice = {};

  for (const [deviceId, { deviceName, snapshot }] of repricedEntries) {
    sourceDevices[deviceId] = buildDeviceSummary(deviceId, deviceName, snapshot);
    perDevice[deviceId] = {
      active_session: snapshot?.active_session || null,
      limits: snapshot?.limits || null,
      burn_rate: snapshot?.burn_rate || null,
      today: snapshot?.today || null,
      totals: snapshot?.totals || null,
      models: snapshot?.models || {},
      top_sessions: snapshot?.top_sessions || [],
      top_projects: snapshot?.top_projects || [],
      recent_days: snapshot?.recent_days || [],
      activity_days: snapshot?.activity_days || snapshot?.recent_days || [],
    };
  }

  const mergedToday = mergeToday(repricedEntries);
  const mergedTotals = mergeTotals(repricedEntries);
  const mergedRecentDays = mergeDaily(repricedEntries, "recent_days");
  const mergedActivityDays = mergeActivityDays(repricedEntries);

  const merged = {
    schema_version: "0.3",
    generated_at: new Date().toISOString(),
    device_count: repricedEntries.size,
    source_devices: sourceDevices,
    today: mergedToday,
    totals: mergedTotals,
    models: mergeModels(repricedEntries),
    recent_days: mergedRecentDays,
    activity_days: mergedActivityDays.length > 0 ? mergedActivityDays : mergedRecentDays,
    trend_views: buildTrendViews(repricedEntries, mergedRecentDays, mergedToday, mergedTotals),
    top_sessions: mergeTopItems(repricedEntries, "top_sessions"),
    top_projects: mergeTopItems(repricedEntries, "top_projects"),
    per_device: perDevice,
    forecast: null, // multi-device forecast is device-specific
    burn_rate: null, // multi-device: see per_device
    limits: null, // multi-device: see per_device
    active_session: null, // multi-device: see per_device
    filters: { since: null, until: null, timezone: null },
    confidence: "merged_from_devices",
    cost: {
      available: mergedTotals.costUSD !== null,
      confidence: "current_price_table",
      pricing: { updated_at: pricingTableUpdatedAt(config) },
    },
    diagnostics: {
      device_count: repricedEntries.size,
    },
    status: buildOverallStatus(repricedEntries),
  };

  return merged;
}

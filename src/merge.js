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
    return row ? { ...row, costUSD: row.costUSD ?? null } : row;
  }

  const models = {};
  let costUSD = 0;
  let priced = false;
  for (const [model, usage] of Object.entries(row.models)) {
    // Aggregated snapshots do not retain an agent per model. Only the explicit
    // Codex product labels may use the Codex fallback; an "unknown" model is
    // left unpriced instead of possibly billing Claude usage as GPT-5.5.
    const normalizedModel = String(model).toLowerCase();
    const source = normalizedModel.startsWith("codex-") || normalizedModel.startsWith("gpt-5.6")
      ? "codex"
      : "claude";
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
      costUSD: null,
      isFallback: false,
      eventCountIncomplete: false,
    };
    target[model].inputTokens += number(usage.inputTokens);
    target[model].cacheCreationTokens += number(usage.cacheCreationTokens);
    target[model].cacheReadTokens += number(usage.cacheReadTokens);
    target[model].outputTokens += number(usage.outputTokens);
    target[model].reasoningOutputTokens += number(usage.reasoningOutputTokens);
    target[model].totalTokens += number(usage.totalTokens);
    addCost(target[model], usage.costUSD);
    if (typeof usage.eventCount === "number" && Number.isFinite(usage.eventCount)) {
      target[model].eventCount = (target[model].eventCount || 0) + usage.eventCount;
    } else {
      target[model].eventCountIncomplete = true;
    }
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

function mergeRowsByDate(existingRows = [], incomingRows = []) {
  const byDate = new Map();
  for (const row of [...existingRows, ...incomingRows]) {
    if (!row?.date) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, { ...blankAggregate(), date: row.date });
    addToAggregate(byDate.get(row.date), row);
  }
  return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function viewKey(view, fallback) {
  return String(view?.environment || view?.display_name || view?.label || view?.id || fallback || "unknown");
}

function mergeTrendView(target, view) {
  target.recent_days = mergeRowsByDate(target.recent_days, view.recent_days || []);
  if (view.today) addToAggregate(target.today, view.today);
  if (view.totals) addToAggregate(target.totals, view.totals);
  target.firstActivity = earliest(target.firstActivity, view.totals?.firstActivity || view.today?.firstActivity);
  target.lastActivity = latest(target.lastActivity, view.totals?.lastActivity || view.today?.lastActivity);
}

function mergeTotals(deviceEntries) {
  const totals = blankAggregate();
  for (const [, { snapshot }] of deviceEntries) {
    if (snapshot?.totals) addToAggregate(totals, snapshot.totals);
  }
  return totals;
}

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function mergeToday(deviceEntries) {
  const today = blankAggregate();
  const date = localDateKey();
  for (const [, { snapshot }] of deviceEntries) {
    const row = snapshot?.today;
    // A device's persisted "today" can be from a previous calendar day.
    // Older snapshots without a date remain compatible, but dated snapshots
    // must match the dashboard's current local date before they are merged.
    if (row && (!row.date || row.date === date)) addToAggregate(today, row);
  }
  return { ...today, date };
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
  const date = localDateKey();
  const currentToday = (row) => {
    if (!row) return null;
    return !row.date || row.date === date ? row : null;
  };
  const views = [{
    id: "total",
    label: "total",
    display_name: "total",
    recent_days: mergedRecentDays,
    today: mergedToday,
    totals: mergedTotals,
  }];
  const environmentViews = new Map();

  for (const [deviceId, { deviceName, snapshot }] of deviceEntries) {
    const labelPrefix = deviceName || deviceId;
    const subViews = Array.isArray(snapshot?.trend_views) ? snapshot.trend_views : [];
    const usableSubViews = subViews.filter((view) => view?.id && view.id !== "total");
    if (usableSubViews.length > 0) {
      for (const view of usableSubViews) {
        const key = viewKey(view, labelPrefix);
        const label = view.display_name || view.label || key;
        if (!environmentViews.has(key)) {
          environmentViews.set(key, {
            id: key,
            label,
            display_name: label,
            detected_name: view.detected_name,
            environment: view.environment,
            environment_kind: view.environment_kind,
            device_ids: [],
            device_names: [],
            recent_days: [],
            today: blankAggregate(),
            totals: blankAggregate(),
          });
        }
        const target = environmentViews.get(key);
        if (!target.device_ids.includes(deviceId)) target.device_ids.push(deviceId);
        if (!target.device_names.includes(labelPrefix)) target.device_names.push(labelPrefix);
        mergeTrendView(target, { ...view, today: currentToday(view.today) });
      }
      continue;
    }

    const key = labelPrefix;
    if (!environmentViews.has(key)) {
      environmentViews.set(key, {
        id: key,
        device_ids: [],
        device_names: [],
        label: labelPrefix,
        display_name: labelPrefix,
        recent_days: [],
        today: blankAggregate(),
        totals: blankAggregate(),
      });
    }
    const target = environmentViews.get(key);
    if (!target.device_ids.includes(deviceId)) target.device_ids.push(deviceId);
    if (!target.device_names.includes(labelPrefix)) target.device_names.push(labelPrefix);
    mergeTrendView(target, {
      recent_days: snapshot?.recent_days || [],
      today: currentToday(snapshot?.today),
      totals: snapshot?.totals || null,
    });
  }

  views.push(...[...environmentViews.values()].map((view) => ({
    ...view,
    device_name: view.device_names?.length === 1 ? view.device_names[0] : null,
  })));
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

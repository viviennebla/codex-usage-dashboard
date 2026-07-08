const SNAPSHOT_SCHEMA_VERSION = "0.2";

function todayKey(now = new Date()) {
  // Use local timezone so "today" matches the daily row grouping
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dayKey(timestamp, timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function blankAggregate(extra = {}) {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUSD: null,
    models: {},
    eventCount: 0,
    firstActivity: null,
    lastActivity: null,
    ...extra,
  };
}

function addEventToAggregate(target, event) {
  target.inputTokens += number(event.inputTokens);
  target.cacheReadTokens += number(event.cacheReadTokens);
  target.outputTokens += number(event.outputTokens);
  target.reasoningOutputTokens += number(event.reasoningOutputTokens);
  target.totalTokens += number(event.totalTokens);
  target.eventCount += 1;
  target.firstActivity =
    !target.firstActivity || Date.parse(event.timestamp) < Date.parse(target.firstActivity)
      ? event.timestamp
      : target.firstActivity;
  target.lastActivity =
    !target.lastActivity || Date.parse(event.timestamp) > Date.parse(target.lastActivity)
      ? event.timestamp
      : target.lastActivity;
}

function tokenTotal(row) {
  return number(row.totalTokens);
}

function isoMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function sortByLastActivityDesc(rows) {
  return [...rows].sort((a, b) => {
    return (isoMs(b.lastActivity) ?? 0) - (isoMs(a.lastActivity) ?? 0);
  });
}

function sumModelBreakdown(rows) {
  const models = new Map();
  for (const row of rows) {
    for (const [model, usage] of Object.entries(row.models || {})) {
      const current = models.get(model) || {
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        eventCount: 0,
        costUSD: null,
        isFallback: false,
      };
      current.inputTokens += number(usage.inputTokens);
      current.cacheReadTokens += number(usage.cacheReadTokens);
      current.outputTokens += number(usage.outputTokens);
      current.reasoningOutputTokens += number(usage.reasoningOutputTokens);
      current.totalTokens += number(usage.totalTokens);
      current.isFallback = current.isFallback || Boolean(usage.isFallback);
      models.set(model, current);
    }
  }
  return Object.fromEntries(models);
}

/**
 * Count events per model from raw events.
 * Returns { modelName: count, ... }
 */
function countEventsByModel(events) {
  const counts = {};
  for (const event of events) {
    const model = event.model || "unknown";
    counts[model] = (counts[model] || 0) + 1;
  }
  return counts;
}

/**
 * Merge per-model event counts into a models object built by sumModelBreakdown.
 */
function mergeEventCounts(models, eventCounts) {
  for (const [model, count] of Object.entries(eventCounts)) {
    if (models[model]) {
      models[model].eventCount = count;
    }
  }
  return models;
}

function addDerived(row) {
  const total = tokenTotal(row);
  const cacheRead = number(row.cacheReadTokens);
  return {
    ...row,
    cacheReadRatio: total > 0 ? cacheRead / total : 0,
    outputRatio: total > 0 ? number(row.outputTokens) / total : 0,
    reasoningRatio: total > 0 ? number(row.reasoningOutputTokens) / total : 0,
  };
}

function latestEventWithRateLimits(events) {
  return [...(events || [])]
    .filter((event) => event.rateLimits)
    .sort((a, b) => (isoMs(b.timestamp) ?? 0) - (isoMs(a.timestamp) ?? 0))[0] || null;
}

function limitStatus(limits) {
  const primary = number(limits?.primary?.used_percent);
  const secondary = number(limits?.secondary?.used_percent);
  const used = Math.max(primary, secondary);
  if (!limits) return { label: "no_limit_data", code: 30 };
  if (used >= 100) return { label: "limit_hit", code: 2 };
  if (used >= 90) return { label: "near_limit", code: 1 };
  return { label: "ok", code: 0 };
}

function tokensSince(events, sessionId, generatedAt, minutes) {
  const threshold = generatedAt.getTime() - minutes * 60 * 1000;
  return (events || [])
    .filter((event) => event.sessionId === sessionId)
    .filter((event) => (isoMs(event.timestamp) ?? 0) >= threshold)
    .reduce((sum, event) => sum + tokenTotal(event), 0);
}

function buildBurnRate(events, activeSession, generatedAt) {
  if (!activeSession) {
    return {
      basis: "latest_session",
      tokens_15m: 0,
      tokens_60m: 0,
      tokens_per_minute_15m: 0,
      tokens_per_minute_60m: 0,
    };
  }
  const tokens15 = tokensSince(events, activeSession.sessionId, generatedAt, 15);
  const tokens60 = tokensSince(events, activeSession.sessionId, generatedAt, 60);
  return {
    basis: "latest_session",
    tokens_15m: tokens15,
    tokens_60m: tokens60,
    tokens_per_minute_15m: Math.round(tokens15 / 15),
    tokens_per_minute_60m: Math.round(tokens60 / 60),
  };
}

function enrichActiveSession(session, generatedAt, burnRate) {
  if (!session) return null;
  const last = isoMs(session.lastActivity);
  const idleMinutes = last ? Math.round((generatedAt.getTime() - last) / 60000) : null;
  return {
    ...session,
    idle_minutes: idleMinutes,
    is_active: idleMinutes !== null && idleMinutes <= 30,
    burn_rate: burnRate,
  };
}

function buildForecast(recentDays) {
  const usable = recentDays.filter((row) => tokenTotal(row) > 0).slice(-5);
  if (usable.length < 2) {
    return {
      basis: "recent_daily_average",
      averageDailyTokens: null,
      projectedMonthlyTokens: null,
      confidence: "unknown",
    };
  }

  const averageDailyTokens = Math.round(
    usable.reduce((sum, row) => sum + tokenTotal(row), 0) / usable.length,
  );
  return {
    basis: "recent_daily_average",
    averageDailyTokens,
    projectedMonthlyTokens: averageDailyTokens * 30,
    confidence: "local_estimate",
  };
}

function buildTrendRows(events, options = {}) {
  const byDate = new Map();
  for (const event of events) {
    if (!event.timestamp) continue;
    const date = dayKey(event.timestamp, options.timezone);
    if (!byDate.has(date)) byDate.set(date, blankAggregate({ date }));
    addEventToAggregate(byDate.get(date), event);
  }
  return [...byDate.values()]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(addDerived);
}

function buildTrendViews(events, totalRows, today, totals, options = {}) {
  const views = [{
    id: "total",
    label: "total",
    display_name: "total",
    recent_days: totalRows,
    today,
    totals,
  }];

  const groups = new Map();
  for (const event of events || []) {
    const id = event.environmentLabel || event.environment || event.environmentId || "unknown";
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        label: event.environmentLabel || event.environment || event.detectedName || "unknown",
        detected_name: event.detectedName || event.environment || "unknown",
        environment: event.environment || "unknown",
        environment_kind: event.environmentKind || "unknown",
        events: [],
      });
    }
    groups.get(id).events.push(event);
  }

  const todayDate = todayKey();
  for (const group of groups.values()) {
    const rows = buildTrendRows(group.events, options);
    const groupToday = rows.find((row) => row.date === todayDate) || null;
    const groupTotals = blankAggregate();
    for (const event of group.events) addEventToAggregate(groupTotals, event);
    views.push({
      id: group.id,
      label: group.label,
      display_name: group.label,
      detected_name: group.detected_name,
      environment: group.environment,
      environment_kind: group.environment_kind,
      recent_days: rows.slice(-35),
      today: groupToday,
      totals: addDerived(groupTotals),
    });
  }

  return views;
}

export function buildSnapshot(reports, options = {}) {
  const generatedAt = new Date();
  const dailyRows = (reports.daily.daily || []).map(addDerived);
  const sessionRows = sortByLastActivityDesc(
    (reports.sessions.sessions || []).map(addDerived),
  );
  const projectRows = (reports.projects?.projects || []).map(addDerived);
  const today = dailyRows.find((row) => row.date === todayKey(generatedAt));
  const recentDays = dailyRows.slice(-35); // compact trend window
  const activityDays = dailyRows.slice(-93); // roughly three months for heatmap
  const trendViews = buildTrendViews(
    reports.events || [],
    recentDays,
    today || null,
    reports.daily.totals || reports.sessions.totals || null,
    options,
  );

  // Per-source activity status (detect expired/inactive agents)
  const todayStr = todayKey(generatedAt);
  const sourceStatus = {};
  for (const evt of reports.events) {
    // Normalise source: Codex events come from "sessions"/"archived_sessions"/"codex-jsonl"
    const raw = evt.source || "unknown";
    const src = raw === "claude" ? "claude" : "codex";
    sourceStatus[src] ||= {
      total_events: 0,
      today_events: 0,
      today_tokens: 0,
      last_activity: null,
    };
    const s = sourceStatus[src];
    s.total_events++;
    if (evt.timestamp) {
      const evtDate = evt.timestamp.slice(0, 10);
      if (evtDate === todayStr) {
        s.today_events++;
        s.today_tokens += evt.totalTokens || 0;
      }
      if (!s.last_activity || evt.timestamp > s.last_activity) {
        s.last_activity = evt.timestamp;
      }
    }
  }
  for (const [src, s] of Object.entries(sourceStatus)) {
    // Hour-precise status:
    //   active  — within 1 hour
    //   recent  — within 24 hours
    //   idle    — within 48 hours
    //   stale   — within 7 days
    //   expired — over 7 days
    const hoursSince = s.last_activity
      ? Math.round((generatedAt - new Date(s.last_activity)) / 3600000 * 10) / 10
      : Infinity;
    s.hours_since_last = hoursSince === Infinity ? null : hoursSince;
    s.status = hoursSince <= 1 ? "active"
      : hoursSince <= 24 ? "recent"
      : hoursSince <= 48 ? "idle"
      : hoursSince <= 168 ? "stale"
      : "expired";
    s.last_activity = s.last_activity || null;
  }
  // Ensure both codex and claude keys exist
  sourceStatus.codex ||= { total_events: 0, today_events: 0, today_tokens: 0, last_activity: null, status: "unknown" };
  sourceStatus.claude ||= { total_events: 0, today_events: 0, today_tokens: 0, last_activity: null, status: "unknown" };

  const latestRateLimitEvent = latestEventWithRateLimits(reports.events);
  const limits = latestRateLimitEvent?.rateLimits || null;
  const limitUpdatedAt = latestRateLimitEvent?.timestamp || null;
  const burnRate = buildBurnRate(reports.events, sessionRows[0] || null, generatedAt);
  const activeSession = enrichActiveSession(sessionRows[0] || null, generatedAt, burnRate);
  const topSessions = [...sessionRows]
    .sort((a, b) => tokenTotal(b) - tokenTotal(a))
    .slice(0, 12);
  const topProjects = [...projectRows].slice(0, 12);
  const status = today ? limitStatus(limits) : { label: "no_today_data", code: 20 };

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    generated_at: generatedAt.toISOString(),
    tool: {
      name: "codex-usage-dashboard",
      version: "0.1.0",
    },
    upstream: reports.tool,
    source: {
      kind: "codex_jsonl_native",
      data_paths: reports.tool?.dataRoots || [],
    },
    confidence: "local_log_parse",
    cost: {
      available: false,
      confidence: "not_priced",
      note: "Native Codex logs contain token counts and rate limits, but no local price table is applied yet.",
    },
    filters: {
      since: options.since || null,
      until: options.until || null,
      timezone: options.timezone || null,
    },
    today: today || null,
    source_status: sourceStatus,
    active_session: activeSession,
    limits,
    limit_updated_at: limitUpdatedAt,
    burn_rate: burnRate,
    recent_days: recentDays,
    activity_days: activityDays,
    trend_views: trendViews,
    top_sessions: topSessions,
    top_projects: topProjects,
    totals: reports.daily.totals || reports.sessions.totals || null,
    models: mergeEventCounts(
      sumModelBreakdown(sessionRows),
      countEventsByModel(reports.events),
    ),
    skills: reports.skills || [],
    forecast: buildForecast(recentDays),
    diagnostics: {
      files_read: reports.tool?.filesRead || 0,
      session_index_entries: reports.tool?.sessionIndexEntries || 0,
      thread_state_entries: reports.tool?.threadStateEntries || 0,
      events_read: reports.events?.length || 0,
      latest_rate_limit_at: latestRateLimitEvent?.timestamp || null,
    },
    status,
  };
}

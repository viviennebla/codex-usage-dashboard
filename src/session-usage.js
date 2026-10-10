const MAX_WINDOWS = 200;
const TOKEN_FIELDS = [
  "inputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

export function normalizeSessionUsageWindows(value) {
  if (!Array.isArray(value)) throw new Error("windows must be an array");
  if (value.length > MAX_WINDOWS) throw new Error(`windows cannot exceed ${MAX_WINDOWS} items`);
  return value.map((item, index) => normalizeWindow(item, index));
}

export function summarizeSessionUsageWindows(events = [], windows = []) {
  const bySession = new Map();
  for (const event of events) {
    if (!event || typeof event.sessionId !== "string" || !event.sessionId) continue;
    const timestamp = Date.parse(event.timestamp || "");
    if (!Number.isFinite(timestamp)) continue;
    const rows = bySession.get(event.sessionId) || [];
    rows.push({ event, timestamp });
    bySession.set(event.sessionId, rows);
  }

  return windows.map(window => {
    const since = Date.parse(window.since);
    const until = Date.parse(window.until);
    const matched = (bySession.get(window.sessionId) || [])
      .filter(item => item.timestamp >= since && item.timestamp <= until)
      .map(item => item.event);

    return {
      key: window.key,
      sessionId: window.sessionId,
      since: window.since,
      until: window.until,
      status: matched.length ? "matched" : "no_events",
      usage: matched.length ? aggregate(matched) : null,
    };
  });
}

function normalizeWindow(value, index) {
  if (!record(value)) throw new Error(`windows[${index}] must be an object`);
  const key = boundedText(value.key, `windows[${index}].key`, 160);
  const sessionId = boundedText(value.sessionId, `windows[${index}].sessionId`, 200);
  const since = instant(value.since, `windows[${index}].since`);
  const until = instant(value.until, `windows[${index}].until`);
  if (Date.parse(until) < Date.parse(since)) throw new Error(`windows[${index}].until must not be before since`);
  return { key, sessionId, since, until };
}

function aggregate(events) {
  const result = {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    costUSD: null,
    firstActivity: null,
    lastActivity: null,
  };
  for (const event of events) {
    for (const field of TOKEN_FIELDS) result[field] += numeric(event[field]);
    if (Number.isFinite(Number(event.costUSD))) result.costUSD = (result.costUSD || 0) + Number(event.costUSD);
    result.eventCount += 1;
    if (!result.firstActivity || Date.parse(event.timestamp) < Date.parse(result.firstActivity)) result.firstActivity = event.timestamp;
    if (!result.lastActivity || Date.parse(event.timestamp) > Date.parse(result.lastActivity)) result.lastActivity = event.timestamp;
  }
  return result;
}

function instant(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function boundedText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

function numeric(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

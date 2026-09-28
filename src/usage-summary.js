import { loadCodexReports } from "./ccusage.js";
import { resolveCodexHomes } from "./sources.js";
import { dayKey, startOfDayInstant } from "./time.js";

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function summarizeCodexDay(events = [], date, timezone) {
  let totalTokens = 0;
  for (const event of events) {
    if (!event?.timestamp) continue;
    if (event.source === "claude") continue;
    if (dayKey(event.timestamp, timezone) !== date) continue;
    totalTokens += number(event.totalTokens);
  }
  return { date, totalTokens: Math.round(totalTokens) };
}

export async function collectCodexDailyUsage(options = {}, dependencies = {}) {
  const resolveHomes = dependencies.resolveCodexHomes || resolveCodexHomes;
  const loadReports = dependencies.loadCodexReports || loadCodexReports;
  const now = dependencies.now?.() || new Date();
  const timezone = options.timezone;
  const date = dayKey(now, timezone);
  const since = startOfDayInstant(date, timezone);

  // One Denglema installation owns exactly one native Codex environment.
  // Do not reuse dashboard-registered directories or auto-discover WSL homes,
  // otherwise Windows + WSL installations could upload the same logs twice.
  const codexHomes = await resolveHomes([], {
    ...options,
    includeDefaults: true,
    noWsl: true,
  });

  const reports = await loadReports({
    ...options,
    codexHomes,
    rawOnly: true,
    usageOnly: true,
    since,
    activitySince: since,
  });
  return summarizeCodexDay(reports.events || [], date, timezone);
}

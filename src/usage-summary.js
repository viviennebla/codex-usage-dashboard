import { loadCodexReports } from "./ccusage.js";
import { resolveCodexHomes } from "./sources.js";
import { dayKey, startOfDayInstant } from "./time.js";

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function cleanDimensionName(value, fallback = null) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text.length > 96 ? text.slice(0, 96) : text;
}

function addDimension(target, name, tokens) {
  if (!name || tokens <= 0) return;
  target.set(name, (target.get(name) || 0) + tokens);
}

function dimensionRows(values) {
  return [...values.entries()]
    .map(([name, totalTokens]) => ({ name, totalTokens: Math.round(totalTokens) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
}

export function summarizeCodexDay(events = [], date, timezone) {
  let totalTokens = 0;
  const models = new Map();
  const projects = new Map();

  for (const event of events) {
    if (!event?.timestamp) continue;
    if (event.source === "claude") continue;
    if (dayKey(event.timestamp, timezone) !== date) continue;

    const tokens = number(event.totalTokens);
    totalTokens += tokens;

    addDimension(
      models,
      cleanDimensionName(event.model, "unknown"),
      tokens,
    );

    // Only upload real workspace basenames. Projectless Codex threads can use
    // thread titles as display names, which must not leave the local machine.
    if (event.projectKind === "workspace") {
      addDimension(
        projects,
        cleanDimensionName(event.projectName),
        tokens,
      );
    }
  }

  return {
    date,
    totalTokens: Math.round(totalTokens),
    models: dimensionRows(models),
    projects: dimensionRows(projects),
  };
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

  const aggregateStarted = Date.now();
  const summary = summarizeCodexDay(reports.events || [], date, timezone);
  const aggregateMs = Date.now() - aggregateStarted;

  return {
    ...summary,
    timingsMs: {
      scanCandidates: Number(reports.timingsMs?.scanCandidates || 0),
      parseActiveSessions: Number(reports.timingsMs?.parseActiveSessions || 0),
      aggregateModelsProjects: aggregateMs,
    },
  };
}

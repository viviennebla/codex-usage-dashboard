import { loadCodexReports } from "./ccusage.js";
import { loadClaudeReports } from "./claude.js";
import { readConfig } from "./config.js";

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

function addToAggregate(target, event) {
  target.inputTokens += event.inputTokens || 0;
  target.cacheReadTokens += event.cacheReadTokens || 0;
  target.outputTokens += event.outputTokens || 0;
  target.reasoningOutputTokens += event.reasoningOutputTokens || 0;
  target.totalTokens += event.totalTokens || 0;
  target.eventCount += 1;
  target.firstActivity =
    !target.firstActivity || Date.parse(event.timestamp) < Date.parse(target.firstActivity)
      ? event.timestamp
      : target.firstActivity;
  target.lastActivity =
    !target.lastActivity || Date.parse(event.timestamp) > Date.parse(target.lastActivity)
      ? event.timestamp
      : target.lastActivity;

  const model = event.model || "unknown";
  target.models[model] ||= {
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUSD: null,
    isFallback: false,
  };
  const m = target.models[model];
  m.inputTokens += event.inputTokens || 0;
  m.cacheReadTokens += event.cacheReadTokens || 0;
  m.outputTokens += event.outputTokens || 0;
  m.reasoningOutputTokens += event.reasoningOutputTokens || 0;
  m.totalTokens += event.totalTokens || 0;
  m.isFallback = m.isFallback || !event.model || event.model === "unknown";
}

function buildRows(events, keyOf, extraOf) {
  const groups = new Map();
  for (const event of events) {
    const key = keyOf(event);
    if (!groups.has(key)) {
      groups.set(key, blankAggregate(extraOf(event, key)));
    }
    addToAggregate(groups.get(key), event);
  }
  return [...groups.values()];
}

function sortByDate(rows) {
  return [...rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function sortByTokens(rows) {
  return [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildTotals(events) {
  const totals = blankAggregate();
  for (const event of events) addToAggregate(totals, event);
  return totals;
}

/**
 * Merge a pre-aggregated row (e.g., a daily summary from one source) into a
 * combined aggregate.  Unlike addToAggregate this sums eventCount from the
 * source row instead of incrementing by 1.
 */
function mergeAggregateRow(target, row) {
  target.inputTokens += row.inputTokens || 0;
  target.cacheReadTokens += row.cacheReadTokens || 0;
  target.outputTokens += row.outputTokens || 0;
  target.reasoningOutputTokens += row.reasoningOutputTokens || 0;
  target.totalTokens += row.totalTokens || 0;
  target.eventCount += row.eventCount || 0;
  target.firstActivity =
    !target.firstActivity || Date.parse(row.firstActivity) < Date.parse(target.firstActivity)
      ? row.firstActivity
      : target.firstActivity;
  target.lastActivity =
    !target.lastActivity || Date.parse(row.lastActivity) > Date.parse(target.lastActivity)
      ? row.lastActivity
      : target.lastActivity;

  if (row.models) {
    for (const [model, usage] of Object.entries(row.models)) {
      target.models[model] ||= {
        inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
        reasoningOutputTokens: 0, totalTokens: 0, costUSD: null, isFallback: false,
      };
      const m = target.models[model];
      m.inputTokens += usage.inputTokens || 0;
      m.cacheReadTokens += usage.cacheReadTokens || 0;
      m.outputTokens += usage.outputTokens || 0;
      m.reasoningOutputTokens += usage.reasoningOutputTokens || 0;
      m.totalTokens += usage.totalTokens || 0;
      m.isFallback = m.isFallback || usage.isFallback;
    }
  }
}

/**
 * Merge daily rows from multiple sources by date.
 */
function mergeDaily(sources) {
  const byDate = new Map();
  for (const source of sources) {
    for (const row of source.daily?.daily || []) {
      if (!row.date) continue;
      if (!byDate.has(row.date)) {
        byDate.set(row.date, blankAggregate({ date: row.date }));
      }
      mergeAggregateRow(byDate.get(row.date), row);
    }
  }
  return sortByDate([...byDate.values()]);
}

/**
 * Merge skill statistics from multiple sources.
 */
function mergeSkillStats(skillLists) {
  const map = new Map();
  for (const list of skillLists) {
    if (!list) continue;
    for (const s of list) {
      if (!map.has(s.name)) {
        map.set(s.name, { name: s.name, count: 0, totalTokens: 0 });
      }
      const entry = map.get(s.name);
      entry.count += s.count || 0;
      entry.totalTokens += s.totalTokens || 0;
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Load all available usage reports (Codex + Claude Code).
 */
export async function loadAllReports(options = {}) {
  // Inject registered directories
  const cfg = await readConfig();
  const registeredCodex = cfg.directories.filter((d) => d.type === "codex").map((d) => d.path);
  const registeredClaude = cfg.directories.filter((d) => d.type === "claude").map((d) => d.path);

  if (registeredCodex.length > 0) {
    const existing = process.env.CODEX_HOME || "";
    const merged = [...new Set([...existing.split(/[:;]/).filter(Boolean), ...registeredCodex])];
    process.env.CODEX_HOME = merged.join(":");
  }
  if (registeredClaude.length > 0) {
    const existing = process.env.CLAUDE_CONFIG_DIR || "";
    const merged = [...new Set([...existing.split(/[,;]/).filter(Boolean), ...registeredClaude])];
    process.env.CLAUDE_CONFIG_DIR = merged.join(",");
  }

  const [codex, claude] = await Promise.all([
    loadCodexReports(options),
    loadClaudeReports(options),
  ]);

  const allEvents = [...(codex.events || []), ...(claude.events || [])].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );

  const daily = mergeDaily([codex, claude]);
  const totals = buildTotals(allEvents);

  const sessions = buildRows(
    allEvents,
    (event) => `${event.source || "unknown"}:${event.sessionId}`,
    (event, key) => ({
      sessionId: event.sessionId,
      sessionFile: event.sessionFile,
      threadName: event.threadName,
      displayName: event.threadName || event.sessionFile || event.sessionId,
      projectPath: event.projectPath,
      projectName: event.projectName,
      projectKind: event.projectKind,
      source: event.source,
      environment: event.environment,
      distro: event.distro,
      user: event.user,
    }),
  ).sort((a, b) => Date.parse(b.lastActivity || 0) - Date.parse(a.lastActivity || 0));

  const projects = sortByTokens(buildRows(
    allEvents,
    (event) => `${event.source || "?"}:${event.projectKey || event.projectPath || "unknown"}`,
    (event) => ({
      projectKey: event.projectKey,
      projectPath: event.projectPath,
      projectName: event.projectName,
      projectKind: event.projectKind,
      projectDisplaySource: event.projectDisplaySource,
      environment: event.environment,
      distro: event.distro,
      user: event.user,
      source: event.source,
    }),
  ));

  const filesRead = (codex.tool?.filesRead || 0) + (claude.tool?.filesRead || 0);
  const dataRoots = [
    ...(codex.tool?.dataRoots || []),
    ...(claude.tool?.dataRoots || []),
  ];

  // Merge skill stats from claude (codex currently has none)
  const skills = mergeSkillStats([
    claude.skills,
  ]);

  return {
    daily: { daily, totals },
    sessions: { sessions, totals },
    projects: { projects, totals },
    events: allEvents,
    skills,
    tool: {
      source: "codex+claude",
      version: "native",
      filesRead,
      sessionIndexEntries: codex.tool?.sessionIndexEntries || 0,
      threadStateEntries: codex.tool?.threadStateEntries || 0,
      dataRoots,
      codexHomes: codex.tool?.codexHomes || [],
      sources: {
        codex: { filesRead: codex.tool?.filesRead || 0, events: codex.events?.length || 0 },
        claude: { filesRead: claude.tool?.filesRead || 0, events: claude.events?.length || 0 },
      },
    },
  };
}

import { loadCodexReports } from "./ccusage.js";
import { loadClaudeReports } from "./claude.js";
import { readConfig } from "./config.js";
import { priceEvents } from "./pricing.js";
import { resolveCodexHomes, resolveClaudeRoots, sourceLabelMap } from "./sources.js";

function blankAggregate(extra = {}) {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    costUSD: null,
    models: {},
    firstActivity: null,
    lastActivity: null,
    ...extra,
  };
}

function addCost(target, value) {
  if (value === null || value === undefined || value === "") return;
  if (!Number.isFinite(Number(value))) return;
  target.costUSD = (target.costUSD || 0) + Number(value);
}

function addToAggregate(target, event) {
  target.inputTokens += event.inputTokens || 0;
  target.cacheCreationTokens += event.cacheCreationTokens || 0;
  target.cacheReadTokens += event.cacheReadTokens || 0;
  target.outputTokens += event.outputTokens || 0;
  target.reasoningOutputTokens += event.reasoningOutputTokens || 0;
  target.totalTokens += event.totalTokens || 0;
  addCost(target, event.costUSD);
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
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    costUSD: null,
    isFallback: false,
  };
  const m = target.models[model];
  m.inputTokens += event.inputTokens || 0;
  m.cacheCreationTokens += event.cacheCreationTokens || 0;
  m.cacheReadTokens += event.cacheReadTokens || 0;
  m.outputTokens += event.outputTokens || 0;
  m.reasoningOutputTokens += event.reasoningOutputTokens || 0;
  m.totalTokens += event.totalTokens || 0;
  m.eventCount = (m.eventCount || 0) + 1;
  addCost(m, event.costUSD);
  m.isFallback = m.isFallback || !event.model || event.model === "unknown";
  m.costPricingFallback = m.costPricingFallback || Boolean(event.costPricingFallback);
  if (event.costPricingModel) m.costPricingModel = event.costPricingModel;
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

export function aggregateEvents(events = []) {
  return buildTotals(events);
}

/**
 * Merge a pre-aggregated row (e.g., a daily summary from one source) into a
 * combined aggregate.  Unlike addToAggregate this sums eventCount from the
 * source row instead of incrementing by 1.
 */
function mergeAggregateRow(target, row) {
  target.inputTokens += row.inputTokens || 0;
  target.cacheCreationTokens += row.cacheCreationTokens || 0;
  target.cacheReadTokens += row.cacheReadTokens || 0;
  target.outputTokens += row.outputTokens || 0;
  target.reasoningOutputTokens += row.reasoningOutputTokens || 0;
  target.totalTokens += row.totalTokens || 0;
  addCost(target, row.costUSD);
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
        inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0,
        reasoningOutputTokens: 0, totalTokens: 0, eventCount: 0, costUSD: null, isFallback: false,
      };
      const m = target.models[model];
      m.inputTokens += usage.inputTokens || 0;
      m.cacheCreationTokens += usage.cacheCreationTokens || 0;
      m.cacheReadTokens += usage.cacheReadTokens || 0;
      m.outputTokens += usage.outputTokens || 0;
      m.reasoningOutputTokens += usage.reasoningOutputTokens || 0;
      m.totalTokens += usage.totalTokens || 0;
      m.eventCount = (m.eventCount || 0) + (usage.eventCount || 0);
      addCost(m, usage.costUSD);
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
      // Key: agent_source + name, so Codex tools and Claude skills don't merge accidentally
      const agent = s.agent || "unknown";
      const key = `${agent}:${s.name}`;
      if (!map.has(key)) {
        map.set(key, { name: s.name, agent, count: 0, totalTokens: 0 });
      }
      const entry = map.get(key);
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
  const cfg = await readConfig();
  const directories = cfg.directories || [];
  const sourceLabels = sourceLabelMap(directories);
  const [codexHomes, claudeRoots] = await Promise.all([
    resolveCodexHomes(directories, { ...options, includeDefaults: false }),
    resolveClaudeRoots(directories),
  ]);

  const [codex, claude] = await Promise.all([
    loadCodexReports({ ...options, codexHomes, sourceLabels }),
    loadClaudeReports({ ...options, claudeRoots, sourceLabels }),
  ]);

  const rawEvents = [...(codex.events || []), ...(claude.events || [])].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const priced = priceEvents(rawEvents, cfg, options);
  const allEvents = priced.events;

  // Lightweight mode: skip heavy aggregation, return only events (for fast limit refresh)
  if (options.lightweight) {
    return {
      daily: { daily: [], totals: blankAggregate() },
      sessions: { sessions: [], totals: blankAggregate() },
      projects: { projects: [], totals: blankAggregate() },
      events: allEvents,
      skills: [],
      tool: {
        source: "codex+claude",
        version: "native",
        filesRead: (codex.tool?.filesRead || 0) + (claude.tool?.filesRead || 0),
        sessionIndexEntries: 0,
        threadStateEntries: 0,
        dataRoots: [],
        codexHomes: [],
        sources: {
          codex: { filesRead: codex.tool?.filesRead || 0, events: codex.events?.length || 0 },
          claude: { filesRead: claude.tool?.filesRead || 0, events: claude.events?.length || 0 },
        },
      },
    };
  }

  const daily = sortByDate(buildRows(
    allEvents,
    (event) => {
      const tz = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(event.timestamp));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    },
    (_event, date) => ({ date }),
  ));
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
      environmentId: event.environmentId,
      environmentKind: event.environmentKind,
      environmentLabel: event.environmentLabel,
      detectedName: event.detectedName,
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
      environmentId: event.environmentId,
      environmentKind: event.environmentKind,
      environmentLabel: event.environmentLabel,
      detectedName: event.detectedName,
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

  // Merge Codex tool calls and Claude skill invocations without conflating them.
  const skills = mergeSkillStats([
    codex.skills,
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
      pricing: priced.meta,
    },
  };
}

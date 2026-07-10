import { createReadStream } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { codexEnvironmentForHome, resolveCodexHomes } from "./sources.js";

const DATE_ONLY = /^(\d{4})-?(\d{2})-?(\d{2})$/;
const CODEX_GENERATED_DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function isPresent(value) {
  return value !== null && value !== undefined;
}

function usageNumber(usage, names) {
  for (const name of names) {
    if (isPresent(usage?.[name])) return number(usage[name]);
  }
  return 0;
}

function normalizeUsage(usage = {}) {
  const inputRawTokens = usageNumber(usage, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "input",
  ]);
  const cacheReadTokens = usageNumber(usage, [
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cacheReadTokens",
    "cachedTokens",
  ]);
  const outputTokens = usageNumber(usage, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "output",
  ]);
  const reasoningOutputTokens = usageNumber(usage, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "reasoning_tokens",
    "reasoningTokens",
  ]);
  const providedTotal = usageNumber(usage, ["total_tokens", "totalTokens", "total"]);
  const totalTokens = providedTotal || inputRawTokens + outputTokens;

  return {
    inputRawTokens,
    inputTokens: Math.max(0, inputRawTokens - cacheReadTokens),
    cacheReadTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function subtractUsage(total, previous) {
  if (!previous) return normalizeUsage(total);
  return normalizeUsage({
    input_tokens: Math.max(0, usageNumber(total, ["input_tokens", "inputTokens"]) - usageNumber(previous, ["input_tokens", "inputTokens"])),
    cached_input_tokens: Math.max(0, usageNumber(total, ["cached_input_tokens", "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadTokens"]) - usageNumber(previous, ["cached_input_tokens", "cache_read_input_tokens", "cacheReadInputTokens", "cacheReadTokens"])),
    output_tokens: Math.max(0, usageNumber(total, ["output_tokens", "outputTokens"]) - usageNumber(previous, ["output_tokens", "outputTokens"])),
    reasoning_output_tokens: Math.max(0, usageNumber(total, ["reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens", "reasoningTokens"]) - usageNumber(previous, ["reasoning_output_tokens", "reasoningOutputTokens", "reasoning_tokens", "reasoningTokens"])),
    total_tokens: Math.max(0, usageNumber(total, ["total_tokens", "totalTokens", "total"]) - usageNumber(previous, ["total_tokens", "totalTokens", "total"])),
  });
}

function isUsefulUsage(usage) {
  return usage.totalTokens > 0 || usage.inputRawTokens > 0 || usage.outputTokens > 0;
}

function parseDateFilter(value, endOfDay = false) {
  if (!value) return null;
  const match = String(value).match(DATE_ONLY);
  if (!match) return Date.parse(value);
  const [, year, month, day] = match;
  const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  return Date.parse(`${year}-${month}-${day}${suffix}`);
}

function withinFilters(timestamp, options) {
  const ms = Date.parse(timestamp || "");
  if (!Number.isFinite(ms)) return false;
  const since = parseDateFilter(options.since);
  const until = parseDateFilter(options.until, true);
  if (since && ms < since) return false;
  if (until && ms > until) return false;
  return true;
}

function dayKey(timestamp, timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function codexHomes(options = {}) {
  if (options.codexHomes) return unique(options.codexHomes);
  return resolveCodexHomes(options.configDirectories || [], options);
}

function codexHomeMeta(home, labels, fallbackIndex) {
  return codexEnvironmentForHome(home, labels, fallbackIndex);
}

async function walkJsonl(root, out = []) {
  if (!(await exists(root))) return out;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(path, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(path);
    }
  }
  return out;
}

async function collectSessionFiles(homes, labels = new Map()) {
  const files = new Map();
  for (const [index, home] of homes.entries()) {
    const meta = codexHomeMeta(home, labels, index + 1);
    for (const source of ["archived_sessions", "sessions"]) {
      const root = join(home, source);
      for (const file of await walkJsonl(root)) {
        const key = relative(root, file).replace(/\\/g, "/");
        files.set(`${home}|${key}`, {
          file,
          source,
          root,
          codexHome: home,
          environment: meta.environment,
          environmentId: meta.environmentId,
          environmentKind: meta.environmentKind,
          environmentLabel: meta.environmentLabel,
          detectedName: meta.detectedName,
          distro: meta.distro,
          user: meta.user,
        });
      }
    }
  }
  return [...files.values()];
}

async function loadSessionIndex(homes) {
  const index = new Map();
  for (const home of homes) {
    const path = join(home, "session_index.jsonl");
    if (!(await exists(path))) continue;
    const content = await readFile(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (!item.id || !item.thread_name) continue;
        const current = index.get(item.id);
        if (!current || Date.parse(item.updated_at || 0) >= Date.parse(current.updatedAt || 0)) {
          index.set(item.id, {
            threadId: item.id,
            threadName: item.thread_name,
            updatedAt: item.updated_at || null,
          });
        }
      } catch {
        // Ignore partial or future-format index lines.
      }
    }
  }
  return index;
}

function stripExtendedPathPrefix(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
}

async function loadThreadStateIndex(homes) {
  const index = new Map();
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return index;
  }

  for (const home of homes) {
    const path = join(home, "state_5.sqlite");
    if (!(await exists(path))) continue;
    let db;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true });
      const rows = db.prepare(
        "select id, title, first_user_message, source, cwd, updated_at_ms, updated_at from threads",
      ).all();
      for (const row of rows) {
        const title = titleFromUserMessage(row.title) || titleFromUserMessage(row.first_user_message);
        if (!row.id || !title) continue;
        index.set(row.id, {
          threadId: row.id,
          threadName: title,
          titleSource: "state_threads",
          source: row.source || null,
          cwd: stripExtendedPathPrefix(row.cwd),
          updatedAt: row.updated_at_ms || row.updated_at || null,
        });
      }
    } catch {
      // The dashboard can still run from JSONL logs if the app sqlite file is locked
      // or if an older Node runtime lacks sqlite support.
    } finally {
      db?.close();
    }
  }
  return index;
}

function modelFrom(value) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (
        typeof child === "string" &&
        ["model", "model_name", "modelName", "model_id", "modelId"].includes(key)
      ) {
        return child;
      }
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return null;
}

function cleanProjectName(projectPath) {
  if (!projectPath) return "unknown";
  const normalized = String(projectPath).replace(/\\/g, "/");
  const segment = normalized.split("/").filter(Boolean).pop();
  return segment || basename(projectPath) || projectPath;
}

function cleanTitle(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}

function titleFromUserMessage(message) {
  if (!message) return null;
  const text = String(message);
  const userInput = text.match(/<user_input>\s*([\s\S]*?)\s*<\/user_input>/);
  if (userInput) {
    try {
      const parsed = JSON.parse(userInput[1]);
      return cleanTitle(parsed.text || parsed.message || userInput[1]);
    } catch {
      return cleanTitle(userInput[1]);
    }
  }
  const userMessageMarker = "## user_message";
  if (text.includes(userMessageMarker)) {
    return cleanTitle(text.slice(text.indexOf(userMessageMarker) + userMessageMarker.length));
  }
  return cleanTitle(text);
}

function isGeneratedCodexWorkspace(projectPath) {
  if (!projectPath) return false;
  const normalized = projectPath.replace(/\\/g, "/");
  const marker = "/Documents/Codex/";
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return false;
  const tail = normalized.slice(index + marker.length);
  const [dateDir] = tail.split("/");
  return CODEX_GENERATED_DATE_DIR.test(dateDir || "");
}

function projectInfo(projectPath, sessionId, threadName) {
  if (isGeneratedCodexWorkspace(projectPath)) {
    return {
      projectKey: `thread:${sessionId}`,
      projectName: threadName || cleanProjectName(projectPath),
      projectPath,
      projectKind: "projectless_thread",
      projectDisplaySource: threadName ? "session_index" : "cwd",
    };
  }
  return {
    projectKey: projectPath || "unknown",
    projectName: cleanProjectName(projectPath),
    projectPath,
    projectKind: projectPath ? "workspace" : "unknown",
    projectDisplaySource: "cwd",
  };
}

function sessionIdFor(meta, fileInfo) {
  if (meta.session_id) return meta.session_id;
  if (meta.id) return meta.id;
  return relative(fileInfo.root, fileInfo.file).replace(/\\/g, "/").replace(/\.jsonl$/, "");
}

function normalizeRateLimit(limit) {
  if (!limit) return null;
  return {
    used_percent: isPresent(limit.used_percent) ? number(limit.used_percent) : null,
    window_minutes: isPresent(limit.window_minutes) ? number(limit.window_minutes) : null,
    resets_at_epoch: isPresent(limit.resets_at) ? number(limit.resets_at) : null,
    resets_at: isPresent(limit.resets_at)
      ? new Date(number(limit.resets_at) * 1000).toISOString()
      : null,
  };
}

function normalizeRateLimits(raw) {
  if (!raw) return null;
  return {
    limit_id: raw.limit_id || null,
    plan_type: raw.plan_type || null,
    primary: normalizeRateLimit(raw.primary),
    secondary: normalizeRateLimit(raw.secondary),
  };
}

function toolCallFromPayload(payload = {}) {
  if (payload.type === "mcp_tool_call_end" && payload.invocation?.tool) {
    const server = payload.invocation.server || "unknown";
    return {
      name: server !== "unknown" ? `${server}/${payload.invocation.tool}` : payload.invocation.tool,
      callId: payload.call_id || payload.callId || null,
    };
  }

  if ((payload.type === "function_call" || payload.type === "custom_tool_call") && payload.name) {
    return {
      name: payload.name,
      callId: payload.call_id || payload.callId || null,
    };
  }

  return null;
}

function addToolCall(toolCounts, seenCallIds, payload) {
  const call = toolCallFromPayload(payload);
  if (!call) return;
  if (call.callId && seenCallIds.has(call.callId)) return;
  if (call.callId) seenCallIds.add(call.callId);

  const existing = toolCounts.get(call.name);
  if (existing) {
    existing.count += 1;
  } else {
    toolCounts.set(call.name, { name: call.name, count: 1, agent: "codex" });
  }
}

export function collectCodexToolCalls(payloads = []) {
  const toolCounts = new Map();
  const seenCallIds = new Set();
  for (const payload of payloads) addToolCall(toolCounts, seenCallIds, payload);
  return [...toolCounts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function parseSessionFile(fileInfo, sessionIndex, threadStateIndex, options) {
  const events = [];
  const meta = {
    sourceFile: fileInfo.file,
    source: fileInfo.source,
    sessionFile: relative(fileInfo.root, fileInfo.file).replace(/\\/g, "/"),
    environment: fileInfo.environment,
    environmentId: fileInfo.environmentId,
    environmentKind: fileInfo.environmentKind,
    environmentLabel: fileInfo.environmentLabel,
    detectedName: fileInfo.detectedName,
    distro: fileInfo.distro,
    user: fileInfo.user,
    cwd: null,
    startedAt: null,
    session_id: null,
    id: null,
    inferredTitle: null,
  };
  let currentModel = null;
  let previousTotalUsage = null;
  let lineNumber = 0;
  const toolCounts = new Map();
  const seenToolCallIds = new Set();

  const stream = createReadStream(fileInfo.file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload || {};
    const timestamp = entry.timestamp || payload.timestamp || meta.startedAt;
    if (entry.type === "session_meta" || payload.cwd || payload.session_id) {
      meta.cwd = payload.cwd || meta.cwd;
      meta.startedAt = payload.timestamp || entry.timestamp || meta.startedAt;
      meta.session_id = payload.session_id || meta.session_id;
      meta.id = payload.id || meta.id;
    }

    const foundModel = modelFrom(payload);
    if (foundModel) currentModel = foundModel;

    if (payload.type === "user_message" && !meta.inferredTitle) {
      meta.inferredTitle = titleFromUserMessage(payload.message);
    }

    // Codex Desktop writes native tools as response_item/function_call and
    // response_item/custom_tool_call; older MCP calls use mcp_tool_call_end.
    addToolCall(toolCounts, seenToolCallIds, payload);

    if (payload.type !== "token_count") continue;

    const info = payload.info || {};
    const lastUsage = info.last_token_usage || info.lastTokenUsage;
    const totalUsage = info.total_token_usage || info.totalTokenUsage;
    const usage = lastUsage ? normalizeUsage(lastUsage) : subtractUsage(totalUsage, previousTotalUsage);
    previousTotalUsage = totalUsage || previousTotalUsage;
    if (!isUsefulUsage(usage) || !withinFilters(timestamp, options)) continue;

    const sessionId = sessionIdFor(meta, fileInfo);
    const thread = sessionIndex.get(sessionId) || null;
    const threadState = threadStateIndex.get(sessionId) || null;
    const threadName = thread?.threadName || threadState?.threadName || meta.inferredTitle || null;
    const threadNameSource = thread?.threadName
      ? "session_index"
      : threadState?.threadName
        ? threadState.titleSource
      : meta.inferredTitle
        ? "first_user_message"
        : null;
    const projectPath = meta.cwd || null;
    const project = projectInfo(projectPath, sessionId, threadName);
    events.push({
      ...usage,
      timestamp,
      sessionId,
      sessionFile: meta.sessionFile,
      threadName,
      threadNameSource,
      model: currentModel || "unknown",
      isFallback: !currentModel,
      projectKey: project.projectKey,
      projectPath: project.projectPath,
      projectName: project.projectName,
      projectKind: project.projectKind,
      projectDisplaySource: project.projectDisplaySource,
      rateLimits: normalizeRateLimits(entry.rate_limits || payload.rate_limits),
      sourceFile: fileInfo.file,
      source: fileInfo.source,
      environment: fileInfo.environment,
      environmentId: fileInfo.environmentId,
      environmentKind: fileInfo.environmentKind,
      environmentLabel: fileInfo.environmentLabel,
      detectedName: fileInfo.detectedName,
      distro: fileInfo.distro,
      user: fileInfo.user,
      lineNumber,
    });
  }

  return { events, tools: [...toolCounts.values()] };
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

function addToAggregate(target, event) {
  target.inputTokens += event.inputTokens;
  target.cacheReadTokens += event.cacheReadTokens;
  target.outputTokens += event.outputTokens;
  target.reasoningOutputTokens += event.reasoningOutputTokens;
  target.totalTokens += event.totalTokens;
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
  const modelTarget = target.models[model];
  modelTarget.inputTokens += event.inputTokens;
  modelTarget.cacheReadTokens += event.cacheReadTokens;
  modelTarget.outputTokens += event.outputTokens;
  modelTarget.reasoningOutputTokens += event.reasoningOutputTokens;
  modelTarget.totalTokens += event.totalTokens;
  modelTarget.isFallback = modelTarget.isFallback || event.isFallback;
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

export async function loadCodexReports(options = {}) {
  const homes = await codexHomes(options);
  const files = await collectSessionFiles(homes, options.sourceLabels || new Map());
  const sessionIndex = await loadSessionIndex(homes);
  const threadStateIndex = await loadThreadStateIndex(homes);
  const nestedResults = await Promise.all(
    files.map((file) => parseSessionFile(file, sessionIndex, threadStateIndex, options)),
  );
  const events = nestedResults.flatMap((r) => r.events).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const rawTools = nestedResults.flatMap((r) => r.tools);
  const toolMap = new Map();
  for (const t of rawTools) {
    if (toolMap.has(t.name)) {
      toolMap.get(t.name).count += t.count;
    } else {
      toolMap.set(t.name, { ...t });
    }
  }
  const tools = [...toolMap.values()].sort((a, b) => b.count - a.count);
  const totals = buildTotals(events);

  const daily = sortByDate(buildRows(
    events,
    (event) => dayKey(event.timestamp, options.timezone),
    (_event, date) => ({ date }),
  ));
  const sessions = buildRows(
    events,
    (event) => event.sessionId,
    (event, sessionId) => ({
      sessionId,
      sessionFile: event.sessionFile,
      threadName: event.threadName,
      threadNameSource: event.threadNameSource,
      displayName: event.threadName || event.sessionFile || sessionId,
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
    events,
    (event) => `${event.environment || "unknown"}:${event.projectKey || event.projectPath || "unknown"}`,
    (event, projectKey) => ({
      projectKey,
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
    }),
  ));

  return {
    daily: { daily, totals },
    sessions: { sessions, totals },
    projects: { projects, totals },
    events,
    skills: tools,
    tool: {
      source: "codex-jsonl",
      version: "native",
      filesRead: files.length,
      sessionIndexEntries: sessionIndex.size,
      threadStateEntries: threadStateIndex.size,
      dataRoots: homes.flatMap((home) => [
        join(home, "sessions"),
        join(home, "archived_sessions"),
        join(home, "session_index.jsonl"),
        join(home, "state_5.sqlite"),
      ]),
      codexHomes: homes,
      parser: basename(new URL(import.meta.url).pathname),
      parserDir: dirname(new URL(import.meta.url).pathname),
    },
  };
}

import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { normalizePathKey, stableId } from "./sources.js";

const DATE_ONLY = /^(\d{4})-?(\d{2})-?(\d{2})$/;

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function isPresent(value) {
  return value !== null && value !== undefined;
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand ~ in a path to the home directory.
 */
function expandHome(path) {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Discover Claude Code project directories.
 * Sources: CLAUDE_CONFIG_DIR env var, ~/.config/claude, ~/.claude
 */
async function discoverClaudeRoots(explicitRoots = null) {
  if (Array.isArray(explicitRoots)) {
    return [...new Set(explicitRoots)];
  }
  const roots = [];

  if (process.env.CLAUDE_CONFIG_DIR) {
    for (const dir of process.env.CLAUDE_CONFIG_DIR.split(/[,;]/)) {
      const trimmed = dir.trim();
      if (!trimmed) continue;
      const expanded = expandHome(trimmed);
      // Allow pointing at either the config root or the projects/ folder
      if (basename(expanded) === "projects" && (await exists(expanded))) {
        roots.push(dirname(expanded));
      } else if (await exists(join(expanded, "projects"))) {
        roots.push(expanded);
      }
    }
    if (roots.length > 0) return [...new Set(roots)];
  }

  // Fall back to default locations
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const candidates = [join(xdgConfigHome, "claude"), join(homedir(), ".claude")];

  for (const candidate of candidates) {
    if (await exists(join(candidate, "projects"))) {
      roots.push(candidate);
    }
  }

  return [...new Set(roots)];
}

function claudeEnvironmentForRoot(root, labels = new Map()) {
  const key = normalizePathKey(root);
  const kind = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform();
  const detectedName = kind === "windows" ? `windows-${hostname()}` : `${kind}-${hostname()}`;
  return {
    environment: detectedName,
    environmentId: stableId("env", key || detectedName),
    environmentKind: kind,
    environmentLabel: labels.get(key) || detectedName,
    detectedName,
  };
}

/**
 * Decode a project directory name back to a filesystem path.
 * Claude Code encodes paths like /Users/name/project → -Users-name-project
 */
function decodeProjectName(dirName) {
  if (!dirName || !dirName.startsWith("-")) return dirName;
  // Replace first char (always '-'), then split on '-' to get segments
  const encoded = dirName.slice(1);
  // The encoding replaces '/' with '-', so we need to guess where slashes go.
  // Common root directories: /Users/, /home/, /Volumes/, /mnt/, /opt/, /var/, /tmp/
  // Strategy: walk the path from the front, testing each possible split.
  // For simplicity, try the known patterns.
  const ROOTS = ["Users", "home", "Volumes", "mnt", "opt", "var", "tmp"];

  for (const root of ROOTS) {
    const marker = `-${root}-`;
    const idx = dirName.indexOf(marker);
    if (idx >= 0) {
      // Everything before the root marker (plus the leading '-') is meaningless,
      // then root + rest with '-' → '/'
      const pathPart = dirName.slice(idx + 1); // e.g., "Users-name-code-project" → /Users/name/code/project
      return "/" + pathPart.replace(/-/g, "/");
    }
  }

  // Fallback: just replace all '-' with '/'
  return "/" + encoded.replace(/-/g, "/");
}

/**
 * Walk a directory recursively, collecting .jsonl files.
 */
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

/**
 * Collect all Claude Code JSONL files across discovered projects.
 */
async function collectClaudeFiles(roots, labels = new Map()) {
  const files = [];
  for (const root of roots) {
    const env = claudeEnvironmentForRoot(root, labels);
    const projectsDir = join(root, "projects");
    if (!(await exists(projectsDir))) continue;

    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(projectsDir, entry.name);
      const projectPath = decodeProjectName(entry.name);

      for (const jsonlFile of await walkJsonl(projectDir)) {
        files.push({
          file: jsonlFile,
          projectDir,
          projectName: basename(projectPath),
          projectPath,
          claudeRoot: root,
          environment: env.environment,
          environmentId: env.environmentId,
          environmentKind: env.environmentKind,
          environmentLabel: env.environmentLabel,
          detectedName: env.detectedName,
        });
      }
    }
  }
  return files;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const inputRawTokens = number(usage.input_tokens);
  const cacheCreationTokens = number(usage.cache_creation_input_tokens);
  const cacheReadTokens = number(usage.cache_read_input_tokens);
  const outputTokens = number(usage.output_tokens);
  const totalTokens = inputRawTokens + cacheCreationTokens + outputTokens;

  return {
    inputRawTokens,
    inputTokens: Math.max(0, inputRawTokens - cacheReadTokens - cacheCreationTokens),
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
  };
}

function isUsefulUsage(usage) {
  return usage && (usage.totalTokens > 0 || usage.inputRawTokens > 0 || usage.outputTokens > 0);
}

function cleanProjectName(projectPath) {
  if (!projectPath) return "unknown";
  return basename(projectPath) || projectPath;
}

/**
 * Parse a single Claude Code JSONL file and extract token usage events
 * and skill (tool_use) calls.
 */
async function parseClaudeFile(fileInfo, options) {
  const events = [];
  // Track message IDs to deduplicate sidechain replays
  const seenMessageIds = new Set();
  let lineNumber = 0;

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

    // Only process assistant messages with usage data
    if (entry.type !== "assistant") continue;

    const msg = entry.message;
    if (!msg) continue;

    const timestamp = entry.timestamp || msg.timestamp || null;
    if (!withinFilters(timestamp, options)) continue;

    const sessionId = entry.sessionId || entry.session_id || "unknown";

    // ── Extract skill calls from tool_use content blocks ──
    const content = msg.content || [];
    // Normalize: content can be a string or an array
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block && block.type === "tool_use" && block.name === "Skill") {
        const skillName = block.input?.skill || "unknown";
        const usage = msg.usage ? normalizeUsage(msg.usage) : null;
        const skillTokens = usage ? usage.totalTokens : 0;
        events.push({
          skill: skillName,
          timestamp,
          sessionId,
          tokens: skillTokens,
          source: "claude",
          projectKey: fileInfo.projectPath || "unknown",
          projectPath: fileInfo.projectPath || null,
          projectName: cleanProjectName(fileInfo.projectPath),
          sourceFile: fileInfo.file,
          lineNumber,
        });
      }
    }

    // ── Token usage event (unchanged logic) ──
    if (!msg.usage) continue;

    const usage = normalizeUsage(msg.usage);
    if (!isUsefulUsage(usage)) continue;

    // Sidechain dedup: keep parent, skip sidechain replay
    const messageId = msg.id || null;
    if (messageId) {
      if (entry.isSidechain && seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }

    const model = msg.model || "unknown";

    events.push({
      ...usage,
      timestamp,
      sessionId,
      model,
      projectKey: fileInfo.projectPath || "unknown",
      projectPath: fileInfo.projectPath || null,
      projectName: cleanProjectName(fileInfo.projectPath),
      projectKind: "workspace",
      projectDisplaySource: "cwd",
      sourceFile: fileInfo.file,
      source: "claude",
      environment: fileInfo.environment,
      environmentId: fileInfo.environmentId,
      environmentKind: fileInfo.environmentKind,
      environmentLabel: fileInfo.environmentLabel,
      detectedName: fileInfo.detectedName,
      distro: null,
      user: null,
      threadName: null,
      threadNameSource: null,
      sessionFile: relative(fileInfo.projectDir, fileInfo.file).replace(/\\/g, "/"),
      isSidechain: !!entry.isSidechain,
      lineNumber,
      rateLimits: null,
    });
  }

  return events;
}

// ── Aggregation helpers (compatible with ccusage.js) ──

function blankAggregate(extra = {}) {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
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
  target.reasoningOutputTokens += event.reasoningOutputTokens || 0;
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
  modelTarget.reasoningOutputTokens += event.reasoningOutputTokens || 0;
  modelTarget.totalTokens += event.totalTokens;
  modelTarget.isFallback = modelTarget.isFallback || !event.model || event.model === "unknown";
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
 * Filter skill events from a raw event list and aggregate them.
 */
function extractSkillCalls(events) {
  const skillMap = new Map();
  for (const ev of events) {
    if (!ev.skill) continue;
    const name = ev.skill;
    if (!skillMap.has(name)) {
      skillMap.set(name, { name, count: 0, totalTokens: 0 });
    }
    const entry = skillMap.get(name);
    entry.count += 1;
    entry.totalTokens += ev.tokens || 0;
  }
  return [...skillMap.values()].sort((a, b) => b.count - a.count);
}

/**
 * Load Claude Code usage reports.
 * Returns the same structure as loadCodexReports() for compatibility.
 */
export async function loadClaudeReports(options = {}) {
  const roots = await discoverClaudeRoots(Object.hasOwn(options, "claudeRoots") ? options.claudeRoots : null);
  if (roots.length === 0) {
    return {
      daily: { daily: [], totals: blankAggregate() },
      sessions: { sessions: [], totals: blankAggregate() },
      projects: { projects: [], totals: blankAggregate() },
      events: [],
      skills: [],
      tool: {
        source: "claude",
        version: "native",
        filesRead: 0,
        dataRoots: [],
        codexHomes: [],
      },
    };
  }

  const files = await collectClaudeFiles(roots, options.sourceLabels || new Map());
  const nestedEvents = await Promise.all(
    files.map((file) => parseClaudeFile(file, options)),
  );
  const allRaw = nestedEvents.flat().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // Separate skill events from usage events
  const skills = extractSkillCalls(allRaw);
  const events = allRaw.filter((ev) => !ev.skill);

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
    (event) => `${event.source || "claude"}:${event.projectKey || event.projectPath || "unknown"}`,
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
      source: event.source,
    }),
  ));

  return {
    daily: { daily, totals },
    sessions: { sessions, totals },
    projects: { projects, totals },
    events,
    skills,
    tool: {
      source: "claude",
      version: "native",
      filesRead: files.length,
      dataRoots: roots.flatMap((root) => [join(root, "projects")]),
      codexHomes: roots,
    },
  };
}

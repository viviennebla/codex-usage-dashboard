import { access, readdir } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, join, delimiter } from "node:path";

const WSL_BASES = ["\\\\wsl.localhost", "\\\\wsl$"];
const FALLBACK_WSL_DISTROS = [
  "Ubuntu-26.04",
  "Ubuntu-24.04",
  "Ubuntu-22.04",
  "Ubuntu",
  "Debian",
];

export function normalizePathKey(path) {
  return String(path || "")
    .replace(/[\\/]+$/, "")
    .replace(/^\\\\wsl\$/i, "\\\\wsl.localhost")
    .toLowerCase();
}

export function stableId(prefix, value) {
  const text = String(value || "unknown");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export function splitPathList(value) {
  return String(value || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const path of paths.filter(Boolean)) {
    const key = normalizePathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function sourceLabelMap(directories = []) {
  const map = new Map();
  for (const dir of directories) {
    if (!dir?.path || !dir.label) continue;
    map.set(normalizePathKey(normalizeCodexHome(dir.path)), dir.label);
    map.set(normalizePathKey(normalizeClaudeRoot(dir.path)), dir.label);
    map.set(normalizePathKey(dir.path), dir.label);
  }
  return map;
}

function registeredSourceKeys(directories = []) {
  const keys = new Set();
  for (const dir of directories) {
    if (!dir?.path) continue;
    const type = dir.type === "claude" ? "claude" : "codex";
    const root = type === "claude" ? normalizeClaudeRoot(dir.path) : normalizeCodexHome(dir.path);
    keys.add(`${type}:${normalizePathKey(root)}`);
  }
  return keys;
}

export function normalizeCodexHome(path) {
  const raw = String(path || "").replace(/[\\/]+$/, "");
  if (!raw) return raw;
  return basename(raw).toLowerCase() === "sessions" ? dirname(raw) : raw;
}

export function normalizeClaudeRoot(path) {
  const raw = String(path || "").replace(/[\\/]+$/, "");
  if (!raw) return raw;
  return basename(raw).toLowerCase() === "projects" ? dirname(raw) : raw;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countJsonl(root, max = 2000) {
  let count = 0;
  async function walk(dir) {
    if (count >= max) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw error;
    }
    for (const entry of entries) {
      if (count >= max) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) count += 1;
    }
  }
  await walk(root);
  return count;
}

function wslMetaFromPath(path) {
  const normalized = String(path || "").replace(/\//g, "\\");
  const match = normalized.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(?:home\\([^\\]+)|root)(?:\\|$)/i);
  if (!match) return null;
  return {
    distro: match[1] || null,
    user: match[2] || "root",
  };
}

export function codexEnvironmentForHome(home, labels = new Map(), fallbackIndex = 1) {
  const key = normalizePathKey(home);
  const label = labels.get(key) || null;
  const wsl = wslMetaFromPath(home);
  if (wsl) {
    const detectedName = wsl.distro ? `wsl-${wsl.distro}` : `device${fallbackIndex}`;
    return {
      environmentId: stableId("env", key),
      environmentKind: "wsl",
      environment: detectedName,
      environmentLabel: label || detectedName,
      detectedName,
      distro: wsl.distro,
      user: wsl.user,
    };
  }

  const kind = platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform();
  const detectedName = kind === "windows" ? `windows-${hostname()}` : `${kind}-${hostname()}`;
  return {
    environmentId: stableId("env", key || detectedName),
    environmentKind: kind,
    environment: detectedName || `device${fallbackIndex}`,
    environmentLabel: label || detectedName || `device${fallbackIndex}`,
    detectedName: detectedName || `device${fallbackIndex}`,
    distro: null,
    user: null,
  };
}

export async function discoverWslCodexHomes() {
  if (platform() !== "win32" || process.env.CODEX_USAGE_INCLUDE_WSL === "0") return [];

  const distros = new Set();
  for (const base of WSL_BASES) {
    try {
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) distros.add(entry.name);
      }
    } catch {
      // Some Windows contexts cannot enumerate \\wsl.*; fallback names cover common installs.
    }
  }
  for (const distro of FALLBACK_WSL_DISTROS) distros.add(distro);

  const homes = [];
  for (const distro of distros) {
    for (const base of WSL_BASES) {
      const homeRoot = join(base, distro, "home");
      try {
        const users = await readdir(homeRoot, { withFileTypes: true });
        for (const user of users) {
          if (!user.isDirectory()) continue;
          const codexHome = join(homeRoot, user.name, ".codex");
          if (await exists(join(codexHome, "sessions"))) homes.push(codexHome);
        }
      } catch {
        // Keep probing other distros/bases.
      }

      const rootCodexHome = join(base, distro, "root", ".codex");
      if (await exists(join(rootCodexHome, "sessions"))) homes.push(rootCodexHome);
    }
  }

  return uniquePaths(homes);
}

export async function resolveCodexHomes(configDirectories = [], options = {}) {
  const registered = configDirectories
    .filter((d) => d.type === "codex")
    .map((d) => normalizeCodexHome(d.path));
  const envHomes = splitPathList(process.env.CODEX_HOME).map(normalizeCodexHome);
  const includeDefaults = options.includeDefaults ?? !Object.hasOwn(options, "includeDefaults");
  const defaults = includeDefaults && envHomes.length === 0 ? [join(homedir(), ".codex")] : [];
  const wsl = includeDefaults && !options.noWsl ? await discoverWslCodexHomes() : [];
  return uniquePaths([...defaults, ...registered, ...wsl]);
}

export async function resolveClaudeRoots(configDirectories = []) {
  const registered = configDirectories
    .filter((d) => d.type === "claude")
    .map((d) => normalizeClaudeRoot(d.path));
  const envRoots = splitPathList(process.env.CLAUDE_CONFIG_DIR).map(normalizeClaudeRoot);
  return uniquePaths([...envRoots, ...registered]);
}

export async function inspectSource(path, type = "codex", labels = new Map()) {
  const normalizedType = type === "claude" ? "claude" : type === "skills" ? "skills" : "codex";
  const root = normalizedType === "skills" ? path
    : normalizedType === "claude" ? normalizeClaudeRoot(path) : normalizeCodexHome(path);
  const dataDir = normalizedType === "skills" ? path
    : normalizedType === "claude" ? join(root, "projects") : join(root, "sessions");
  const key = normalizePathKey(root);
  const env = normalizedType === "codex"
    ? codexEnvironmentForHome(root, labels)
    : {
      environmentId: stableId("env", key),
      environmentKind: platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : platform(),
      environment: `${platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : platform()}-${hostname()}`,
      environmentLabel: labels.get(key) || `${platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : platform()}-${hostname()}`,
      detectedName: `${platform() === "win32" ? "windows" : platform() === "darwin" ? "macos" : platform()}-${hostname()}`,
    };

  const result = {
    path,
    normalized_path: root,
    data_path: dataDir,
    type: normalizedType,
    label: labels.get(key) || null,
    detected_name: env.detectedName,
    display_name: env.environmentLabel,
    environment_id: env.environmentId,
    environment_kind: env.environmentKind,
    status: "unknown",
    exists: false,
    files_found: 0,
    message: "",
  };

  if (!(await exists(root))) {
    return { ...result, status: "missing", message: "Path does not exist" };
  }
  result.exists = true;
  if (!(await exists(dataDir))) {
    return { ...result, status: "missing", message: `Expected data directory not found: ${dataDir}` };
  }

  // Skills are portable Markdown files and may be nested under arbitrary Agent layouts.
  if (normalizedType === "skills") {
    try {
      const { scanSkillDir } = await import("./skills-sync.js");
      const skills = await scanSkillDir(dataDir);
      result.files_found = skills.length;
      result.status = skills.length > 0 ? "ok" : "empty";
      result.message = skills.length > 0 ? `Found ${skills.length} skill(s)` : "No skill Markdown files found";
    } catch (error) {
      return { ...result, status: "unreadable", message: error?.message || "Cannot read skills directory" };
    }
  } else {
    try {
      const files = await countJsonl(dataDir);
      result.files_found = files;
      result.status = files > 0 ? "ok" : "empty";
      result.message = files > 0 ? `Found ${files} JSONL file(s)` : "No JSONL files found";
    } catch (error) {
      return {
        ...result,
        status: "unreadable",
        message: error?.message || "Cannot read data directory",
      };
    }
  }
  return result;
}

export async function discoverSourceDiagnostics(configDirectories = []) {
  const labels = sourceLabelMap(configDirectories);
  const registered = registeredSourceKeys(configDirectories);
  const home = homedir();
  const candidates = [
    { path: join(home, ".codex"), type: "codex", origin: "auto" },
    { path: join(home, ".claude"), type: "claude", origin: "auto" },
    { path: join(home, ".config", "claude"), type: "claude", origin: "auto" },
  ];

  for (const path of await discoverWslCodexHomes()) {
    candidates.push({ path, type: "codex", origin: "auto" });
  }

  const diagnostics = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const inspected = await inspectSource(candidate.path, candidate.type, labels);
    const key = `${candidate.type}:${normalizePathKey(inspected.normalized_path)}`;
    if (registered.has(key) || seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ ...inspected, origin: candidate.origin });
  }
  return diagnostics;
}

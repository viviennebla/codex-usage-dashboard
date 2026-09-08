import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, readFile, rename, writeFile, mkdir } from "node:fs/promises";

const CONFIG_PATH_DEFAULT = join(homedir(), ".codex-usage.json");

function defaultConfig() {
  return { version: 1, directories: [], pricing: {}, sync: { server: null, token: null } };
}

export async function readConfig(configPath = CONFIG_PATH_DEFAULT) {
  try {
    const raw = await readFile(configPath, "utf8");
    const cfg = JSON.parse(raw);
    return {
      version: cfg.version || 1,
      directories: (cfg.directories || []).map((d) => ({
        path: d.path,
        type: d.type || "codex",
        label: d.label || null,
        addedAt: d.addedAt || null,
      })),
      pricing: cfg.pricing && typeof cfg.pricing === "object" ? cfg.pricing : {},
      sync: {
        server: typeof cfg.sync?.server === "string" && cfg.sync.server.trim()
          ? cfg.sync.server.trim().replace(/\/+$/, "")
          : null,
        token: typeof cfg.sync?.token === "string" && cfg.sync.token
          ? cfg.sync.token
          : null,
      },
    };
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(config, configPath = CONFIG_PATH_DEFAULT) {
  await mkdir(join(configPath, ".."), { recursive: true });
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
  } catch {
    // chmod is not supported on every platform; the restrictive create mode still applies where available.
  }
  await rename(tmp, configPath);
}

export function resolveSyncConnection(options = {}, config = {}, env = process.env) {
  return {
    server: options.server || config.sync?.server || null,
    token: options.token || env.DASHBOARD_TOKEN || config.sync?.token || null,
  };
}

export async function updateSyncConnection(
  { server, token, clearToken = false },
  configPath = CONFIG_PATH_DEFAULT,
) {
  const config = await readConfig(configPath);
  const current = config.sync || {};
  config.sync = {
    server: typeof server === "string" && server.trim()
      ? server.trim().replace(/\/+$/, "")
      : current.server || null,
    token: clearToken
      ? null
      : (typeof token === "string" && token ? token : current.token || null),
  };
  await writeConfig(config, configPath);
  return config.sync;
}

export async function addDirectory(path, type, label, configPath = CONFIG_PATH_DEFAULT) {
  const config = await readConfig(configPath);
  const normalized = path.replace(/\/+$/, "");
  // Don't duplicate
  if (config.directories.some((d) => d.path === normalized && d.type === type)) {
    return { config, added: false, reason: "already registered" };
  }
  config.directories.push({
    path: normalized,
    type,
    label: label || null,
    addedAt: new Date().toISOString(),
  });
  await writeConfig(config, configPath);
  return { config, added: true };
}

export async function removeDirectory(path, type, configPath = CONFIG_PATH_DEFAULT) {
  const config = await readConfig(configPath);
  const before = config.directories.length;
  config.directories = config.directories.filter(
    (d) => !(d.path === path && (!type || d.type === type)),
  );
  if (config.directories.length < before) {
    await writeConfig(config, configPath);
    return { config, removed: true };
  }
  return { config, removed: false, reason: "not found" };
}

export async function listDirectories(configPath = CONFIG_PATH_DEFAULT) {
  const config = await readConfig(configPath);
  return config.directories;
}

export { CONFIG_PATH_DEFAULT };

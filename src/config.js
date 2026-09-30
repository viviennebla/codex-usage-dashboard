import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, readFile, rename, writeFile, mkdir } from "node:fs/promises";

const CONFIG_PATH_DEFAULT = join(homedir(), ".codex-usage.json");

function defaultConfig() {
  return {
    version: 1,
    directories: [],
    pricing: {},
    sync: { server: null, token: null },
    denglema: {
      server: null,
      installationId: null,
      token: null,
      timezone: null,
      autoUpload: { enabled: false, interval: null },
    },
  };
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
      denglema: {
        server: typeof cfg.denglema?.server === "string" && cfg.denglema.server.trim()
          ? cfg.denglema.server.trim().replace(/\/+$/, "")
          : null,
        installationId: typeof cfg.denglema?.installationId === "string" && cfg.denglema.installationId
          ? cfg.denglema.installationId
          : null,
        token: typeof cfg.denglema?.token === "string" && cfg.denglema.token
          ? cfg.denglema.token
          : null,
        timezone: typeof cfg.denglema?.timezone === "string" && cfg.denglema.timezone
          ? cfg.denglema.timezone
          : null,
        autoUpload: {
          enabled: cfg.denglema?.autoUpload?.enabled === true,
          interval: ["1h", "3h", "6h", "1d"].includes(cfg.denglema?.autoUpload?.interval)
            ? cfg.denglema.autoUpload.interval
            : null,
        },
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

export function resolveDenglemaConnection(options = {}, config = {}, env = process.env) {
  return {
    server: options.server || config.denglema?.server || null,
    installationId: options.installationId || config.denglema?.installationId || null,
    token: options.token || env.DENGLEMA_TOKEN || config.denglema?.token || null,
    timezone: options.timezone || config.denglema?.timezone || null,
    autoUpload: {
      enabled: config.denglema?.autoUpload?.enabled === true,
      interval: ["1h", "3h", "6h", "1d"].includes(config.denglema?.autoUpload?.interval)
        ? config.denglema.autoUpload.interval
        : null,
    },
  };
}

export async function updateDenglemaConnection(
  { server, installationId, token, timezone, clearToken = false },
  configPath = CONFIG_PATH_DEFAULT,
) {
  const config = await readConfig(configPath);
  const current = config.denglema || {};
  config.denglema = {
    server: typeof server === "string" && server.trim()
      ? server.trim().replace(/\/+$/, "")
      : current.server || null,
    installationId: typeof installationId === "string" && installationId
      ? installationId
      : current.installationId || null,
    token: clearToken
      ? null
      : (typeof token === "string" && token ? token : current.token || null),
    timezone: typeof timezone === "string" && timezone
      ? timezone
      : current.timezone || null,
    autoUpload: current.autoUpload || { enabled: false, interval: null },
  };
  await writeConfig(config, configPath);
  return config.denglema;
}

export async function updateDenglemaAutoUpload(
  { enabled, interval },
  configPath = CONFIG_PATH_DEFAULT,
) {
  const config = await readConfig(configPath);
  const allowed = new Set(["1h", "3h", "6h", "1d"]);
  const nextEnabled = enabled === true;
  const nextInterval = nextEnabled
    ? String(interval || "").trim()
    : null;

  if (nextEnabled && !allowed.has(nextInterval)) {
    throw new Error("auto upload interval must be one of: 1h, 3h, 6h, 1d");
  }

  config.denglema ||= {};
  config.denglema.autoUpload = {
    enabled: nextEnabled,
    interval: nextInterval,
  };
  await writeConfig(config, configPath);
  return config.denglema.autoUpload;
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

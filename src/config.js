import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { exists } from "node:fs";

const CONFIG_PATH_DEFAULT = join(homedir(), ".codex-usage.json");

function defaultConfig() {
  return { version: 1, directories: [] };
}

function existsAsync(path) {
  return new Promise((resolve) => {
    import("node:fs").then((fs) => fs.exists(path, resolve));
  }).catch(() => false);
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
    };
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(config, configPath = CONFIG_PATH_DEFAULT) {
  await mkdir(join(configPath, ".."), { recursive: true });
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await (await import("node:fs/promises")).rename(tmp, configPath);
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

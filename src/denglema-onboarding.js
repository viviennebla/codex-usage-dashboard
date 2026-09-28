import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveDenglemaDataDir } from "./denglema-snapshot.js";

export const DENGLEMA_ONBOARDING_URL =
  "https://vimo-dev-server.taila62aff.ts.net/onboarding";
const ONBOARDING_STATE_VERSION = 1;

function statePath(options = {}, dependencies = {}) {
  return join(
    resolveDenglemaDataDir(options, dependencies),
    "onboarding-state.json",
  );
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function writeState(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

function browserCommand(url, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const env = dependencies.env || process.env;

  if (platform === "win32") {
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  }
  if (platform === "darwin") return ["open", [url]];
  if (env.WSL_DISTRO_NAME) {
    return [
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Process", url],
    ];
  }
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    return ["xdg-open", [url]];
  }
  return null;
}

export async function openDenglemaOnboarding(
  url = DENGLEMA_ONBOARDING_URL,
  dependencies = {},
) {
  const command = browserCommand(url, dependencies);
  if (!command) return false;
  const spawnFn = dependencies.spawn || spawn;

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const child = spawnFn(command[0], command[1], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once?.("error", () => done(false));
      child.once?.("spawn", () => {
        child.unref?.();
        done(true);
      });
      if (!child.once) done(true);
    } catch {
      done(false);
    }
  });
}

export async function maybeOpenDenglemaOnboarding(
  status,
  options = {},
  dependencies = {},
) {
  if (status?.bound) return { opened: false, reason: "bound" };

  const path = statePath(options, dependencies);
  const state = await readState(path);
  if (state?.version === ONBOARDING_STATE_VERSION && state?.opened_at) {
    return { opened: false, reason: "already_shown" };
  }

  const openFn = dependencies.openDenglemaOnboarding || openDenglemaOnboarding;
  const opened = await openFn(DENGLEMA_ONBOARDING_URL, dependencies);
  if (!opened) return { opened: false, reason: "unsupported" };

  const now = dependencies.now?.() || new Date();
  await writeState(path, {
    version: ONBOARDING_STATE_VERSION,
    opened_at: now.toISOString(),
    url: DENGLEMA_ONBOARDING_URL,
  });
  return { opened: true, reason: "unbound" };
}

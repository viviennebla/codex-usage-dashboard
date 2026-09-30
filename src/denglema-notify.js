import { spawnSync } from "node:child_process";

import { readConfig } from "./config.js";
import {
  readDenglemaNotificationState,
  writeDenglemaNotificationState,
} from "./denglema-snapshot.js";

function formatTokens(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function windowsToast(title, message, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.UI.Notifications.ToastTemplateType, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$title=[Environment]::GetEnvironmentVariable('DENGLEMA_NOTIFY_TITLE')",
    "$message=[Environment]::GetEnvironmentVariable('DENGLEMA_NOTIFY_MESSAGE')",
    "$template=[Windows.UI.Notifications.ToastTemplateType]::ToastText02",
    "$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
    "$texts=$xml.GetElementsByTagName('text')",
    "$null=$texts.Item(0).AppendChild($xml.CreateTextNode($title))",
    "$null=$texts.Item(1).AppendChild($xml.CreateTextNode($message))",
    "$toast=[Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenAI.Codex').Show($toast)",
  ].join("; ");

  const result = spawn("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-Command",
    script,
  ], {
    env: {
      ...(dependencies.env || process.env),
      DENGLEMA_NOTIFY_TITLE: title,
      DENGLEMA_NOTIFY_MESSAGE: message,
    },
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `Windows notification failed with status ${result.status}`);
  }
}

function macNotification(title, message, dependencies = {}) {
  const spawn = dependencies.spawnSync || spawnSync;
  const result = spawn("osascript", [
    "-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e", "end run",
    title,
    message,
  ], {
    env: dependencies.env || process.env,
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `macOS notification failed with status ${result.status}`);
  }
}

function linuxNotification(title, message, dependencies = {}) {
  const env = dependencies.env || process.env;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;

  const spawn = dependencies.spawnSync || spawnSync;
  const result = spawn("notify-send", [title, message], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });

  if (result.error?.code === "ENOENT") return false;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `Linux notification failed with status ${result.status}`);
  }
  return true;
}

export function sendDenglemaNativeNotification(title, message, dependencies = {}) {
  const platform = dependencies.platform || process.platform;

  if (platform === "win32") {
    windowsToast(title, message, dependencies);
    return true;
  }
  if (platform === "darwin") {
    macNotification(title, message, dependencies);
    return true;
  }
  if (platform === "linux") {
    return linuxNotification(title, message, dependencies);
  }
  return false;
}

export async function maybeNotifyDenglemaSnapshot(
  snapshotResult,
  options = {},
  dependencies = {},
) {
  const snapshot = snapshotResult?.snapshot;
  if (!snapshotResult?.collected || !snapshot) {
    return { notified: false, reason: "not_collected" };
  }
  if (snapshotResult.upload_status !== "pending") {
    return { notified: false, reason: "already_uploaded" };
  }
  if (Number(snapshot.total_tokens || 0) <= 0) {
    return { notified: false, reason: "empty" };
  }

  const readConfigFn = dependencies.readConfig || readConfig;
  const config = await readConfigFn(options.configPath);
  if (config.denglema?.autoUpload?.enabled === true) {
    return { notified: false, reason: "auto_upload_enabled" };
  }

  const state = await readDenglemaNotificationState(options, dependencies);
  if (state?.pending_reminder_date === snapshot.date) {
    return { notified: false, reason: "daily_reminder_sent" };
  }

  const title = "蹬了吗 · 今天还没自动更新";
  const message =
    `本地已有 ${formatTokens(snapshot.total_tokens)} tokens。可在 Codex 里开启自动更新，或说“上传蹬了吗”。`;

  const send = dependencies.sendNativeNotification || sendDenglemaNativeNotification;
  const delivered = await send(title, message, dependencies);
  if (!delivered) {
    return { notified: false, reason: "unsupported" };
  }

  const now = dependencies.now?.() || new Date();
  await writeDenglemaNotificationState({
    ...(state || {}),
    observed_at: snapshot.observed_at,
    notified_at: now.toISOString(),
    pending_reminder_date: snapshot.date,
    date: snapshot.date,
    total_tokens: Number(snapshot.total_tokens || 0),
  }, options, dependencies);

  return {
    notified: true,
    observed_at: snapshot.observed_at,
    total_tokens: Number(snapshot.total_tokens || 0),
  };
}


export async function maybeNotifyDenglemaUploadFailure(
  error,
  options = {},
  dependencies = {},
) {
  const state = await readDenglemaNotificationState(options, dependencies);
  const now = dependencies.now?.() || new Date();
  const previous = Date.parse(state?.upload_failure_notified_at || "");
  if (Number.isFinite(previous) && now.getTime() - previous < 60 * 60 * 1000) {
    return { notified: false, reason: "failure_throttled" };
  }

  const title = "蹬了吗 · 自动上传失败";
  const message = "本地 usage 快照仍然保留，稍后会自动重试。";
  const send = dependencies.sendNativeNotification || sendDenglemaNativeNotification;
  const delivered = await send(title, message, dependencies);
  if (!delivered) {
    return { notified: false, reason: "unsupported" };
  }

  await writeDenglemaNotificationState({
    ...(state || {}),
    upload_failure_notified_at: now.toISOString(),
    upload_failure_reason: error?.message ? String(error.message).slice(0, 160) : "upload failed",
  }, options, dependencies);

  return { notified: true };
}

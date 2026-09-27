import { spawnSync } from "node:child_process";

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
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$title=[Environment]::GetEnvironmentVariable('DENGLEMA_NOTIFY_TITLE')",
    "$message=[Environment]::GetEnvironmentVariable('DENGLEMA_NOTIFY_MESSAGE')",
    "$title=[System.Security.SecurityElement]::Escape($title)",
    "$message=[System.Security.SecurityElement]::Escape($message)",
    "$xml=New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>'+$title+'</text><text>'+$message+'</text></binding></visual></toast>')",
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

  const state = await readDenglemaNotificationState(options, dependencies);
  if (state?.observed_at === snapshot.observed_at) {
    return { notified: false, reason: "already_notified" };
  }

  const title = "蹬了吗 · 快照已生成";
  const message =
    `本地快照：${formatTokens(snapshot.total_tokens)} tokens。尚未上传；想上传时说“上传蹬了吗”，忽略即可继续留在本机。`;

  const send = dependencies.sendNativeNotification || sendDenglemaNativeNotification;
  const delivered = await send(title, message, dependencies);
  if (!delivered) {
    return { notified: false, reason: "unsupported" };
  }

  const now = dependencies.now?.() || new Date();
  await writeDenglemaNotificationState({
    observed_at: snapshot.observed_at,
    notified_at: now.toISOString(),
    date: snapshot.date,
    total_tokens: Number(snapshot.total_tokens || 0),
  }, options, dependencies);

  return {
    notified: true,
    observed_at: snapshot.observed_at,
    total_tokens: Number(snapshot.total_tokens || 0),
  };
}

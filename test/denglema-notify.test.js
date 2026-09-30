import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maybeNotifyDenglemaSnapshot,
  maybeNotifyDenglemaUploadFailure,
  sendDenglemaNativeNotification,
} from "../src/denglema-notify.js";
import { readDenglemaNotificationState } from "../src/denglema-snapshot.js";

async function withTempData(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), "denglema-notify-"));
  try {
    return await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function pendingSnapshot(total = 1234) {
  return {
    collected: true,
    upload_status: "pending",
    snapshot: {
      schema_version: 1,
      observed_at: "2026-09-27T12:00:00.000Z",
      date: "2026-09-27",
      total_tokens: total,
      timezone: "Asia/Shanghai",
    },
  };
}

test("new pending snapshot notifies once and persists notification state", async () => withTempData(async (dataDir) => {
  let calls = 0;
  let notification;
  const dependencies = {
    env: {},
    now: () => new Date("2026-09-27T12:01:00Z"),
    readConfig: async () => ({ denglema: { autoUpload: { enabled: false, interval: null } } }),
    sendNativeNotification: async (title, message) => {
      calls += 1;
      notification = { title, message };
      return true;
    },
  };

  const first = await maybeNotifyDenglemaSnapshot(
    pendingSnapshot(123456),
    { dataDir },
    dependencies,
  );
  assert.equal(first.notified, true);
  assert.equal(calls, 1);
  assert.match(notification.title, /蹬了吗/);
  assert.match(notification.message, /123,456/);

  const state = await readDenglemaNotificationState({ dataDir }, { env: {} });
  assert.equal(state.observed_at, "2026-09-27T12:00:00.000Z");
  assert.equal(state.total_tokens, 123456);

  const second = await maybeNotifyDenglemaSnapshot(
    pendingSnapshot(123456),
    { dataDir },
    dependencies,
  );
  assert.equal(second.notified, false);
  assert.equal(second.reason, "daily_reminder_sent");
  assert.equal(calls, 1);
}));

test("new observation with no token growth does not notify again", async () => withTempData(async (dataDir) => {
  let calls = 0;
  const dependencies = {
    env: {},
    now: () => new Date("2026-09-27T13:01:00Z"),
    readConfig: async () => ({ denglema: { autoUpload: { enabled: false, interval: null } } }),
    sendNativeNotification: async () => {
      calls += 1;
      return true;
    },
  };

  await maybeNotifyDenglemaSnapshot(
    pendingSnapshot(500),
    { dataDir },
    dependencies,
  );

  const later = {
    ...pendingSnapshot(500),
    snapshot: {
      ...pendingSnapshot(500).snapshot,
      observed_at: "2026-09-27T13:00:00.000Z",
    },
  };
  const result = await maybeNotifyDenglemaSnapshot(
    later,
    { dataDir },
    dependencies,
  );

  assert.equal(result.notified, false);
  assert.equal(result.reason, "daily_reminder_sent");
  assert.equal(calls, 1);
}));

test("uploaded and empty snapshots do not notify", async () => withTempData(async (dataDir) => {
  let calls = 0;
  const dependencies = {
    env: {},
    readConfig: async () => ({ denglema: { autoUpload: { enabled: false, interval: null } } }),
    sendNativeNotification: async () => {
      calls += 1;
      return true;
    },
  };

  const uploaded = await maybeNotifyDenglemaSnapshot({
    ...pendingSnapshot(10),
    upload_status: "uploaded",
  }, { dataDir }, dependencies);
  assert.equal(uploaded.reason, "already_uploaded");

  const empty = await maybeNotifyDenglemaSnapshot(
    pendingSnapshot(0),
    { dataDir },
    dependencies,
  );
  assert.equal(empty.reason, "empty");
  assert.equal(calls, 0);
}));

test("unsupported native notification does not mark snapshot as notified", async () => withTempData(async (dataDir) => {
  const result = await maybeNotifyDenglemaSnapshot(
    pendingSnapshot(99),
    { dataDir },
    {
      env: {},
      sendNativeNotification: async () => false,
    },
  );
  assert.equal(result.notified, false);
  assert.equal(result.reason, "unsupported");
  assert.equal(
    await readDenglemaNotificationState({ dataDir }, { env: {} }),
    null,
  );
}));

test("native notification dispatch uses platform-specific commands", () => {
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  };

  assert.equal(sendDenglemaNativeNotification("title", "body", {
    platform: "win32",
    env: {},
    spawnSync,
  }), true);
  assert.equal(calls[0].command, "powershell.exe");

  calls.length = 0;
  assert.equal(sendDenglemaNativeNotification("title", "body", {
    platform: "darwin",
    env: {},
    spawnSync,
  }), true);
  assert.equal(calls[0].command, "osascript");

  calls.length = 0;
  assert.equal(sendDenglemaNativeNotification("title", "body", {
    platform: "linux",
    env: {},
    spawnSync,
  }), false);
  assert.equal(calls.length, 0);
});


test("auto upload suppresses pending snapshot reminders", async () => withTempData(async (dataDir) => {
  let calls = 0;
  const result = await maybeNotifyDenglemaSnapshot(
    pendingSnapshot(777),
    { dataDir },
    {
      env: {},
      readConfig: async () => ({
        denglema: { autoUpload: { enabled: true, interval: "3h" } },
      }),
      sendNativeNotification: async () => {
        calls += 1;
        return true;
      },
    },
  );

  assert.equal(result.notified, false);
  assert.equal(result.reason, "auto_upload_enabled");
  assert.equal(calls, 0);
}));

test("auto upload failure notification is throttled for one hour", async () => withTempData(async (dataDir) => {
  let calls = 0;
  let now = new Date("2026-09-27T12:00:00Z");
  const dependencies = {
    env: {},
    now: () => now,
    sendNativeNotification: async (title, message) => {
      calls += 1;
      assert.match(title, /自动上传失败/);
      assert.match(message, /稍后会自动重试/);
      return true;
    },
  };

  const first = await maybeNotifyDenglemaUploadFailure(
    new Error("network down"),
    { dataDir },
    dependencies,
  );
  assert.equal(first.notified, true);
  assert.equal(calls, 1);

  now = new Date("2026-09-27T12:30:00Z");
  const second = await maybeNotifyDenglemaUploadFailure(
    new Error("network down"),
    { dataDir },
    dependencies,
  );
  assert.equal(second.notified, false);
  assert.equal(second.reason, "failure_throttled");
  assert.equal(calls, 1);

  now = new Date("2026-09-27T13:01:00Z");
  const third = await maybeNotifyDenglemaUploadFailure(
    new Error("still down"),
    { dataDir },
    dependencies,
  );
  assert.equal(third.notified, true);
  assert.equal(calls, 2);
}));

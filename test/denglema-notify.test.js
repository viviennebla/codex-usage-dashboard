import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  maybeNotifyDenglemaSnapshot,
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
  assert.equal(second.reason, "already_notified");
  assert.equal(calls, 1);
}));

test("uploaded and empty snapshots do not notify", async () => withTempData(async (dataDir) => {
  let calls = 0;
  const dependencies = {
    env: {},
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

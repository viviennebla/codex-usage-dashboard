import assert from "node:assert/strict";
import test from "node:test";

import { mergeWithDeviceStates } from "../src/headless.js";

test("headless merge includes remote usage but preserves local account state", async () => {
  const aggregate = (tokens) => ({ totalTokens: tokens, models: {} });
  const local = {
    today: aggregate(20),
    totals: aggregate(40),
    models: {},
    limits: { primary: { used_percent: 10 } },
    active_session: { sessionId: "local-session" },
    skills: [{ name: "local-skill" }],
  };
  const remote = {
    today: aggregate(30),
    totals: aggregate(60),
    models: {},
    limits: { primary: { used_percent: 90 } },
    active_session: { sessionId: "remote-session" },
  };
  const merged = await mergeWithDeviceStates(local, {
    localName: "local",
    config: {},
    remoteDevices: new Map([["remote", { deviceName: "remote", snapshot: remote }]]),
  });

  assert.equal(merged.today.totalTokens, 50);
  assert.equal(merged.totals.totalTokens, 100);
  assert.deepEqual(merged.limits, local.limits);
  assert.deepEqual(merged.active_session, local.active_session);
  assert.deepEqual(merged.skills, local.skills);
  assert.equal(merged.devices.length, 2);
});

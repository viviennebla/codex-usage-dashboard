import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot } from "../src/snapshot.js";

function localDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

test("derives model tokens and requests from the same raw events", () => {
  const now = new Date();
  const date = localDate(now);
  const model = "deepseek-v4-pro";
  const usage = { totalTokens: 30, models: { [model]: { totalTokens: 999, eventCount: 999 } } };
  const events = [
    { timestamp: now.toISOString(), model, totalTokens: 10 },
    { timestamp: new Date(now.getTime() - 1_000).toISOString(), model, totalTokens: 20 },
  ];

  const snapshot = buildSnapshot({
    events,
    daily: { daily: [{ date, ...usage }], totals: usage },
    sessions: { sessions: [{ ...usage, sessionId: "session-1", lastActivity: now.toISOString() }] },
    projects: { projects: [] },
    tool: {},
  });

  assert.equal(snapshot.today.models[model].eventCount, 2);
  assert.equal(snapshot.today.models[model].totalTokens, 30);
  assert.equal(snapshot.totals.models[model].eventCount, 2);
  assert.equal(snapshot.totals.models[model].totalTokens, 30);
  assert.equal(snapshot.models[model].eventCount, 2);
  assert.equal(snapshot.models[model].totalTokens, 30);
});

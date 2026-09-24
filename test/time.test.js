import assert from "node:assert/strict";
import test from "node:test";

import { startOfDayInstant } from "../src/time.js";

test("startOfDayInstant converts a leaderboard date to the correct UTC instant", () => {
  assert.equal(
    startOfDayInstant("2026-09-24", "Asia/Shanghai"),
    "2026-09-23T16:00:00.000Z",
  );
  assert.equal(
    startOfDayInstant("2026-09-24", "UTC"),
    "2026-09-24T00:00:00.000Z",
  );
});

test("startOfDayInstant handles daylight saving offsets", () => {
  assert.equal(
    startOfDayInstant("2026-07-01", "America/Los_Angeles"),
    "2026-07-01T07:00:00.000Z",
  );
  assert.equal(
    startOfDayInstant("2026-01-01", "America/Los_Angeles"),
    "2026-01-01T08:00:00.000Z",
  );
});

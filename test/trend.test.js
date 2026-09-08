import assert from "node:assert/strict";
import test from "node:test";

import { alignedTrendDays } from "../public/trend.js";

test("aligns trend rows to a shared date window and pads later zero days", () => {
  const rows = [
    { date: "2026-09-02", totalTokens: 20, eventCount: 2 },
    { date: "2026-09-04", totalTokens: 40, eventCount: 4 },
  ];
  const result = alignedTrendDays(rows, "2026-09-06", 5);

  assert.deepEqual(result.map((row) => row.date), [
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
    "2026-09-05",
    "2026-09-06",
  ]);
  assert.deepEqual(result.map((row) => row.totalTokens), [20, 0, 40, 0, 0]);
});

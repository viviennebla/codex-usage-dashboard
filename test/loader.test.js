import assert from "node:assert/strict";
import test from "node:test";
import { aggregateEvents } from "../src/loader.js";

test("counts each token event in its model request total", () => {
  const total = aggregateEvents([
    { model: "gpt-5.5", inputTokens: 10, totalTokens: 10 },
    { model: "gpt-5.5", inputTokens: 20, totalTokens: 20 },
    { model: "gpt-5.6-terra", inputTokens: 30, totalTokens: 30 },
  ]);

  assert.equal(total.models["gpt-5.5"].eventCount, 2);
  assert.equal(total.models["gpt-5.6-terra"].eventCount, 1);
});

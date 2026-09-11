import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";

import { resolveCodexHomes } from "../src/sources.js";

test("CODEX_HOME entries are included in resolved Codex homes", async () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = ["/opt/codex-one", "/opt/codex-two"].join(delimiter);
  try {
    assert.deepEqual(await resolveCodexHomes([], { noWsl: true }), [
      "/opt/codex-one",
      "/opt/codex-two",
    ]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("a confirmed registered Codex directory loads without CODEX_HOME", async () => {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    assert.deepEqual(await resolveCodexHomes([
      { path: "/home/test/.codex", type: "codex" },
    ], { includeDefaults: false, noWsl: true }), [
      "/home/test/.codex",
    ]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadClaudeReports } from "../src/claude.js";
import { FileParseCache } from "../src/file-cache.js";

function assistant(id, timestamp, inputTokens, outputTokens) {
  return {
    type: "assistant",
    timestamp,
    sessionId: "session-1",
    message: {
      id,
      model: "claude-test",
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

test("incrementally parses appended Claude JSONL records", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-usage-incremental-"));
  const project = join(root, "projects", "-tmp-project");
  await mkdir(project, { recursive: true });
  const file = join(project, "session.jsonl");
  await writeFile(file, `${JSON.stringify(assistant("m1", "2026-09-09T00:01:00.000Z", 10, 2))}\n`);
  const fileCache = new FileParseCache();
  const options = { claudeRoots: [root], fileCache, timezone: "UTC" };

  const first = await loadClaudeReports(options);
  await appendFile(file, `${JSON.stringify(assistant("m2", "2026-09-09T00:02:00.000Z", 20, 3))}\n`);
  const incremental = await loadClaudeReports(options);
  const full = await loadClaudeReports({ ...options, fileCache: null });

  assert.equal(first.events.length, 1);
  assert.equal(incremental.events.length, 2);
  assert.equal(fileCache.stats().incrementalParses, 1);
  assert.deepEqual(incremental.events, full.events);
  assert.deepEqual(incremental.daily, full.daily);
});

import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileParseCache } from "../src/file-cache.js";

test("reuses unchanged file parse results and reparses changed files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-cache-"));
  const file = join(directory, "session.jsonl");
  const cache = new FileParseCache();
  let parses = 0;
  const parse = async () => ({ value: ++parses });

  await writeFile(file, "first\n");
  assert.deepEqual(await cache.get("codex", file, "context", parse), { value: 1 });
  assert.deepEqual(await cache.get("codex", file, "context", parse), { value: 1 });

  await writeFile(file, "second value\n");
  assert.deepEqual(await cache.get("codex", file, "context", parse), { value: 2 });
});

test("incremental cache parses appended bytes and falls back when the prefix changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-usage-incremental-cache-"));
  const file = join(directory, "session.jsonl");
  const cache = new FileParseCache();
  await writeFile(file, "first\n");

  const full = async ({ start, end }) => ({ text: `full:${start}-${end}`, chunks: 1 });
  const append = async (previous, { start, end }) => ({
    text: previous.text,
    chunks: previous.chunks + 1,
    range: `${start}-${end}`,
  });
  const initial = await cache.getIncremental("codex", file, "context", { full, append });
  await appendFile(file, "second\n");
  const appended = await cache.getIncremental("codex", file, "context", { full, append });

  assert.equal(initial.chunks, 1);
  assert.equal(appended.chunks, 2);
  assert.equal(appended.range, "6-12");
  assert.equal(cache.stats().incrementalParses, 1);
  assert.equal(cache.stats().bytesSkipped, 6);

  await writeFile(file, "changed prefix and a longer replacement\n");
  const replaced = await cache.getIncremental("codex", file, "context", { full, append });
  assert.equal(replaced.chunks, 1);
  assert.equal(cache.stats().fullParses, 2);
});

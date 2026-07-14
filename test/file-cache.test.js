import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

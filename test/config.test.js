import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readConfig,
  resolveSyncConnection,
  updateSyncConnection,
  writeConfig,
} from "../src/config.js";

test("sync connection is persisted in a private local config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "usage-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");

  await writeConfig({ version: 1, directories: [], pricing: {}, sync: { server: null, token: null } }, path);
  await updateSyncConnection({ server: "https://sync.example/", token: "saved-token" }, path);

  const config = await readConfig(path);
  assert.deepEqual(config.sync, { server: "https://sync.example", token: "saved-token" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).sync.token, "saved-token");

  await updateSyncConnection({ server: "https://other.example" }, path);
  assert.equal((await readConfig(path)).sync.token, "saved-token");
});

test("explicit and environment values override saved sync settings", () => {
  const config = { sync: { server: "https://saved.example", token: "saved" } };
  assert.deepEqual(resolveSyncConnection({}, config, {}), {
    server: "https://saved.example",
    token: "saved",
  });
  assert.deepEqual(resolveSyncConnection(
    { server: "https://flag.example", token: "flag" },
    config,
    { DASHBOARD_TOKEN: "env" },
  ), {
    server: "https://flag.example",
    token: "flag",
  });
  assert.equal(resolveSyncConnection({}, config, { DASHBOARD_TOKEN: "env" }).token, "env");
});

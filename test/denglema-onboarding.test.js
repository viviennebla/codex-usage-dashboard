import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DENGLEMA_ONBOARDING_URL,
  maybeOpenDenglemaOnboarding,
  openDenglemaOnboarding,
} from "../src/denglema-onboarding.js";

test("bound installations never open onboarding", async () => {
  let opens = 0;
  const result = await maybeOpenDenglemaOnboarding(
    { bound: true },
    {},
    { openDenglemaOnboarding: async () => { opens += 1; return true; } },
  );
  assert.deepEqual(result, { opened: false, reason: "bound" });
  assert.equal(opens, 0);
});

test("unbound installation opens onboarding only once", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "denglema-onboarding-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  let opens = 0;
  const dependencies = {
    env: { PLUGIN_DATA: dataDir },
    now: () => new Date("2026-09-28T03:00:00Z"),
    openDenglemaOnboarding: async (url) => {
      opens += 1;
      assert.equal(url, DENGLEMA_ONBOARDING_URL);
      return true;
    },
  };

  const first = await maybeOpenDenglemaOnboarding({ bound: false }, {}, dependencies);
  const second = await maybeOpenDenglemaOnboarding({ bound: false }, {}, dependencies);
  assert.deepEqual(first, { opened: true, reason: "unbound" });
  assert.deepEqual(second, { opened: false, reason: "already_shown" });
  assert.equal(opens, 1);

  const state = JSON.parse(await readFile(join(dataDir, "onboarding-state.json"), "utf8"));
  assert.equal(state.version, 1);
  assert.equal(state.opened_at, "2026-09-28T03:00:00.000Z");
});

test("Windows onboarding uses the default URL handler", async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  let seen = null;

  const promise = openDenglemaOnboarding("https://example.test/onboarding", {
    platform: "win32",
    spawn(command, args, options) {
      seen = { command, args, options };
      setImmediate(() => child.emit("spawn"));
      return child;
    },
  });

  assert.equal(await promise, true);
  assert.equal(seen.command, "rundll32.exe");
  assert.deepEqual(seen.args, [
    "url.dll,FileProtocolHandler",
    "https://example.test/onboarding",
  ]);
  assert.equal(seen.options.windowsHide, true);
});

import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  confirmDetectedSources,
  configureConnection,
  createTerminalPrompter,
  runInteractiveCli,
  runInteractiveSkillsCli,
} from "../src/interactive-cli.js";

test("interactive CLI confirms and imports detected default sources", async () => {
  const calls = [];
  const prompt = {
    confirm: async (label, defaultYes, details) => {
      calls.push(["confirm", label, defaultYes, details]);
      return true;
    },
    page: (title) => calls.push(["page", title]),
    working: (message) => calls.push(["working", message]),
    success: (message) => calls.push(["success", message]),
    pause: async () => calls.push(["pause"]),
  };
  const added = [];

  const imported = await confirmDetectedSources(prompt, {
    readConfig: async () => ({ directories: [] }),
    discoverSourceDiagnostics: async () => [
      { path: "/home/test/.codex", normalized_path: "/home/test/.codex", type: "codex", status: "ok", files_found: 12, display_name: "Linux" },
      { path: "/home/test/.claude", type: "claude", status: "empty", files_found: 0 },
    ],
    addDirectory: async (...args) => {
      added.push(args);
      return { added: true };
    },
  });

  assert.equal(imported.length, 1);
  assert.deepEqual(added, [["/home/test/.codex", "codex", "Linux"]]);
  assert.equal(calls[0][0], "confirm");
  assert.equal(calls[0][2], false);
  assert.match(calls[0][3][0], /12 JSONL files/);
  assert.deepEqual(calls.slice(-3).map((call) => call[0]), ["working", "success", "pause"]);
});

test("terminal menu uses arrow keys, Enter, and ANSI highlighting", async (t) => {
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  t.after(() => {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  });
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (enabled) => { input.isRaw = enabled; };
  let rendered = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      rendered += chunk.toString();
      callback();
    },
  });
  output.isTTY = true;
  output.columns = 80;
  const prompt = createTerminalPrompter(input, output);
  prompt.open();

  const selected = prompt.select("Menu", [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
  ]);
  input.write("\x1b[B");
  input.write("\r");

  assert.equal(await selected, "second");
  assert.equal(input.isRaw, false);
  assert.match(rendered, /↑\/↓ move/);
  assert.match(rendered, /\x1b\[1;30;46m/);

  const submenu = prompt.select("Submenu", [
    { value: "back", label: "Back" },
  ]);
  input.write("\r");
  assert.equal(await submenu, "back");
  assert.match(rendered, /\x1b\[H\x1b\[2J\x1b\[1;36mSubmenu/);

  const paused = prompt.pause();
  input.write("\x1b[A");
  input.write("\r");
  await paused;
  assert.equal(input.isRaw, false);

  prompt.close();
  assert.equal(input.isPaused(), true);
  assert.match(rendered, /\x1b\[\?1049h/);
  assert.match(rendered, /\x1b\[\?1049l/);
  assert.match(rendered, /\x1b\[H\x1b\[2J\x1b\[1;36mMenu/);
});

test("interactive connection setup keeps secrets out of status output", async () => {
  const messages = [];
  let update;
  const prompt = {
    text: async () => "https://sync.example/",
    secret: async () => "super-secret",
    write: (message) => messages.push(message),
  };

  const result = await configureConnection(prompt, {
    readConfig: async () => ({ sync: { server: null, token: null } }),
    updateSyncConnection: async (value) => {
      update = value;
      return { server: "https://sync.example", token: value.token };
    },
  });

  assert.equal(update.token, "super-secret");
  assert.equal(result.token, "super-secret");
  assert.doesNotMatch(messages.join("\n"), /super-secret/);
  assert.match(messages.join("\n"), /token configured/);
});

test("blank interactive token keeps an existing saved token", async () => {
  let update;
  const prompt = {
    text: async (_label, defaultValue) => defaultValue,
    secret: async () => "",
    write: () => {},
  };
  await configureConnection(prompt, {
    readConfig: async () => ({ sync: { server: "https://sync.example", token: "saved" } }),
    updateSyncConnection: async (value) => {
      update = value;
      return { server: value.server, token: "saved" };
    },
  });
  assert.equal(update.token, undefined);
  assert.equal(update.clearToken, false);
});

test("interactive CLI runs selected actions and returns to the menu", async () => {
  const selections = ["1", "0"];
  let clearCount = 0;
  let pauseCount = 0;
  let usageCount = 0;
  const prompt = {
    clear: () => { clearCount += 1; },
    write: () => {},
    select: async () => selections.shift(),
    pause: async () => { pauseCount += 1; },
  };

  const code = await runInteractiveCli({}, {
    showUsage: async () => { usageCount += 1; },
    pushUsage: async () => {},
    pullUsage: async () => {},
  }, {
    prompt,
    readConfig: async () => ({ sync: { server: null, token: null } }),
    env: {},
  });

  assert.equal(code, 0);
  assert.equal(usageCount, 1);
  assert.equal(pauseCount, 1);
  assert.equal(clearCount, 0);
});

test("interactive push and pull show working and terminal states", async () => {
  const selections = ["2", "3", "0"];
  const states = [];
  const prompt = {
    write: () => {},
    select: async () => selections.shift(),
    page: (title) => states.push(`page:${title}`),
    working: (message) => states.push(`working:${message}`),
    success: (message) => states.push(`success:${message}`),
    warning: (message) => states.push(`warning:${message}`),
    error: (message) => states.push(`error:${message}`),
    pause: async () => {},
  };

  await runInteractiveCli({}, {
    showUsage: async () => {},
    pushUsage: async () => ({ ok: true }),
    pullUsage: async () => ({ ok: true, status: "success", failed: [] }),
  }, {
    prompt,
    readConfig: async () => ({ sync: { server: "https://sync.example", token: "saved" } }),
    env: {},
  });

  assert.deepEqual(states, [
    "page:Push usage snapshot",
    "working:Working…",
    "success:Done · Usage snapshot pushed.",
    "page:Pull usage snapshots",
    "working:Working…",
    "success:Done · Usage snapshots pulled.",
  ]);
});

test("interactive Skill push and pull show working and done states", async () => {
  const selections = ["2", "1", "3", "0"];
  const states = [];
  const prompt = {
    select: async () => selections.shift(),
    confirm: async () => true,
    page: (title) => states.push(`page:${title}`),
    working: (message) => states.push(`working:${message}`),
    success: (message) => states.push(`success:${message}`),
    warning: (message) => states.push(`warning:${message}`),
    error: (message) => states.push(`error:${message}`),
    pause: async () => {},
  };

  await runInteractiveSkillsCli({}, prompt, {
    readConfig: async () => ({
      directories: [{ path: "/skills", type: "skills" }],
      sync: { server: "https://sync.example", token: "saved" },
    }),
    env: {},
    runSkillsCli: async (options, runDependencies = {}) => {
      if (options.skillsAction === "pull") {
        await runDependencies.confirm("Apply these Skill bundle changes?", {
          target_dir: "/skills",
          strategy: "merge",
          summary: { add: 1 },
        });
      }
      return 0;
    },
  });

  assert.deepEqual(states.filter((state) => state.startsWith("working:")), [
    "working:Pulling…",
    "working:Applying…",
    "working:Pushing…",
  ]);
  assert.deepEqual(states.filter((state) => state.startsWith("success:")), [
    "success:Done · Skill bundle pull finished.",
    "success:Done · Skill bundle pushed.",
  ]);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatSkillPlan, hasSkillPlanChanges, resolveSkillSourcePath, runSkillsCli } from "../src/skills-cli.js";

test("resolves an explicit or single configured skill source path", () => {
  const directories = [{ type: "skills", path: "/srv/skills" }];
  assert.equal(resolveSkillSourcePath(directories), "/srv/skills");
  assert.equal(resolveSkillSourcePath([], "/tmp/skills"), "/tmp/skills");
  assert.throws(() => resolveSkillSourcePath([]), /pass --path/);
  assert.throws(() => resolveSkillSourcePath([
    { type: "skills", path: "/one" },
    { type: "skills", path: "/two" },
  ]), /Multiple/);
});

test("formats a non-interactive skill pull plan", () => {
  const plan = {
    target_dir: "/srv/skills",
    strategy: "merge",
    add: ["common/new.md"],
    update: ["SKILL_BUNDLE.md"],
    remove: [],
    unchanged: ["common/same.md"],
    summary: { add: 1, update: 1, remove: 0, unchanged: 1 },
  };
  assert.equal(hasSkillPlanChanges(plan), true);
  assert.match(formatSkillPlan(plan), /Changes: \+1 ~1 -0 =1/);
  assert.match(formatSkillPlan(plan), /Add: common\/new\.md/);
  assert.equal(hasSkillPlanChanges({ summary: {} }), false);
});

test("skill commands read the saved local server and token", async () => {
  let request;
  const code = await runSkillsCli({ skillsAction: "list", json: true }, {
    config: {
      directories: [],
      sync: { server: "https://saved.example", token: "saved-token" },
    },
    env: {},
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response("[]", { status: 200 });
    },
    output: () => {},
  });
  assert.equal(code, 0);
  assert.equal(request.url, "https://saved.example/api/skills");
  assert.equal(request.options.headers.authorization, "Bearer saved-token");
});

test("skill pull previews by default and applies only with --yes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skills-cli-pull-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = {
    files: [
      { path: "SKILL_BUNDLE.md", content: "# Rules\n" },
      { path: "common/demo.md", content: "# Demo\n" },
    ],
    skills: [{ name: "demo", source_markdown: "common/demo.md" }],
  };
  const fetchImpl = async () => new Response(JSON.stringify(bundle), { status: 200 });
  const previewOutput = [];
  const previewCode = await runSkillsCli({
    skillsAction: "pull",
    server: "https://sync.example",
    path: root,
    json: true,
  }, {
    config: { directories: [] },
    fetchImpl,
    output: (text) => previewOutput.push(text),
  });
  assert.equal(previewCode, 2);
  assert.equal(JSON.parse(previewOutput.join("")).confirmation_required, true);
  await assert.rejects(readFile(join(root, "common", "demo.md"), "utf8"), /ENOENT/);

  const applyOutput = [];
  const applyCode = await runSkillsCli({
    skillsAction: "pull",
    server: "https://sync.example",
    path: root,
    yes: true,
    json: true,
  }, {
    config: { directories: [] },
    fetchImpl,
    output: (text) => applyOutput.push(text),
  });
  assert.equal(applyCode, 0);
  assert.equal(JSON.parse(applyOutput.join("")).applied, true);
  assert.equal(await readFile(join(root, "common", "demo.md"), "utf8"), "# Demo\n");
});

test("interactive confirmation applies a skill pull without --yes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skills-cli-confirm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = {
    files: [{ path: "common/demo.md", content: "# Demo\n" }],
    skills: [{ name: "demo", source_markdown: "common/demo.md" }],
  };
  let confirmations = 0;
  const code = await runSkillsCli({
    skillsAction: "pull",
    server: "https://sync.example",
    path: root,
  }, {
    config: { directories: [] },
    fetchImpl: async () => new Response(JSON.stringify(bundle), { status: 200 }),
    output: () => {},
    confirm: async () => {
      confirmations += 1;
      return true;
    },
  });
  assert.equal(code, 0);
  assert.equal(confirmations, 1);
  assert.equal(await readFile(join(root, "common", "demo.md"), "utf8"), "# Demo\n");
});

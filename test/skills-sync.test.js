import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applySkillBundleToDir,
  buildCodexSkillInstallPrompt,
  canonicalSkillMarkdown,
  compareSkills,
  importSkillMarkdown,
  scanSkillBundleDir,
  readImportedSkills,
  scanAgentSkillRoot,
  scanSkillDir,
  SKILL_BUNDLE_FILE,
} from "../src/skills-sync.js";

test("prefers SKILL.md when normalizing a multi-file skill", () => {
  const result = canonicalSkillMarkdown("demo", {
    "docs/notes.md": "notes",
    "SKILL.md": "# Demo\n\nInstructions",
    "scripts/run.sh": "echo no",
  });

  assert.equal(result.markdown, "# Demo\n\nInstructions\n");
  assert.equal(result.source_markdown, "SKILL.md");
  assert.equal(result.markdown_file_count, 2);
  assert.equal(result.ignored_file_count, 1);
});

test("recursively identifies each Markdown filename as a skill name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skills-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "common", "nested"), { recursive: true });
  await writeFile(join(root, "common", "nested", "portable-skill.md"), "# Portable\n", "utf8");
  await writeFile(join(root, "common", "AGENTS.md"), "not a skill", "utf8");
  await writeFile(join(root, SKILL_BUNDLE_FILE), "not a skill", "utf8");
  await writeFile(join(root, "_template.md"), "not a skill", "utf8");

  const skills = await scanSkillDir(root);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "portable-skill");
  assert.equal(skills[0].markdown, "# Portable\n");
  assert.equal(skills[0].source_markdown, "common/nested/portable-skill.md");
  assert.equal("files" in skills[0], false);
});

test("imports legacy file payloads into a Markdown staging manifest", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "skills-import-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const record = await importSkillMarkdown({
    name: "legacy/skill",
    files: { "SKILL.md": "# Legacy\n", "run.sh": "exit 1" },
    sha256: "remote-hash",
    last_modified: "2026-07-13T00:00:00.000Z",
  }, stateDir, "https://sync.example");

  const imported = await readImportedSkills(stateDir);
  assert.deepEqual(imported, [record]);
  assert.equal(record.install_status, "pending-agent-install");
  assert.equal(await readFile(join(stateDir, "imported-skills", record.markdown_file), "utf8"), "# Legacy\n");
  assert.equal(record.markdown_file, "legacy_skill.md");
});

test("uses the imported Markdown filename as the portable skill name", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "skills-filename-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const record = await importSkillMarkdown({ name: "reviewer", markdown: "# Reviewer\n" }, stateDir);
  assert.equal(record.markdown_file, "reviewer.md");
});

test("recognizes installed Agent skills from skill-name/SKILL.md", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agent-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested", "reviewer"), { recursive: true });
  await writeFile(join(root, "nested", "reviewer", "SKILL.md"), "# Reviewer\n", "utf8");
  await writeFile(join(root, "nested", "reviewer.md"), "not installed structure", "utf8");

  const installations = await scanAgentSkillRoot(root, "codex");
  assert.equal(installations.length, 1);
  assert.equal(installations[0].name, "reviewer");
  assert.equal(installations[0].agent, "codex");
});

test("keeps sync state separate from pending Agent installation", () => {
  const remote = { name: "demo", sha256: "new", last_modified: "2026-07-13T00:00:00.000Z" };
  const pending = { name: "demo", sha256: "new", install_status: "pending-agent-install" };
  const [result] = compareSkills([], [remote], [pending]);

  assert.equal(result.status, "remote-only");
  assert.equal(result.install_status, "pending-agent-install");
});

test("matches Agent installation status by skill name without case sensitivity", () => {
  const local = { name: "Reviewer", sha256: "same", last_modified: "2026-07-13T00:00:00.000Z" };
  const remote = { name: "reviewer", sha256: "same", last_modified: "2026-07-13T00:00:00.000Z" };
  const installation = { name: "REVIEWER", agent: "codex", installed_file: "/skills/REVIEWER/SKILL.md" };
  const [result] = compareSkills([local], [remote], [], [installation]);

  assert.equal(result.status, "same");
  assert.equal(result.install_status, "installed");
  assert.deepEqual(result.installations, [installation]);
  assert.equal(result.name, "Reviewer");
});

test("does not treat a synchronized Markdown source as installed", () => {
  const local = { name: "reviewer", sha256: "same", last_modified: "2026-07-13T00:00:00.000Z" };
  const [result] = compareSkills([local], []);
  assert.equal(result.status, "local-only");
  assert.equal(result.install_status, "not-installed");
});

test("refuses to build a Codex install prompt without a configured skills source", async () => {
  await assert.rejects(
    buildCodexSkillInstallPrompt(["reviewer"], []),
    /No skill source directory is configured/,
  );
});

test("builds a Codex install prompt from a configured source bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skills-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "common"), { recursive: true });
  await writeFile(join(root, SKILL_BUNDLE_FILE), "# Skill bundle rules\n", "utf8");
  await writeFile(join(root, "common", "reviewer.md"), "# Reviewer\n\n## Source Metadata\n\n- Source name: `reviewer`\n- Trigger: review code\n", "utf8");

  const result = await buildCodexSkillInstallPrompt(["reviewer"], [{ path: root, type: "skills" }]);

  assert.equal(result.target_runtime, "codex");
  assert.deepEqual(result.skills, ["reviewer"]);
  assert.match(result.prompt, /Target runtime: Codex/);
  assert.match(result.prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.prompt, /- reviewer \(common\/reviewer\.md\)/);
  assert.match(result.prompt, /read SKILL_BUNDLE\.md first/);
});

test("skill bundle snapshots include manager rules and omit local junk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skills-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "common"), { recursive: true });
  await writeFile(join(root, SKILL_BUNDLE_FILE), "# Bundle\n", "utf8");
  await writeFile(join(root, "common", "reviewer.md"), "# Reviewer\n", "utf8");
  await writeFile(join(root, ".DS_Store"), "junk", "utf8");

  const bundle = await scanSkillBundleDir(root);
  assert.deepEqual(bundle.files.map((file) => file.path).sort(), [SKILL_BUNDLE_FILE, "common/reviewer.md"].sort());
  assert.equal(bundle.skills.length, 1);
  assert.equal(bundle.skills[0].name, "reviewer");
});

test("applying a skill bundle makes the local source directory match managed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skills-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "common"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "# Old rules\n", "utf8");
  await writeFile(join(root, "common", "old.md"), "# Old\n", "utf8");

  await applySkillBundleToDir({
    files: [
      { path: SKILL_BUNDLE_FILE, content: "# New rules\n" },
      { path: "common/reviewer.md", content: "# Reviewer\n" },
    ],
  }, root);

  await assert.rejects(readFile(join(root, "AGENTS.md"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(root, "common", "old.md"), "utf8"), /ENOENT/);
  assert.equal(await readFile(join(root, SKILL_BUNDLE_FILE), "utf8"), "# New rules\n");
  assert.equal(await readFile(join(root, "common", "reviewer.md"), "utf8"), "# Reviewer\n");
});

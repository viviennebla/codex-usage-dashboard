import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolveClaudeRoots, resolveCodexHomes } from "./sources.js";

const IMPORT_DIR = "imported-skills";
const IMPORT_MANIFEST = "index.json";
const STORED_BUNDLE_FILE = "skills-bundle.json";
export const SKILL_BUNDLE_FILE = "SKILL_BUNDLE.md";

function expandHome(path) {
  if (path.startsWith("~")) return join(homedir(), path.slice(1));
  return path;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

function safeMarkdownFileName(name) {
  const stem = String(name)
    .replace(/\.md$/i, "")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+/, "")
    .trim() || "skill";
  return `${stem}.md`;
}

const NON_SKILL_MARKDOWN = new Set(["agents.md", "skill_bundle.md", "readme.md", "changelog.md", "license.md"]);
const BUNDLE_IGNORED_NAMES = new Set([".DS_Store"]);
const BUNDLE_IGNORED_DIRS = new Set([".git", "node_modules"]);

function isSkillMarkdown(filename) {
  const lower = filename.toLowerCase();
  return lower.endsWith(".md")
    && !NON_SKILL_MARKDOWN.has(lower)
    && !filename.startsWith("_")
    && !filename.startsWith(".");
}

function skillNameFromFile(filename) {
  return basename(filename, extname(filename));
}

function safeBundlePath(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Unsafe bundle path: ${path}`);
  }
  return normalized;
}

function shouldIgnoreBundleEntry(entryName) {
  return BUNDLE_IGNORED_NAMES.has(entryName);
}

function bundleHash(files = []) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256 || sha256(file.content || ""));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Convert a legacy file map into one portable Markdown document. */
export function canonicalSkillMarkdown(name, files = {}) {
  const markdownFiles = Object.entries(files)
    .filter(([path, content]) => extname(path).toLowerCase() === ".md" && typeof content === "string")
    .sort(([a], [b]) => a.localeCompare(b));
  const ignoredFileCount = Object.keys(files).length - markdownFiles.length;
  if (!markdownFiles.length) return { markdown: "", markdown_file_count: 0, ignored_file_count: ignoredFileCount };

  const primary = markdownFiles.find(([path]) => basename(path).toLowerCase() === "skill.md");
  if (primary) {
    return {
      markdown: primary[1].trimEnd() + "\n",
      markdown_file_count: markdownFiles.length,
      ignored_file_count: ignoredFileCount,
      source_markdown: primary[0],
    };
  }

  if (markdownFiles.length === 1) {
    return {
      markdown: markdownFiles[0][1].trimEnd() + "\n",
      markdown_file_count: 1,
      ignored_file_count: ignoredFileCount,
      source_markdown: markdownFiles[0][0],
    };
  }

  const markdown = [
    `# ${name}`,
    "",
    ...markdownFiles.flatMap(([path, content]) => [`## ${path}`, "", content.trim(), ""]),
  ].join("\n").trimEnd() + "\n";
  return {
    markdown,
    markdown_file_count: markdownFiles.length,
    ignored_file_count: ignoredFileCount,
    source_markdown: null,
  };
}

/** Recursively scan a registered directory. Every Markdown filename is one skill name. */
export async function scanSkillDir(dirPath) {
  const expanded = expandHome(dirPath);
  if (!(await isDirectory(expanded))) return [];

  const skills = [];
  async function collect(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath);
        continue;
      }
      if (!entry.isFile() || !isSkillMarkdown(entry.name)) continue;
      try {
        const markdown = (await readFile(fullPath, "utf8")).trimEnd() + "\n";
        if (!markdown.trim()) continue;
        skills.push({
          name: skillNameFromFile(entry.name),
          source_dir: dirPath,
          markdown,
          last_modified: (await stat(fullPath)).mtime.toISOString(),
          sha256: sha256(markdown),
          markdown_file_count: 1,
          ignored_file_count: 0,
          source_markdown: relative(expanded, fullPath).replace(/\\/g, "/"),
        });
      } catch { /* Skip unreadable Markdown files. */ }
    }
  }
  await collect(expanded);
  return skills;
}

export async function scanAllSkillDirs(configDirectories = []) {
  const allSkills = [];
  for (const directory of configDirectories.filter((item) => item.type === "skills")) {
    allSkills.push(...await scanSkillDir(directory.path));
  }
  const seen = new Set();
  return allSkills.filter((skill) => {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scanSkillBundleDir(dirPath) {
  const expanded = expandHome(dirPath);
  if (!(await isDirectory(expanded))) throw new Error(`Skill source directory not found: ${dirPath}`);

  const files = [];
  async function collect(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (shouldIgnoreBundleEntry(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      const relPath = relative(expanded, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (BUNDLE_IGNORED_DIRS.has(entry.name)) continue;
        await collect(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(fullPath, "utf8");
      const file = {
        path: safeBundlePath(relPath),
        content: content.trimEnd() + "\n",
        last_modified: (await stat(fullPath)).mtime.toISOString(),
      };
      file.sha256 = sha256(file.content);
      files.push(file);
    }
  }

  await collect(expanded);
  const skills = await scanSkillDir(expanded);
  return {
    version: 1,
    source_dir: dirPath,
    generated_at: new Date().toISOString(),
    file_count: files.length,
    sha256: bundleHash(files),
    files,
    skills,
  };
}

export async function scanAllSkillBundles(configDirectories = []) {
  const bundles = [];
  for (const directory of configSkillDirs(configDirectories)) {
    bundles.push(await scanSkillBundleDir(directory.path));
  }
  return bundles;
}

function getSingleSkillSourceDir(configDirectories = [], names = [], localSkills = []) {
  const skillDirs = configSkillDirs(configDirectories);
  if (!skillDirs.length) throw new Error("No skill source directory is configured");
  if (!names.length) {
    if (skillDirs.length > 1) throw new Error("Multiple skill source directories are configured; select skills from one source");
    return skillDirs[0].path;
  }
  const localMap = new Map(localSkills.map((skill) => [skill.name.toLowerCase(), skill]));
  const sourceDirs = new Set();
  for (const name of names) {
    const skill = localMap.get(String(name).toLowerCase());
    if (!skill) throw new Error(`Skill source file not found: ${name}`);
    sourceDirs.add(skill.source_dir);
  }
  if (sourceDirs.size !== 1) throw new Error("Selected skills span multiple skill source directories");
  return [...sourceDirs][0];
}

export async function scanSelectedSkillBundle(names = [], configDirectories = []) {
  const requested = [...new Set((Array.isArray(names) ? names : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean))];
  const localSkills = await scanAllSkillDirs(configDirectories);
  const sourceDir = getSingleSkillSourceDir(configDirectories, requested, localSkills);
  return scanSkillBundleDir(sourceDir);
}

export async function writeStoredSkillBundle(bundle, stateDir = "state") {
  if (!bundle?.files || !Array.isArray(bundle.files)) throw new Error("Invalid skill bundle payload");
  const normalized = {
    version: 1,
    generated_at: bundle.generated_at || new Date().toISOString(),
    source_dir: bundle.source_dir || null,
    sha256: bundle.sha256 || bundleHash(bundle.files),
    file_count: bundle.files.length,
    skills: Array.isArray(bundle.skills) ? bundle.skills : [],
    files: bundle.files.map((file) => ({
      path: safeBundlePath(file.path),
      content: String(file.content ?? "").trimEnd() + "\n",
      sha256: file.sha256 || sha256(String(file.content ?? "").trimEnd() + "\n"),
      last_modified: file.last_modified || null,
    })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, STORED_BUNDLE_FILE);
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
  return normalized;
}

export async function readStoredSkillBundle(stateDir = "state") {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, STORED_BUNDLE_FILE), "utf8"));
    return parsed?.files && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

export async function applySkillBundleToDir(bundle, dirPath) {
  if (!bundle?.files || !Array.isArray(bundle.files)) throw new Error("Invalid skill bundle payload");
  const expanded = expandHome(dirPath);
  await mkdir(expanded, { recursive: true });
  const incomingPaths = new Set(bundle.files.map((file) => safeBundlePath(file.path)));

  async function removeOrphans(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (shouldIgnoreBundleEntry(entry.name)) continue;
      const fullPath = join(directory, entry.name);
      const relPath = relative(expanded, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (BUNDLE_IGNORED_DIRS.has(entry.name)) continue;
        await removeOrphans(fullPath);
        continue;
      }
      if (entry.isFile() && !incomingPaths.has(relPath)) await rm(fullPath, { force: true });
    }
  }

  await removeOrphans(expanded);
  for (const file of bundle.files) {
    const relPath = safeBundlePath(file.path);
    const destination = join(expanded, relPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, String(file.content ?? "").trimEnd() + "\n", "utf8");
  }
  return scanSkillBundleDir(dirPath);
}

function configSkillDirs(configDirectories = []) {
  return configDirectories.filter((item) => item.type === "skills");
}

async function assertReadableFile(path, message) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(message);
    await readFile(path, "utf8");
  } catch {
    throw new Error(message);
  }
}

function firstPathSegment(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts.length > 1 ? parts[0] : null;
}

function selectedSkillsSummary(group, localSkills) {
  const selectedSegments = new Set(group.skills.map((skill) => firstPathSegment(skill.source_markdown)));
  if (selectedSegments.size === 1) {
    const [segment] = selectedSegments;
    if (segment) {
      const sourceSkillsInSegment = localSkills
        .filter((skill) => skill.source_dir === group.source_dir)
        .filter((skill) => firstPathSegment(skill.source_markdown) === segment);
      const selectedNames = new Set(group.skills.map((skill) => skill.name.toLowerCase()));
      const allSegmentSelected = sourceSkillsInSegment.length > 0
        && sourceSkillsInSegment.every((skill) => selectedNames.has(skill.name.toLowerCase()))
        && selectedNames.size === sourceSkillsInSegment.length;
      if (allSegmentSelected) return [`Selected skills: all ${segment} skills`];
    }
  }

  return [
    "Selected skills:",
    ...group.skills.map((skill) => `- ${skill.name} (${skill.source_markdown})`),
  ];
}

export async function buildCodexSkillInstallPrompt(names = [], configDirectories = []) {
  const requested = [...new Set((Array.isArray(names) ? names : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean))];
  if (!requested.length) throw new Error("No skill names selected");

  const skillDirs = configSkillDirs(configDirectories);
  if (!skillDirs.length) throw new Error("No skill source directory is configured");

  const localSkills = await scanAllSkillDirs(configDirectories);
  const localMap = new Map(localSkills.map((skill) => [skill.name.toLowerCase(), skill]));
  const missing = requested.filter((name) => !localMap.has(name.toLowerCase()));
  if (missing.length) throw new Error(`Skill source file not found: ${missing.join(", ")}`);

  const selected = requested.map((name) => localMap.get(name.toLowerCase()));
  const bySource = new Map();
  for (const skill of selected) {
    const sourceDir = skill.source_dir;
    const expandedSourceDir = expandHome(sourceDir);
    if (!skill.source_markdown) throw new Error(`Missing source Markdown path for ${skill.name}`);
    await assertReadableFile(join(expandedSourceDir, SKILL_BUNDLE_FILE), `${SKILL_BUNDLE_FILE} not found in skill source directory: ${sourceDir}`);
    await assertReadableFile(join(expandedSourceDir, skill.source_markdown), `Source Markdown not found for ${skill.name}: ${skill.source_markdown}`);

    const group = bySource.get(sourceDir) || {
      source_dir: sourceDir,
      expanded_source_dir: expandedSourceDir,
      skills: [],
    };
    group.skills.push({
      name: skill.name,
      source_markdown: skill.source_markdown,
    });
    bySource.set(sourceDir, group);
  }

  const groups = [...bySource.values()].sort((a, b) => a.expanded_source_dir.localeCompare(b.expanded_source_dir));
  for (const group of groups) group.skills.sort((a, b) => a.name.localeCompare(b.name));

  const prompt = [
    "Target runtime: Codex",
    "",
    "Install the selected skills from the configured dashboard skill source bundle(s).",
    `For each bundle, read ${SKILL_BUNDLE_FILE} first, then follow its Codex Skill Package Rules to generate, validate, and install the selected skills.`,
    "",
    ...groups.flatMap((group) => [
      `Skill source bundle: ${group.expanded_source_dir}`,
      ...selectedSkillsSummary(group, localSkills),
      "",
    ]),
    "Treat this as a sync/update request.",
    "",
    "If a selected skill conflicts with, functionally overlaps, or appears to replace an existing installed skill under a different name, do not silently choose a resolution. Report the suspected conflict pairs and ask me whether to keep both, skip the selected skill, replace/update the existing skill, remove the old skill and install the new one, or rename/split responsibilities.",
    "",
    `If an exact target skill already exists, follow ${SKILL_BUNDLE_FILE} update rules and avoid overwriting local modifications unless the bundle rules and my request explicitly allow it.`,
    "",
    "After installation, report:",
    "- each selected skill as installed, updated, skipped, invalid, or conflicted;",
    "- selected skills that remain unsynced and why;",
    "- installed skills not managed by this selected bundle as installed-only.",
  ].join("\n").trimEnd() + "\n";

  return {
    target_runtime: "codex",
    source_bundles: groups,
    skills: selected.map((skill) => skill.name),
    prompt,
  };
}

export async function scanAgentSkillRoot(skillsRoot, agent) {
  if (!(await isDirectory(skillsRoot))) return [];
  const installations = [];

  async function collect(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collect(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== "skill.md") continue;
      try {
        installations.push({
          name: basename(dirname(fullPath)),
          agent,
          skills_root: skillsRoot,
          installed_file: fullPath,
          last_modified: (await stat(fullPath)).mtime.toISOString(),
        });
      } catch { /* Skip unreadable installed Skill files. */ }
    }
  }

  await collect(skillsRoot);
  const seen = new Set();
  return installations.filter((installation) => {
    const key = `${installation.agent}:${installation.name.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function scanAgentInstallations(configDirectories = [], options = {}) {
  const [codexHomes, claudeRoots] = await Promise.all([
    resolveCodexHomes(configDirectories, options),
    resolveClaudeRoots(configDirectories),
  ]);
  const installations = [];
  const scannedRoots = new Set();
  async function scanRoot(root, agent) {
    const key = `${agent}:${root.toLowerCase()}`;
    if (scannedRoots.has(key)) return;
    scannedRoots.add(key);
    installations.push(...await scanAgentSkillRoot(root, agent));
  }
  for (const home of codexHomes) {
    await scanRoot(join(home, "skills"), "codex");
    await scanRoot(join(dirname(home), ".agents", "skills"), "codex");
  }
  for (const root of claudeRoots) {
    await scanRoot(join(root, "skills"), "claude");
  }
  return installations;
}

async function readImportManifest(stateDir) {
  try {
    const raw = await readFile(join(stateDir, IMPORT_DIR, IMPORT_MANIFEST), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.skills) ? parsed : { version: 1, skills: [] };
  } catch {
    return { version: 1, skills: [] };
  }
}

async function writeImportManifest(stateDir, manifest) {
  const importDir = join(stateDir, IMPORT_DIR);
  await mkdir(importDir, { recursive: true });
  const path = join(importDir, IMPORT_MANIFEST);
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function readImportedSkills(stateDir = "state") {
  return (await readImportManifest(stateDir)).skills;
}

/** Stage a remote Markdown document for an Agent to recognize and install later. */
export async function importSkillMarkdown(skill, stateDir = "state", importedFrom = null) {
  const legacy = skill?.files ? canonicalSkillMarkdown(skill.name, skill.files) : null;
  const markdown = typeof skill?.markdown === "string" ? skill.markdown : legacy?.markdown;
  if (!skill?.name || !markdown?.trim()) throw new Error("Skill does not contain Markdown");

  const importedAt = new Date().toISOString();
  const filename = safeMarkdownFileName(skill.name);
  const importDir = join(stateDir, IMPORT_DIR);
  await mkdir(importDir, { recursive: true });
  await writeFile(join(importDir, filename), markdown.trimEnd() + "\n", "utf8");

  const manifest = await readImportManifest(stateDir);
  const record = {
    name: skill.name,
    sha256: skill.sha256 || sha256(markdown.trimEnd() + "\n"),
    last_modified: skill.last_modified || importedAt,
    imported_at: importedAt,
    imported_from: importedFrom,
    markdown_file: filename,
    install_status: "pending-agent-install",
  };
  manifest.skills = [...manifest.skills.filter((item) => item.name !== skill.name), record]
    .sort((a, b) => a.name.localeCompare(b.name));
  await writeImportManifest(stateDir, manifest);
  return record;
}

/** Compare installed local skills, remote copies, and locally imported documents. */
export function compareSkills(localSkills, remoteSkills, importedSkills = [], agentInstallations = []) {
  const key = (name) => String(name).toLowerCase();
  const remoteMap = new Map(remoteSkills.map((item) => [key(item.name), item]));
  const localMap = new Map(localSkills.map((item) => [key(item.name), item]));
  const importedMap = new Map(importedSkills.map((item) => [key(item.name), item]));
  const installationsMap = new Map();
  for (const installation of agentInstallations) {
    const nameKey = key(installation.name);
    const existing = installationsMap.get(nameKey) || [];
    existing.push(installation);
    installationsMap.set(nameKey, existing);
  }
  const allNames = new Set([...localMap.keys(), ...remoteMap.keys(), ...importedMap.keys()]);
  const results = [];

  for (const nameKey of allNames) {
    const local = localMap.get(nameKey) || null;
    const remote = remoteMap.get(nameKey) || null;
    const imported = importedMap.get(nameKey) || null;
    const installations = installationsMap.get(nameKey) || [];
    const name = local?.name || remote?.name || imported?.name || nameKey;
    let status;
    if (local && remote) {
      if (local.sha256 === remote.sha256) status = "same";
      else status = (local.last_modified || "") > (remote.last_modified || "") ? "newer" : "older";
    } else if (local) status = "local-only";
    else if (remote) status = "remote-only";
    else status = "imported-only";

    let installStatus = installations.length ? "installed" : imported?.install_status || "not-installed";
    if (!installations.length && local && imported && imported.sha256 !== local.sha256) installStatus = "update-pending-agent-install";
    else if (!installations.length && imported && remote && imported.sha256 !== remote.sha256) installStatus = "import-outdated";
    results.push({ name, status, install_status: installStatus, installations, local, remote, imported });
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

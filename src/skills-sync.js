import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { resolveClaudeRoots, resolveCodexHomes } from "./sources.js";

const IMPORT_DIR = "imported-skills";
const IMPORT_MANIFEST = "index.json";

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

const NON_SKILL_MARKDOWN = new Set(["agents.md", "readme.md", "changelog.md", "license.md"]);

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

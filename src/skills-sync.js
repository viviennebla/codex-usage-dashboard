import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { homedir } from "node:os";

function expandHome(p) {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function exists(path) {
  try { await readdir(path); return true; } catch { return false; }
}

/**
 * Scan a third-party skills directory and return skill file metadata.
 * Each subdirectory is treated as one skill.
 */
export async function scanSkillDir(dirPath) {
  const expanded = expandHome(dirPath);
  const skills = [];
  if (!(await exists(expanded))) return skills;

  const entries = await readdir(expanded, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(expanded, entry.name);
    const files = {};
    let lastModified = null;

    // Recursively collect all files
    async function collect(dir, prefix = "") {
      const subs = await readdir(dir, { withFileTypes: true });
      for (const sub of subs) {
        const full = join(dir, sub.name);
        const key = prefix ? `${prefix}/${sub.name}` : sub.name;
        if (sub.isFile()) {
          const content = await readFile(full, "utf8");
          files[key] = content;
          // Track most recent modification
          try {
            const stat = await import("node:fs/promises").then((m) => m.stat(full));
            const mtime = stat.mtime.toISOString();
            if (!lastModified || mtime > lastModified) lastModified = mtime;
          } catch {}
        } else if (sub.isDirectory()) {
          await collect(full, key);
        }
      }
    }

    try {
      await collect(skillDir);
      if (Object.keys(files).length === 0) continue;
      // Compute hash from concatenated file contents
      const allContent = Object.values(files).join("\n");
      skills.push({
        name: entry.name,
        source_dir: dirPath,
        files,
        last_modified: lastModified || new Date().toISOString(),
        sha256: sha256(allContent),
        file_count: Object.keys(files).length,
      });
    } catch { /* skip unreadable skill dirs */ }
  }

  return skills;
}

/**
 * Scan all registered skill directories.
 */
export async function scanAllSkillDirs(configDirectories = []) {
  const skillDirs = configDirectories
    .filter((d) => d.type === "skills")
    .map((d) => d.path);

  // Default: no skill dirs unless registered
  const allSkills = [];
  for (const dir of skillDirs) {
    const skills = await scanSkillDir(dir);
    allSkills.push(...skills);
  }

  // Deduplicate by name (first wins)
  const seen = new Set();
  return allSkills.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

/**
 * Compare local skills against remote skill list.
 * Returns each skill with a status flag.
 */
export function compareSkills(localSkills, remoteSkills) {
  const remoteMap = new Map(remoteSkills.map((r) => [r.name, r]));
  const localMap = new Map(localSkills.map((l) => [l.name, l]));
  const allNames = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const results = [];

  for (const name of allNames) {
    const local = localMap.get(name);
    const remote = remoteMap.get(name);

    if (local && remote) {
      if (local.sha256 === remote.sha256) {
        results.push({ name, status: "same", local, remote });
      } else if ((local.last_modified || "") > (remote.last_modified || "")) {
        results.push({ name, status: "newer", local, remote });
      } else {
        results.push({ name, status: "older", local, remote });
      }
    } else if (local && !remote) {
      results.push({ name, status: "local-only", local, remote: null });
    } else {
      results.push({ name, status: "remote-only", local: null, remote });
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Write skill files to a target directory (used when pulling from remote).
 */
export async function writeSkillFiles(skillName, files, targetDir) {
  const expanded = expandHome(targetDir);
  const skillDir = join(expanded, skillName);
  await mkdir(skillDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(skillDir, filename);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}

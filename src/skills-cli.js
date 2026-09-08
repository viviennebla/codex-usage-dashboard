import {
  applySkillBundleToDir,
  buildCodexSkillInstallPrompt,
  compareSkills,
  fetchRemoteSkillBundle,
  fetchRemoteSkills,
  planSkillBundleApply,
  pushRemoteSkillBundle,
  readImportedSkills,
  scanAgentInstallations,
  scanAllSkillDirs,
  scanSkillBundleDir,
} from "./skills-sync.js";
import { readConfig, resolveSyncConnection } from "./config.js";

function withExplicitSkillPath(directories = [], path) {
  if (!path) return directories;
  return [
    ...directories.filter((directory) => directory.type !== "skills"),
    { path, type: "skills", label: "CLI" },
  ];
}

export function resolveSkillSourcePath(directories = [], explicitPath = null) {
  if (explicitPath) return explicitPath;
  const paths = [...new Set(directories
    .filter((directory) => directory.type === "skills")
    .map((directory) => directory.path))];
  if (!paths.length) throw new Error("No skill source directory is configured; pass --path <dir>");
  if (paths.length > 1) throw new Error("Multiple skill source directories are configured; pass --path <dir>");
  return paths[0];
}

export function hasSkillPlanChanges(plan) {
  const summary = plan?.summary || {};
  return Boolean(summary.add || summary.update || summary.remove);
}

export function formatSkillPlan(plan) {
  const summary = plan.summary || {};
  const lines = [
    `Target: ${plan.target_dir}`,
    `Strategy: ${plan.strategy}`,
    `Changes: +${summary.add || 0} ~${summary.update || 0} -${summary.remove || 0} =${summary.unchanged || 0}`,
  ];
  for (const [label, paths] of [["Add", plan.add], ["Update", plan.update], ["Remove", plan.remove]]) {
    if (paths?.length) lines.push(`${label}: ${paths.join(", ")}`);
  }
  return lines.join("\n");
}

function parseSelectedNames(value) {
  return [...new Set(String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean))];
}

function writeResult(value, json, output) {
  output(json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`);
}

export async function runSkillsCli(options, dependencies = {}) {
  const action = options.skillsAction || "list";
  const output = dependencies.output || ((text) => process.stdout.write(text));
  const config = dependencies.config || await readConfig();
  const directories = withExplicitSkillPath(config.directories || [], options.path);
  const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
  const server = connection.server;
  const token = connection.token;

  if (action === "list" || action === "status") {
    const local = await scanAllSkillDirs(directories);
    const remote = server
      ? await fetchRemoteSkills(server, { token, fetchImpl: dependencies.fetchImpl })
      : [];
    const remoteSkills = remote.filter((skill) => !skill.source_markdown || skill.source_markdown.startsWith("common/"));
    const imported = await readImportedSkills(options.stateDir || "state");
    const installations = await scanAgentInstallations(directories, options);
    const comparison = compareSkills(local, remoteSkills, imported, installations);
    if (options.json) {
      writeResult({ local, remote: remoteSkills, imported, installations, comparison }, true, output);
    } else if (!comparison.length) {
      writeResult("No local, remote, imported, or installed skills found.", false, output);
    } else {
      const rows = comparison.map((item) => {
        const installed = item.installations?.length
          ? item.installations.map((entry) => entry.agent).join("+")
          : item.install_status;
        return `${item.name}\t${item.status}\t${installed}`;
      });
      writeResult(["NAME\tSYNC\tINSTALL", ...rows].join("\n"), false, output);
    }
    return 0;
  }

  if (action === "pull") {
    if (!server) throw new Error("No sync server is configured; run the interactive CLI or pass --server <url>");
    const targetDir = resolveSkillSourcePath(config.directories || [], options.path);
    const strategy = options.strategy || "merge";
    if (strategy !== "merge" && strategy !== "overwrite") {
      throw new Error("--strategy must be merge or overwrite");
    }
    const bundle = await fetchRemoteSkillBundle(server, { token, fetchImpl: dependencies.fetchImpl });
    const plan = await planSkillBundleApply(bundle, targetDir, { strategy });
    if (!options.json) writeResult(formatSkillPlan(plan), false, output);
    if (!hasSkillPlanChanges(plan)) {
      if (options.json) writeResult({ applied: false, plan }, true, output);
      else writeResult("Skill source bundle is already up to date.", false, output);
      return 0;
    }
    if (options.dryRun) {
      if (options.json) writeResult({ applied: false, plan }, true, output);
      return 0;
    }
    if (!options.yes && dependencies.confirm) {
      const confirmed = await dependencies.confirm("Apply these Skill bundle changes?");
      if (!confirmed) {
        if (options.json) writeResult({ applied: false, cancelled: true, plan }, true, output);
        else writeResult("Pull cancelled.", false, output);
        return 0;
      }
    } else if (!options.yes) {
      if (options.json) writeResult({ applied: false, confirmation_required: true, plan }, true, output);
      else writeResult("Preview only. Re-run with --yes to apply these changes.", false, output);
      return 2;
    }
    const applied = await applySkillBundleToDir(bundle, targetDir, { strategy });
    const result = {
      applied: true,
      plan,
      bundle: { sha256: applied.sha256, file_count: applied.file_count, skills_count: applied.skills.length },
    };
    if (options.json) writeResult(result, true, output);
    else writeResult(`Pulled bundle ${applied.sha256}: ${applied.file_count} files, ${applied.skills.length} skills.`, false, output);
    return 0;
  }

  if (action === "push") {
    if (!server) throw new Error("No sync server is configured; run the interactive CLI or pass --server <url>");
    const sourceDir = resolveSkillSourcePath(config.directories || [], options.path);
    const bundle = await scanSkillBundleDir(sourceDir);
    if (options.dryRun) {
      const summary = {
        pushed: false,
        source_dir: sourceDir,
        sha256: bundle.sha256,
        file_count: bundle.file_count,
        skills_count: bundle.skills.length,
      };
      writeResult(
        options.json ? summary : `Dry run: ${bundle.file_count} files, ${bundle.skills.length} skills, bundle ${bundle.sha256}.`,
        options.json,
        output,
      );
      return 0;
    }
    const response = await pushRemoteSkillBundle(server, bundle, {
      token,
      deviceId: options.device,
      fetchImpl: dependencies.fetchImpl,
    });
    const result = { pushed: true, source_dir: sourceDir, ...response };
    writeResult(
      options.json
        ? result
        : `Pushed bundle ${response.sha256 || bundle.sha256}: ${response.file_count ?? bundle.file_count} files, ${response.skills_count ?? bundle.skills.length} skills.`,
      options.json,
      output,
    );
    return 0;
  }

  if (action === "prompt" || action === "install-prompt") {
    const local = await scanAllSkillDirs(directories);
    const names = options.all || !options.names
      ? local.map((skill) => skill.name)
      : parseSelectedNames(options.names);
    if (!names.length) throw new Error("No local skill sources found; pull a bundle or pass --path <dir>");
    const result = await buildCodexSkillInstallPrompt(names, directories);
    writeResult(options.json ? result : result.prompt.trimEnd(), options.json, output);
    return 0;
  }

  throw new Error(`Unknown skills action: ${action}`);
}

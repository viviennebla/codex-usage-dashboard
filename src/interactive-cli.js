import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import {
  addDirectory,
  readConfig,
  resolveSyncConnection,
  updateSyncConnection,
} from "./config.js";
import { runSkillsCli } from "./skills-cli.js";

export function createTerminalPrompter(input = process.stdin, output = process.stdout) {
  let muted = false;
  const readlineOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  readlineOutput.isTTY = output.isTTY;
  readlineOutput.columns = output.columns;
  const rl = createInterface({ input, output: readlineOutput, terminal: Boolean(input.isTTY) });

  return {
    write(text = "") {
      output.write(`${text}\n`);
    },
    async text(label, defaultValue = "") {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = await rl.question(`${label}${suffix}: `);
      return answer.trim() || defaultValue;
    },
    async secret(label, hasCurrent = false) {
      const suffix = hasCurrent ? " [saved; blank keeps it, - clears it]" : " [blank for none]";
      output.write(`${label}${suffix}: `);
      muted = true;
      try {
        return (await rl.question("")).trim();
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    async select(title, choices) {
      output.write(`\n${title}\n`);
      for (const choice of choices) output.write(`  ${choice.value}) ${choice.label}\n`);
      const allowed = new Set(choices.map((choice) => String(choice.value)));
      while (true) {
        const answer = (await rl.question("Select: ")).trim();
        if (allowed.has(answer)) return answer;
        output.write("Please select one of the listed numbers.\n");
      }
    },
    async confirm(label, defaultYes = false) {
      const answer = (await rl.question(`${label} ${defaultYes ? "[Y/n]" : "[y/N]"}: `))
        .trim()
        .toLowerCase();
      if (!answer) return defaultYes;
      return answer === "y" || answer === "yes";
    },
    close() {
      rl.close();
    },
  };
}

export async function configureConnection(prompt, dependencies = {}) {
  const readConfigFn = dependencies.readConfig || readConfig;
  const updateConnectionFn = dependencies.updateSyncConnection || updateSyncConnection;
  const config = await readConfigFn();
  const current = config.sync || {};
  const server = await prompt.text("Sync server URL", current.server || "");
  if (!server) throw new Error("A sync server URL is required");
  const tokenInput = await prompt.secret("Sync token", Boolean(current.token));
  const sync = await updateConnectionFn({
    server,
    token: tokenInput && tokenInput !== "-" ? tokenInput : undefined,
    clearToken: tokenInput === "-",
  });
  prompt.write(`Connection saved: ${sync.server} · token ${sync.token ? "configured" : "not configured"}`);
  return sync;
}

async function requireConnection(options, prompt, dependencies) {
  const config = await (dependencies.readConfig || readConfig)();
  const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
  if (connection.server) return connection;
  prompt.write("No sync server is configured yet.");
  await configureConnection(prompt, dependencies);
  const updated = await (dependencies.readConfig || readConfig)();
  return resolveSyncConnection(options, updated, dependencies.env || process.env);
}

async function selectSkillPath(options, prompt, dependencies) {
  if (options.path) return options.path;
  const readConfigFn = dependencies.readConfig || readConfig;
  const config = await readConfigFn();
  const paths = [...new Set((config.directories || [])
    .filter((directory) => directory.type === "skills")
    .map((directory) => directory.path))];
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) {
    const selected = await prompt.select("Choose a Skill source directory", [
      ...paths.map((path, index) => ({ value: String(index + 1), label: path })),
      { value: "0", label: "Add another directory" },
    ]);
    if (selected !== "0") return paths[Number(selected) - 1];
  }
  const path = await prompt.text("Skill source directory");
  if (!path) throw new Error("A Skill source directory is required");
  await (dependencies.addDirectory || addDirectory)(path, "skills", "Interactive CLI");
  return path;
}

export async function runInteractiveSkillsCli(options, prompt, dependencies = {}) {
  while (true) {
    const action = await prompt.select("Skills", [
      { value: "1", label: "View sync/install status" },
      { value: "2", label: "Pull remote bundle" },
      { value: "3", label: "Push local bundle" },
      { value: "4", label: "Print install prompt" },
      { value: "0", label: "Back" },
    ]);
    if (action === "0") return;
    try {
      const config = await (dependencies.readConfig || readConfig)();
      if (action === "1") {
        const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "list",
          server: connection.server,
          token: connection.token,
        });
        continue;
      }

      const path = await selectSkillPath(options, prompt, dependencies);
      if (action === "4") {
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "prompt",
          path,
          all: true,
        });
        continue;
      }

      const connection = await requireConnection(options, prompt, dependencies);
      if (action === "2") {
        const strategy = await prompt.select("Pull strategy", [
          { value: "1", label: "Merge (keep local-only files)" },
          { value: "2", label: "Overwrite (match remote exactly)" },
        ]);
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "pull",
          path,
          server: connection.server,
          token: connection.token,
          strategy: strategy === "2" ? "overwrite" : "merge",
        }, {
          confirm: (message) => prompt.confirm(message),
        });
        continue;
      }

      if (await prompt.confirm(`Push the Skill bundle from ${path}?`)) {
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "push",
          path,
          server: connection.server,
          token: connection.token,
        });
      }
    } catch (error) {
      prompt.write(`Error: ${error?.message || error}`);
    }
  }
}

export async function runInteractiveCli(options, actions, dependencies = {}) {
  const prompt = dependencies.prompt || createTerminalPrompter();
  try {
    while (true) {
      const config = await (dependencies.readConfig || readConfig)();
      const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
      prompt.write("");
      prompt.write("Codex Usage Dashboard");
      prompt.write(`Connection: ${connection.server || "not configured"} · token ${connection.token ? "available" : "missing"}`);
      const action = await prompt.select("Main menu", [
        { value: "1", label: "View usage summary" },
        { value: "2", label: "Push usage snapshot" },
        { value: "3", label: "Pull usage snapshots" },
        { value: "4", label: "Manage Skills" },
        { value: "5", label: "Configure connection" },
        { value: "0", label: "Exit" },
      ]);
      if (action === "0") return 0;
      try {
        if (action === "5") {
          await configureConnection(prompt, dependencies);
        } else if (action === "4") {
          await runInteractiveSkillsCli(options, prompt, dependencies);
        } else {
          const resolved = action === "1"
            ? resolveSyncConnection(options, config, dependencies.env || process.env)
            : await requireConnection(options, prompt, dependencies);
          if (action === "1") await actions.showUsage({ ...options, ...resolved });
          if (action === "2") await actions.pushUsage({ ...options, ...resolved });
          if (action === "3") await actions.pullUsage({ ...options, ...resolved });
        }
      } catch (error) {
        prompt.write(`Error: ${error?.message || error}`);
      }
    }
  } finally {
    if (!dependencies.prompt) prompt.close();
  }
}

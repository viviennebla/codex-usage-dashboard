import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import {
  addDirectory,
  readConfig,
  resolveSyncConnection,
  updateSyncConnection,
} from "./config.js";
import { formatSkillPlan, runSkillsCli } from "./skills-cli.js";
import { createUsageService } from "./application-service.js";

export function createTerminalPrompter(input = process.stdin, output = process.stdout) {
  const forceColor = Boolean(process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0");
  const colorEnabled = Boolean(output.isTTY && (forceColor || !Object.hasOwn(process.env, "NO_COLOR")));
  const initialRawMode = Boolean(input.isRaw);
  let activeInterface = null;
  let screenOpen = false;

  function color(code, text) {
    return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  function setRawMode(enabled) {
    if (input.isTTY && typeof input.setRawMode === "function") input.setRawMode(enabled);
  }

  function cancelledError() {
    const error = new Error("Interactive CLI cancelled");
    error.code = "ERR_CLI_CANCELLED";
    return error;
  }

  function clearScreen() {
    if (output.isTTY) output.write("\x1b[H\x1b[2J");
  }

  function renderDetails(details = []) {
    for (const detail of details) {
      if (typeof detail === "string") {
        output.write(`${detail}\n`);
        continue;
      }
      const value = detail.value ?? "";
      output.write(`${color("2", `${detail.label}:`)} ${color(detail.healthy === false ? "33" : "32", value)}\n`);
    }
  }

  function page(title, details = []) {
    clearScreen();
    output.write(`${color("1;36", title)}\n`);
    renderDetails(details);
  }

  async function question(label, { secret = false } = {}) {
    let muted = false;
    const questionOutput = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) output.write(chunk, encoding);
        callback();
      },
    });
    questionOutput.isTTY = output.isTTY;
    questionOutput.columns = output.columns;
    const rl = createInterface({ input, output: questionOutput, terminal: Boolean(input.isTTY) });
    activeInterface = rl;
    if (screenOpen) output.write("\x1b[?25h");
    if (secret) {
      output.write(label);
      muted = true;
    }
    try {
      return await rl.question(secret ? "" : label);
    } finally {
      muted = false;
      rl.close();
      activeInterface = null;
      if (secret) output.write("\n");
      if (screenOpen) output.write("\x1b[?25l");
    }
  }

  async function pause(label = "Press Enter to return to the menu") {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      await question(`${color("2", label)}…`);
      return;
    }
    emitKeypressEvents(input);
    output.write(`${color("2", `${label}…`)}\n`);
    const wasRaw = Boolean(input.isRaw);
    return new Promise((resolve, reject) => {
      function cleanup() {
        input.off("keypress", onKeypress);
        setRawMode(wasRaw);
      }

      function onKeypress(_text, key = {}) {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(cancelledError());
          return;
        }
        if (["return", "enter", "escape"].includes(key.name)) {
          cleanup();
          resolve();
        }
      }

      input.on("keypress", onKeypress);
      setRawMode(true);
      input.resume();
    });
  }

  async function select(title, choices, { initialIndex = 0, details = [] } = {}) {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      throw new Error("Menu selection requires an interactive terminal");
    }
    if (!choices.length) throw new Error("Menu has no choices");
    let selectedIndex = Math.max(0, Math.min(initialIndex, choices.length - 1));
    const wasRaw = Boolean(input.isRaw);
    emitKeypressEvents(input);

    function render(moveUp = false) {
      if (moveUp) output.write(`\x1b[${choices.length}A`);
      choices.forEach((choice, index) => {
        const cursor = index === selectedIndex ? "❯" : " ";
        const label = ` ${cursor} ${choice.label} `;
        const line = index === selectedIndex ? color("1;30;46", label) : color("37", label);
        output.write(`\x1b[2K\r${line}\n`);
      });
    }

    return new Promise((resolve, reject) => {
      function cleanup() {
        input.off("keypress", onKeypress);
        setRawMode(wasRaw);
      }

      function finish(value) {
        cleanup();
        output.write("\n");
        resolve(value);
      }

      function onKeypress(_text, key = {}) {
        if (key.ctrl && key.name === "c") {
          cleanup();
          output.write("\n");
          reject(cancelledError());
          return;
        }
        if (key.name === "escape") {
          const back = choices.find((choice) => String(choice.value) === "0")
            || choices.find((choice) => String(choice.value) === "no");
          if (back) finish(back.value);
          return;
        }
        if (key.name === "up" || key.name === "k") {
          selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
          render(true);
          return;
        }
        if (key.name === "down" || key.name === "j") {
          selectedIndex = (selectedIndex + 1) % choices.length;
          render(true);
          return;
        }
        if (key.name === "home") {
          selectedIndex = 0;
          render(true);
          return;
        }
        if (key.name === "end") {
          selectedIndex = choices.length - 1;
          render(true);
          return;
        }
        if (key.name === "return" || key.name === "enter") finish(choices[selectedIndex].value);
      }

      input.on("keypress", onKeypress);
      setRawMode(true);
      input.resume();
      page(title, details);
      output.write(`${color("2", "  ↑/↓ move  •  Enter select  •  Esc back")}\n`);
      render();
    });
  }

  return {
    open() {
      if (!output.isTTY || screenOpen) return;
      screenOpen = true;
      output.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
    },
    clear() {
      clearScreen();
    },
    page,
    write(text = "") {
      output.write(`${text}\n`);
    },
    heading(text) {
      output.write(`${color("1;36", text)}\n`);
    },
    success(text) {
      output.write(`${color("32", `✔ ${text}`)}\n`);
    },
    warning(text) {
      output.write(`${color("33", `! ${text}`)}\n`);
    },
    working(text = "Working…") {
      output.write(`${color("33", `… ${text}`)}\n`);
    },
    error(text) {
      output.write(`${color("31", `✖ ${text}`)}\n`);
    },
    status(label, value, healthy = true) {
      output.write(`${color("2", `${label}:`)} ${color(healthy ? "32" : "33", value)}\n`);
    },
    pause,
    async text(label, defaultValue = "") {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = await question(`${color("36", label)}${color("2", suffix)}: `);
      return answer.trim() || defaultValue;
    },
    async secret(label, hasCurrent = false) {
      const suffix = hasCurrent ? " [saved; blank keeps it, - clears it]" : " [blank for none]";
      return (await question(`${color("36", label)}${color("2", suffix)}: `, { secret: true })).trim();
    },
    select,
    async confirm(label, defaultYes = false, details = []) {
      const choices = defaultYes
        ? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
        : [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];
      return await select(label, choices, { details }) === "yes";
    },
    close() {
      activeInterface?.close();
      setRawMode(initialRawMode);
      if (screenOpen) {
        output.write("\x1b[?25h\x1b[?1049l");
        screenOpen = false;
      }
      input.pause();
    },
  };
}

function detectedSourceDetail(source) {
  const type = source.type === "claude" ? "Claude" : "Codex";
  const path = source.normalized_path || source.path;
  return `${type} · ${path} · ${source.files_found || 0} JSONL files`;
}

export async function confirmDetectedSources(prompt, dependencies = {}) {
  if (typeof prompt.confirm !== "function") return [];
  const service = createUsageService({}, {
    readConfig: dependencies.readConfig,
    discoverSourceDiagnostics: dependencies.discoverSourceDiagnostics,
    addDirectory: dependencies.addDirectory,
  });
  const config = await (dependencies.readConfig || readConfig)();
  const discovered = (await service.discoverSources({ directories: config.directories || [] }))
    .filter((source) => source.status === "ok" && ["codex", "claude"].includes(source.type));
  if (!discovered.length) return [];
  const confirmed = await prompt.confirm(
    `Import ${discovered.length} detected data source${discovered.length === 1 ? "" : "s"}?`,
    false,
    discovered.map(detectedSourceDetail),
  );
  if (!confirmed) return [];
  prompt.page?.("Import detected data sources");
  prompt.working?.("Importing…");
  const imported = [];
  for (const source of discovered) {
    const result = await service.importSource(source);
    if (result.added) imported.push(result.source);
  }
  const message = `Done · Imported ${imported.length} data source${imported.length === 1 ? "" : "s"}.`;
  if (prompt.success) prompt.success(message);
  else prompt.write(message);
  await prompt.pause?.();
  return imported;
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
  const message = `Connection saved: ${sync.server} · token ${sync.token ? "configured" : "not configured"}`;
  if (prompt.success) prompt.success(message);
  else prompt.write(message);
  return sync;
}

async function requireConnection(options, prompt, dependencies) {
  const config = await (dependencies.readConfig || readConfig)();
  const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
  if (connection.server) return connection;
  if (prompt.warning) prompt.warning("No sync server is configured yet.");
  else prompt.write("No sync server is configured yet.");
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
  prompt.page?.("Add Skill source directory");
  const path = await prompt.text("Skill source directory");
  if (!path) throw new Error("A Skill source directory is required");
  await (dependencies.addDirectory || addDirectory)(path, "skills", "Interactive CLI");
  return path;
}

export async function runInteractiveSkillsCli(options, prompt, dependencies = {}) {
  while (true) {
    const action = await prompt.select("Codex Usage Dashboard · Skills", [
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
        prompt.page?.("Skill sync/install status", ["Loading…"]);
        const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "list",
          server: connection.server,
          token: connection.token,
        });
        await prompt.pause?.();
        continue;
      }

      const path = await selectSkillPath(options, prompt, dependencies);
      if (action === "4") {
        prompt.page?.("Skill install prompt", [`Source: ${path}`]);
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "prompt",
          path,
          all: true,
        });
        await prompt.pause?.();
        continue;
      }

      const connection = await requireConnection(options, prompt, dependencies);
      if (action === "2") {
        const strategy = await prompt.select("Pull strategy", [
          { value: "1", label: "Merge (keep local-only files)" },
          { value: "2", label: "Overwrite (match remote exactly)" },
        ]);
        prompt.page?.("Pull remote Skill bundle");
        prompt.working?.("Pulling…");
        let pullConfirmed = null;
        await (dependencies.runSkillsCli || runSkillsCli)({
          ...options,
          skillsAction: "pull",
          path,
          server: connection.server,
          token: connection.token,
          strategy: strategy === "2" ? "overwrite" : "merge",
        }, {
          confirm: async (message, plan) => {
            pullConfirmed = await prompt.confirm(message, false, [formatSkillPlan(plan)]);
            if (pullConfirmed) {
              prompt.page?.("Pull remote Skill bundle");
              prompt.working?.("Applying…");
            }
            return pullConfirmed;
          },
        });
        if (pullConfirmed === false) prompt.warning?.("Cancelled · No Skill files changed.");
        else prompt.success?.("Done · Skill bundle pull finished.");
        await prompt.pause?.();
        continue;
      }

      const pushConfirmed = await prompt.confirm(`Push the Skill bundle from ${path}?`);
      if (!pushConfirmed) {
        prompt.page?.("Push local Skill bundle", [`Source: ${path}`]);
        prompt.warning?.("Cancelled · Nothing was pushed.");
        await prompt.pause?.();
        continue;
      }
      prompt.page?.("Push local Skill bundle", [`Source: ${path}`]);
      prompt.working?.("Pushing…");
      await (dependencies.runSkillsCli || runSkillsCli)({
        ...options,
        skillsAction: "push",
        path,
        server: connection.server,
        token: connection.token,
      });
      prompt.success?.("Done · Skill bundle pushed.");
      await prompt.pause?.();
    } catch (error) {
      if (error?.code === "ERR_CLI_CANCELLED") throw error;
      if (prompt.error) prompt.error(error?.message || error);
      else prompt.write(`Error: ${error?.message || error}`);
      await prompt.pause?.();
    }
  }
}

export async function runInteractiveCli(options, actions, dependencies = {}) {
  const prompt = dependencies.prompt || createTerminalPrompter();
  prompt.open?.();
  try {
    try {
      await confirmDetectedSources(prompt, dependencies);
    } catch (error) {
      if (error?.code === "ERR_CLI_CANCELLED") throw error;
      prompt.page?.("Import detected data sources");
      if (prompt.error) prompt.error(`Failed · ${error?.message || error}`);
      else prompt.write(`Failed · ${error?.message || error}`);
      await prompt.pause?.();
    }
    while (true) {
      const config = await (dependencies.readConfig || readConfig)();
      const connection = resolveSyncConnection(options, config, dependencies.env || process.env);
      const connectionText = `${connection.server || "not configured"} · token ${connection.token ? "available" : "missing"}`;
      const action = await prompt.select("Codex Usage Dashboard · Main menu", [
        { value: "1", label: "View usage summary" },
        { value: "2", label: "Push usage snapshot" },
        { value: "3", label: "Pull usage snapshots" },
        { value: "4", label: "Manage Skills" },
        { value: "5", label: "Configure connection" },
        { value: "0", label: "Exit" },
      ], {
        details: [{
          label: "Connection",
          value: connectionText,
          healthy: Boolean(connection.server && connection.token),
        }],
      });
      if (action === "0") return 0;
      try {
        if (action === "5") {
          prompt.page?.("Configure connection");
          await configureConnection(prompt, dependencies);
          await prompt.pause?.();
        } else if (action === "4") {
          await runInteractiveSkillsCli(options, prompt, dependencies);
        } else {
          const actionTitle = {
            1: "Usage summary",
            2: "Push usage snapshot",
            3: "Pull usage snapshots",
          }[action];
          prompt.page?.(actionTitle);
          prompt.working?.("Working…");
          const resolved = action === "1"
            ? resolveSyncConnection(options, config, dependencies.env || process.env)
            : await requireConnection(options, prompt, dependencies);
          if (action === "1") await actions.showUsage({
            ...options,
            ...resolved,
            refreshPolicy: "stale-while-revalidate",
          });
          if (action === "2") {
            const result = await actions.pushUsage({ ...options, ...resolved }, {
              onProgress: (event) => {
                if (event?.kind === "push" && event.status === "running") prompt.working?.(event.message || "Working…");
              },
            });
            if (result?.status === "cancelled") prompt.warning?.("Cancelled · Nothing was pushed.");
            else if (result?.status === "failed" || result?.ok === false) prompt.error?.(`Failed · ${result.error || "Usage push failed."}`);
            else prompt.success?.("Done · Usage snapshot pushed.");
          }
          if (action === "3") {
            const result = await actions.pullUsage({ ...options, ...resolved }, {
              onProgress: (event) => {
                if (event?.kind === "pull" && event.status === "running") prompt.working?.(event.message || "Working…");
              },
            });
            if (result?.status === "cancelled") prompt.warning?.("Cancelled · No snapshots changed.");
            else if (result?.status === "failed" || (result?.ok === false && !result?.failed?.length)) {
              prompt.error?.(`Failed · ${result.message || "Usage pull failed."}`);
            } else if (result?.failed?.length) prompt.warning?.(`Done with warnings · ${result.failed.length} device pull${result.failed.length === 1 ? "" : "s"} failed.`);
            else prompt.success?.("Done · Usage snapshots pulled.");
          }
          await prompt.pause?.();
        }
      } catch (error) {
        if (error?.code === "ERR_CLI_CANCELLED") throw error;
        if (prompt.error) prompt.error(error?.message || error);
        else prompt.write(`Error: ${error?.message || error}`);
        await prompt.pause?.();
      }
    }
  } catch (error) {
    if (error?.code === "ERR_CLI_CANCELLED") return 130;
    throw error;
  } finally {
    if (!dependencies.prompt) prompt.close();
  }
}

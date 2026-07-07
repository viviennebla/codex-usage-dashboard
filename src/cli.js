#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { loadCodexReports } from "./ccusage.js";
import { formatCli } from "./format.js";
import { buildSnapshot } from "./snapshot.js";
import { DEFAULT_STATE_PATH, writeStateFile } from "./state.js";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function parseArgs(argv) {
  const [command = "--help", ...rest] = argv;
  const options = {
    command,
    state: DEFAULT_STATE_PATH,
    port: 34777,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--since") options.since = rest[++index];
    else if (arg === "--until") options.until = rest[++index];
    else if (arg === "--timezone") options.timezone = rest[++index];
    else if (arg === "--state") options.state = rest[++index];
    else if (arg === "--port") options.port = Number(rest[++index]);
    else if (arg === "--no-cost") options.noCost = true;
    else if (arg === "--no-wsl") options.noWsl = true;
  }
  return options;
}

function help() {
  return `Codex Usage Dashboard

Usage:
  node src/cli.js snapshot [--since YYYYMMDD] [--state state/latest.json]
  node src/cli.js cli [--since YYYYMMDD] [--no-wsl]
  node src/cli.js web [--port 34777] [--no-wsl]

Commands:
  snapshot  Write the canonical dashboard snapshot.
  cli       Print a terminal summary from the snapshot.
  web       Start the local web dashboard.
`;
}

async function createSnapshot(options) {
  const reports = await loadCodexReports(options);
  const snapshot = buildSnapshot(reports, options);
  await writeStateFile(snapshot, options.state);
  return snapshot;
}

async function serveStatic(pathname) {
  const clean = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^[/\\]+/, "");
  if (clean.startsWith("..")) {
    return { status: 403, body: "Forbidden", type: "text/plain; charset=utf-8" };
  }
  const file = join("public", clean);
  return {
    status: 200,
    body: await readFile(file),
    type: MIME[extname(file)] || "application/octet-stream",
  };
}

function startWeb(options) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (url.pathname === "/api/snapshot") {
        const snapshot = await createSnapshot(options);
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify(snapshot));
        return;
      }
      const response = await serveStatic(url.pathname);
      res.writeHead(response.status, { "content-type": response.type });
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.stack : String(error));
    }
  });

  server.listen(options.port, "127.0.0.1", () => {
    console.log(`Codex Usage Dashboard: http://127.0.0.1:${options.port}`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "--help" || options.command === "-h") {
    console.log(help());
    return;
  }

  if (options.command === "snapshot") {
    const snapshot = await createSnapshot(options);
    console.log(`Wrote ${options.state}`);
    console.log(`Today: ${snapshot.today?.totalTokens?.toLocaleString("en-US") || 0} tokens`);
    return;
  }

  if (options.command === "cli") {
    const snapshot = await createSnapshot(options);
    console.log(formatCli(snapshot));
    return;
  }

  if (options.command === "web") {
    startWeb(options);
    return;
  }

  console.error(help());
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

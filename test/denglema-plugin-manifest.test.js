import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function missing(path) {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("Denglema is a single portable plugin package", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json");
  const plugin = await readJson("plugin.json");
  const mcp = await readJson("mcp.json");

  assert.equal(marketplace.name, "denglema");
  assert.equal(marketplace.interface.displayName, "蹬了吗");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "denglema");
  assert.deepEqual(marketplace.plugins[0].source, {
    source: "local",
    path: "./",
  });
  assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");
  assert.equal(marketplace.plugins[0].policy.authentication, "ON_INSTALL");

  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "denglema");
  assert.equal(plugin.version, "0.1.13");
  assert.equal(plugin.homepage, "https://vimo-dev-server.taila62aff.ts.net/");
  assert.equal(plugin.extensions["com.openai"].interface.websiteURL, plugin.homepage);

  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.equal(mcp.mcpServers.denglema.type, "stdio");
  assert.equal(mcp.mcpServers.denglema.command, "node");
  assert.deepEqual(mcp.mcpServers.denglema.args, ["./src/denglema-mcp.js"]);
  assert.equal(mcp.mcpServers.denglema.cwd, "./");

  assert.equal(await missing(".codex-plugin/plugin.json"), true);
  assert.equal(await missing(".mcp.json"), true);
  assert.equal(await missing("skills/denglema-sync/SKILL.md"), false);
});

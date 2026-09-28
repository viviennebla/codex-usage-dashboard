import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("Denglema marketplace is Git-source friendly and versions stay aligned", async () => {
  const marketplace = await readJson(".agents/plugins/marketplace.json");
  const plugin = await readJson("plugin.json");
  const codexPlugin = await readJson(".codex-plugin/plugin.json");

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

  assert.equal(plugin.name, "denglema");
  assert.equal(codexPlugin.name, "denglema");
  assert.equal(plugin.version, "0.1.4");
  assert.equal(codexPlugin.version, plugin.version);
  assert.equal(codexPlugin.skills, "./skills/");
  assert.equal(codexPlugin.mcpServers, "./.mcp.json");
});

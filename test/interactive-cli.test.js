import assert from "node:assert/strict";
import test from "node:test";

import { configureConnection } from "../src/interactive-cli.js";

test("interactive connection setup keeps secrets out of status output", async () => {
  const messages = [];
  let update;
  const prompt = {
    text: async () => "https://sync.example/",
    secret: async () => "super-secret",
    write: (message) => messages.push(message),
  };

  const result = await configureConnection(prompt, {
    readConfig: async () => ({ sync: { server: null, token: null } }),
    updateSyncConnection: async (value) => {
      update = value;
      return { server: "https://sync.example", token: value.token };
    },
  });

  assert.equal(update.token, "super-secret");
  assert.equal(result.token, "super-secret");
  assert.doesNotMatch(messages.join("\n"), /super-secret/);
  assert.match(messages.join("\n"), /token configured/);
});

test("blank interactive token keeps an existing saved token", async () => {
  let update;
  const prompt = {
    text: async (_label, defaultValue) => defaultValue,
    secret: async () => "",
    write: () => {},
  };
  await configureConnection(prompt, {
    readConfig: async () => ({ sync: { server: "https://sync.example", token: "saved" } }),
    updateSyncConnection: async (value) => {
      update = value;
      return { server: value.server, token: "saved" };
    },
  });
  assert.equal(update.token, undefined);
  assert.equal(update.clearToken, false);
});

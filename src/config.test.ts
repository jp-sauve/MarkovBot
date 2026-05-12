import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "./config.js";

test("loadConfig reads logShadowResponses from config files", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "markovbot-config-"));
  const configPath = join(tempDir, "config.json");

  writeFileSync(
    configPath,
    JSON.stringify({
      server: "irc.example.test",
      port: 6697,
      tls: true,
      nick: "markovbot",
      channels: ["#bots"],
      replyProbability: 0.02,
      logShadowResponses: true,
      minResponseWords: 3,
      maxResponseWords: 30,
      shapeBoostFactor: 2,
      markovOrder: 2,
      ignoredNicks: ["ChanServ", "NickServ"],
      dbPath: "markov.db",
      fallbackResponses: []
    })
  );

  const config = loadConfig(configPath);

  assert.equal(config.logShadowResponses, true);

  rmSync(tempDir, { recursive: true, force: true });
});

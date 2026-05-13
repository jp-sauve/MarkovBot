import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "./index.js";

function withEnv(
  overrides: Record<string, string | undefined>,
  callback: () => void
): void {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    callback();
  } finally {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createTempConfig(config: unknown): {
  tempDir: string;
  configPath: string;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "markovbot-config-"));
  const configPath = join(tempDir, "config.json");

  writeFileSync(configPath, JSON.stringify(config));

  return { tempDir, configPath };
}

function cleanupTempDir(tempDir: string): void {
  rmSync(tempDir, { recursive: true, force: true });
}

test("loadConfig reads logShadowResponses from config files", () => {
  const { tempDir, configPath } = createTempConfig({
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
  });

  const config = loadConfig(configPath);

  assert.equal(config.logShadowResponses, true);

  cleanupTempDir(tempDir);
});

test("loadConfig applies environment overrides and parses booleans, numbers, and lists", () => {
  const { tempDir, configPath } = createTempConfig({
    server: "irc.example.test",
    port: 6667,
    tls: false,
    nick: "markovbot",
    channels: ["#bots"],
    replyProbability: 0.02,
    logShadowResponses: false,
    minResponseWords: 3,
    maxResponseWords: 30,
    shapeBoostFactor: 2,
    markovOrder: 2,
    ignoredNicks: ["ChanServ", "NickServ"],
    dbPath: "markov.db",
    fallbackResponses: ["fallback one"]
  });

  withEnv(
    {
      MARKOV_IRC_SERVER: "irc.override.test",
      MARKOV_IRC_PORT: "6697",
      MARKOV_IRC_TLS: "yes",
      MARKOV_IRC_CHANNELS: "#general, #random",
      MARKOV_LOG_SHADOW_RESPONSES: "true",
      MARKOV_MIN_RESPONSE_WORDS: "5",
      MARKOV_FALLBACK_RESPONSES: "one, two"
    },
    () => {
      const config = loadConfig(configPath);

      assert.equal(config.server, "irc.override.test");
      assert.equal(config.port, 6697);
      assert.equal(config.tls, true);
      assert.deepEqual(config.channels, ["#general", "#random"]);
      assert.equal(config.logShadowResponses, true);
      assert.equal(config.minResponseWords, 5);
      assert.deepEqual(config.fallbackResponses, ["one", "two"]);
    }
  );

  cleanupTempDir(tempDir);
});

test("loadConfig falls back when environment numeric input is invalid", () => {
  const { tempDir, configPath } = createTempConfig({
    channels: ["#bots"],
    minResponseWords: 4,
    maxResponseWords: 10
  });

  withEnv({ MARKOV_MIN_RESPONSE_WORDS: "not-a-number" }, () => {
    const config = loadConfig(configPath);

    assert.equal(config.minResponseWords, 4);
  });

  cleanupTempDir(tempDir);
});

test("loadConfig returns null discord config when partial Discord settings are present", () => {
  const { tempDir, configPath } = createTempConfig({
    channels: ["#bots"],
    discordToken: "token-only"
  });

  const config = loadConfig(configPath);

  assert.equal(config.discord, null);

  cleanupTempDir(tempDir);
});

test("loadConfig throws when the config file is missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "markovbot-config-"));
  const configPath = join(tempDir, "missing.json");

  assert.throws(() => loadConfig(configPath), /Config file not found/);

  cleanupTempDir(tempDir);
});

test("loadConfig throws on invalid JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "markovbot-config-"));
  const configPath = join(tempDir, "config.json");

  writeFileSync(configPath, "{ invalid json");

  assert.throws(() => loadConfig(configPath), SyntaxError);

  cleanupTempDir(tempDir);
});

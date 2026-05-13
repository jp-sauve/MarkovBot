import assert from "node:assert/strict";
import test from "node:test";

import type { Config } from "../config/index.js";
import { isIgnoredNick, makeAlternateNick, shouldRespond } from "./irc.js";

function createConfig(overrides: Partial<Config> = {}): Config {
  return {
    server: "irc.example.test",
    port: 6667,
    tls: false,
    nick: "MarkovBot",
    channels: ["#bots"],
    replyProbability: 0.2,
    logShadowResponses: false,
    minResponseWords: 3,
    maxResponseWords: 30,
    shapeBoostFactor: 2,
    markovOrder: 3,
    ignoredNicks: ["ChanServ", "NickServ"],
    dbPath: "markov3.db",
    fallbackResponses: [],
    discord: null,
    ...overrides
  };
}

function withMockRandom(value: number, callback: () => void): void {
  const originalRandom = Math.random;
  Math.random = () => value;

  try {
    callback();
  } finally {
    Math.random = originalRandom;
  }
}

test("isIgnoredNick matches the bot nick and ignored nicks case-insensitively", () => {
  const config = createConfig();

  assert.equal(isIgnoredNick("markovbot", config), true);
  assert.equal(isIgnoredNick("NICKSERV", config), true);
  assert.equal(isIgnoredNick("somebody", config), false);
});

test("shouldRespond returns true for forced replies and bot mentions", () => {
  const config = createConfig();

  assert.equal(shouldRespond("plain message", config, true), true);
  assert.equal(shouldRespond("hey markovbot answer this", config), true);
});

test("shouldRespond respects reply probability when there is no mention", () => {
  const config = createConfig({ replyProbability: 0.25 });

  withMockRandom(0.2, () => {
    assert.equal(shouldRespond("plain message", config), true);
  });
  withMockRandom(0.8, () => {
    assert.equal(shouldRespond("plain message", config), false);
  });
});

test("makeAlternateNick appends suffixes and enforces the IRC length cap", () => {
  assert.equal(makeAlternateNick("markovbot", 1), "markovbot_");
  assert.equal(makeAlternateNick("markovbot", 3), "markovbot_3");

  const truncated = makeAlternateNick("abcdefghijklmnopqrstuvwxyz123456", 12);

  assert.equal(truncated.length, 30);
  assert.equal(truncated.endsWith("_12"), true);
});

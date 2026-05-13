import assert from "node:assert/strict";
import test from "node:test";

import type { Client, Message } from "discord.js";

import type { Config } from "../config/index.js";
import { isIgnoredAuthor, resolveMentions, shouldRespond } from "./discord.js";

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
    ignoredNicks: ["nightbot", "chanserv"],
    dbPath: "markov3.db",
    fallbackResponses: [],
    discord: null,
    ...overrides
  };
}

function createMessage(overrides: Record<string, unknown> = {}): Message {
  return {
    content: "hello world",
    author: {
      bot: false,
      username: "alice"
    },
    mentions: {
      users: new Map(),
      members: new Map(),
      channels: new Map()
    },
    ...overrides
  } as Message;
}

function createClient(overrides: Record<string, unknown> = {}): Client {
  return {
    user: {
      id: "bot-id",
      username: "DiscordBot"
    },
    ...overrides
  } as Client;
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

test("isIgnoredAuthor filters bot accounts and ignored usernames", () => {
  const config = createConfig();

  assert.equal(
    isIgnoredAuthor(
      createMessage({ author: { bot: true, username: "alice" } }),
      config
    ),
    true
  );
  assert.equal(
    isIgnoredAuthor(
      createMessage({ author: { bot: false, username: "NightBot" } }),
      config
    ),
    true
  );
  assert.equal(isIgnoredAuthor(createMessage(), config), false);
});

test("resolveMentions replaces user and channel mentions when metadata is available", () => {
  const message = createMessage({
    content: "hi <@123> in <#456>",
    mentions: {
      users: new Map([["123", { username: "alice" }]]),
      members: new Map([["123", { displayName: "AliceDisplay" }]]),
      channels: new Map([["456", { name: "bots" }]])
    }
  });

  assert.equal(resolveMentions(message), "hi @AliceDisplay in #bots");
});

test("shouldRespond returns true for direct mentions and bot names in text", () => {
  const config = createConfig();
  const client = createClient();

  const mentionedMessage = createMessage({
    mentions: {
      users: {
        has: (id: string) => id === "bot-id",
        get: () => undefined
      },
      members: new Map(),
      channels: new Map()
    } as unknown as Message["mentions"]
  });

  assert.equal(shouldRespond(mentionedMessage, client, config), true);
  assert.equal(
    shouldRespond(createMessage({ content: "hey DiscordBot" }), client, config),
    true
  );
  assert.equal(
    shouldRespond(createMessage({ content: "hey markovbot" }), client, config),
    true
  );
});

test("shouldRespond falls back to reply probability when there is no mention", () => {
  const config = createConfig({ replyProbability: 0.25 });
  const client = createClient();
  const message = createMessage({ content: "plain message" });

  withMockRandom(0.2, () => {
    assert.equal(shouldRespond(message, client, config), true);
  });
  withMockRandom(0.8, () => {
    assert.equal(shouldRespond(message, client, config), false);
  });
});

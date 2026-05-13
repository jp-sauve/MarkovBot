import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface DiscordConfig {
  token: string;
  clientId: string;
  guildIds: string[];
  channels: string[];
}

export interface Config {
  server: string;
  port: number;
  tls: boolean;
  nick: string;
  channels: string[];
  replyProbability: number;
  logShadowResponses: boolean;
  minResponseWords: number;
  maxResponseWords: number;
  shapeBoostFactor: number;
  markovOrder: number;
  ignoredNicks: string[];
  dbPath: string;
  fallbackResponses: string[];
  discord: DiscordConfig | null;
}

interface RawConfig {
  server?: string;
  port?: number;
  tls?: boolean;
  nick?: string;
  channels?: string[];
  replyProbability?: number;
  logShadowResponses?: boolean;
  minResponseWords?: number;
  maxResponseWords?: number;
  shapeBoostFactor?: number;
  markovOrder?: number;
  ignoredNicks?: string[];
  dbPath?: string;
  fallbackResponses?: string[];
  discordToken?: string;
  discordClientId?: string;
  discordGuildIds?: string[];
  discordChannels?: string[];
}

const DEFAULT_CONFIG = {
  server: "localhost",
  port: 6667,
  tls: false,
  nick: "markovbot",
  channels: ["#markovbot"],
  replyProbability: 0.02,
  logShadowResponses: false,
  minResponseWords: 3,
  maxResponseWords: 30,
  shapeBoostFactor: 2,
  markovOrder: 3,
  ignoredNicks: ["ChanServ", "NickServ"],
  dbPath: "markov3.db",
  fallbackResponses: [] as string[]
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJsonConfig(configPath: string): RawConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(configPath, "utf8")) as RawConfig;
}

function loadDiscordConfig(fileConfig: RawConfig): DiscordConfig | null {
  const token =
    process.env.MARKOV_DISCORD_TOKEN ?? fileConfig.discordToken ?? "";
  const clientId =
    process.env.MARKOV_DISCORD_CLIENT_ID ?? fileConfig.discordClientId ?? "";
  const guildIds = parseList(
    process.env.MARKOV_DISCORD_GUILD_IDS,
    fileConfig.discordGuildIds ?? []
  );
  const channels = parseList(
    process.env.MARKOV_DISCORD_CHANNELS,
    fileConfig.discordChannels ?? []
  );

  const anyDiscordConfig = Boolean(
    token || clientId || guildIds.length > 0 || channels.length > 0
  );
  const fullyConfigured = Boolean(token && clientId && channels.length > 0);

  if (!anyDiscordConfig) {
    return null;
  }

  if (!fullyConfigured) {
    console.warn(
      "Discord config is incomplete; skipping Discord startup. Set token, client ID, and at least one channel."
    );
    return null;
  }

  return {
    token,
    clientId,
    guildIds,
    channels
  };
}

export function loadConfig(
  configPath = resolve(
    process.cwd(),
    process.env.MARKOV_CONFIG_PATH ?? "config.json"
  )
): Config {
  const fileConfig = readJsonConfig(configPath);

  const config: Config = {
    server:
      process.env.MARKOV_IRC_SERVER ??
      fileConfig.server ??
      DEFAULT_CONFIG.server,
    port: parseNumber(
      process.env.MARKOV_IRC_PORT,
      fileConfig.port ?? DEFAULT_CONFIG.port
    ),
    tls: parseBoolean(
      process.env.MARKOV_IRC_TLS,
      fileConfig.tls ?? DEFAULT_CONFIG.tls
    ),
    nick: process.env.MARKOV_IRC_NICK ?? fileConfig.nick ?? DEFAULT_CONFIG.nick,
    channels: parseList(
      process.env.MARKOV_IRC_CHANNELS,
      fileConfig.channels ?? DEFAULT_CONFIG.channels
    ),
    replyProbability: parseNumber(
      process.env.MARKOV_REPLY_PROBABILITY,
      fileConfig.replyProbability ?? DEFAULT_CONFIG.replyProbability
    ),
    logShadowResponses: parseBoolean(
      process.env.MARKOV_LOG_SHADOW_RESPONSES,
      fileConfig.logShadowResponses ?? DEFAULT_CONFIG.logShadowResponses
    ),
    minResponseWords: parseNumber(
      process.env.MARKOV_MIN_RESPONSE_WORDS,
      fileConfig.minResponseWords ?? DEFAULT_CONFIG.minResponseWords
    ),
    maxResponseWords: parseNumber(
      process.env.MARKOV_MAX_RESPONSE_WORDS,
      fileConfig.maxResponseWords ?? DEFAULT_CONFIG.maxResponseWords
    ),
    shapeBoostFactor: parseNumber(
      process.env.MARKOV_SHAPE_BOOST_FACTOR,
      fileConfig.shapeBoostFactor ?? DEFAULT_CONFIG.shapeBoostFactor
    ),
    markovOrder: parseNumber(
      process.env.MARKOV_ORDER,
      fileConfig.markovOrder ?? DEFAULT_CONFIG.markovOrder
    ),
    ignoredNicks: parseList(
      process.env.MARKOV_IGNORED_NICKS,
      fileConfig.ignoredNicks ?? DEFAULT_CONFIG.ignoredNicks
    ),
    dbPath:
      process.env.MARKOV_DB_PATH ?? fileConfig.dbPath ?? DEFAULT_CONFIG.dbPath,
    fallbackResponses: parseList(
      process.env.MARKOV_FALLBACK_RESPONSES,
      fileConfig.fallbackResponses ?? DEFAULT_CONFIG.fallbackResponses
    ),
    discord: loadDiscordConfig(fileConfig)
  };

  if (config.channels.length === 0) {
    throw new Error("Config must include at least one IRC channel.");
  }

  if (config.replyProbability < 0 || config.replyProbability > 1) {
    throw new Error("Config replyProbability must be between 0 and 1.");
  }

  if (
    config.minResponseWords < 1 ||
    !Number.isInteger(config.minResponseWords)
  ) {
    throw new Error("Config minResponseWords must be a positive integer.");
  }

  if (
    config.maxResponseWords < 1 ||
    !Number.isInteger(config.maxResponseWords)
  ) {
    throw new Error("Config maxResponseWords must be a positive integer.");
  }

  if (config.shapeBoostFactor < 1) {
    throw new Error(
      "Config shapeBoostFactor must be greater than or equal to 1."
    );
  }

  if (config.minResponseWords > config.maxResponseWords) {
    throw new Error(
      "Config minResponseWords must be less than or equal to maxResponseWords."
    );
  }

  if (config.markovOrder < 1 || !Number.isInteger(config.markovOrder)) {
    throw new Error("Config markovOrder must be a positive integer.");
  }

  return config;
}

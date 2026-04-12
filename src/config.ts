import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  server: string;
  port: number;
  tls: boolean;
  nick: string;
  channels: string[];
  replyProbability: number;
  maxResponseWords: number;
  markovOrder: number;
  ignoredNicks: string[];
  dbPath: string;
}

type PartialConfig = Partial<Config>;

const DEFAULT_CONFIG: Config = {
  server: 'localhost',
  port: 6667,
  tls: false,
  nick: 'markovbot',
  channels: ['#markovbot'],
  replyProbability: 0.02,
  maxResponseWords: 30,
  markovOrder: 2,
  ignoredNicks: ['ChanServ', 'NickServ'],
  dbPath: 'markov.db',
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

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJsonConfig(configPath: string): PartialConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  return JSON.parse(readFileSync(configPath, 'utf8')) as PartialConfig;
}

export function loadConfig(configPath = resolve(process.cwd(), process.env.MARKOV_CONFIG_PATH ?? 'config.json')): Config {
  const fileConfig = readJsonConfig(configPath);

  const config: Config = {
    server: process.env.MARKOV_IRC_SERVER ?? fileConfig.server ?? DEFAULT_CONFIG.server,
    port: parseNumber(process.env.MARKOV_IRC_PORT, fileConfig.port ?? DEFAULT_CONFIG.port),
    tls: parseBoolean(process.env.MARKOV_IRC_TLS, fileConfig.tls ?? DEFAULT_CONFIG.tls),
    nick: process.env.MARKOV_IRC_NICK ?? fileConfig.nick ?? DEFAULT_CONFIG.nick,
    channels: parseList(process.env.MARKOV_IRC_CHANNELS, fileConfig.channels ?? DEFAULT_CONFIG.channels),
    replyProbability: parseNumber(process.env.MARKOV_REPLY_PROBABILITY, fileConfig.replyProbability ?? DEFAULT_CONFIG.replyProbability),
    maxResponseWords: parseNumber(process.env.MARKOV_MAX_RESPONSE_WORDS, fileConfig.maxResponseWords ?? DEFAULT_CONFIG.maxResponseWords),
    markovOrder: parseNumber(process.env.MARKOV_ORDER, fileConfig.markovOrder ?? DEFAULT_CONFIG.markovOrder),
    ignoredNicks: parseList(process.env.MARKOV_IGNORED_NICKS, fileConfig.ignoredNicks ?? DEFAULT_CONFIG.ignoredNicks),
    dbPath: process.env.MARKOV_DB_PATH ?? fileConfig.dbPath ?? DEFAULT_CONFIG.dbPath,
  };

  if (config.channels.length === 0) {
    throw new Error('Config must include at least one channel.');
  }

  if (config.replyProbability < 0 || config.replyProbability > 1) {
    throw new Error('Config replyProbability must be between 0 and 1.');
  }

  if (config.maxResponseWords < 1 || !Number.isInteger(config.maxResponseWords)) {
    throw new Error('Config maxResponseWords must be a positive integer.');
  }

  if (config.markovOrder < 1 || !Number.isInteger(config.markovOrder)) {
    throw new Error('Config markovOrder must be a positive integer.');
  }

  return config;
}
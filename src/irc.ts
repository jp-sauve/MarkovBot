import IRC from 'irc-framework';

import type { Config } from './config.js';
import { MarkovEngine, looksLikeCommand, pickSeedWord } from './markov.js';

interface MessageEvent {
  message: string;
  nick: string;
  target: string;
}

interface IrcClient {
  on(event: string, handler: (...args: any[]) => void): void;
  connect(options: Record<string, unknown>): void;
  join(channel: string): void;
  say(target: string, message: string): void;
  quit(message?: string): void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isIgnoredNick(nick: string, config: Config): boolean {
  const lowered = nick.toLowerCase();
  return lowered === config.nick.toLowerCase() || config.ignoredNicks.some((entry) => entry.toLowerCase() === lowered);
}

function shouldRespond(message: string, config: Config): boolean {
  const mentionPattern = new RegExp(`\\b${escapeRegExp(config.nick)}\\b`, 'i');
  return mentionPattern.test(message) || Math.random() < config.replyProbability;
}

export function startIrcBot(config: Config, markov: MarkovEngine): { stop: () => void } {
  const IrcFramework = IRC as { Client: new () => IrcClient };
  const client = new IrcFramework.Client();

  client.on('registered', () => {
    for (const channel of config.channels) {
      client.join(channel);
    }
    console.log(`Connected as ${config.nick}; joined ${config.channels.join(', ')}`);
  });

  client.on('close', () => {
    console.log('IRC connection closed.');
  });

  client.on('socket error', (error: unknown) => {
    console.error('IRC socket error:', error);
  });

  client.on('message', (event: MessageEvent) => {
    if (!config.channels.includes(event.target)) {
      return;
    }

    if (isIgnoredNick(event.nick, config)) {
      return;
    }

    if (looksLikeCommand(event.message)) {
      return;
    }

    markov.learn(event.message);

    if (!shouldRespond(event.message, config)) {
      return;
    }

    const response = markov.generate(pickSeedWord(event.message, config.nick));
    if (!response) {
      return;
    }

    client.say(event.target, response);
  });

  client.connect({
    host: config.server,
    port: config.port,
    nick: config.nick,
    tls: config.tls,
    auto_reconnect: true,
    auto_reconnect_max_retries: 10,
  });

  return {
    stop: () => {
      client.quit('markovbot shutting down');
    },
  };
}
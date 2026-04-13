import IRC from "irc-framework";

import type { Config } from "./config.js";
import { MarkovEngine, looksLikeCommand, pickSeedWord } from "./markov.js";

interface MessageEvent {
  message: string;
  nick: string;
  target: string;
}

interface RegistrationEvent {
  nick: string;
}

interface JoinEvent {
  nick: string;
  channel: string;
}

interface IrcErrorEvent {
  error: string;
  channel?: string;
  reason?: string;
}

interface NickEvent {
  nick: string;
  reason: string;
}

interface IrcChannel {
  join: () => void;
}

interface IrcClient {
  on(event: string, handler: (...args: any[]) => void): void;
  once(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
  connect(options: Record<string, unknown>): void;
  join(channel: string): void;
  changeNick(nick: string): void;
  channel(channel: string): IrcChannel;
  say(target: string, message: string): void;
  quit(message?: string): void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isIgnoredNick(nick: string, config: Config): boolean {
  const lowered = nick.toLowerCase();
  return (
    lowered === config.nick.toLowerCase() ||
    config.ignoredNicks.some((entry) => entry.toLowerCase() === lowered)
  );
}

function shouldRespond(message: string, config: Config): boolean {
  const mentionPattern = new RegExp(`\\b${escapeRegExp(config.nick)}\\b`, "i");
  return (
    mentionPattern.test(message) || Math.random() < config.replyProbability
  );
}

function makeAlternateNick(baseNick: string, attempt: number): string {
  const suffix = attempt === 1 ? "_" : `_${attempt}`;
  const maxBaseLength = Math.max(1, 30 - suffix.length);
  return `${baseNick.slice(0, maxBaseLength)}${suffix}`;
}

export async function startIrcBot(
  config: Config,
  markov: MarkovEngine
): Promise<{ stop: () => void }> {
  const IrcFramework = IRC as { Client: new () => IrcClient };
  const client = new IrcFramework.Client();
  const joinedChannels = new Set<string>();
  let activeNick = config.nick;
  let nickAttempt = 0;

  const registration = new Promise<void>((resolve, reject) => {
    const registrationTimeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `IRC registration timed out for ${config.server}:${config.port}`
        )
      );
    }, 20000);

    const clearRegistrationTimeout = (): void => {
      clearTimeout(registrationTimeout);
    };

    const cleanup = (): void => {
      clearRegistrationTimeout();
      client.removeListener("registered", onRegistered);
      client.removeListener("nick in use", onNickInUse);
      client.removeListener("nick invalid", onNickInvalid);
      client.removeListener("close", onClose);
      client.removeListener("socket close", onSocketClose);
    };

    const onRegistered = (event: RegistrationEvent): void => {
      activeNick = event.nick;
      cleanup();
      resolve();
    };

    const onNickInUse = (event: NickEvent): void => {
      nickAttempt += 1;
      const fallbackNick = makeAlternateNick(config.nick, nickAttempt);
      activeNick = fallbackNick;
      console.warn(
        `IRC nick ${event.nick} is in use; retrying as ${fallbackNick}.`
      );
      client.changeNick(fallbackNick);
    };

    const onNickInvalid = (event: NickEvent): void => {
      nickAttempt += 1;
      const fallbackNick = makeAlternateNick("markovbot", nickAttempt);
      activeNick = fallbackNick;
      console.warn(
        `IRC nick ${event.nick} is invalid; retrying as ${fallbackNick}.`
      );
      client.changeNick(fallbackNick);
    };

    const onClose = (): void => {
      cleanup();
      reject(new Error("IRC connection closed before registration completed."));
    };

    const onSocketClose = (error: unknown): void => {
      if (!error) {
        return;
      }

      cleanup();
      reject(
        new Error(`IRC socket closed before registration: ${String(error)}`)
      );
    };

    client.on("registered", onRegistered);
    client.on("nick in use", onNickInUse);
    client.on("nick invalid", onNickInvalid);
    client.on("close", onClose);
    client.on("socket close", onSocketClose);
  });

  client.on("registered", (event: RegistrationEvent) => {
    activeNick = event.nick;
    for (const channel of config.channels) {
      client.channel(channel).join();
    }
    console.log(
      `Connected to IRC as ${activeNick}; joining ${config.channels.join(", ")}`
    );
  });

  client.on("join", (event: JoinEvent) => {
    if (!config.channels.includes(event.channel)) {
      return;
    }

    if (event.nick.toLowerCase() !== activeNick.toLowerCase()) {
      return;
    }

    if (joinedChannels.has(event.channel)) {
      return;
    }

    joinedChannels.add(event.channel);
    console.log(`Joined IRC channel ${event.channel} as ${activeNick}.`);
  });

  client.on("close", () => {
    console.log("IRC connection closed.");
  });

  client.on("socket error", (error: unknown) => {
    console.error("IRC socket error:", error);
  });

  client.on("irc error", (event: IrcErrorEvent) => {
    if (event.channel) {
      console.error(
        `IRC error for ${event.channel}: ${event.error}${event.reason ? ` (${event.reason})` : ""}`
      );
      return;
    }

    console.error(
      `IRC error: ${event.error}${event.reason ? ` (${event.reason})` : ""}`
    );
  });

  client.on("message", (event: MessageEvent) => {
    const isPrivateMessage =
      event.target.toLowerCase() === activeNick.toLowerCase();

    if (!isPrivateMessage && !config.channels.includes(event.target)) {
      return;
    }

    if (isIgnoredNick(event.nick, config)) {
      return;
    }

    if (looksLikeCommand(event.message)) {
      return;
    }

    markov.learn(event.message);

    if (isPrivateMessage) {
      console.log(`IRC private message from ${event.nick}: ${event.message}`);
      return;
    }

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
    auto_reconnect_max_retries: 10
  });

  await registration;

  return {
    stop: () => {
      client.quit("markovbot shutting down");
    }
  };
}

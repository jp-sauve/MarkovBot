import dotenv from "dotenv";

import { loadConfig } from "./config.js";
import { MarkovDatabase } from "./db.js";
import { startDiscordBot } from "./discord.js";
import { startIrcBot } from "./irc.js";
import { MarkovEngine } from "./markov.js";

dotenv.config();

interface RuntimeHandle {
  stop: () => void | Promise<void>;
}

const config = loadConfig();
const database = new MarkovDatabase(config.dbPath);
const markov = new MarkovEngine(database, {
  order: config.markovOrder,
  maxResponseWords: config.maxResponseWords
});
const runtimeHandles: RuntimeHandle[] = [];

function registerHandle(handle: RuntimeHandle): void {
  runtimeHandles.push(handle);
}

async function startServices(): Promise<void> {
  try {
    registerHandle(await startIrcBot(config, markov));
  } catch (error) {
    console.error("IRC startup failed:", error);
  }

  if (config.discord) {
    try {
      registerHandle(await startDiscordBot(config, markov));
    } catch (error) {
      console.error("Discord startup failed:", error);
    }
  } else {
    console.log("Discord is not configured; IRC-only mode enabled.");
  }

  if (runtimeHandles.length === 0) {
    database.close();
    throw new Error("No bot connectors started successfully.");
  }
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);

  await Promise.allSettled(
    runtimeHandles.map((handle) => Promise.resolve(handle.stop()))
  );
  database.close();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

startServices().catch((error) => {
  console.error("Startup failed:", error);
  database.close();
  process.exit(1);
});

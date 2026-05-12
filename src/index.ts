import dotenv from "dotenv";

import { loadConfig } from "./config/index.js";
import { MarkovDatabase } from "./db/index.js";
import { startDiscordBot } from "./connectors/discord.js";
import { startIrcBot } from "./connectors/irc.js";
import { MarkovEngine } from "./engine/markov.js";
import { PosTagger } from "./engine/pos.js";

dotenv.config();

interface RuntimeHandle {
  stop: () => void | Promise<void>;
}

const config = loadConfig();
const database = new MarkovDatabase(config.dbPath);
const posTagger = new PosTagger();
const markov = new MarkovEngine(
  database,
  {
    order: config.markovOrder,
    minResponseWords: config.minResponseWords,
    maxResponseWords: config.maxResponseWords,
    fallbackResponses: config.fallbackResponses,
    shapeBoostFactor: config.shapeBoostFactor
  },
  posTagger
);
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

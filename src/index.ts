import { loadConfig } from './config.js';
import { MarkovDatabase } from './db.js';
import { startIrcBot } from './irc.js';
import { MarkovEngine } from './markov.js';

const config = loadConfig();
const database = new MarkovDatabase(config.dbPath);
const markov = new MarkovEngine(database, {
  order: config.markovOrder,
  maxResponseWords: config.maxResponseWords,
});
const bot = startIrcBot(config, markov);

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  bot.stop();
  database.close();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
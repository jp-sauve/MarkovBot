import Database from 'better-sqlite3';

export interface WeightedSuffix {
  suffix: string;
  frequency: number;
}

export interface WeightedPrefix {
  prefix: string;
  frequency: number;
}

export class MarkovDatabase {
  private readonly database: Database.Database;

  private readonly insertPair;

  private readonly selectNextWords;

  private readonly selectStartingPairs;

  private readonly selectSeededPrefixes;

  private readonly insertChain;

  constructor(dbPath: string) {
    this.database = new Database(dbPath);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = NORMAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS markov_pairs (
        id INTEGER PRIMARY KEY,
        prefix TEXT NOT NULL,
        suffix TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        UNIQUE(prefix, suffix)
      );
      CREATE INDEX IF NOT EXISTS idx_markov_pairs_prefix ON markov_pairs(prefix);
    `);

    this.insertPair = this.database.prepare(`
      INSERT INTO markov_pairs (prefix, suffix, frequency)
      VALUES (?, ?, 1)
      ON CONFLICT(prefix, suffix)
      DO UPDATE SET frequency = frequency + 1
    `);
    this.selectNextWords = this.database.prepare(`
      SELECT suffix, frequency
      FROM markov_pairs
      WHERE prefix = ?
    `);
    this.selectStartingPairs = this.database.prepare(`
      SELECT prefix, SUM(frequency) AS frequency
      FROM markov_pairs
      WHERE prefix = ? OR prefix LIKE ?
      GROUP BY prefix
    `);
    this.selectSeededPrefixes = this.database.prepare(`
      SELECT prefix, SUM(frequency) AS frequency
      FROM markov_pairs
      WHERE lower(prefix) = ?
        OR lower(prefix) LIKE ?
        OR lower(prefix) LIKE ?
        OR lower(prefix) LIKE ?
      GROUP BY prefix
    `);
    this.insertChain = this.database.transaction((pairs: Array<{ prefix: string; suffix: string }>) => {
      for (const pair of pairs) {
        this.insertPair.run(pair.prefix, pair.suffix);
      }
    });
  }

  addChain(pairs: Array<{ prefix: string; suffix: string }>): void {
    if (pairs.length === 0) {
      return;
    }

    this.insertChain(pairs);
  }

  getNextWords(prefix: string): WeightedSuffix[] {
    return this.selectNextWords.all(prefix) as WeightedSuffix[];
  }

  getStartingPairs(startToken: string): WeightedPrefix[] {
    return this.selectStartingPairs.all(startToken, `${startToken} %`) as WeightedPrefix[];
  }

  findSeededPrefixes(seedWord: string): WeightedPrefix[] {
    const normalized = seedWord.toLowerCase();
    return this.selectSeededPrefixes.all(
      normalized,
      `${normalized} %`,
      `% ${normalized} %`,
      `% ${normalized}`,
    ) as WeightedPrefix[];
  }

  close(): void {
    this.database.close();
  }
}
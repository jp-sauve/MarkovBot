import Database from "better-sqlite3";

import { MarkovDatabase } from "./index.js";
import { PosTagger } from "../engine/pos.js";

const START_TOKEN = "__START__";
const END_TOKEN = "__END__";

interface MigrationOptions {
  dbPath: string;
  batchSize: number;
  samples: number;
  maxWords: number;
  skipPairs: boolean;
  skipShapes: boolean;
}

interface MarkovPairRow {
  id: number;
  prefix: string;
  suffix: string;
}

interface WeightedValue {
  value: string;
  frequency: number;
}

interface SentenceShapeCount {
  shape: string;
  frequency: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): MigrationOptions {
  const options: MigrationOptions = {
    dbPath: "markov3.db",
    batchSize: 500,
    samples: 5000,
    maxWords: 30,
    skipPairs: false,
    skipShapes: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--db-path") {
      options.dbPath = argv[index + 1] ?? options.dbPath;
      index += 1;
    } else if (argument === "--batch-size") {
      options.batchSize = parseNumber(argv[index + 1], options.batchSize);
      index += 1;
    } else if (argument === "--samples") {
      options.samples = parseNumber(argv[index + 1], options.samples);
      index += 1;
    } else if (argument === "--max-words") {
      options.maxWords = parseNumber(argv[index + 1], options.maxWords);
      index += 1;
    } else if (argument === "--skip-pairs") {
      options.skipPairs = true;
    } else if (argument === "--skip-shapes") {
      options.skipShapes = true;
    } else if (argument === "--help") {
      console.log(
        [
          "Usage: tsx src/migrate.ts [options]",
          "",
          "Options:",
          "  --db-path <path>     SQLite database path (default: markov3.db)",
          "  --batch-size <n>     Rows per pair-update transaction (default: 500)",
          "  --samples <n>        Number of chain walks for sentence shapes (default: 5000)",
          "  --max-words <n>      Max words per sampled sentence (default: 30)",
          "  --skip-pairs         Skip markov_pairs POS backfill",
          "  --skip-shapes        Skip sentence_shapes recomputation"
        ].join("\n")
      );
      process.exit(0);
    }
  }

  return options;
}

function pickWeighted(items: WeightedValue[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const total = items.reduce((sum, item) => sum + item.frequency, 0);
  let threshold = Math.random() * total;

  for (const item of items) {
    threshold -= item.frequency;
    if (threshold <= 0) {
      return item.value;
    }
  }

  return items.at(-1)?.value;
}

function bootstrapSchema(dbPath: string): void {
  const database = new MarkovDatabase(dbPath);
  database.close();
}

function splitPrefix(prefix: string): string[] {
  return prefix.split(" ").filter((token) => token && token !== START_TOKEN);
}

function backfillPairPos(
  db: Database.Database,
  posTagger: PosTagger,
  batchSize: number
): void {
  const total = (
    db.prepare("SELECT COUNT(*) AS count FROM markov_pairs").get() as {
      count: number;
    }
  ).count;
  const selectPairs = db.prepare(`
    SELECT id, prefix, suffix
    FROM markov_pairs
    WHERE id > ?
    ORDER BY id ASC
    LIMIT ?
  `);
  const updatePair = db.prepare(`
    UPDATE markov_pairs
    SET prefix_pos = ?, suffix_pos = ?
    WHERE id = ?
  `);
  const updateBatch = db.transaction(
    (
      rows: Array<{
        id: number;
        prefixPos: string | null;
        suffixPos: string | null;
      }>
    ) => {
      for (const row of rows) {
        updatePair.run(row.prefixPos, row.suffixPos, row.id);
      }
    }
  );

  let lastId = 0;
  let processed = 0;

  while (true) {
    const rows = selectPairs.all(lastId, batchSize) as MarkovPairRow[];
    if (rows.length === 0) {
      break;
    }

    const updates = rows.map((row) => {
      const prefixWords = splitPrefix(row.prefix);
      const sentence =
        row.suffix === END_TOKEN ? prefixWords : [...prefixWords, row.suffix];
      const taggedWords = sentence.length > 0 ? posTagger.tag(sentence) : [];

      return {
        id: row.id,
        prefixPos:
          prefixWords.length > 0
            ? (taggedWords[prefixWords.length - 1]?.tag ?? null)
            : null,
        suffixPos:
          row.suffix === END_TOKEN ? null : (taggedWords.at(-1)?.tag ?? null)
      };
    });

    updateBatch(updates);

    lastId = rows.at(-1)?.id ?? lastId;
    processed += rows.length;
    console.log(`Pairs: ${processed}/${total}`);
  }
}

function recomputeSentenceShapes(
  db: Database.Database,
  posTagger: PosTagger,
  samples: number,
  maxWords: number
): void {
  const startingPrefixes = db
    .prepare(
      `
      SELECT prefix AS value, SUM(frequency) AS frequency
      FROM markov_pairs
      WHERE prefix = ? OR prefix LIKE ?
      GROUP BY prefix
    `
    )
    .all(START_TOKEN, `${START_TOKEN} %`) as WeightedValue[];

  const nextWordsByPrefix = new Map<string, WeightedValue[]>();
  const selectNextWords = db.prepare(`
    SELECT suffix AS value, frequency
    FROM markov_pairs
    WHERE prefix = ?
  `);
  const sentenceShapeCounts = new Map<string, number>();
  const replaceShapes = db.transaction((shapes: SentenceShapeCount[]) => {
    db.prepare("DELETE FROM sentence_shapes").run();
    const insertShape = db.prepare(`
      INSERT INTO sentence_shapes (shape, frequency)
      VALUES (?, ?)
    `);

    for (const shape of shapes) {
      insertShape.run(shape.shape, shape.frequency);
    }
  });

  const getNextWords = (prefix: string): WeightedValue[] => {
    const cached = nextWordsByPrefix.get(prefix);
    if (cached) {
      return cached;
    }

    const values = selectNextWords.all(prefix) as WeightedValue[];
    nextWordsByPrefix.set(prefix, values);
    return values;
  };

  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const startingPrefix = pickWeighted(startingPrefixes);
    if (!startingPrefix) {
      break;
    }

    let currentPrefix = startingPrefix.split(" ");
    const tokens = currentPrefix.filter((token) => token !== START_TOKEN);

    while (tokens.length < maxWords) {
      const nextWord = pickWeighted(getNextWords(currentPrefix.join(" ")));
      if (!nextWord || nextWord === END_TOKEN) {
        break;
      }

      tokens.push(nextWord);
      currentPrefix = [...currentPrefix.slice(1), nextWord];
    }

    if (tokens.length === 0) {
      continue;
    }

    const shape = posTagger
      .tag(tokens)
      .map((entry) => entry.tag)
      .join(" ");

    if (!shape) {
      continue;
    }

    sentenceShapeCounts.set(shape, (sentenceShapeCounts.get(shape) ?? 0) + 1);
  }

  replaceShapes(
    Array.from(sentenceShapeCounts, ([shape, frequency]) => ({
      shape,
      frequency
    }))
  );
  console.log(
    `Shapes: wrote ${sentenceShapeCounts.size} unique shapes from ${samples} samples`
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  bootstrapSchema(options.dbPath);

  const db = new Database(options.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const posTagger = new PosTagger();

  try {
    if (!options.skipPairs) {
      backfillPairPos(db, posTagger, options.batchSize);
    }

    if (!options.skipShapes) {
      recomputeSentenceShapes(db, posTagger, options.samples, options.maxWords);
    }
  } finally {
    db.close();
  }
}

main();

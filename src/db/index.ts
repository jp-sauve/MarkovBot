import Database from "better-sqlite3";

import type { TaggedWord } from "../engine/pos.js";

export interface WeightedSuffix {
  suffix: string;
  frequency: number;
  suffixPos: string | null;
}

export interface WeightedPrefix {
  prefix: string;
  frequency: number;
  prefixPos: string | null;
}

export interface WordPosFrequency {
  tag: string;
  count: number;
}

export interface SentenceShapeFrequency {
  shape: string;
  frequency: number;
}

export interface OutputLabel {
  id: number;
  name: string;
  description: string;
  count: number;
}

export interface OutputLabelMeta {
  otherLabels: string[];
  confidence: number;
  humanReviewed: boolean;
}

export interface OutputLogEntry {
  output: string;
  seedWord: string | null;
  source: string | null;
  channel: string | null;
  isFallback: boolean;
}

export interface OutputLogRecord extends OutputLogEntry {
  id: number;
  generatedAt: number;
  labelId: number | null;
  labelMeta: OutputLabelMeta | null;
}

interface MarkovPair {
  prefix: string;
  suffix: string;
  prefixPos: string | null;
  suffixPos: string | null;
}

export class MarkovDatabase {
  private readonly database: Database.Database;

  private readonly insertPair;

  private readonly selectNextWords;

  private readonly selectStartingPairs;

  private readonly selectSeededPrefixes;

  private readonly insertChain;

  private readonly insertWordPos;

  private readonly insertWordPosBatch;

  private readonly selectWordPos;

  private readonly insertSentenceShape;

  private readonly selectSentenceShapes;

  private readonly insertOutputLog;

  private readonly selectOutputLogs;

  private readonly insertLabel;

  private readonly selectLabelById;

  private readonly selectLabelByName;

  private readonly selectAllLabels;

  private readonly updateLabelDescriptionStmt;

  private readonly deleteLabelStmt;

  private readonly incrementLabelCount;

  private readonly decrementLabelCount;

  private readonly setOutputLabelStmt;

  private readonly clearOutputLabelStmt;

  private readonly selectUnlabeledOutputs;

  private readonly selectOutputsByLabel;

  constructor(dbPath: string) {
    this.database = new Database(dbPath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS markov_pairs (
        id INTEGER PRIMARY KEY,
        prefix TEXT NOT NULL,
        suffix TEXT NOT NULL,
        prefix_pos TEXT,
        suffix_pos TEXT,
        frequency INTEGER NOT NULL DEFAULT 1,
        UNIQUE(prefix, suffix)
      );
      CREATE TABLE IF NOT EXISTS word_pos (
        word TEXT NOT NULL,
        tag TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (word, tag)
      );
      CREATE TABLE IF NOT EXISTS sentence_shapes (
        id INTEGER PRIMARY KEY,
        shape TEXT NOT NULL UNIQUE,
        frequency INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS output_log (
        id INTEGER PRIMARY KEY,
        generated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        output TEXT NOT NULL,
        seed_word TEXT,
        source TEXT,
        channel TEXT,
        is_fallback INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS output_labels (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_markov_pairs_prefix ON markov_pairs(prefix);
      CREATE INDEX IF NOT EXISTS idx_word_pos_word ON word_pos(word);
      CREATE INDEX IF NOT EXISTS idx_sentence_shapes_shape ON sentence_shapes(shape);
      CREATE INDEX IF NOT EXISTS idx_output_log_generated_at ON output_log(generated_at);
      CREATE INDEX IF NOT EXISTS idx_output_log_source_channel ON output_log(source, channel);
      CREATE INDEX IF NOT EXISTS idx_output_labels_name ON output_labels(name);
    `);

    this.migrateMarkovPairsTable();
    this.migrateOutputLogTable();

    this.insertPair = this.database.prepare(`
      INSERT INTO markov_pairs (prefix, suffix, prefix_pos, suffix_pos, frequency)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(prefix, suffix)
      DO UPDATE SET frequency = frequency + 1
    `);
    this.selectNextWords = this.database.prepare(`
      SELECT suffix, frequency, suffix_pos AS suffixPos
      FROM markov_pairs
      WHERE prefix = ?
    `);
    this.selectStartingPairs = this.database.prepare(`
      SELECT prefix, SUM(frequency) AS frequency, MAX(prefix_pos) AS prefixPos
      FROM markov_pairs
      WHERE prefix = ? OR prefix LIKE ?
      GROUP BY prefix
    `);
    this.selectSeededPrefixes = this.database.prepare(`
      SELECT prefix, SUM(frequency) AS frequency, MAX(prefix_pos) AS prefixPos
      FROM markov_pairs
      WHERE lower(prefix) = ?
        OR lower(prefix) LIKE ?
        OR lower(prefix) LIKE ?
        OR lower(prefix) LIKE ?
      GROUP BY prefix
    `);
    this.insertChain = this.database.transaction((pairs: MarkovPair[]) => {
      for (const pair of pairs) {
        this.insertPair.run(
          pair.prefix,
          pair.suffix,
          pair.prefixPos,
          pair.suffixPos
        );
      }
    });
    this.insertWordPos = this.database.prepare(`
      INSERT INTO word_pos (word, tag, count)
      VALUES (?, ?, 1)
      ON CONFLICT(word, tag)
      DO UPDATE SET count = count + 1
    `);
    this.insertWordPosBatch = this.database.transaction(
      (entries: TaggedWord[]) => {
        for (const entry of entries) {
          this.insertWordPos.run(entry.token, entry.tag);
        }
      }
    );
    this.selectWordPos = this.database.prepare(`
      SELECT tag, count
      FROM word_pos
      WHERE word = ?
      ORDER BY count DESC, tag ASC
    `);
    this.insertSentenceShape = this.database.prepare(`
      INSERT INTO sentence_shapes (shape, frequency)
      VALUES (?, 1)
      ON CONFLICT(shape)
      DO UPDATE SET frequency = frequency + 1
    `);
    this.selectSentenceShapes = this.database.prepare(`
      SELECT shape, frequency
      FROM sentence_shapes
      ORDER BY frequency DESC, shape ASC
      LIMIT 500
    `);
    this.insertOutputLog = this.database.prepare(`
      INSERT INTO output_log (output, seed_word, source, channel, is_fallback)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.selectOutputLogs = this.database.prepare(`
      SELECT
        id,
        generated_at AS generatedAt,
        output,
        seed_word AS seedWord,
        source,
        channel,
        is_fallback AS isFallback,
        label_id AS labelId,
        label_meta AS labelMeta
      FROM output_log
      ORDER BY id DESC
      LIMIT ?
    `);
    this.insertLabel = this.database.prepare(`
      INSERT OR IGNORE INTO output_labels (name, description)
      VALUES (?, ?)
    `);
    this.selectLabelById = this.database.prepare(`
      SELECT id, name, description, count
      FROM output_labels
      WHERE id = ?
    `);
    this.selectLabelByName = this.database.prepare(`
      SELECT id, name, description, count
      FROM output_labels
      WHERE name = ?
    `);
    this.selectAllLabels = this.database.prepare(`
      SELECT id, name, description, count
      FROM output_labels
      ORDER BY name ASC
    `);
    this.updateLabelDescriptionStmt = this.database.prepare(`
      UPDATE output_labels
      SET description = ?
      WHERE id = ?
    `);
    this.deleteLabelStmt = this.database.transaction((id: number) => {
      this.database
        .prepare(
          "UPDATE output_log SET label_id = NULL, label_meta = NULL WHERE label_id = ?"
        )
        .run(id);
      this.database.prepare("DELETE FROM output_labels WHERE id = ?").run(id);
    });
    this.incrementLabelCount = this.database.prepare(`
      UPDATE output_labels SET count = count + 1 WHERE id = ?
    `);
    this.decrementLabelCount = this.database.prepare(`
      UPDATE output_labels SET count = MAX(0, count - 1) WHERE id = ?
    `);
    this.setOutputLabelStmt = this.database.transaction(
      (outputLogId: number, labelId: number, metaJson: string) => {
        const existing = this.database
          .prepare("SELECT label_id AS labelId FROM output_log WHERE id = ?")
          .get(outputLogId) as { labelId: number | null } | undefined;
        if (existing?.labelId != null) {
          this.decrementLabelCount.run(existing.labelId);
        }
        this.database
          .prepare(
            "UPDATE output_log SET label_id = ?, label_meta = ? WHERE id = ?"
          )
          .run(labelId, metaJson, outputLogId);
        this.incrementLabelCount.run(labelId);
      }
    );
    this.clearOutputLabelStmt = this.database.transaction(
      (outputLogId: number) => {
        const existing = this.database
          .prepare("SELECT label_id AS labelId FROM output_log WHERE id = ?")
          .get(outputLogId) as { labelId: number | null } | undefined;
        if (existing?.labelId != null) {
          this.decrementLabelCount.run(existing.labelId);
        }
        this.database
          .prepare(
            "UPDATE output_log SET label_id = NULL, label_meta = NULL WHERE id = ?"
          )
          .run(outputLogId);
      }
    );
    this.selectUnlabeledOutputs = this.database.prepare(`
      SELECT
        id,
        generated_at AS generatedAt,
        output,
        seed_word AS seedWord,
        source,
        channel,
        is_fallback AS isFallback,
        label_id AS labelId,
        label_meta AS labelMeta
      FROM output_log
      WHERE label_id IS NULL
      ORDER BY id ASC
      LIMIT ?
    `);
    this.selectOutputsByLabel = this.database.prepare(`
      SELECT
        id,
        generated_at AS generatedAt,
        output,
        seed_word AS seedWord,
        source,
        channel,
        is_fallback AS isFallback,
        label_id AS labelId,
        label_meta AS labelMeta
      FROM output_log
      WHERE label_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
  }

  addChain(pairs: MarkovPair[]): void {
    if (pairs.length === 0) {
      return;
    }

    this.insertChain(pairs);
  }

  addWordPos(entries: TaggedWord[]): void {
    if (entries.length === 0) {
      return;
    }

    this.insertWordPosBatch(entries);
  }

  addSentenceShape(shape: string): void {
    if (!shape) {
      return;
    }

    this.insertSentenceShape.run(shape);
  }

  getNextWords(prefix: string): WeightedSuffix[] {
    return this.selectNextWords.all(prefix) as WeightedSuffix[];
  }

  getStartingPairs(startToken: string): WeightedPrefix[] {
    return this.selectStartingPairs.all(
      startToken,
      `${startToken} %`
    ) as WeightedPrefix[];
  }

  findSeededPrefixes(seedWord: string): WeightedPrefix[] {
    const normalized = seedWord.toLowerCase();
    return this.selectSeededPrefixes.all(
      normalized,
      `${normalized} %`,
      `% ${normalized} %`,
      `% ${normalized}`
    ) as WeightedPrefix[];
  }

  getWordPos(word: string): WordPosFrequency[] {
    return this.selectWordPos.all(word) as WordPosFrequency[];
  }

  getSentenceShapes(): SentenceShapeFrequency[] {
    return this.selectSentenceShapes.all() as SentenceShapeFrequency[];
  }

  logOutput(entry: OutputLogEntry): void {
    this.insertOutputLog.run(
      entry.output,
      entry.seedWord,
      entry.source,
      entry.channel,
      entry.isFallback ? 1 : 0
    );
  }

  getOutputLogs(limit = 100): OutputLogRecord[] {
    const rows = this.selectOutputLogs.all(limit) as Array<
      Omit<OutputLogRecord, "isFallback" | "labelMeta"> & {
        isFallback: number;
        labelMeta: string | null;
      }
    >;

    return rows.map((row) => ({
      ...row,
      isFallback: Boolean(row.isFallback),
      labelMeta: row.labelMeta
        ? (JSON.parse(row.labelMeta) as OutputLabelMeta)
        : null
    }));
  }

  // ── output_labels CRUD ────────────────────────────────────────────────────

  createLabel(name: string, description = ""): OutputLabel {
    this.insertLabel.run(name, description);
    return this.selectLabelByName.get(name) as OutputLabel;
  }

  getLabelById(id: number): OutputLabel | null {
    return (this.selectLabelById.get(id) as OutputLabel | undefined) ?? null;
  }

  getLabelByName(name: string): OutputLabel | null {
    return (
      (this.selectLabelByName.get(name) as OutputLabel | undefined) ?? null
    );
  }

  getAllLabels(): OutputLabel[] {
    return this.selectAllLabels.all() as OutputLabel[];
  }

  updateLabelDescription(id: number, description: string): void {
    this.updateLabelDescriptionStmt.run(description, id);
  }

  deleteLabel(id: number): void {
    (this.deleteLabelStmt as (id: number) => void)(id);
  }

  // ── output_log label helpers ──────────────────────────────────────────────

  setOutputLabel(
    outputLogId: number,
    labelId: number,
    meta: OutputLabelMeta
  ): void {
    (
      this.setOutputLabelStmt as (
        id: number,
        labelId: number,
        metaJson: string
      ) => void
    )(outputLogId, labelId, JSON.stringify(meta));
  }

  clearOutputLabel(outputLogId: number): void {
    (this.clearOutputLabelStmt as (id: number) => void)(outputLogId);
  }

  getUnlabeledOutputs(limit = 100): OutputLogRecord[] {
    const rows = this.selectUnlabeledOutputs.all(limit) as Array<
      Omit<OutputLogRecord, "isFallback" | "labelMeta"> & {
        isFallback: number;
        labelMeta: string | null;
      }
    >;
    return rows.map((row) => ({
      ...row,
      isFallback: Boolean(row.isFallback),
      labelMeta: null
    }));
  }

  getOutputsByLabel(labelId: number, limit = 100): OutputLogRecord[] {
    const rows = this.selectOutputsByLabel.all(labelId, limit) as Array<
      Omit<OutputLogRecord, "isFallback" | "labelMeta"> & {
        isFallback: number;
        labelMeta: string | null;
      }
    >;
    return rows.map((row) => ({
      ...row,
      isFallback: Boolean(row.isFallback),
      labelMeta: row.labelMeta
        ? (JSON.parse(row.labelMeta) as OutputLabelMeta)
        : null
    }));
  }

  close(): void {
    this.database.close();
  }

  private migrateMarkovPairsTable(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(markov_pairs)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("prefix_pos")) {
      this.database.exec("ALTER TABLE markov_pairs ADD COLUMN prefix_pos TEXT");
    }

    if (!columnNames.has("suffix_pos")) {
      this.database.exec("ALTER TABLE markov_pairs ADD COLUMN suffix_pos TEXT");
    }
  }

  private migrateOutputLogTable(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(output_log)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("label_id")) {
      this.database.exec("ALTER TABLE output_log ADD COLUMN label_id INTEGER");
    }

    if (!columnNames.has("label_meta")) {
      this.database.exec("ALTER TABLE output_log ADD COLUMN label_meta TEXT");
    }

    this.database.exec(
      "CREATE INDEX IF NOT EXISTS idx_output_log_label_id ON output_log(label_id)"
    );
  }
}

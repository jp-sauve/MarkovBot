import assert from "node:assert/strict";
import test from "node:test";

import { MarkovDatabase } from "../db/index.js";
import { MarkovEngine, tokenize } from "./markov.js";
import { PosTagger } from "./pos.js";

function createOptions(
  overrides: Partial<ConstructorParameters<typeof MarkovEngine>[1]> = {}
) {
  return {
    order: 1,
    minResponseWords: 1,
    maxResponseWords: 20,
    fallbackResponses: ["I don't know."],
    shapeBoostFactor: 2,
    ...overrides
  };
}

test("learn stores POS tags, tagged chain links, and sentence shapes", () => {
  const db = new MarkovDatabase(":memory:");
  const engine = new MarkovEngine(db, createOptions(), new PosTagger());

  engine.learn("the quick fox runs");

  assert.equal(db.getWordPos("quick")[0]?.tag, "JJ");
  assert.deepEqual(db.getNextWords("the"), [
    {
      suffix: "quick",
      frequency: 1,
      suffixPos: "JJ"
    }
  ]);
  assert.deepEqual(db.getSentenceShapes(), [
    {
      shape: "DT JJ NN VBZ",
      frequency: 1
    }
  ]);

  db.close();
});

test("grammar boost prefers POS-compatible next words when transitions are ambiguous", () => {
  const db = new MarkovDatabase(":memory:");

  db.addChain([
    { prefix: "__START__", suffix: "the", prefixPos: null, suffixPos: "DT" },
    { prefix: "the", suffix: "cat", prefixPos: "DT", suffixPos: "NN" },
    { prefix: "the", suffix: "run", prefixPos: "DT", suffixPos: "VB" },
    { prefix: "cat", suffix: "__END__", prefixPos: "NN", suffixPos: null },
    { prefix: "run", suffix: "__END__", prefixPos: "VB", suffixPos: null }
  ]);

  const engine = new MarkovEngine(
    db,
    createOptions({ shapeBoostFactor: 1, maxResponseWords: 2 })
  );

  let nounCount = 0;
  let verbCount = 0;

  for (let index = 0; index < 600; index += 1) {
    const output = engine.generate().toLowerCase();

    if (output === "the cat.") {
      nounCount += 1;
    } else if (output === "the run.") {
      verbCount += 1;
    }
  }

  assert.ok(
    nounCount > verbCount,
    `expected noun branch to win more often, got noun=${nounCount}, verb=${verbCount}`
  );

  db.close();
});

test("shape-guided generation biases seeded outputs toward learned sentence endings", () => {
  const tagger = new PosTagger();
  const baselineDb = new MarkovDatabase(":memory:");
  const baselineEngine = new MarkovEngine(
    baselineDb,
    createOptions({ shapeBoostFactor: 1, maxResponseWords: 10 }),
    tagger
  );
  const shapedDb = new MarkovDatabase(":memory:");
  const shapedEngine = new MarkovEngine(
    shapedDb,
    createOptions({ shapeBoostFactor: 10, maxResponseWords: 10 }),
    tagger
  );

  const corpus = [
    "cat eats fish",
    "cat eats quickly",
    "the bird sees worms",
    "the fox finds food",
    "a dog chases squirrels",
    "a mouse likes cheese",
    "the wolf hunts deer",
    "a bear seeks honey",
    "the rabbit nibbles grass",
    "the hawk catches mice",
    "the owl watches prey"
  ];

  for (const sentence of corpus) {
    baselineEngine.learn(sentence);
    shapedEngine.learn(sentence);
  }

  let baselineNounEndings = 0;
  let baselineAdverbEndings = 0;
  let shapedNounEndings = 0;
  let shapedAdverbEndings = 0;

  for (let index = 0; index < 200; index += 1) {
    const baselineReply = baselineEngine.generate("cat");
    const baselineLastTag =
      tagger.tag(tokenize(baselineReply)).at(-1)?.tag ?? "";

    if (baselineLastTag.startsWith("NN")) {
      baselineNounEndings += 1;
    } else if (baselineLastTag.startsWith("RB")) {
      baselineAdverbEndings += 1;
    }

    const shapedReply = shapedEngine.generate("cat");
    const shapedLastTag = tagger.tag(tokenize(shapedReply)).at(-1)?.tag ?? "";

    if (shapedLastTag.startsWith("NN")) {
      shapedNounEndings += 1;
    } else if (shapedLastTag.startsWith("RB")) {
      shapedAdverbEndings += 1;
    }
  }

  assert.ok(
    shapedNounEndings > baselineNounEndings,
    `expected shaped generation to produce more noun endings, got baseline=${baselineNounEndings}, shaped=${shapedNounEndings}`
  );
  assert.ok(
    shapedAdverbEndings < baselineAdverbEndings,
    `expected shaped generation to reduce adverb endings, got baseline=${baselineAdverbEndings}, shaped=${shapedAdverbEndings}`
  );

  baselineDb.close();
  shapedDb.close();
});

test("seeded generation and basic Markov fallback still work without POS data", () => {
  const db = new MarkovDatabase(":memory:");
  const engine = new MarkovEngine(db, createOptions({ maxResponseWords: 4 }));

  engine.learn("cat naps softly");
  engine.learn("dog barks loudly");

  for (let index = 0; index < 20; index += 1) {
    const seeded = engine.generate("dog").toLowerCase();
    assert.ok(
      seeded.startsWith("dog "),
      `expected seeded output to start from dog prefix, got ${seeded}`
    );
  }

  const fallbackDb = new MarkovDatabase(":memory:");
  const fallbackEngine = new MarkovEngine(fallbackDb, createOptions());

  assert.equal(fallbackEngine.generate("missing"), "I don't know.");

  db.close();
  fallbackDb.close();
});

test("generateAndLog stores generated outputs with context and fallback state", () => {
  const db = new MarkovDatabase(":memory:");
  const engine = new MarkovEngine(db, createOptions({ maxResponseWords: 4 }));

  engine.learn("cat naps softly");

  const generated = engine.generateAndLog("cat", {
    source: "irc",
    channel: "#bots"
  });
  const logs = db.getOutputLogs(1);

  assert.ok(generated.length > 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.seedWord, "cat");
  assert.equal(logs[0]?.source, "irc");
  assert.equal(logs[0]?.channel, "#bots");
  assert.equal(logs[0]?.isFallback, false);

  const fallbackDb = new MarkovDatabase(":memory:");
  const fallbackEngine = new MarkovEngine(fallbackDb, createOptions());
  const fallback = fallbackEngine.generateAndLog("missing", {
    source: "discord",
    channel: "123456"
  });

  assert.equal(fallback, "I don't know.");

  const fallbackLogs = fallbackDb.getOutputLogs(1);

  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0]?.output, "I don't know.");
  assert.equal(fallbackLogs[0]?.seedWord, "missing");
  assert.equal(fallbackLogs[0]?.source, "discord");
  assert.equal(fallbackLogs[0]?.channel, "123456");
  assert.equal(fallbackLogs[0]?.isFallback, true);

  db.close();
  fallbackDb.close();
});

test("tokenize strips apostrophes that only act as outer quote punctuation", () => {
  assert.deepEqual(tokenize("'Earth stood still'"), [
    "Earth",
    "stood",
    "still"
  ]);
  assert.deepEqual(tokenize("This won't do.'"), ["This", "won't", "do"]);
});

test("generation cleans dangling quote punctuation before finalizing output", () => {
  const db = new MarkovDatabase(":memory:");
  const engine = new MarkovEngine(db, createOptions({ maxResponseWords: 6 }));

  engine.learn("this won't do.'");
  assert.equal(engine.generate(), "This won't do.");

  db.close();
});

test("generation falls back instead of returning a fragment ending in a determiner", () => {
  const db = new MarkovDatabase(":memory:");
  const engine = new MarkovEngine(db, createOptions({ minResponseWords: 1 }));

  engine.learn("depending on the");
  assert.equal(engine.generate(), "I don't know.");

  db.close();
});

import assert from "node:assert/strict";
import test from "node:test";

import { MarkovDatabase, type OutputLabelMeta } from "./index.js";

function sortByPrefix<T extends { prefix: string }>(items: T[]): T[] {
  return [...items].sort((left, right) =>
    left.prefix.localeCompare(right.prefix)
  );
}

test("addChain aggregates duplicate pairs and exposes weighted next words", () => {
  const db = new MarkovDatabase(":memory:");

  db.addChain([
    { prefix: "hello", suffix: "world", prefixPos: "UH", suffixPos: "NN" },
    { prefix: "hello", suffix: "world", prefixPos: "UH", suffixPos: "NN" },
    { prefix: "hello", suffix: "there", prefixPos: "UH", suffixPos: "RB" }
  ]);

  assert.deepEqual(db.getNextWords("hello"), [
    { suffix: "world", frequency: 2, suffixPos: "NN" },
    { suffix: "there", frequency: 1, suffixPos: "RB" }
  ]);

  db.close();
});

test("getStartingPairs and findSeededPrefixes match expected prefixes", () => {
  const db = new MarkovDatabase(":memory:");

  db.addChain([
    {
      prefix: "__START__",
      suffix: "hello",
      prefixPos: null,
      suffixPos: "UH"
    },
    {
      prefix: "__START__ hello",
      suffix: "world",
      prefixPos: "UH",
      suffixPos: "NN"
    },
    {
      prefix: "say hello",
      suffix: "again",
      prefixPos: "UH",
      suffixPos: "RB"
    },
    {
      prefix: "shelloworld",
      suffix: "oops",
      prefixPos: null,
      suffixPos: null
    }
  ]);

  assert.deepEqual(sortByPrefix(db.getStartingPairs("__START__")), [
    { prefix: "__START__", frequency: 1, prefixPos: null },
    { prefix: "__START__ hello", frequency: 1, prefixPos: "UH" }
  ]);
  assert.deepEqual(sortByPrefix(db.findSeededPrefixes("HELLO")), [
    { prefix: "__START__ hello", frequency: 1, prefixPos: "UH" },
    { prefix: "say hello", frequency: 1, prefixPos: "UH" }
  ]);

  db.close();
});

test("addWordPos and addSentenceShape aggregate frequencies", () => {
  const db = new MarkovDatabase(":memory:");

  db.addWordPos([
    { token: "run", tag: "VB" },
    { token: "run", tag: "VB" },
    { token: "run", tag: "NN" }
  ]);
  db.addSentenceShape("NN VB");
  db.addSentenceShape("NN VB");
  db.addSentenceShape("DT NN VB");

  assert.deepEqual(db.getWordPos("run"), [
    { tag: "VB", count: 2 },
    { tag: "NN", count: 1 }
  ]);
  assert.deepEqual(db.getSentenceShapes(), [
    { shape: "NN VB", frequency: 2 },
    { shape: "DT NN VB", frequency: 1 }
  ]);

  db.close();
});

test("setOutputLabel stores label metadata and updates label counts", () => {
  const db = new MarkovDatabase(":memory:");
  const approved = db.createLabel("good", "Looks acceptable");
  const meta: OutputLabelMeta = {
    otherLabels: ["fragment"],
    confidence: 0.9,
    humanReviewed: false
  };

  db.logOutput({
    output: "Hello there.",
    seedWord: "hello",
    source: "irc",
    channel: "#bots",
    isFallback: false
  });

  const logId = db.getOutputLogs(1)[0]?.id;
  assert.ok(logId != null);

  db.setOutputLabel(logId, approved.id, meta);

  const logs = db.getOutputLogs(1);
  const label = db.getLabelById(approved.id);

  assert.equal(logs[0]?.labelId, approved.id);
  assert.deepEqual(logs[0]?.labelMeta, meta);
  assert.equal(label?.count, 1);

  db.close();
});

test("clearOutputLabel returns outputs to unlabeled state and decrements counts", () => {
  const db = new MarkovDatabase(":memory:");
  const label = db.createLabel("fragment", "Incomplete output");

  db.logOutput({
    output: "Depending on the",
    seedWord: null,
    source: "discord",
    channel: "123",
    isFallback: true
  });

  const logId = db.getOutputLogs(1)[0]?.id;
  assert.ok(logId != null);

  db.setOutputLabel(logId, label.id, {
    otherLabels: [],
    confidence: 0.7,
    humanReviewed: true
  });
  db.clearOutputLabel(logId);

  const logs = db.getOutputLogs(1);
  const unlabeled = db.getUnlabeledOutputs(10);

  assert.equal(logs[0]?.labelId, null);
  assert.equal(logs[0]?.labelMeta, null);
  assert.equal(db.getLabelById(label.id)?.count, 0);
  assert.equal(unlabeled.length, 1);
  assert.equal(unlabeled[0]?.id, logId);

  db.close();
});

test("deleteLabel clears label references from output logs", () => {
  const db = new MarkovDatabase(":memory:");
  const label = db.createLabel("nonsense", "Incoherent output");

  db.logOutput({
    output: "The sky under because.",
    seedWord: "sky",
    source: "irc",
    channel: "#bots",
    isFallback: false
  });

  const logId = db.getOutputLogs(1)[0]?.id;
  assert.ok(logId != null);

  db.setOutputLabel(logId, label.id, {
    otherLabels: [],
    confidence: 0.6,
    humanReviewed: false
  });
  db.deleteLabel(label.id);

  const logs = db.getOutputLogs(1);

  assert.equal(db.getLabelById(label.id), null);
  assert.equal(logs[0]?.labelId, null);
  assert.equal(logs[0]?.labelMeta, null);

  db.close();
});

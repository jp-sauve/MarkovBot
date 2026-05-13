import { MarkovDatabase } from "../db/index.js";
import { MarkovEngine, tokenize } from "../engine/markov.js";
import { PosTagger } from "../engine/pos.js";

function createEngine(usePosTagger: boolean, shapeBoostFactor = 2) {
  const database = new MarkovDatabase(":memory:");
  const posTagger = usePosTagger ? new PosTagger() : undefined;
  const engine = new MarkovEngine(
    database,
    {
      order: 1,
      minResponseWords: 1,
      maxResponseWords: 20,
      fallbackResponses: ["I don't know."],
      shapeBoostFactor
    },
    posTagger
  );

  return { database, engine, posTagger };
}

function runPosIntegrationProbe(): void {
  const { database, engine } = createEngine(true);

  engine.learn("the quick fox runs");

  console.log("=== POS Integration ===");
  console.log(
    "word_pos for quick:",
    JSON.stringify(database.getWordPos("quick"))
  );
  console.log(
    "next words after 'the':",
    JSON.stringify(database.getNextWords("the"))
  );
  console.log("sentence shapes:", JSON.stringify(database.getSentenceShapes()));
  console.log();

  database.close();
}

function runGrammarProbe(): void {
  const { database, engine, posTagger } = createEngine(true, 10);

  if (!posTagger) {
    throw new Error("Expected POS tagger for grammar probe.");
  }

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
    engine.learn(sentence);
  }

  let nounEndings = 0;
  let adverbEndings = 0;
  const samples: string[] = [];

  for (let index = 0; index < 20; index += 1) {
    samples.push(engine.generate("cat"));
  }

  for (let index = 0; index < 200; index += 1) {
    const reply = engine.generate("cat");
    const lastTag = posTagger.tag(tokenize(reply)).at(-1)?.tag ?? "";

    if (lastTag.startsWith("NN")) {
      nounEndings += 1;
    } else if (lastTag.startsWith("RB")) {
      adverbEndings += 1;
    }
  }

  console.log("=== Grammar + Shape Bias ===");
  console.log(
    "top sentence shapes:",
    JSON.stringify(database.getSentenceShapes().slice(0, 5))
  );
  console.log("sample seeded outputs:");
  for (const sample of samples) {
    console.log(`- ${sample}`);
  }
  console.log(`noun-like endings: ${nounEndings}`);
  console.log(`adverb endings: ${adverbEndings}`);
  console.log();

  database.close();
}

function runBaselineProbe(): void {
  const { database, engine } = createEngine(false);

  const corpus = [
    "the quick brown fox jumps",
    "the lazy dog sleeps",
    "the clever bird sings",
    "a bright moon glows"
  ];

  for (const sentence of corpus) {
    engine.learn(sentence);
  }

  console.log("=== Basic Markov Fallback ===");
  for (let index = 0; index < 10; index += 1) {
    console.log(`- ${engine.generate()}`);
  }
  console.log(`seeded fallback sample: ${engine.generate("moon")}`);

  database.close();
}

runPosIntegrationProbe();
runGrammarProbe();
runBaselineProbe();

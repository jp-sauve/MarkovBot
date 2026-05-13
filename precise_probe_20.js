import { MarkovDatabase } from './dist/db.js';
import { MarkovEngine } from './dist/markov.js';

async function run() {
  const db = new MarkovDatabase(':memory:');
  const options = {
    order: 1,
    minResponseWords: 1,
    maxResponseWords: 50,
    fallbackResponses: ["I'm not sure what to say."]
  };
  const engine = new MarkovEngine(db, options);

  const trainingData = [
    "the quick brown fox jumps over the lazy dog",
    "a quick brown dog jumps over the lazy fox",
    "the lazy dog sleeps under the quick brown fox",
    "the quick brown fox is very quick",
    "the lazy dog is very lazy"
  ];

  for (const text of trainingData) {
    engine.learn(text);
  }

  for (let i = 0; i < 20; i++) {
    const output = engine.generate();
    process.stdout.write("out=" + output + "\n");
  }
}

run().catch(console.error);

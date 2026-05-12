import Database from 'better-sqlite3';
import { MarkovDatabase } from './dist/db.js';
import { getPosBigramBoost } from './dist/pos_grammar.js';
import fs from 'fs';
import path from 'path';

async function run() {
    const dbPath = path.join('/tmp', 'markov_precise_' + Math.random().toString(36).substring(7) + '.db');
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE markov_pairs (id INTEGER PRIMARY KEY, prefix TEXT NOT NULL, suffix TEXT NOT NULL, prefix_pos TEXT, suffix_pos TEXT, frequency INTEGER NOT NULL DEFAULT 1, UNIQUE(prefix, suffix));');
    const insert = raw.prepare('INSERT INTO markov_pairs (prefix, suffix, prefix_pos, suffix_pos, frequency) VALUES (?, ?, ?, ?, ?)');
    insert.run('__START__', 'the', null, 'DT', 100);
    insert.run('the', 'cat', 'DT', 'NN', 100);
    insert.run('the', 'runs', 'DT', 'VB', 100);
    insert.run('cat', '__END__', 'NN', null, 100);
    insert.run('runs', '__END__', 'VB', null, 100);
    raw.close();

    const db = new MarkovDatabase(dbPath);
    
    const nextThe = db.getNextWords('the');
    const boostNN = getPosBigramBoost('DT', 'NN');
    const boostVB = getPosBigramBoost('DT', 'VB');

    console.log('nextThe=' + JSON.stringify(nextThe));
    console.log('boostNN=' + boostNN);
    console.log('boostVB=' + boostVB);

    db.close();
    fs.unlinkSync(dbPath);
}
run().catch(err => {
    console.error(err);
    process.exit(1);
});

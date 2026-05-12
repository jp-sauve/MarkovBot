# MarkovBot Agent Notes

## Project Overview
- TypeScript Node.js project using NodeNext ESM.
- Purpose: shared Markov-chain chat bot for IRC and optionally Discord.
- Entry point: [src/index.ts](src/index.ts)
- Shared Markov logic lives in [src/markov.ts](src/markov.ts) and persistence in [src/db.ts](src/db.ts).

## Commands
- Build: `npm run build`
- Dev run: `npm run dev`
- Production run: `npm run start`

## Validation
- After TypeScript changes, run `npm run build`.
- There is currently no automated test script in `package.json`.

## Architecture
- [src/index.ts](src/index.ts): loads env/config, opens the database, starts IRC and optional Discord connectors, handles shutdown.
- [src/config/index.ts](src/config/index.ts): merges `config.json` and `MARKOV_*` environment variables, validates runtime settings, enables Discord only when fully configured.
- [src/db/index.ts](src/db/index.ts): owns the SQLite schema and weighted prefix/suffix queries.
- [src/db/migrate.ts](src/db/migrate.ts): one-time migration script for existing databases.
- [src/engine/markov.ts](src/engine/markov.ts): tokenization, command detection, seed-word selection, learning, and response generation.
- [src/engine/pos.ts](src/engine/pos.ts): POS tagger wrapper.
- [src/engine/pos_grammar.ts](src/engine/pos_grammar.ts): POS bigram boost table.
- [src/connectors/irc.ts](src/connectors/irc.ts): IRC connector, registration handling, nick fallback, message learning, channel replies.
- [src/connectors/discord.ts](src/connectors/discord.ts): Discord connector, slash-command registration, mention resolution, message learning, channel replies.
- [src/scripts/generation_probe.ts](src/scripts/generation_probe.ts): dev tool for probing generation quality.
- [src/scripts/label_worker.ts](src/scripts/label_worker.ts): dev tool for labeling bot outputs.

## Conventions
- Keep ESM import specifiers with `.js` extensions in TypeScript source.
- Prefer putting shared chat behavior in `engine/markov.ts`, `config/index.ts`, or `db/index.ts` instead of duplicating logic across IRC and Discord connectors.
- Keep changes minimal and consistent with existing strict TypeScript style.

## Project-Specific Gotchas
- `irc-framework` does not ship usable TypeScript types here; the local ambient declaration is in [src/types/irc-framework.d.ts](src/types/irc-framework.d.ts).
- `config.json`, `*.db`, and backup/runtime data files are environment and state artifacts. Do not modify them unless the user explicitly asks.
- If configuration behavior changes, update [config.example.json](config.example.json) rather than assuming local `config.json` should be edited.
- Discord startup is optional and can be skipped when config is incomplete; IRC and Discord startup errors are handled independently.

## Useful Starting Points
- Runtime boot flow: [src/index.ts](src/index.ts)
- Config loading and env names: [src/config/index.ts](src/config/index.ts)
- Shared text generation behavior: [src/engine/markov.ts](src/engine/markov.ts)
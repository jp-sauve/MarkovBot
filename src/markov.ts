import { MarkovDatabase, type WeightedPrefix } from './db.js';

const START_TOKEN = '__START__';
const END_TOKEN = '__END__';

export interface MarkovOptions {
  order: number;
  maxResponseWords: number;
}

function pickWeighted<T extends { frequency: number }>(items: T[]): T | null {
  if (items.length === 0) {
    return null;
  }

  const total = items.reduce((sum, item) => sum + item.frequency, 0);
  let threshold = Math.random() * total;

  for (const item of items) {
    threshold -= item.frequency;
    if (threshold <= 0) {
      return item;
    }
  }

  return items.at(-1) ?? null;
}

function trimToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

export function tokenize(message: string): string[] {
  const cleaned = message
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(' ')
    .map((token) => trimToken(token))
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function pickSeedWord(message: string, botNick: string): string | undefined {
  const nickPattern = new RegExp(`\\b${escapeRegExp(botNick)}\\b`, 'ig');
  const stripped = message.replace(nickPattern, ' ');
  const candidates = tokenize(stripped).filter((word) => word.length > 2);

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function looksLikeCommand(message: string): boolean {
  return /^[!.][^\s]+/.test(message.trim());
}

export class MarkovEngine {
  constructor(
    private readonly db: MarkovDatabase,
    private readonly options: MarkovOptions,
  ) {}

  learn(message: string): void {
    const tokens = tokenize(message);
    if (tokens.length === 0) {
      return;
    }

    const chain = [
      ...Array.from({ length: this.options.order }, () => START_TOKEN),
      ...tokens,
      END_TOKEN,
    ];
    const pairs: Array<{ prefix: string; suffix: string }> = [];

    for (let index = this.options.order; index < chain.length; index += 1) {
      pairs.push({
        prefix: chain.slice(index - this.options.order, index).join(' '),
        suffix: chain[index],
      });
    }

    this.db.addChain(pairs);
  }

  generate(seedWord?: string): string {
    const initialPrefix = pickWeighted(this.resolveInitialPrefixes(seedWord));
    if (!initialPrefix) {
      return '';
    }

    let currentPrefix = initialPrefix.prefix.split(' ');
    const output = currentPrefix.filter((word) => word !== START_TOKEN);

    while (output.length < this.options.maxResponseWords) {
      const nextWord = pickWeighted(this.db.getNextWords(currentPrefix.join(' ')));
      if (!nextWord || nextWord.suffix === END_TOKEN) {
        break;
      }

      output.push(nextWord.suffix);
      currentPrefix = [...currentPrefix.slice(1), nextWord.suffix];
    }

    return output.join(' ').trim();
  }

  private resolveInitialPrefixes(seedWord?: string): WeightedPrefix[] {
    if (seedWord) {
      const seededPrefixes = this.db.findSeededPrefixes(seedWord);
      if (seededPrefixes.length > 0) {
        return seededPrefixes;
      }
    }

    return this.db.getStartingPairs(START_TOKEN);
  }
}
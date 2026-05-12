import {
  MarkovDatabase,
  type SentenceShapeFrequency,
  type WeightedPrefix
} from "./db.js";
import type { PosTagger } from "./pos.js";
import { getPosBigramBoost } from "./pos_grammar.js";

const START_TOKEN = "__START__";
const END_TOKEN = "__END__";
const FRAGMENT_ENDINGS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "his",
  "her",
  "our",
  "their"
]);

export interface MarkovOptions {
  order: number;
  minResponseWords: number;
  maxResponseWords: number;
  fallbackResponses: string[];
  shapeBoostFactor?: number;
}

export interface GenerationLogContext {
  source?: string;
  channel?: string;
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
  const trimmed = token.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  const withoutDetachedQuotes = trimmed.replace(
    /(?<![\p{L}\p{N}])'+|'+(?![\p{L}\p{N}])/gu,
    ""
  );

  return withoutDetachedQuotes.replace(
    /^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu,
    ""
  );
}

function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function postProcess(text: string): string {
  if (!text) {
    return text;
  }

  const normalized = text
    .split(/\s+/)
    .map((token) => trimToken(token))
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!normalized) {
    return normalized;
  }

  const capitalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  if (/[.!?]$/.test(capitalized)) {
    return capitalized;
  }

  const lastWord = capitalized.split(/\s+/).at(-1)?.toLowerCase() ?? "";
  const questionWords = new Set([
    "right",
    "yes",
    "no",
    "huh",
    "eh",
    "what",
    "who",
    "how",
    "when",
    "where",
    "why",
    "really",
    "though"
  ]);

  return `${capitalized}${questionWords.has(lastWord) ? "?" : "."}`;
}

function isStructurallyCompleteResponse(
  text: string,
  minResponseWords: number
): boolean {
  const words = tokenize(text);

  if (words.length < minResponseWords) {
    return false;
  }

  const lastWord = words.at(-1)?.toLowerCase() ?? "";
  return !FRAGMENT_ENDINGS.has(lastWord);
}

export function tokenize(message: string): string[] {
  const cleaned = message
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(" ")
    .map((token) => trimToken(token))
    .filter((token) => token.length >= 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pickSeedWord(
  message: string,
  botNick: string
): string | undefined {
  const nickPattern = new RegExp(`\\b${escapeRegExp(botNick)}\\b`, "ig");
  const stripped = message.replace(nickPattern, " ");
  const candidates = tokenize(stripped).filter((word) => word.length > 2);

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function looksLikeCommand(message: string): boolean {
  return /^[!.+][^\s]+/.test(message.trim());
}

function applyPosGrammarBoost<
  T extends { frequency: number; suffixPos: string | null }
>(items: T[], prefixPos: string | null): T[] {
  return items.map((item) => ({
    ...item,
    frequency: item.frequency * getPosBigramBoost(prefixPos, item.suffixPos)
  }));
}

function parseSentenceShape(shape: string): string[] {
  return shape.split(/\s+/).filter(Boolean);
}

function pickWeightedShape(
  shapes: SentenceShapeFrequency[],
  preferredTag: string | null
): string[] | null {
  const weightedShapes = shapes.flatMap((shape) => {
    const tags = parseSentenceShape(shape.shape);

    if (tags.length === 0) {
      return [];
    }

    return {
      tags,
      frequency:
        preferredTag && tags.includes(preferredTag)
          ? shape.frequency * 1.5
          : shape.frequency
    };
  });
  const selected = pickWeighted(weightedShapes);

  return selected?.tags ?? null;
}

function applyShapeSlotBoost<
  T extends { frequency: number; suffixPos: string | null }
>(items: T[], expectedTag: string | null, boostFactor = 2): T[] {
  if (!expectedTag || boostFactor <= 1) {
    return items;
  }

  return items.map((item) => ({
    ...item,
    frequency:
      item.frequency * (item.suffixPos === expectedTag ? boostFactor : 1)
  }));
}

export class MarkovEngine {
  constructor(
    private readonly db: MarkovDatabase,
    private readonly options: MarkovOptions,
    private readonly posTagger?: PosTagger
  ) {}

  learn(message: string): void {
    const tokens = tokenize(message);
    if (tokens.length === 0) {
      return;
    }

    const taggedWords = this.posTagger?.tag(tokens) ?? [];
    const sentenceShape = taggedWords.map((entry) => entry.tag).join(" ");
    const tagAtTokenIndex = (tokenIndex: number): string | null =>
      taggedWords[tokenIndex]?.tag ?? null;

    const chain = [
      ...Array.from({ length: this.options.order }, () => START_TOKEN),
      ...tokens,
      END_TOKEN
    ];
    const pairs: Array<{
      prefix: string;
      suffix: string;
      prefixPos: string | null;
      suffixPos: string | null;
    }> = [];

    for (let index = this.options.order; index < chain.length; index += 1) {
      const prefixWords = chain.slice(index - this.options.order, index);
      const prefixTail = prefixWords.at(-1);
      const suffix = chain[index];

      pairs.push({
        prefix: prefixWords.join(" "),
        suffix,
        prefixPos:
          prefixTail && prefixTail !== START_TOKEN
            ? tagAtTokenIndex(index - this.options.order - 1)
            : null,
        suffixPos:
          suffix !== END_TOKEN
            ? tagAtTokenIndex(index - this.options.order)
            : null
      });
    }

    this.db.addChain(pairs);
    this.db.addWordPos(taggedWords);
    this.db.addSentenceShape(sentenceShape);
  }

  generate(seedWord?: string): string {
    return this.generateResponse(seedWord).text;
  }

  generateAndLog(seedWord?: string, context?: GenerationLogContext): string {
    const response = this.generateResponse(seedWord);

    if (response.text) {
      this.db.logOutput({
        output: response.text,
        seedWord: seedWord ?? null,
        source: context?.source ?? null,
        channel: context?.channel ?? null,
        isFallback: response.isFallback
      });
    }

    return response.text;
  }

  private generateResponse(seedWord?: string): {
    text: string;
    isFallback: boolean;
  } {
    const initialPrefix = pickWeighted(this.resolveInitialPrefixes(seedWord));
    if (!initialPrefix) {
      return {
        text: this.pickFallbackResponse(),
        isFallback: true
      };
    }

    let currentPrefix = initialPrefix.prefix.split(" ");
    let currentPrefixPos = initialPrefix.prefixPos;
    const output = currentPrefix.filter((word) => word !== START_TOKEN);
    const wordCounts = new Map<string, number>();
    const preferredShapeTag = this.resolvePreferredShapeTag(seedWord);
    const targetShape = pickWeightedShape(
      this.db.getSentenceShapes(),
      preferredShapeTag
    );

    for (const word of output) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }

    while (output.length < this.options.maxResponseWords) {
      const candidates = this.db.getNextWords(currentPrefix.join(" "));
      const nonRepeatedCandidates = candidates.filter(
        (candidate) => (wordCounts.get(candidate.suffix) ?? 0) < 2
      );
      const weightedCandidates = applyPosGrammarBoost(
        nonRepeatedCandidates.length > 0 ? nonRepeatedCandidates : candidates,
        currentPrefixPos
      );
      const shapeWeightedCandidates = applyShapeSlotBoost(
        weightedCandidates,
        targetShape?.[output.length] ?? null,
        this.options.shapeBoostFactor
      );
      const nextWord = pickWeighted(shapeWeightedCandidates);

      if (!nextWord || nextWord.suffix === END_TOKEN) {
        break;
      }

      output.push(nextWord.suffix);
      wordCounts.set(
        nextWord.suffix,
        (wordCounts.get(nextWord.suffix) ?? 0) + 1
      );
      currentPrefixPos = nextWord.suffixPos;
      currentPrefix = [...currentPrefix.slice(1), nextWord.suffix];
    }

    if (output.length < this.options.minResponseWords) {
      return {
        text: this.pickFallbackResponse(),
        isFallback: true
      };
    }

    const responseText = postProcess(output.join(" ").trim());

    if (
      !responseText ||
      !isStructurallyCompleteResponse(
        responseText,
        this.options.minResponseWords
      )
    ) {
      return {
        text: this.pickFallbackResponse(),
        isFallback: true
      };
    }

    return {
      text: responseText,
      isFallback: false
    };
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

  private resolvePreferredShapeTag(seedWord?: string): string | null {
    if (!seedWord) {
      return null;
    }

    const exactMatches = this.db.getWordPos(seedWord);
    if (exactMatches.length > 0) {
      return exactMatches[0]?.tag ?? null;
    }

    const normalizedSeedWord = seedWord.toLowerCase();
    if (normalizedSeedWord === seedWord) {
      return null;
    }

    return this.db.getWordPos(normalizedSeedWord)[0]?.tag ?? null;
  }

  private pickFallbackResponse(): string {
    return pickRandom(this.options.fallbackResponses) ?? "";
  }
}

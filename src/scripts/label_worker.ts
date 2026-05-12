import { spawnSync } from "node:child_process";

import { MarkovDatabase, type OutputLabelMeta } from "../db/index.js";

const ALLOWED_LABELS = [
  "good",
  "fragment",
  "run-on",
  "topic jump",
  "repetitive",
  "no verb",
  "conjunction ending",
  "preposition ending",
  "username",
  "nonsense"
] as const;

type AllowedLabel = (typeof ALLOWED_LABELS)[number];

const LABEL_PRECEDENCE: AllowedLabel[] = [
  "nonsense",
  "no verb",
  "fragment",
  "run-on",
  "conjunction ending",
  "preposition ending",
  "repetitive",
  "topic jump",
  "username",
  "good"
];

const LABEL_DESCRIPTIONS: Record<AllowedLabel, string> = {
  good: "Acceptable output; none of the deficiency conditions apply.",
  fragment: "Incomplete clause or cut-off thought.",
  "run-on": "Too many clauses; poor boundary or punctuation.",
  "topic jump": "Abrupt semantic shift mid-sentence.",
  repetitive: "Obvious word or phrase repetition without purpose.",
  "no verb": "No finite main verb present.",
  "conjunction ending": "Ends with a conjunction token.",
  "preposition ending": "Ends with a preposition token.",
  username: "Dominated by nick or user-handle artifact.",
  nonsense: "Grammatical or semantic incoherence beyond other labels."
};

const CLASSIFIER_PROMPT = `You are a sentence quality classifier for a Markov chain chatbot.
Classify the given sentence with exactly one label from this list: ${ALLOWED_LABELS.join(", ")}.

Label definitions:
${Object.entries(LABEL_DESCRIPTIONS)
  .map(([label, description]) => `- ${label}: ${description}`)
  .join("\n")}

If multiple issues apply, choose the most severe using this precedence:
${LABEL_PRECEDENCE.join(" > ")}

Return ONLY valid JSON with this exact shape:
{"label":"<one label>","reason":"<max 12 words>","otherLabels":["<label>"],"confidence":0.9}`;

interface WorkerOptions {
  dbPath: string;
  batchSize: number;
  chunkSize: number;
  delayMs: number;
  maxAttempts: number;
  dryRun: boolean;
}

interface ClassifierResult {
  label: AllowedLabel;
  reason: string;
  otherLabels: string[];
  confidence: number;
}

interface BatchItem {
  id: number;
  sentence: string;
}

interface GeminiCallResult {
  stdout: string;
  stderr: string;
}

function parseArgs(argv: string[]): WorkerOptions {
  const options: WorkerOptions = {
    dbPath: "markov3.db",
    batchSize: 50,
    chunkSize: 8,
    delayMs: 500,
    maxAttempts: 3,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--db-path" && argv[index + 1]) {
      options.dbPath = argv[index + 1] as string;
      index += 1;
    } else if (argument === "--batch" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        options.batchSize = parsed;
      }
      index += 1;
    } else if (argument === "--chunk-size" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        options.chunkSize = parsed;
      }
      index += 1;
    } else if (argument === "--delay" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isInteger(parsed) && parsed >= 0) {
        options.delayMs = parsed;
      }
      index += 1;
    } else if (argument === "--max-attempts" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isInteger(parsed) && parsed > 0) {
        options.maxAttempts = parsed;
      }
      index += 1;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help") {
      console.log(
        [
          "Usage: tsx src/label_worker.ts [options]",
          "",
          "Options:",
          "  --db-path <path>      SQLite path (default: markov3.db)",
          "  --batch <n>           Number of rows to process (default: 50)",
          "  --chunk-size <n>      Sentences per Gemini call (default: 8)",
          "  --delay <ms>          Delay between rows in ms (default: 500)",
          "  --max-attempts <n>    Retries per row (default: 3)",
          "  --dry-run             Skip gemini call and write sample labels",
          "  --help                Show this help"
        ].join("\n")
      );
      process.exit(0);
    }
  }

  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logSnippet(value: string, maxLength = 800): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...(truncated)`;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? trimmed).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  const text = stripCodeFence(raw);

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

function tryParseArray(raw: string): unknown[] | null {
  const text = stripCodeFence(raw);

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]) as unknown;
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

function enqueueCandidate(
  queue: string[],
  seen: Set<string>,
  value: unknown
): void {
  if (typeof value !== "string") {
    return;
  }

  const normalized = value.trim();
  if (normalized.length === 0 || seen.has(normalized)) {
    return;
  }

  seen.add(normalized);
  queue.push(normalized);
}

function extractClassifierPayload(raw: string): Record<string, unknown> {
  const queue: string[] = [];
  const seen = new Set<string>();
  enqueueCandidate(queue, seen, raw);

  while (queue.length > 0) {
    const candidate = queue.shift() as string;
    const parsed = tryParseObject(candidate);
    if (!parsed) {
      continue;
    }

    if (typeof parsed["label"] === "string") {
      return parsed;
    }

    enqueueCandidate(queue, seen, parsed["response"]);
    enqueueCandidate(queue, seen, parsed["text"]);
    enqueueCandidate(queue, seen, parsed["content"]);
    enqueueCandidate(queue, seen, parsed["message"]);

    const candidates = parsed["candidates"];
    if (Array.isArray(candidates)) {
      for (const item of candidates) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const itemRecord = item as Record<string, unknown>;
        enqueueCandidate(queue, seen, itemRecord["text"]);
        enqueueCandidate(queue, seen, itemRecord["content"]);

        const content = itemRecord["content"];
        if (content && typeof content === "object") {
          const parts = (content as Record<string, unknown>)["parts"];
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (!part || typeof part !== "object") {
                continue;
              }

              enqueueCandidate(
                queue,
                seen,
                (part as Record<string, unknown>)["text"]
              );
            }
          }
        }
      }
    }
  }

  throw new Error(
    `No classifier payload with label found. raw=${logSnippet(raw, 500)}`
  );
}

function extractClassifierArray(raw: string): Record<string, unknown>[] {
  const queue: string[] = [];
  const seen = new Set<string>();
  enqueueCandidate(queue, seen, raw);

  while (queue.length > 0) {
    const candidate = queue.shift() as string;
    const parsedArray = tryParseArray(candidate);
    if (parsedArray) {
      return parsedArray.filter(isRecord);
    }

    const parsed = tryParseObject(candidate);
    if (!parsed) {
      continue;
    }

    const directArray =
      parsed["results"] ?? parsed["items"] ?? parsed["labels"];
    if (Array.isArray(directArray)) {
      return directArray.filter(isRecord);
    }

    enqueueCandidate(queue, seen, parsed["response"]);
    enqueueCandidate(queue, seen, parsed["text"]);
    enqueueCandidate(queue, seen, parsed["content"]);
    enqueueCandidate(queue, seen, parsed["message"]);

    const candidates = parsed["candidates"];
    if (Array.isArray(candidates)) {
      for (const item of candidates) {
        if (!isRecord(item)) {
          continue;
        }

        enqueueCandidate(queue, seen, item["text"]);
        enqueueCandidate(queue, seen, item["content"]);

        const content = item["content"];
        if (isRecord(content)) {
          const parts = content["parts"];
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (!isRecord(part)) {
                continue;
              }

              enqueueCandidate(queue, seen, part["text"]);
            }
          }
        }
      }
    }
  }

  throw new Error(`No classifier array found. raw=${logSnippet(raw, 500)}`);
}

function normalizeClassifierResult(
  parsed: Record<string, unknown>
): ClassifierResult {
  const label = parsed["label"];
  if (
    typeof label !== "string" ||
    !ALLOWED_LABELS.includes(label as AllowedLabel)
  ) {
    const parsedKeys = Object.keys(parsed).join(", ") || "(none)";
    throw new Error(
      `Invalid label in output: ${String(label)}; keys=${parsedKeys}; payload=${logSnippet(JSON.stringify(parsed), 300)}`
    );
  }

  const reason =
    typeof parsed["reason"] === "string" && parsed["reason"].trim().length > 0
      ? parsed["reason"].trim()
      : "No reason provided";

  const otherLabels = Array.isArray(parsed["otherLabels"])
    ? parsed["otherLabels"].filter(
        (item): item is string =>
          typeof item === "string" &&
          ALLOWED_LABELS.includes(item as AllowedLabel) &&
          item !== label
      )
    : [];

  const confidenceValue = parsed["confidence"];
  const confidence =
    typeof confidenceValue === "number"
      ? Math.max(0, Math.min(1, confidenceValue))
      : typeof confidenceValue === "string" &&
          Number.isFinite(Number(confidenceValue))
        ? Math.max(0, Math.min(1, Number(confidenceValue)))
        : 0.5;

  return {
    label: label as AllowedLabel,
    reason,
    otherLabels,
    confidence
  };
}

function parseClassifierResult(raw: string): ClassifierResult {
  return normalizeClassifierResult(extractClassifierPayload(raw));
}

function parseBatchId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseBatchResult(
  raw: string,
  items: BatchItem[]
): Map<number, ClassifierResult> {
  const expectedIds = new Set(items.map((item) => item.id));
  const parsedItems = extractClassifierArray(raw);
  const results = new Map<number, ClassifierResult>();

  for (const parsedItem of parsedItems) {
    const id = parseBatchId(parsedItem["id"]);
    if (id == null || !expectedIds.has(id) || results.has(id)) {
      continue;
    }

    try {
      results.set(id, normalizeClassifierResult(parsedItem));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Ignoring invalid batch result for id ${id}: ${message}`);
    }
  }

  return results;
}

function createDryRunResult(): ClassifierResult {
  return {
    label: "good",
    reason: "Dry-run placeholder",
    otherLabels: [],
    confidence: 1
  };
}

function callGemini(prompt: string): GeminiCallResult {
  const result = spawnSync("gemini", ["-o", "json", prompt], {
    encoding: "utf8",
    timeout: 60000
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `gemini failed with status ${String(result.status)}: stderr=${logSnippet(stderr, 400)} stdout=${logSnippet(stdout, 400)}`
    );
  }

  return {
    stdout,
    stderr
  };
}

function buildBatchPrompt(items: BatchItem[]): string {
  const sentences = items
    .map((item) => `${item.id}: ${JSON.stringify(item.sentence)}`)
    .join("\n");

  return `${CLASSIFIER_PROMPT}

Classify every sentence below.
Return ONLY a valid JSON array with exactly ${items.length} objects.
Each object must use this exact shape:
{"id":123,"label":"<one label>","reason":"<max 12 words>","otherLabels":["<label>"],"confidence":0.9}

Rules:
- Return one object for every id shown below.
- Use each id exactly once.
- Do not include any text before or after the JSON array.

Sentences:
${sentences}`;
}

function classifyBatchWithGemini(
  items: BatchItem[],
  dryRun: boolean
): Map<number, ClassifierResult> {
  if (dryRun) {
    return new Map(
      items.map((item) => [item.id, createDryRunResult()] as const)
    );
  }

  const prompt = buildBatchPrompt(items);
  const { stdout, stderr } = callGemini(prompt);

  try {
    return parseBatchResult(stdout, items);
  } catch (error) {
    console.warn("Gemini batch parse failure diagnostics:");
    console.warn(`ids=${items.map((item) => item.id).join(", ")}`);
    console.warn(`stdout=${logSnippet(stdout, 1200)}`);
    if (stderr.trim().length > 0) {
      console.warn(`stderr=${logSnippet(stderr, 600)}`);
    }
    throw error;
  }
}

function classifyWithGemini(
  sentence: string,
  dryRun: boolean
): ClassifierResult {
  if (dryRun) {
    return createDryRunResult();
  }

  const prompt = `${CLASSIFIER_PROMPT}\n\nSentence: "${sentence}"`;
  const { stdout, stderr } = callGemini(prompt);

  try {
    return parseClassifierResult(stdout);
  } catch (error) {
    console.warn("Gemini parse failure diagnostics:");
    console.warn(`sentence=${logSnippet(sentence, 200)}`);
    console.warn(`stdout=${logSnippet(stdout, 1200)}`);
    if (stderr.trim().length > 0) {
      console.warn(`stderr=${logSnippet(stderr, 600)}`);
    }
    throw error;
  }
}

async function classifySingleWithRetries(
  item: BatchItem,
  maxAttempts: number,
  delayMs: number,
  dryRun: boolean
): Promise<ClassifierResult | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return classifyWithGemini(item.sentence, dryRun);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${item.id}] attempt ${attempt} failed: ${message}`);
      if (attempt < maxAttempts && delayMs > 0 && !dryRun) {
        await sleep(delayMs * attempt);
      }
    }
  }

  return null;
}

async function splitAndClassifyChunk(
  items: BatchItem[],
  maxAttempts: number,
  delayMs: number,
  dryRun: boolean
): Promise<Map<number, ClassifierResult>> {
  if (items.length <= 1) {
    return classifyChunk(items, maxAttempts, delayMs, dryRun);
  }

  const midpoint = Math.ceil(items.length / 2);
  const leftItems = items.slice(0, midpoint);
  const rightItems = items.slice(midpoint);
  const leftResults = await classifyChunk(
    leftItems,
    maxAttempts,
    delayMs,
    dryRun
  );

  if (rightItems.length > 0 && delayMs > 0 && !dryRun) {
    await sleep(delayMs);
  }

  const rightResults = await classifyChunk(
    rightItems,
    maxAttempts,
    delayMs,
    dryRun
  );

  return new Map([...leftResults, ...rightResults]);
}

async function classifyChunk(
  items: BatchItem[],
  maxAttempts: number,
  delayMs: number,
  dryRun: boolean
): Promise<Map<number, ClassifierResult>> {
  if (items.length === 0) {
    return new Map();
  }

  if (items.length === 1) {
    const result = await classifySingleWithRetries(
      items[0],
      maxAttempts,
      delayMs,
      dryRun
    );
    return result ? new Map([[items[0].id, result]]) : new Map();
  }

  const ids = items.map((item) => item.id).join(", ");

  try {
    const results = classifyBatchWithGemini(items, dryRun);
    if (results.size === items.length) {
      return results;
    }

    const unresolvedItems = items.filter((item) => !results.has(item.id));
    console.warn(
      `Batch returned ${results.size}/${items.length} results for ids=${ids}; splitting unresolved ids=${unresolvedItems
        .map((item) => item.id)
        .join(", ")}`
    );
    const fallbackResults = await splitAndClassifyChunk(
      unresolvedItems,
      maxAttempts,
      delayMs,
      dryRun
    );
    return new Map([...results, ...fallbackResults]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Batch classify failed for ids=${ids}: ${message}`);
    return splitAndClassifyChunk(items, maxAttempts, delayMs, dryRun);
  }
}

function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = new MarkovDatabase(options.dbPath);

  try {
    for (const labelName of ALLOWED_LABELS) {
      db.createLabel(labelName, LABEL_DESCRIPTIONS[labelName]);
    }

    const rows = db.getUnlabeledOutputs(options.batchSize);
    if (rows.length === 0) {
      console.log("No unlabeled rows found.");
      return;
    }

    console.log(`Processing ${rows.length} row(s) from ${options.dbPath}`);

    let successCount = 0;
    let failureCount = 0;
    const rowChunks = chunkItems(rows, options.chunkSize);

    for (let chunkIndex = 0; chunkIndex < rowChunks.length; chunkIndex += 1) {
      const rowChunk = rowChunks[chunkIndex] as typeof rows;
      const items = rowChunk.map((row) => ({
        id: row.id,
        sentence: row.output
      }));
      const results = await classifyChunk(
        items,
        options.maxAttempts,
        options.delayMs,
        options.dryRun
      );

      for (const row of rowChunk) {
        const result = results.get(row.id);
        if (!result) {
          failureCount += 1;
          console.warn(`[${row.id}] failed after batched fallback`);
          continue;
        }

        if (options.dryRun) {
          successCount += 1;
          console.log(
            `[${row.id}] dry-run -> ${result.label} (${result.confidence.toFixed(2)}) - ${result.reason}`
          );
          continue;
        }

        const label = db.getLabelByName(result.label);
        if (!label) {
          failureCount += 1;
          console.warn(
            `[${row.id}] missing label in output_labels: ${result.label}`
          );
          continue;
        }

        const meta: OutputLabelMeta = {
          otherLabels: result.otherLabels,
          confidence: result.confidence,
          humanReviewed: false
        };

        db.setOutputLabel(row.id, label.id, meta);
        successCount += 1;
        console.log(
          `[${row.id}] ${result.label} (${result.confidence.toFixed(2)}) - ${result.reason}`
        );
      }

      if (
        chunkIndex < rowChunks.length - 1 &&
        options.delayMs > 0 &&
        !options.dryRun
      ) {
        await sleep(options.delayMs);
      }
    }

    console.log(`Done. success=${successCount} failed=${failureCount}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});

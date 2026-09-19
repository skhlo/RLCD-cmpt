/**
 * Search entries — BM25 + regex search over session history.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/search-entries.ts)
 * Fork changes: shared parser-owned query plans for both recall surfaces.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import {
  textOf,
  toolCallArgsText,
  extractToolCallArgsText,
  isContentBearing,
  clip,
} from "./content";
import type { RecallMode } from "./recall-scope";

// Mirrors @earendil-works/pi-coding-agent's BashExecutionMessage (not re-exported from index)
interface LocalBashExec {
  role: "bashExecution";
  command: string;
  output: string;
}

export interface FileMatch {
  /** Name of the tool (write, edit, hex_edit) */
  toolName: string;
  /** File path from the tool call arguments */
  path: string;
  /** Number of lines in the content that matched the query */
  lineCount: number;
  /** First matching line snippet (only populated for top matches) */
  snippet?: string;
}

/** A file touched in one entry — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
}

/** Aggregated view of a file touched across multiple entries. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
  /** Per-file match indicators from content-bearing tool calls */
  fileMatches?: FileMatch[];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Try to compile as regex; fall back to escaped literal. */
const safeRegex = (pattern: string): RegExp => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/** Match a single search term literally (all metacharacters escaped). */
const literalRegex = (term: string): RegExp => new RegExp(escapeRegex(term), "i");

/**
 * Operator characters that signal regex intent in a single term. A bare dot
 * is deliberately excluded: filenames ("observer.ts") and versions ("v1.0")
 * are prose, not patterns. `$`/`^` stay: anchoring an otherwise-plain term is
 * still useful, and prose rarely leads/trails with them.
 */
const REGEX_TERM_HINT = /[|*+?{}()[\]\\^$]/;

export type SearchTermIntent = "literal" | "pattern";

/** A query term paired with the parser-owned intent and compiled matcher. */
export interface SearchTermPlan {
  readonly term: string;
  readonly intent: SearchTermIntent;
  readonly pattern: RegExp;
}

/**
 * Compile one query term: operator-bearing terms stay regex patterns
 * (invalid ones fall back to an escaped literal via safeRegex), plain terms —
 * including dotted filenames — match literally, so "observer.ts" never
 * matches "observerXts". Never throws.
 */
const compileTerm = (term: string): SearchTermPlan => {
  const intent = REGEX_TERM_HINT.test(term) ? "pattern" : "literal";
  return {
    term,
    intent,
    pattern: intent === "pattern" ? safeRegex(term) : literalRegex(term),
  };
};

const compileTerms = (terms: readonly string[]): SearchTermPlan[] => terms.map(compileTerm);

/** Build a matcher over compiled per-term patterns — matches first available term. */
const snippetRegex = (terms: readonly SearchTermPlan[]): RegExp => {
  const alts = terms.map(({ pattern }) => pattern.source);
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: readonly SearchTermPlan[]): readonly SearchTermPlan[] => {
  const meaningful = terms.filter(
    ({ term }) => !STOPWORDS.has(term.toLowerCase()) && term.length > 1,
  );
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

/** One parser-owned interpretation shared by search and both recall surfaces. */
export interface SearchQueryPlan {
  /** Full query with outer whitespace removed; internal wording is unchanged. */
  readonly query: string;
  /** Pattern when any term contains a regex operator, otherwise literal. */
  readonly intent: SearchTermIntent;
  /** Query-syntax eligibility only; callers still enforce route and mode exclusions. */
  readonly eligibleForReranking: boolean;
  /** Every compiled term, including stopwords, for file-match snippets. */
  readonly allTerms: readonly SearchTermPlan[];
  /** The compiled terms used by the existing BM25 and transcript-snippet search. */
  readonly terms: readonly SearchTermPlan[];
}

/** Parse and compile a query once without changing its existing search meaning. */
export const planSearchQuery = (query?: string): SearchQueryPlan | undefined => {
  const rawQuery = query?.trim();
  if (!rawQuery) return undefined;

  const allTerms = compileTerms(rawQuery.split(/\s+/));
  const intent = allTerms.some((term) => term.intent === "pattern") ? "pattern" : "literal";
  return {
    query: rawQuery,
    intent,
    eligibleForReranking: intent === "literal",
    allTerms,
    terms: filterStopwords(allTerms),
  };
};

/** Count how many distinct terms match the haystack. */
const countMatches = (hay: string, compiled: readonly SearchTermPlan[]): number => {
  let count = 0;
  for (const c of compiled) {
    if (c.pattern.test(hay)) count++;
  }
  return count;
};

// ── BM25+ scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 0.5; // BM25+ lower-bound floor for matched terms

/** Count occurrences of a regex pattern in text. */
const termFreq = (text: string, pattern: RegExp): number => {
  const matches = text.match(new RegExp(pattern.source, "gi"));
  return matches ? matches.length : 0;
};

interface BM25Context {
  n: number; // total docs
  avgDl: number; // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], compiled: readonly SearchTermPlan[]): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    totalLen += doc.split(/\s+/).length;
    for (const c of compiled) {
      if (c.pattern.test(doc)) {
        df.set(c.term, (df.get(c.term) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

/** BM25+ score for a single doc against query terms. */
const bm25Score = (doc: string, compiled: readonly SearchTermPlan[], ctx: BM25Context): number => {
  const dl = doc.split(/\s+/).length;
  let score = 0;

  for (const c of compiled) {
    const tf = termFreq(doc, c.pattern);
    if (tf === 0) continue;

    const docFreq = ctx.df.get(c.term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization + BM25+ delta floor
    const tfNorm =
      (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + (BM25_B * dl) / Math.max(ctx.avgDl, 1)));
    score += idf * (tfNorm + BM25_DELTA);
  }

  return score;
};

/**
 * Maximum characters of a single line kept in a search snippet. A long line
 * (e.g. a dumped tool result) is clipped so one match cannot blow the recall
 * response; the match itself stays visible via a match-centered window.
 */
const SNIPPET_LINE_MAX = 1000;

/**
 * Clip a single snippet line to SNIPPET_LINE_MAX.
 * When `regex` is provided (the matched context line), the window is centered
 * on the match so the hit stays visible even deep in a long line; otherwise
 * (plain context lines) the start is kept.
 */
const clipSnippetLine = (line: string, regex?: RegExp): string => {
  if (line.length <= SNIPPET_LINE_MAX) return line;
  let trimmed = line.slice(0, SNIPPET_LINE_MAX);
  let prefix = "";
  if (regex) {
    const match = regex.exec(line);
    if (match) {
      const radius = Math.max(0, Math.floor((SNIPPET_LINE_MAX - match[0].length) / 2));
      const start = Math.max(0, match.index - radius);
      const end = Math.min(line.length, match.index + match[0].length + radius);
      prefix = start > 0 ? "… " : "";
      trimmed = line.slice(start, end);
    }
  }
  return `${prefix}${trimmed} … [truncated]`;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  // Cap each line so a single 50KB output cannot flood the response;
  // clip the matched line around the hit so the match stays visible.
  parts.push(
    ...slice.map((line, i) => clipSnippetLine(line, i === matchIdx - start ? regex : undefined)),
  );
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/** Build full searchable text for a message, optionally filtered by mode. */
const RECALL_TOOL_NAME = "recall";
const TOOL_ARGS_BUDGET = 2000;

const searchableToolCallArgs = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  const raw = content
    .filter((part) => part.type === "toolCall")
    .filter((part) => part.name?.toLowerCase() !== RECALL_TOOL_NAME)
    .map((part) => extractToolCallArgsText(part.arguments))
    .filter(Boolean)
    .join("\n");
  return clip(raw, TOOL_ARGS_BUDGET);
};

const fullText = (msg: Message, mode?: RecallMode): string => {
  if ((msg as any).role === "bashExecution") {
    if (mode === "file") return ""; // bash is not file content
    const bashMsg = msg as unknown as LocalBashExec;
    return `${bashMsg.command ?? ""} ${bashMsg.output ?? ""}`;
  }
  if (mode === "file") {
    return toolCallArgsText(msg.content);
  }
  if (
    (msg as any).role === "toolResult" &&
    (msg as any).toolName?.toLowerCase() === RECALL_TOOL_NAME
  ) {
    return "";
  }
  // hybrid (default): both transcript text + tool call args
  const text = textOf(msg.content);
  const toolArgs = searchableToolCallArgs(msg.content);
  return toolArgs ? `${text}\n${toolArgs}` : text;
};

/**
 * Extract searchable text from tool call arguments (content, edits, oldText, newText).
 */
function extractToolCallText(args: Record<string, unknown>): string {
  let text = "";
  if (typeof args.content === "string") text += args.content + "\n";
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        if (typeof edit.oldText === "string") text += edit.oldText + "\n";
        if (typeof edit.newText === "string") text += edit.newText + "\n";
      }
    }
  }
  if (typeof args.oldText === "string" && !Array.isArray(args.edits)) text += args.oldText + "\n";
  if (typeof args.newText === "string" && !Array.isArray(args.edits)) text += args.newText + "\n";
  return text;
}

/**
 * Compute file indicators from a message (no query — counts total lines per file).
 */
export function getFileIndicators(msg: Message): FileMatch[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const fileMatches: FileMatch[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;

    const path = ["path", "filePath", "file_path", "file"]
      .map((k) => args[k])
      .find((v): v is string => typeof v === "string")!;

    const totalText = extractToolCallText(args);
    const nonEmpty = totalText.split("\n").filter((l) => l.trim().length > 0);
    fileMatches.push({
      toolName: part.name || "",
      path,
      lineCount: nonEmpty.length,
    });
  }
  return fileMatches;
}

function computeFileMatches(msg: Message | undefined, plan: SearchQueryPlan): FileMatch[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const regex = snippetRegex(plan.allTerms);
  const fileMatches: FileMatch[] = [];

  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    if (!isContentBearing(args)) continue;

    // Path is guaranteed by isContentBearing check
    const path = ["path", "filePath", "file_path", "file"]
      .map((k) => args[k])
      .find((v): v is string => typeof v === "string")!;

    const searchText = extractToolCallText(args);
    if (!searchText) continue;

    const lines = searchText.split("\n");
    const matchingLines = lines.filter((line) => regex.test(line));
    if (matchingLines.length > 0) {
      fileMatches.push({
        toolName: part.name || "",
        path,
        lineCount: matchingLines.length,
        snippet: matchingLines[0],
      });
    }
  }

  return fileMatches;
}

/** Aggregate file operations across all entries for mode:touched. */
export function getTouchedFiles(messages: Message[], rendered: RenderedEntry[]): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      map.get(fm.path)!.entries.push({ index, toolName: fm.toolName });
    }
  }
  return Array.from(map.values());
}

export interface SearchResult {
  hits: SearchHit[];
  totalBeforeCap: number;
  truncated: boolean;
}

export interface SearchTuning {
  relativeFloor?: number;
  cap?: number;
}

const BM25_RELATIVE_FLOOR = 0.2;
const SEARCH_RESULT_CAP = 50;

const applyRelativeFloor = (
  scored: Array<{ hit: SearchHit; score: number }>,
  floor: number,
): Array<{ hit: SearchHit; score: number }> => {
  if (scored.length === 0 || scored[0].score <= 0) return scored;
  const topScore = scored[0].score;
  return scored.filter(({ score }) => score >= topScore * floor);
};

const capHits = (hits: SearchHit[], cap: number): SearchResult => {
  const totalBeforeCap = hits.length;
  const capped = hits.slice(0, cap);
  return {
    hits: capped,
    totalBeforeCap,
    truncated: capped.length < totalBeforeCap,
  };
};

export const searchEntriesDetailedWithPlan = (
  entries: RenderedEntry[],
  messages: Message[],
  plan: SearchQueryPlan | undefined,
  tuning?: SearchTuning,
  mode?: RecallMode,
): SearchResult => {
  if (!plan) return { hits: entries, totalBeforeCap: entries.length, truncated: false };

  const relativeFloor = tuning?.relativeFloor ?? BM25_RELATIVE_FLOOR;
  const cap = tuning?.cap ?? SEARCH_RESULT_CAP;
  const compiled = plan.terms;
  const snipRe = snippetRegex(compiled);

  // Build all docs for BM25 context (cache fullText to avoid recomputing)
  const docs: string[] = [];
  const fullTextCache: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg, mode) : e.summary;
    fullTextCache.push(text);
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const ctx = buildBM25Context(docs, compiled);

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, compiled);
    if (mc === 0) continue;
    const score = bm25Score(hay, compiled, ctx);
    const text = fullTextCache[i];
    const snip = lineSnippet(text, snipRe);
    const fileMatches = computeFileMatches(messages[i], plan);
    const extra = fileMatches.length > 0 ? { fileMatches } : {};
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc, ...extra },
      score,
    });
  }

  // Sort by BM25 score desc (term coverage flows through matchCount + score)
  scored.sort((a, b) => b.score - a.score);
  const effectiveTermCount = new Set(compiled.map((c) => c.term.toLowerCase())).size;
  const floored = effectiveTermCount >= 2 ? applyRelativeFloor(scored, relativeFloor) : scored;
  return capHits(
    floored.map((s) => s.hit),
    cap,
  );
};

/** Compatibility wrapper for existing callers that still supply query text. */
export const searchEntriesDetailed = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
  tuning?: SearchTuning,
  mode?: RecallMode,
): SearchResult =>
  searchEntriesDetailedWithPlan(entries, messages, planSearchQuery(query), tuning, mode);

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
  _page?: number,
  mode?: RecallMode,
): SearchHit[] => searchEntriesDetailed(entries, messages, query, undefined, mode).hits;

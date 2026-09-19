import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { loadAllMessages } from "../core/load-messages.js";
import type { RenderedEntry } from "../core/render-entries.js";

export type ReplayPartition = "tuning" | "held-out";

export interface ReplayInputPaths {
  readonly corpus: string;
  readonly queries: string;
  readonly truth: string;
}

export interface ReplayQuery {
  readonly id: string;
  readonly text: string;
  readonly category: string;
}

export interface AnswerableTruth {
  readonly classification: "answerable";
  readonly answerEntryIds: readonly string[];
}

export interface NoAnswerTruth {
  readonly classification: "no-answer";
}

export interface InvalidTruth {
  readonly classification: "invalid";
  readonly issues: readonly ReplayValidationIssue[];
}

export type ReplayTruth = AnswerableTruth | NoAnswerTruth | InvalidTruth;

export interface ReplayFixtureCase {
  readonly query: ReplayQuery;
  readonly truth: ReplayTruth;
}

export interface ReplayValidationIssue {
  readonly code:
    | "ambiguous-label"
    | "ambiguous-labels"
    | "contradictory-label"
    | "invalid-answer-evidence"
    | "invalid-label"
    | "ineligible-query"
    | "invalid-truth-record"
    | "missing-answer-entry"
    | "missing-label"
    | "orphan-label"
    | "unreviewed-label";
  readonly queryId: string | null;
  readonly detail: string;
}

export interface ReplayFixture {
  readonly revision: string;
  readonly partition: ReplayPartition;
  readonly paths: ReplayInputPaths;
  readonly digests: Readonly<Record<keyof ReplayInputPaths, string>>;
  readonly rendered: RenderedEntry[];
  readonly rawMessages: Message[];
  readonly cases: readonly ReplayFixtureCase[];
  readonly validationIssues: readonly ReplayValidationIssue[];
}

export class ReplayFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayFixtureError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonObject = (path: string, kind: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReplayFixtureError(`Cannot parse ${kind} file ${path}: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new ReplayFixtureError(`${kind} file ${path} must contain one JSON object`);
  }
  return parsed;
};

const requireString = (value: unknown, field: string, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReplayFixtureError(`${field} in ${path} must be a non-empty string`);
  }
  return value;
};

const readMetadata = (
  document: Record<string, unknown>,
  path: string,
  expectedPartition: ReplayPartition,
): { revision: string; partition: ReplayPartition } => {
  if (document.schemaVersion !== 1) {
    throw new ReplayFixtureError(`schemaVersion in ${path} must be 1`);
  }
  const revision = requireString(document.fixtureRevision, "fixtureRevision", path);
  const partition = document.partition;
  if (partition !== "tuning" && partition !== "held-out") {
    throw new ReplayFixtureError(`partition in ${path} must be tuning or held-out`);
  }
  if (partition !== expectedPartition) {
    throw new ReplayFixtureError(
      `Partition mismatch: ${path} is ${partition}, but --partition is ${expectedPartition}`,
    );
  }
  return { revision, partition };
};

const readCorpusMetadata = (
  path: string,
  expectedPartition: ReplayPartition,
): { revision: string; partition: ReplayPartition } => {
  const firstLine = readFileSync(path, "utf8")
    .split("\n")
    .find((line) => line.trim().length > 0);
  if (!firstLine) {
    throw new ReplayFixtureError(`Corpus ${path} is empty`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReplayFixtureError(`Cannot parse corpus metadata in ${path}: ${detail}`);
  }
  if (!isRecord(parsed) || parsed.type !== "session") {
    throw new ReplayFixtureError(`First record in ${path} must be fixture session metadata`);
  }
  return readMetadata(parsed, path, expectedPartition);
};

const readQueries = (document: Record<string, unknown>, path: string): readonly ReplayQuery[] => {
  if (!Array.isArray(document.queries)) {
    throw new ReplayFixtureError(`queries in ${path} must be an array`);
  }

  const seen = new Set<string>();
  return document.queries.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new ReplayFixtureError(`queries[${index}] in ${path} must be an object`);
    }
    const id = requireString(raw.id, `queries[${index}].id`, path);
    if (seen.has(id)) {
      throw new ReplayFixtureError(`Duplicate query id ${JSON.stringify(id)} in ${path}`);
    }
    seen.add(id);
    return {
      id,
      text: requireString(raw.text, `queries[${index}].text`, path),
      category: requireString(raw.category, `queries[${index}].category`, path),
    };
  });
};

const issue = (
  code: ReplayValidationIssue["code"],
  queryId: string | null,
  detail: string,
): ReplayValidationIssue => ({ code, queryId, detail });

const validateTruthRecord = (
  raw: Record<string, unknown>,
  queryId: string,
  corpusIds: ReadonlySet<string>,
): ReplayTruth => {
  const issues: ReplayValidationIssue[] = [];
  if (raw.reviewed !== true) {
    issues.push(issue("unreviewed-label", queryId, "Truth label must set reviewed to true"));
  }

  if (raw.classification === "ambiguous") {
    issues.push(
      issue("ambiguous-label", queryId, "Truth label is ambiguous and requires human review"),
    );
  } else if (raw.classification === "answerable") {
    if (
      !Array.isArray(raw.answerEntryIds) ||
      raw.answerEntryIds.length === 0 ||
      raw.answerEntryIds.some((entryId) => typeof entryId !== "string" || entryId.length === 0)
    ) {
      issues.push(
        issue(
          "invalid-answer-evidence",
          queryId,
          "Answerable label requires one or more non-empty answerEntryIds",
        ),
      );
    } else {
      const answerEntryIds = raw.answerEntryIds.filter(
        (entryId): entryId is string => typeof entryId === "string",
      );
      if (new Set(answerEntryIds).size !== answerEntryIds.length) {
        issues.push(
          issue(
            "invalid-answer-evidence",
            queryId,
            "Answerable label contains duplicate answerEntryIds",
          ),
        );
      }
      const missing = answerEntryIds.filter((entryId) => !corpusIds.has(entryId));
      if (missing.length > 0) {
        issues.push(
          issue(
            "missing-answer-entry",
            queryId,
            `Answer evidence is absent from the corpus: ${missing.join(", ")}`,
          ),
        );
      }
      if (issues.length === 0) {
        return { classification: "answerable", answerEntryIds };
      }
    }
  } else if (raw.classification === "no-answer") {
    if (Array.isArray(raw.answerEntryIds) && raw.answerEntryIds.length > 0) {
      issues.push(
        issue("contradictory-label", queryId, "No-answer label also supplies answerEntryIds"),
      );
    } else if (issues.length === 0) {
      return { classification: "no-answer" };
    }
  } else {
    issues.push(
      issue("invalid-label", queryId, "classification must be answerable, no-answer, or ambiguous"),
    );
  }

  return { classification: "invalid", issues };
};

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export const readReplayFixture = (
  paths: ReplayInputPaths,
  expectedPartition: ReplayPartition,
): ReplayFixture => {
  const queriesDocument = parseJsonObject(paths.queries, "queries");
  const truthDocument = parseJsonObject(paths.truth, "truth");
  const corpusMetadata = readCorpusMetadata(paths.corpus, expectedPartition);
  const queriesMetadata = readMetadata(queriesDocument, paths.queries, expectedPartition);
  const truthMetadata = readMetadata(truthDocument, paths.truth, expectedPartition);
  if (
    corpusMetadata.revision !== queriesMetadata.revision ||
    corpusMetadata.revision !== truthMetadata.revision
  ) {
    throw new ReplayFixtureError(
      `Fixture revision mismatch: corpus is ${corpusMetadata.revision}, queries are ${queriesMetadata.revision}, truth is ${truthMetadata.revision}`,
    );
  }

  const queries = readQueries(queriesDocument, paths.queries);
  const loaded = loadAllMessages(paths.corpus, false);
  const corpusIds = new Set<string>();
  for (const entryId of loaded.entryIds) {
    if (entryId.length === 0) {
      throw new ReplayFixtureError(`Every message in ${paths.corpus} must have an entry id`);
    }
    if (corpusIds.has(entryId)) {
      throw new ReplayFixtureError(`Duplicate corpus entry id ${JSON.stringify(entryId)}`);
    }
    corpusIds.add(entryId);
  }

  if (!Array.isArray(truthDocument.labels)) {
    throw new ReplayFixtureError(`labels in ${paths.truth} must be an array`);
  }

  const queryIds = new Set(queries.map((query) => query.id));
  const recordsByQuery = new Map<string, Record<string, unknown>[]>();
  const validationIssues: ReplayValidationIssue[] = [];
  for (const [index, raw] of truthDocument.labels.entries()) {
    if (!isRecord(raw) || typeof raw.queryId !== "string" || raw.queryId.length === 0) {
      validationIssues.push(
        issue(
          "invalid-truth-record",
          null,
          `labels[${index}] must be an object with a non-empty queryId`,
        ),
      );
      continue;
    }
    if (!queryIds.has(raw.queryId)) {
      validationIssues.push(
        issue("orphan-label", raw.queryId, "Truth label has no matching fixture query"),
      );
      continue;
    }
    const records = recordsByQuery.get(raw.queryId) ?? [];
    records.push(raw);
    recordsByQuery.set(raw.queryId, records);
  }

  const cases = queries.map((query): ReplayFixtureCase => {
    const records = recordsByQuery.get(query.id) ?? [];
    if (records.length === 0) {
      return {
        query,
        truth: {
          classification: "invalid",
          issues: [issue("missing-label", query.id, "Query has no reviewed truth label")],
        },
      };
    }
    if (records.length > 1) {
      return {
        query,
        truth: {
          classification: "invalid",
          issues: [
            issue(
              "ambiguous-labels",
              query.id,
              `Query has ${records.length} truth labels; exactly one is required`,
            ),
          ],
        },
      };
    }
    return { query, truth: validateTruthRecord(records[0], query.id, corpusIds) };
  });

  return {
    revision: queriesMetadata.revision,
    partition: queriesMetadata.partition,
    paths,
    digests: {
      corpus: sha256(paths.corpus),
      queries: sha256(paths.queries),
      truth: sha256(paths.truth),
    },
    rendered: loaded.rendered,
    rawMessages: loaded.rawMessages,
    cases,
    validationIssues,
  };
};

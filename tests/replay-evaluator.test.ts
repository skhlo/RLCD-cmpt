import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateLexicalReplay } from "../src/evaluation/lexical-replay.js";
import {
  readReplayFixture,
  ReplayFixtureError,
  type ReplayInputPaths,
  type ReplayPartition,
} from "../src/evaluation/replay-fixture.js";

interface QueryInput {
  readonly id: string;
  readonly text: string;
  readonly category?: string;
}

interface FixtureOptions {
  readonly messages: readonly Record<string, unknown>[];
  readonly queries: readonly QueryInput[];
  readonly labels: readonly unknown[];
  readonly partition?: ReplayPartition;
  readonly corpusPartition?: ReplayPartition;
  readonly truthPartition?: ReplayPartition;
  readonly revision?: string;
}

interface FixtureFiles {
  readonly dir: string;
  readonly paths: ReplayInputPaths;
  readonly partition: ReplayPartition;
}

const messageEntry = (id: string, text: string): Record<string, unknown> => ({
  type: "message",
  id,
  message: { role: "user", content: text },
});

const answerable = (
  queryId: string,
  answerEntryIds: readonly string[],
): Record<string, unknown> => ({
  queryId,
  classification: "answerable",
  answerEntryIds,
  reviewed: true,
});

const noAnswer = (queryId: string): Record<string, unknown> => ({
  queryId,
  classification: "no-answer",
  reviewed: true,
});

const rankMissMessages = (prefix: string): readonly Record<string, unknown>[] => [
  ...Array.from({ length: 5 }, (_, index) =>
    messageEntry(
      `${prefix}-distractor-${index + 1}`,
      "The amber release marker owner review asks which team owns the amber release marker, but records no owning team.",
    ),
  ),
  messageEntry(
    `${prefix}-answer`,
    "The completed ownership record says Team Sable owns the amber release marker for production releases.",
  ),
];

const writeFixture = (options: FixtureOptions): FixtureFiles => {
  const dir = mkdtempSync(join(tmpdir(), "blackhole-replay-"));
  const paths = {
    corpus: join(dir, "corpus.jsonl"),
    queries: join(dir, "queries.json"),
    truth: join(dir, "truth.json"),
  };
  const partition = options.partition ?? "tuning";
  const revision = options.revision ?? "test-v1";
  const corpusPartition = options.corpusPartition ?? partition;
  const corpusRecords = [
    {
      type: "session",
      id: `fixture-${corpusPartition}`,
      schemaVersion: 1,
      fixtureRevision: revision,
      partition: corpusPartition,
    },
    ...options.messages,
  ];
  writeFileSync(
    paths.corpus,
    `${corpusRecords.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  writeFileSync(
    paths.queries,
    `${JSON.stringify({
      schemaVersion: 1,
      fixtureRevision: revision,
      partition,
      queries: options.queries.map((query) => ({
        id: query.id,
        text: query.text,
        category: query.category ?? "test",
      })),
    })}\n`,
  );
  writeFileSync(
    paths.truth,
    `${JSON.stringify({
      schemaVersion: 1,
      fixtureRevision: revision,
      partition: options.truthPartition ?? partition,
      labels: options.labels,
    })}\n`,
  );
  return { dir, paths, partition };
};

const TEST_IMPLEMENTATION = {
  provenance: "executable-sha256",
  executableSha256: "0".repeat(64),
} as const;

const reportFixture = (files: FixtureFiles) =>
  evaluateLexicalReplay(readReplayFixture(files.paths, files.partition), TEST_IMPLEMENTATION);

const cleanup = (files: FixtureFiles): void => {
  rmSync(files.dir, { recursive: true });
};

const writeMinimalFixture = (): FixtureFiles =>
  writeFixture({
    messages: [messageEntry("m1", "known answer")],
    queries: [{ id: "q1", text: "known answer" }],
    labels: [answerable("q1", ["m1"])],
  });

const writeJson = (path: string, document: unknown): void => {
  writeFileSync(path, `${JSON.stringify(document)}\n`);
};

const validQueriesDocument = (queries: unknown): Record<string, unknown> => ({
  schemaVersion: 1,
  fixtureRevision: "test-v1",
  partition: "tuning",
  queries,
});

const validTruthDocument = (labels: unknown): Record<string, unknown> => ({
  schemaVersion: 1,
  fixtureRevision: "test-v1",
  partition: "tuning",
  labels,
});

describe("replay fixture structure validation", () => {
  it.each([
    ["malformed JSON", "{", /Cannot parse queries file/],
    ["a non-object JSON value", "[]", /queries file .* must contain one JSON object/],
  ])("rejects a queries file containing %s", (_caseName, contents, expected) => {
    const files = writeMinimalFixture();
    try {
      writeFileSync(files.paths.queries, contents);
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(expected);
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["an unsupported schema", { schemaVersion: 2 }, /schemaVersion .* must be 1/],
    ["an empty fixture revision", { fixtureRevision: "" }, /fixtureRevision .* non-empty/],
    ["an invalid partition", { partition: "private" }, /partition .* must be tuning or held-out/],
    ["a mismatched partition", { partition: "held-out" }, /Partition mismatch/],
  ])("rejects query metadata with %s", (_caseName, override, expected) => {
    const files = writeMinimalFixture();
    try {
      writeJson(files.paths.queries, {
        ...validQueriesDocument([{ id: "q1", text: "known answer", category: "test" }]),
        ...override,
      });
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(expected);
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["an empty corpus", "\n", /Corpus .* is empty/],
    ["malformed JSON metadata", "{\n", /Cannot parse corpus metadata/],
    ["non-object metadata", "[]\n", /must be fixture session metadata/],
    [
      "a non-session first record",
      `${JSON.stringify({ type: "message", id: "m0", message: { role: "user", content: "x" } })}\n`,
      /must be fixture session metadata/,
    ],
  ])("rejects %s", (_caseName, contents, expected) => {
    const files = writeMinimalFixture();
    try {
      writeFileSync(files.paths.corpus, contents);
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(expected);
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["malformed JSON", "{malformed-json", /Cannot parse corpus record 2/],
    ["a non-object value", "[]", /Corpus record 2 .* must be a message object/],
    [
      "a non-message object",
      JSON.stringify({ type: "branch", id: "branch-entry" }),
      /Corpus record 2 .* must be a message object/,
    ],
    [
      "a non-string message id",
      JSON.stringify({ type: "message", id: 2, message: { role: "user", content: "x" } }),
      /id in corpus record 2 .* must be a non-empty string/,
    ],
    [
      "a non-object message",
      JSON.stringify({ type: "message", id: "m2", message: null }),
      /message in corpus record 2 .* must be an object/,
    ],
  ])("rejects a corpus record containing %s", (_caseName, record, expected) => {
    const files = writeMinimalFixture();
    try {
      writeFileSync(
        files.paths.corpus,
        `${JSON.stringify({
          type: "session",
          id: "fixture-tuning",
          schemaVersion: 1,
          fixtureRevision: "test-v1",
          partition: "tuning",
        })}\n${record}\n`,
      );
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(expected);
    } finally {
      cleanup(files);
    }
  });

  it("rejects a non-array query collection", () => {
    const files = writeMinimalFixture();
    try {
      writeJson(files.paths.queries, validQueriesDocument({}));
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(
        /queries .* must be an array/,
      );
    } finally {
      cleanup(files);
    }
  });

  it("rejects a malformed query record", () => {
    const files = writeMinimalFixture();
    try {
      writeJson(files.paths.queries, validQueriesDocument([null]));
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(
        /queries\[0\].* must be an object/,
      );
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["id", { id: "", text: "known answer", category: "test" }, /queries\[0\].id .* non-empty/],
    ["text", { id: "q1", text: "", category: "test" }, /queries\[0\].text .* non-empty/],
    [
      "category",
      { id: "q1", text: "known answer", category: "" },
      /queries\[0\].category .* non-empty/,
    ],
  ])("rejects an invalid query %s", (_field, query, expected) => {
    const files = writeMinimalFixture();
    try {
      writeJson(files.paths.queries, validQueriesDocument([query]));
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(expected);
    } finally {
      cleanup(files);
    }
  });

  it("rejects duplicate query ids", () => {
    const files = writeMinimalFixture();
    try {
      writeJson(
        files.paths.queries,
        validQueriesDocument([
          { id: "q1", text: "first query", category: "test" },
          { id: "q1", text: "second query", category: "test" },
        ]),
      );
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(
        /Duplicate query id "q1"/,
      );
    } finally {
      cleanup(files);
    }
  });

  it("rejects fixture revision mismatches", () => {
    const files = writeMinimalFixture();
    try {
      writeJson(files.paths.truth, {
        ...validTruthDocument([answerable("q1", ["m1"])]),
        fixtureRevision: "other-v1",
      });
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(
        /Fixture revision mismatch:.*truth is other-v1/,
      );
    } finally {
      cleanup(files);
    }
  });

  it.each([
    [
      "a missing corpus entry id",
      [{ type: "message", message: { role: "user", content: "x" } }],
      /id in corpus record 2 .* must be a non-empty string/,
    ],
    [
      "a duplicate corpus entry id",
      [messageEntry("m1", "first"), messageEntry("m1", "second")],
      /Duplicate corpus entry id "m1"/,
    ],
  ])("rejects %s", (_caseName, messages, expected) => {
    const files = writeFixture({
      messages,
      queries: [{ id: "q1", text: "known answer" }],
      labels: [answerable("q1", ["m1"])],
    });
    try {
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(expected);
    } finally {
      cleanup(files);
    }
  });

  it("rejects a non-array truth-label collection", () => {
    const files = writeMinimalFixture();
    try {
      writeJson(files.paths.truth, validTruthDocument({}));
      expect(() => readReplayFixture(files.paths, files.partition)).toThrowError(
        /labels .* must be an array/,
      );
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["a non-object", null],
    ["a missing query id", {}],
    ["an empty query id", { queryId: "" }],
  ])("keeps %s truth record visible as invalid", (_caseName, label) => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [label],
    });
    try {
      const report = reportFixture(files);
      expect(report.validation).toMatchObject({
        valid: false,
        reviewRequired: true,
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-truth-record", queryId: null }),
        ]),
      });
    } finally {
      cleanup(files);
    }
  });

  it("keeps an orphan truth record visible as invalid", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [answerable("orphan", ["m1"])],
    });
    try {
      expect(reportFixture(files).validation.issues).toEqual(
        expect.arrayContaining([
          { code: "orphan-label", queryId: "orphan", detail: expect.any(String) },
        ]),
      );
    } finally {
      cleanup(files);
    }
  });
});

describe("replay truth validation", () => {
  it("marks a missing truth label invalid instead of inferring one", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        queryId: "q1",
        outcome: "invalid",
        issues: [{ code: "missing-label", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["a populated array", ["m1"]],
    ["an empty array", []],
    ["a string", "m1"],
    ["null", null],
  ])("marks a no-answer label with %s answerEntryIds as contradictory", (_caseName, value) => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [
        {
          queryId: "q1",
          classification: "no-answer",
          answerEntryIds: value,
          reviewed: true,
        },
      ],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "contradictory-label", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it("keeps an explicitly ambiguous label visible for review", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "possible answer")],
      queries: [{ id: "q1", text: "possible answer" }],
      labels: [{ queryId: "q1", classification: "ambiguous", reviewed: true }],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "ambiguous-label", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it("marks duplicate labels ambiguous rather than choosing one", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [answerable("q1", ["m1"]), noAnswer("q1")],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "ambiguous-labels", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it.each([
    ["a non-array value", "m1"],
    ["an empty array", []],
    ["a non-string id", [123]],
    ["an empty id", [""]],
    ["duplicate ids", ["m1", "m1"]],
  ])("marks answerable evidence with %s invalid", (_caseName, answerEntryIds) => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [
        {
          queryId: "q1",
          classification: "answerable",
          answerEntryIds,
          reviewed: true,
        },
      ],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "invalid-answer-evidence", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it("marks an unreviewed label invalid", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [{ queryId: "q1", classification: "no-answer", reviewed: false }],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "unreviewed-label", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it("marks an unknown truth classification invalid", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [{ queryId: "q1", classification: "probably", reviewed: true }],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "invalid-label", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it("requires answer evidence to exist in the loaded corpus", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "other evidence")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [answerable("q1", ["missing-entry"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "missing-answer-entry", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });
});

describe("lexical baseline outcomes", () => {
  it("reports a uniquely evidenced answer below the first page as a rank miss", () => {
    const files = writeFixture({
      messages: rankMissMessages("q1"),
      queries: [{ id: "q1", text: "which team owns amber release marker" }],
      labels: [answerable("q1", ["q1-answer"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "rank-miss",
        knownAnswerEntryIds: ["q1-answer"],
        bestKnownAnswerRank: 6,
        candidateMissReason: null,
      });
    } finally {
      cleanup(files);
    }
  });

  it("attributes a candidate excluded by term matching to lexical matching", () => {
    const files = writeFixture({
      messages: [
        messageEntry("distractor", "needle appears without the answer"),
        messageEntry("answer", "the verified solution uses a compass"),
      ],
      queries: [{ id: "q1", text: "needle" }],
      labels: [answerable("q1", ["answer"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "candidate-miss",
        bestKnownAnswerRank: null,
        reciprocalRank: 0,
        candidateMissReason: "lexical-match",
      });
    } finally {
      cleanup(files);
    }
  });

  it("attributes a candidate excluded by the relative floor to the floor", () => {
    const commonOnly = Array.from({ length: 99 }, (_, index) =>
      messageEntry(`common-${index}`, "common"),
    );
    const files = writeFixture({
      messages: [
        messageEntry("top", "common raretarget raretarget raretarget raretarget"),
        ...commonOnly,
        messageEntry("answer", "common"),
      ],
      queries: [{ id: "q1", text: "common raretarget" }],
      labels: [answerable("q1", ["answer"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "candidate-miss",
        candidateMissReason: "relative-floor",
      });
    } finally {
      cleanup(files);
    }
  });

  it("attributes a candidate beyond the shortlist cap to the cap", () => {
    const files = writeFixture({
      messages: Array.from({ length: 51 }, (_, index) => messageEntry(`m${index + 1}`, "needle")),
      queries: [{ id: "q1", text: "needle" }],
      labels: [answerable("q1", ["m51"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "candidate-miss",
        candidateMissReason: "candidate-cap",
      });
    } finally {
      cleanup(files);
    }
  });

  it("marks pattern queries outside the ordinary replay scope invalid", () => {
    const files = writeFixture({
      messages: [messageEntry("answer", "needle answer")],
      queries: [{ id: "q1", text: "needle|answer" }],
      labels: [answerable("q1", ["answer"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "invalid",
        issues: [{ code: "ineligible-query", queryId: "q1" }],
      });
    } finally {
      cleanup(files);
    }
  });

  it("reports no-answer queries that still retrieve overlap candidates", () => {
    const files = writeFixture({
      messages: [messageEntry("mention", "quartz token appears but supplies no deployment owner")],
      queries: [{ id: "q1", text: "quartz deployment owner" }],
      labels: [noAnswer("q1")],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "no-answer-candidates",
        candidateEntryIds: ["mention"],
      });
    } finally {
      cleanup(files);
    }
  });

  it("reports no-answer queries with an empty lexical shortlist", () => {
    const files = writeFixture({
      messages: [messageEntry("other", "unrelated deployment note")],
      queries: [{ id: "q1", text: "quartz owner" }],
      labels: [noAnswer("q1")],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "no-answer-empty",
        candidateEntryIds: [],
      });
    } finally {
      cleanup(files);
    }
  });
});

describe("replay metrics and manifest", () => {
  it("uses only valid answerable queries as known-answer denominators", () => {
    const files = writeFixture({
      messages: [messageEntry("answer", "offline sqlite reason")],
      queries: [
        { id: "answerable", text: "offline sqlite reason" },
        { id: "no-answer", text: "quartz owner" },
        { id: "invalid", text: "missing truth" },
      ],
      labels: [answerable("answerable", ["answer"]), noAnswer("no-answer")],
    });
    try {
      const report = reportFixture(files);
      expect(report.aggregate).toMatchObject({
        totalQueries: 3,
        validQueries: 2,
        invalidQueries: 1,
        answerableQueries: 1,
        noAnswerQueries: 1,
        candidateCoverage: { hits: 1, denominator: 1, rate: 1 },
        answerAt5: { hits: 1, denominator: 1, rate: 1 },
        meanReciprocalRank: { sum: 1, denominator: 1, value: 1 },
      });
    } finally {
      cleanup(files);
    }
  });

  it("calculates aggregate MRR from unrounded reciprocal ranks", () => {
    const files = writeFixture({
      messages: [
        messageEntry("rank-1-answer", "cobalt owner Team Azure"),
        ...rankMissMessages("rank-6"),
      ],
      queries: [
        { id: "rank-1", text: "cobalt owner Team Azure" },
        { id: "rank-6", text: "which team owns amber release marker" },
      ],
      labels: [answerable("rank-1", ["rank-1-answer"]), answerable("rank-6", ["rank-6-answer"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.aggregate.meanReciprocalRank).toEqual({
        sum: 1.166667,
        denominator: 2,
        value: 0.583333,
      });
    } finally {
      cleanup(files);
    }
  });

  it("reports null quality rates when there are no known-answer cases", () => {
    const files = writeFixture({
      messages: [messageEntry("mention", "quartz mention")],
      queries: [{ id: "q1", text: "quartz owner" }],
      labels: [noAnswer("q1")],
    });
    try {
      const report = reportFixture(files);
      expect(report.aggregate).toMatchObject({
        answerableQueries: 0,
        candidateCoverage: { hits: 0, denominator: 0, rate: null },
        answerAt5: { hits: 0, denominator: 0, rate: null },
        meanReciprocalRank: { sum: 0, denominator: 0, value: null },
      });
    } finally {
      cleanup(files);
    }
  });

  it("produces the same report for the same manifest inputs", () => {
    const files = writeFixture({
      messages: [messageEntry("answer", "offline sqlite reason")],
      queries: [{ id: "q1", text: "offline sqlite reason" }],
      labels: [answerable("q1", ["answer"])],
      revision: "reproducible-v1",
    });
    try {
      const first = reportFixture(files);
      const second = reportFixture(files);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    } finally {
      cleanup(files);
    }
  });

  it("records frozen lexical parameters and content digests", () => {
    const files = writeFixture({
      messages: [messageEntry("answer", "offline sqlite reason")],
      queries: [{ id: "q1", text: "offline sqlite reason" }],
      labels: [answerable("q1", ["answer"])],
    });
    try {
      const report = reportFixture(files);
      expect(report).toMatchObject({
        parameters: {
          mode: "hybrid",
          answerAtK: 5,
          ranking: {
            algorithm: "bm25-plus",
            bm25K1: 1.2,
            bm25B: 0.75,
            bm25Delta: 0.5,
            relativeFloor: 0.2,
            relativeFloorMinimumTermCount: 2,
            candidateCap: 50,
          },
        },
        fixture: {
          inputSha256: {
            corpus: expect.stringMatching(/^[a-f0-9]{64}$/),
            queries: expect.stringMatching(/^[a-f0-9]{64}$/),
            truth: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
    } finally {
      cleanup(files);
    }
  });

  it("rejects a held-out corpus presented as tuning input", () => {
    const files = writeFixture({
      messages: [messageEntry("answer", "offline sqlite reason")],
      queries: [{ id: "q1", text: "offline sqlite reason" }],
      labels: [answerable("q1", ["answer"])],
      partition: "tuning",
      corpusPartition: "held-out",
    });
    try {
      expect(() => readReplayFixture(files.paths, "tuning")).toThrowError(
        new ReplayFixtureError(
          `Partition mismatch: ${files.paths.corpus} is held-out, but --partition is tuning`,
        ),
      );
    } finally {
      cleanup(files);
    }
  });

  it("rejects a held-out truth file presented as tuning input", () => {
    const files = writeFixture({
      messages: [messageEntry("answer", "offline sqlite reason")],
      queries: [{ id: "q1", text: "offline sqlite reason" }],
      labels: [answerable("q1", ["answer"])],
      partition: "tuning",
      truthPartition: "held-out",
    });
    try {
      expect(() => readReplayFixture(files.paths, "tuning")).toThrowError(
        new ReplayFixtureError(
          `Partition mismatch: ${files.paths.truth} is held-out, but --partition is tuning`,
        ),
      );
    } finally {
      cleanup(files);
    }
  });
});

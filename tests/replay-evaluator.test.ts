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

const reportFixture = (files: FixtureFiles) =>
  evaluateLexicalReplay(readReplayFixture(files.paths, files.partition));

const cleanup = (files: FixtureFiles): void => {
  rmSync(files.dir, { recursive: true, force: true });
};

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

  it("marks a no-answer label with answer evidence as contradictory", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [
        {
          queryId: "q1",
          classification: "no-answer",
          answerEntryIds: ["m1"],
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

  it("marks an answerable label without evidence invalid", () => {
    const files = writeFixture({
      messages: [messageEntry("m1", "known answer")],
      queries: [{ id: "q1", text: "known answer" }],
      labels: [answerable("q1", [])],
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
  it("reports a known answer below the first page as a rank miss", () => {
    const files = writeFixture({
      messages: Array.from({ length: 6 }, (_, index) =>
        messageEntry(`m${index + 1}`, "shared needle evidence"),
      ),
      queries: [{ id: "q1", text: "shared needle evidence" }],
      labels: [answerable("q1", ["m6"])],
    });
    try {
      const report = reportFixture(files);
      expect(report.cases[0]).toMatchObject({
        outcome: "rank-miss",
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
            algorithm: "existing-bm25-plus",
            relativeFloor: 0.2,
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

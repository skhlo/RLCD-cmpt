import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateLexicalReplay } from "../src/evaluation/lexical-replay.js";
import {
  readReplayFixture,
  type ReplayInputPaths,
  type ReplayPartition,
} from "../src/evaluation/replay-fixture.js";

const publicPaths = (partition: ReplayPartition): ReplayInputPaths => {
  const root = join(process.cwd(), "fixtures", "replay", "public-v1", partition);
  return {
    corpus: join(root, "corpus.jsonl"),
    queries: join(root, "queries.json"),
    truth: join(root, "truth.json"),
  };
};

const TEST_IMPLEMENTATION = {
  provenance: "executable-sha256",
  executableSha256: "0".repeat(64),
} as const;

const publicReport = (partition: ReplayPartition) =>
  evaluateLexicalReplay(readReplayFixture(publicPaths(partition), partition), TEST_IMPLEMENTATION);

describe("public lexical replay fixtures", () => {
  it("keeps the tuning partition valid with frozen baseline counts", () => {
    expect(publicReport("tuning")).toMatchObject({
      validation: { valid: true, reviewRequired: false, issues: [] },
      aggregate: {
        totalQueries: 16,
        answerableQueries: 12,
        noAnswerQueries: 4,
        candidateMisses: 1,
        rankMisses: 1,
        candidateCoverage: { hits: 11, denominator: 12, rate: 0.916667 },
        answerAt5: { hits: 10, denominator: 12, rate: 0.833333 },
        meanReciprocalRank: { sum: 9.666667, denominator: 12, value: 0.805556 },
      },
    });
  });

  it("uses uniquely evidenced rank-miss labels in the tuning partition", () => {
    const report = publicReport("tuning");
    expect(report.cases.find((caseReport) => caseReport.queryId === "tq11")).toMatchObject({
      query: "which keychain owns the shared deploy token marker",
      outcome: "rank-miss",
      knownAnswerEntryIds: ["t26"],
      bestKnownAnswerRank: 6,
    });
  });

  it("keeps the held-out partition valid with frozen baseline counts", () => {
    expect(publicReport("held-out")).toMatchObject({
      validation: { valid: true, reviewRequired: false, issues: [] },
      aggregate: {
        totalQueries: 16,
        answerableQueries: 12,
        noAnswerQueries: 4,
        candidateMisses: 1,
        rankMisses: 1,
        candidateCoverage: { hits: 11, denominator: 12, rate: 0.916667 },
        answerAt5: { hits: 10, denominator: 12, rate: 0.833333 },
        meanReciprocalRank: { sum: 9.666667, denominator: 12, value: 0.805556 },
      },
    });
  });

  it("uses uniquely evidenced rank-miss labels in the held-out partition", () => {
    const report = publicReport("held-out");
    expect(report.cases.find((caseReport) => caseReport.queryId === "hq11")).toMatchObject({
      query: "which environment owns the shared feature omega marker",
      outcome: "rank-miss",
      knownAnswerEntryIds: ["h26"],
      bestKnownAnswerRank: 6,
    });
  });

  it("covers every required synthetic-query category in both partitions", () => {
    for (const partition of ["tuning", "held-out"] as const) {
      const categories = new Set(
        publicReport(partition).cases.map((caseReport) => caseReport.category),
      );
      expect({ partition, categories: [...categories].sort() }).toMatchObject({
        partition,
        categories: expect.arrayContaining([
          "command",
          "correction",
          "decision-reason",
          "error",
          "no-answer",
          "supersession",
          "term-overlap-distractor",
        ]),
      });
    }
  });
});

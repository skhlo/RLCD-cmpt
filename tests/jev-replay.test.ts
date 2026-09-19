import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  JEV_EVALUATION_THRESHOLDS,
  createJevEvaluationPlan,
  evaluateJevReplay,
  type JevEvaluationApproval,
} from "../src/evaluation/jev-replay.js";
import {
  readReplayFixture,
  type ReplayFixture,
  type ReplayInputPaths,
  type ReplayPartition,
} from "../src/evaluation/replay-fixture.js";
import type {
  JevTransport,
  JevTransportRequest,
  JevTransportResponse,
} from "../src/evaluation/typesafe-http.js";

interface FixtureFiles {
  readonly dir: string;
  readonly paths: ReplayInputPaths;
  readonly fixture: ReplayFixture;
}

const message = (id: string, text: string): Record<string, unknown> => ({
  type: "message",
  id,
  message: { role: "user", content: text },
});

const writeFixture = (partition: ReplayPartition, suffix: string): FixtureFiles => {
  const dir = mkdtempSync(join(tmpdir(), `blackhole-jev-${suffix}-`));
  const paths = {
    corpus: join(dir, "corpus.jsonl"),
    queries: join(dir, "queries.json"),
    truth: join(dir, "truth.json"),
  };
  const messages = [
    ...Array.from({ length: 5 }, (_, index) =>
      message(
        `d${index + 1}`,
        "The amber release marker owner review repeats which team owns the marker but records no team.",
      ),
    ),
    message("z-answer", "The completed record says Team Sable owns the amber release marker."),
    message("no-answer-mention", "Quartz rotation owner is requested, but no owner is recorded."),
  ];
  const revision = `jev-${suffix}-v1`;
  writeFileSync(
    paths.corpus,
    `${[
      {
        type: "session",
        id: `fixture-${suffix}`,
        schemaVersion: 1,
        fixtureRevision: revision,
        partition,
      },
      ...messages,
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  writeFileSync(
    paths.queries,
    `${JSON.stringify({
      schemaVersion: 1,
      fixtureRevision: revision,
      partition,
      queries: [
        {
          id: "owner",
          text: "which team owns amber release marker",
          category: "term-overlap-distractor",
        },
        { id: "no-answer", text: "quartz rotation owner", category: "no-answer" },
      ],
    })}\n`,
  );
  writeFileSync(
    paths.truth,
    `${JSON.stringify({
      schemaVersion: 1,
      fixtureRevision: revision,
      partition,
      labels: [
        {
          queryId: "owner",
          classification: "answerable",
          answerEntryIds: ["z-answer"],
          reviewed: true,
        },
        { queryId: "no-answer", classification: "no-answer", reviewed: true },
      ],
    })}\n`,
  );
  return { dir, paths, fixture: readReplayFixture(paths, partition) };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scriptedResponse = (
  request: JevTransportRequest,
  invalidUsage = false,
): JevTransportResponse => {
  const parsed: unknown = JSON.parse(request.body);
  if (!isRecord(parsed) || !isRecord(parsed.state) || !Array.isArray(parsed.state.candidates)) {
    throw new Error("script received an invalid request");
  }
  const answers: Record<string, { type: "noul"; noul: number }> = {};
  parsed.state.candidates.forEach((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.passage !== "string") {
      throw new Error("script received an invalid candidate");
    }
    answers[`c${index}`] = {
      type: "noul",
      noul: candidate.passage.includes("Team Sable") ? 0.99 : 0.1,
    };
  });
  return {
    status: 200,
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers,
      usage: invalidUsage
        ? { input_tokens: "unknown", output_tokens: 2 }
        : { input_tokens: 320, output_tokens: 20 },
    }),
  };
};

const scriptedTransport = (
  run: (request: JevTransportRequest) => JevTransportResponse | Promise<JevTransportResponse>,
  evidenceSource: JevTransport["evidenceSource"] = "scripted",
): JevTransport => ({ evidenceSource, send: run });

const implementation = {
  provenance: "executable-sha256",
  executableSha256: "0".repeat(64),
} as const;

const approval: JevEvaluationApproval = {
  evidenceSha256: "a".repeat(64),
  transmissionApproved: true,
  privateAccountTermsAccepted: true,
  localRawEvidenceRetentionDays: 7,
  localRetentionExtensionReference: null,
};

const withFixtures = async <T>(
  run: (tuning: FixtureFiles, heldOut: FixtureFiles) => Promise<T> | T,
): Promise<T> => {
  const tuning = writeFixture("tuning", "tuning");
  const heldOut = writeFixture("held-out", "held-out");
  try {
    return await run(tuning, heldOut);
  } finally {
    rmSync(tuning.dir, { recursive: true });
    rmSync(heldOut.dir, { recursive: true });
  }
};

describe("Jev evaluation plan", () => {
  it("freezes contract, proposed bounds, thresholds, price, and both input provenances", async () => {
    await withFixtures((tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });

      expect(plan).toMatchObject({
        manifestVersion: 1,
        evaluator: "jev-evaluation-plan-v1",
        freezeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        input: {
          kind: "synthetic",
          tuning: { inputSha256: tuning.fixture.digests },
          heldOut: { inputSha256: heldOut.fixture.digests },
        },
        contract: {
          model: "jev-1.13.0",
          promptVersion: "recall-evidence-noul-v1",
          responseContractVersion: "complete-noul-vector-v1",
          tokenEstimateIsExact: false,
          liveShadowEvaluationsRequiredForOfflineEvaluator: false,
        },
        thresholds: JEV_EVALUATION_THRESHOLDS,
        pricing: {
          inputUsdPerMillionTokens: 0.042,
          outputTokensFree: true,
          provenance: expect.stringContaining("docs.typesafe.ai/models"),
          contractualQuote: false,
        },
        preparation: {
          status: "READY_FOR_CALIBRATION",
          preparedQueries: 2,
          failedQueries: 0,
        },
        gates: {
          status: "BLOCKED",
          reasons: expect.arrayContaining([
            "real-api-calibration-missing",
            "held-out-evaluation-missing",
            "synthetic-input-cannot-pass-empirical-gates",
          ]),
        },
      });
    });
  });
});

describe("bounded Jev replay", () => {
  it("reranks every candidate from a complete response and reports a pending real review", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      let calls = 0;
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport((request) => {
          calls++;
          return scriptedResponse(request);
        }),
        apiKey: "scripted-key",
        implementation,
      });
      const owner = report.cases.find((caseReport) => caseReport.queryId === "owner");

      expect(calls).toBe(2);
      expect(owner).toMatchObject({
        lexical: { outcome: "rank-miss", bestKnownAnswerRank: 6 },
        semantic: {
          result: "reranked",
          candidateEntryIds: ["z-answer", "d1", "d2", "d3", "d4", "d5"],
          bestKnownAnswerRank: 1,
          usage: { inputTokens: 320, outputTokens: 20 },
        },
      });
      expect(report.comparison).toMatchObject({
        candidateMisses: 0,
        lexicalRankMisses: 1,
        semanticRankMisses: 0,
        promotionsIntoTop5: 1,
        firstPageRegressions: [],
        disagreements: [expect.objectContaining({ queryId: "owner", reviewStatus: "pending" })],
      });
      expect(report.evidence).toMatchObject({
        source: "scripted",
        actualApiUsage: false,
        estimatorCalibrationAccepted: false,
      });
      expect(report.gates).toMatchObject({
        status: "BLOCKED",
        reasons: expect.arrayContaining([
          "scripted-transport-is-not-empirical-evidence",
          "synthetic-input-cannot-pass-empirical-gates",
          "review-evidence-missing",
        ]),
      });
    });
  });

  it("preserves the complete lexical order on a transport failure", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport(() => {
          throw new Error("offline scripted failure");
        }),
        apiKey: "scripted-key",
        implementation,
      });
      const owner = report.cases.find((caseReport) => caseReport.queryId === "owner");

      expect(owner).toMatchObject({
        lexical: { candidateEntryIds: ["d1", "d2", "d3", "d4", "d5", "z-answer"] },
        semantic: {
          result: "lexical-fallback",
          fallbackReason: "transport-failure",
          candidateEntryIds: ["d1", "d2", "d3", "d4", "d5", "z-answer"],
        },
      });
      expect(report.operations).toMatchObject({
        attemptedRequests: 2,
        validJudgments: 0,
        failures: [
          { queryId: "owner", reason: "transport-failure" },
          { queryId: "no-answer", reason: "transport-failure" },
        ],
      });
    });
  });

  it.each([
    ["malformed JSON", () => "{", "response-json"],
    [
      "the wrong model",
      (request: JevTransportRequest) =>
        scriptedResponse(request).body.replace("jev-1.13.0", "jev-latest"),
      "response-model",
    ],
    [
      "an incomplete answer set",
      () =>
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      "response-answer-keys",
    ],
  ])("preserves complete lexical order for %s", async (_name, responseBody, reason) => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport((request) => ({ status: 200, body: responseBody(request) })),
        apiKey: "scripted-key",
        implementation,
      });
      const owner = report.cases.find((caseReport) => caseReport.queryId === "owner");

      expect(owner).toMatchObject({
        lexical: { candidateEntryIds: ["d1", "d2", "d3", "d4", "d5", "z-answer"] },
        semantic: {
          result: "lexical-fallback",
          fallbackReason: reason,
          candidateEntryIds: ["d1", "d2", "d3", "d4", "d5", "z-answer"],
        },
      });
    });
  });

  it("preserves complete lexical order when a scripted response exceeds the body cap", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport(() => ({ status: 200, body: "x".repeat(64 * 1024 + 1) })),
        apiKey: "scripted-key",
        implementation,
      });

      expect(report.cases.find(({ queryId }) => queryId === "owner")).toMatchObject({
        semantic: {
          result: "lexical-fallback",
          fallbackReason: "response-too-large",
          candidateEntryIds: ["d1", "d2", "d3", "d4", "d5", "z-answer"],
        },
      });
    });
  });

  it("treats a cooperative deadline overrun as whole-list fallback", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      let now = 0;
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport((request) => {
          now = 1_201;
          return scriptedResponse(request);
        }),
        apiKey: "scripted-key",
        implementation,
        now: () => now,
      });

      expect(report.cases.find(({ queryId }) => queryId === "owner")).toMatchObject({
        semantic: {
          result: "lexical-fallback",
          fallbackReason: "deadline-overrun",
          candidateEntryIds: ["d1", "d2", "d3", "d4", "d5", "z-answer"],
        },
      });
      expect(report.operations.latencyMs.cooperativeDeadlineOverruns).toBe(1);
    });
  });

  it("uses a valid judgment even when usage is invalid, but blocks budget evidence", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport((request) => scriptedResponse(request, true)),
        apiKey: "scripted-key",
        implementation,
      });
      const owner = report.cases.find((caseReport) => caseReport.queryId === "owner");

      expect(owner).toMatchObject({
        semantic: {
          result: "reranked",
          bestKnownAnswerRank: 1,
          usage: null,
          usageIssue: "invalid-usage",
        },
      });
      expect(report.operations).toMatchObject({
        validJudgments: 2,
        responsesWithValidUsage: 0,
      });
      expect(report.gates.reasons).toContain("actual-usage-evidence-incomplete");
    });
  });

  it("does not dispatch a live held-out request before qualified real calibration", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const privatePlan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "private-reviewed",
        implementation,
      });
      let calls = 0;
      const report = await evaluateJevReplay(heldOut.fixture, privatePlan, {
        phase: "held-out",
        transport: scriptedTransport((request) => {
          calls++;
          return scriptedResponse(request);
        }, "native-api"),
        apiKey: "operator-key",
        approval,
        implementation,
      });

      expect(calls).toBe(0);
      expect(report.cases[0]).toMatchObject({
        semantic: {
          result: "lexical-fallback",
          fallbackReason: "qualified-calibration-required",
        },
      });
      expect(report.gates.reasons).toContain("qualified-real-api-calibration-missing");
    });
  });

  it("keeps candidate misses separate from semantic rank misses", async () => {
    await withFixtures(async (tuning, heldOut) => {
      const plan = createJevEvaluationPlan({
        tuningFixture: tuning.fixture,
        heldOutInputSha256: heldOut.fixture.digests,
        inputKind: "synthetic",
        implementation,
      });
      const report = await evaluateJevReplay(heldOut.fixture, plan, {
        phase: "held-out",
        transport: scriptedTransport((request) => scriptedResponse(request)),
        apiKey: "scripted-key",
        implementation,
      });

      expect(report.comparison).toMatchObject({
        candidateMisses: 0,
        lexicalRankMisses: 1,
        semanticRankMisses: 0,
      });
      expect(report.comparison.candidateMissDetails).toEqual([]);
    });
  });
});

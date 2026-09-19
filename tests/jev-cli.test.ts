import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runJevCli, type JevCliDependencies } from "../src/evaluation/jev-cli.js";
import { createJevEvaluationPlan, evaluateJevReplay } from "../src/evaluation/jev-replay.js";
import { readReplayFixture } from "../src/evaluation/replay-fixture.js";

const fixtureRoot = join(process.cwd(), "fixtures", "replay", "public-v1");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fixtureArgs = (partition: "tuning" | "held-out"): string[] => [
  "--corpus",
  join(fixtureRoot, partition, "corpus.jsonl"),
  "--queries",
  join(fixtureRoot, partition, "queries.json"),
  "--truth",
  join(fixtureRoot, partition, "truth.json"),
  "--partition",
  partition,
];

const prepareArgs = (inputKind: "synthetic" | "private-reviewed" = "synthetic"): string[] => [
  "prepare",
  ...fixtureArgs("tuning"),
  "--held-out-corpus",
  join(fixtureRoot, "held-out", "corpus.jsonl"),
  "--held-out-queries",
  join(fixtureRoot, "held-out", "queries.json"),
  "--held-out-truth",
  join(fixtureRoot, "held-out", "truth.json"),
  "--input-kind",
  inputKind,
];

const invoke = async (
  args: readonly string[],
  overrides: Partial<JevCliDependencies> = {},
): Promise<{ status: number; stdout: string; stderr: string }> => {
  let stdout = "";
  let stderr = "";
  const status = await runJevCli(args, {
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    env: {},
    executableSha256: "0".repeat(64),
    ...overrides,
  });
  return { status, stdout, stderr };
};

const withPlan = async <T>(
  run: (planPath: string, plan: Record<string, unknown>) => Promise<T> | T,
  inputKind: "synthetic" | "private-reviewed" = "synthetic",
): Promise<T> => {
  const prepared = await invoke(prepareArgs(inputKind));
  const parsed: unknown = JSON.parse(prepared.stdout);
  if (!isRecord(parsed)) throw new Error("prepare output must be an object");
  const plan = parsed;
  const dir = mkdtempSync(join(tmpdir(), "blackhole-jev-cli-"));
  const planPath = join(dir, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  try {
    return await run(planPath, plan);
  } finally {
    rmSync(dir, { recursive: true });
  }
};

const writeApproval = (
  path: string,
  planSha256: unknown,
  phase: "calibration" | "held-out" = "calibration",
): void => {
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      planSha256,
      phase,
      transmissionApproved: true,
      approvedBy: "synthetic-fixture",
      approvedAt: "2026-09-19T00:00:00Z",
      evidenceReference: "test-only approval fixture",
      localRawEvidenceRetentionDays: 7,
    })}\n`,
  );
};

const completeResponse = (body: string): { readonly status: number; readonly body: string } => {
  const request: unknown = JSON.parse(body);
  if (!isRecord(request) || !isRecord(request.questions)) {
    throw new Error("scripted transport received a malformed request");
  }
  return {
    status: 200,
    body: JSON.stringify({
      model: "jev-1.13.0",
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.1 }]),
      ),
      usage: { input_tokens: 100, output_tokens: 1 },
    }),
  };
};

const throwingEnv = new Proxy<Record<string, string | undefined>>(
  {},
  {
    get() {
      throw new Error("credentials must not be read");
    },
  },
);

describe("Jev evaluator CLI", () => {
  it("prepares and freezes a deterministic blocked plan without reading credentials", async () => {
    const result = await invoke(prepareArgs(), { env: throwingEnv });
    const report: unknown = JSON.parse(result.stdout);

    expect({ status: result.status, stderr: result.stderr, report }).toMatchObject({
      status: 0,
      stderr: "",
      report: {
        evaluator: "jev-evaluation-plan-v1",
        input: { kind: "synthetic" },
        preparation: { status: "READY_FOR_CALIBRATION", preparedQueries: 14, failedQueries: 0 },
        gates: {
          status: "BLOCKED",
          reasons: expect.arrayContaining([
            "real-api-calibration-missing",
            "held-out-evaluation-missing",
          ]),
        },
      },
    });
  });

  it("cannot relabel the committed public fixtures as private evidence", async () => {
    const result = await invoke(prepareArgs("private-reviewed"));

    expect(result).toMatchObject({
      status: 1,
      stdout: "",
      stderr: expect.stringContaining("must use synthetic input provenance"),
    });
  });

  it("emits a blocked calibration report without --live and never reads credentials", async () => {
    await withPlan(async (planPath) => {
      const result = await invoke(
        ["run", "--phase", "calibration", ...fixtureArgs("tuning"), "--plan", planPath],
        { env: throwingEnv },
      );
      const report: unknown = JSON.parse(result.stdout);

      expect({ status: result.status, stderr: result.stderr, report }).toMatchObject({
        status: 2,
        stderr: "",
        report: {
          phase: "calibration",
          evidence: { source: "none", nativeApiRequestsDispatched: false },
          operations: { attemptedRequests: 0, providerReportedUsageResponses: 0 },
          gates: {
            status: "BLOCKED",
            readyForHeldOut: false,
            reasons: expect.arrayContaining(["live-transmission-approval-and-evidence-missing"]),
          },
        },
      });
    });
  });

  it("emits a blocked held-out comparison without calibration or credential access", async () => {
    await withPlan(async (planPath) => {
      const result = await invoke(
        ["run", "--phase", "held-out", ...fixtureArgs("held-out"), "--plan", planPath],
        { env: throwingEnv },
      );
      const report: unknown = JSON.parse(result.stdout);

      expect({ status: result.status, report }).toMatchObject({
        status: 2,
        report: {
          phase: "held-out",
          fixture: { partition: "held-out" },
          comparison: { candidateMisses: 1, lexicalRankMisses: 1 },
          gates: { status: "BLOCKED" },
        },
      });
    });
  });

  it("reports zero-candidate no-answer skips separately from model evidence", async () => {
    await withPlan(async (planPath) => {
      const result = await invoke([
        "run",
        "--phase",
        "held-out",
        ...fixtureArgs("held-out"),
        "--plan",
        planPath,
      ]);
      const report: unknown = JSON.parse(result.stdout);

      expect(report).toMatchObject({
        comparison: {
          noAnswerCases: 4,
          noAnswerEligibleCases: 2,
          noAnswerCompleteJudgments: 0,
          noAnswerZeroCandidateCases: 2,
        },
        gates: {
          reasons: expect.arrayContaining(["no-answer-judgment-evidence-incomplete"]),
        },
      });
    });
  });

  it("rejects a structurally valid preparation-count mutation at the freeze digest", async () => {
    await withPlan(async (planPath, plan) => {
      const preparation = plan.preparation;
      if (!isRecord(preparation) || typeof preparation.preparedQueries !== "number") {
        throw new Error("plan preparation must contain a numeric prepared-query count");
      }
      writeFileSync(
        planPath,
        `${JSON.stringify({
          ...plan,
          preparation: {
            ...preparation,
            preparedQueries: preparation.preparedQueries + 1,
          },
        })}\n`,
      );

      const result = await invoke([
        "run",
        "--phase",
        "calibration",
        ...fixtureArgs("tuning"),
        "--plan",
        planPath,
      ]);

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("freeze digest does not match"),
      });
    });
  });

  it("binds review evidence to a validated held-out report and frozen plan", async () => {
    await withPlan(async (planPath, plan) => {
      const run = await invoke([
        "run",
        "--phase",
        "held-out",
        ...fixtureArgs("held-out"),
        "--plan",
        planPath,
      ]);
      const dir = dirname(planPath);
      const reportPath = join(dir, "held-out.json");
      const reviewPath = join(dir, "review.json");
      writeFileSync(reportPath, run.stdout);
      const reportSha256 = createHash("sha256").update(run.stdout).digest("hex");
      writeFileSync(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          heldOutEvidenceSha256: reportSha256,
          reviewedBy: "fixture-reviewer",
          reviewedAt: "2026-09-19T00:00:00Z",
          items: [],
        })}\n`,
      );

      const result = await invoke([
        "assess",
        "--plan",
        planPath,
        "--report",
        reportPath,
        "--review-evidence",
        reviewPath,
      ]);
      const assessment: unknown = JSON.parse(result.stdout);

      expect({ status: result.status, assessment }).toMatchObject({
        status: 2,
        assessment: {
          evaluator: "jev-held-out-assessment-v1",
          planSha256: plan.freezeSha256,
          heldOutEvidenceSha256: reportSha256,
          review: {
            reviewedBy: "fixture-reviewer",
            reviewedItems: 0,
            pendingItems: 0,
          },
          gates: { status: "BLOCKED" },
        },
      });
    });
  });

  it("removes only the review blocker after validating every pending judgment", async () => {
    const tuning = readReplayFixture(
      {
        corpus: join(fixtureRoot, "tuning", "corpus.jsonl"),
        queries: join(fixtureRoot, "tuning", "queries.json"),
        truth: join(fixtureRoot, "tuning", "truth.json"),
      },
      "tuning",
    );
    const heldOut = readReplayFixture(
      {
        corpus: join(fixtureRoot, "held-out", "corpus.jsonl"),
        queries: join(fixtureRoot, "held-out", "queries.json"),
        truth: join(fixtureRoot, "held-out", "truth.json"),
      },
      "held-out",
    );
    const implementation = {
      provenance: "executable-sha256" as const,
      executableSha256: "0".repeat(64),
    };
    const plan = createJevEvaluationPlan({
      tuningFixture: tuning,
      heldOutInputSha256: heldOut.digests,
      inputKind: "synthetic",
      implementation,
    });
    const report = await evaluateJevReplay(heldOut, plan, {
      phase: "held-out",
      implementation,
      apiKey: "scripted-key",
      transport: {
        evidenceSource: "scripted",
        async send({ body }) {
          const request: unknown = JSON.parse(body);
          if (!isRecord(request) || !isRecord(request.questions)) {
            throw new Error("scripted transport received a malformed request");
          }
          return {
            status: 200,
            body: JSON.stringify({
              model: "jev-1.13.0",
              answers: Object.fromEntries(
                Object.keys(request.questions).map((key, index) => [
                  key,
                  { type: "noul", noul: index === 0 ? 0.99 : 0.1 },
                ]),
              ),
              usage: { input_tokens: 100, output_tokens: 1 },
            }),
          };
        },
      },
    });
    const pendingIds = [
      ...new Set([
        ...report.comparison.disagreements.map(({ queryId }) => queryId),
        ...report.comparison.rankRegressions.map(({ queryId }) => queryId),
      ]),
    ].sort();
    expect(pendingIds.length).toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), "blackhole-jev-assess-"));
    try {
      const planPath = join(dir, "plan.json");
      const reportPath = join(dir, "held-out.json");
      const reviewPath = join(dir, "review.json");
      writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
      const reportBody = `${JSON.stringify(report)}\n`;
      writeFileSync(reportPath, reportBody);
      writeFileSync(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          heldOutEvidenceSha256: createHash("sha256").update(reportBody).digest("hex"),
          reviewedBy: "fixture-reviewer",
          reviewedAt: "2026-09-19T00:00:00Z",
          items: pendingIds.map((queryId) => ({
            queryId,
            judgment: "acceptable-change",
            notes: "Synthetic fixture review for assessment mechanics only.",
          })),
        })}\n`,
      );

      const result = await invoke([
        "assess",
        "--plan",
        planPath,
        "--report",
        reportPath,
        "--review-evidence",
        reviewPath,
      ]);
      const assessment: unknown = JSON.parse(result.stdout);

      expect(assessment).toMatchObject({
        planSha256: plan.freezeSha256,
        gates: {
          status: "BLOCKED",
          reasons: expect.not.arrayContaining(["review-evidence-missing"]),
        },
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("refuses held-out evidence from a different implementation", async () => {
    await withPlan(async (planPath) => {
      const run = await invoke([
        "run",
        "--phase",
        "held-out",
        ...fixtureArgs("held-out"),
        "--plan",
        planPath,
      ]);
      const report: unknown = JSON.parse(run.stdout);
      if (!isRecord(report)) throw new Error("held-out output must be an object");
      const dir = dirname(planPath);
      const reportPath = join(dir, "wrong-implementation.json");
      const reviewPath = join(dir, "review.json");
      const changed = {
        ...report,
        implementation: {
          provenance: "executable-sha256",
          executableSha256: "1".repeat(64),
        },
      };
      const body = `${JSON.stringify(changed)}\n`;
      writeFileSync(reportPath, body);
      writeFileSync(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          heldOutEvidenceSha256: createHash("sha256").update(body).digest("hex"),
          reviewedBy: "fixture-reviewer",
          reviewedAt: "2026-09-19T00:00:00Z",
          items: [],
        })}\n`,
      );

      const result = await invoke([
        "assess",
        "--plan",
        planPath,
        "--report",
        reportPath,
        "--review-evidence",
        reviewPath,
      ]);

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining(
          "does not bind this frozen plan, implementation, and input",
        ),
      });
    });
  });

  it("refuses a held-out report whose claimed gates disagree with complete records", async () => {
    await withPlan(async (planPath) => {
      const run = await invoke([
        "run",
        "--phase",
        "held-out",
        ...fixtureArgs("held-out"),
        "--plan",
        planPath,
      ]);
      const report: unknown = JSON.parse(run.stdout);
      if (!isRecord(report) || !isRecord(report.gates)) {
        throw new Error("held-out output must contain gates");
      }
      const dir = dirname(planPath);
      const reportPath = join(dir, "tampered-held-out.json");
      const reviewPath = join(dir, "review.json");
      const tamperedReport = {
        ...report,
        gates: { ...report.gates, status: "PASS", reasons: [] },
      };
      const reportBody = `${JSON.stringify(tamperedReport)}\n`;
      writeFileSync(reportPath, reportBody);
      writeFileSync(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          heldOutEvidenceSha256: createHash("sha256").update(reportBody).digest("hex"),
          reviewedBy: "fixture-reviewer",
          reviewedAt: "2026-09-19T00:00:00Z",
          items: [],
        })}\n`,
      );

      const result = await invoke([
        "assess",
        "--plan",
        planPath,
        "--report",
        reportPath,
        "--review-evidence",
        reviewPath,
      ]);

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("gates are inconsistent with validated records"),
      });
    });
  });

  it("rejects non-native calibration evidence before approval, credentials, or dispatch", async () => {
    await withPlan(async (planPath) => {
      const calibration = await invoke([
        "run",
        "--phase",
        "calibration",
        ...fixtureArgs("tuning"),
        "--plan",
        planPath,
      ]);
      const dir = dirname(planPath);
      const calibrationPath = join(dir, "calibration.json");
      writeFileSync(calibrationPath, calibration.stdout);
      let transportFactories = 0;

      const result = await invoke(
        [
          "run",
          "--phase",
          "held-out",
          ...fixtureArgs("held-out"),
          "--plan",
          planPath,
          "--live",
          "--calibration",
          calibrationPath,
          "--approval",
          join(dir, "must-not-read-approval.json"),
          "--output",
          join(dir, "must-not-create-output.json"),
        ],
        {
          env: throwingEnv,
          createNativeTransport: () => {
            transportFactories++;
            throw new Error("must not create transport");
          },
        },
      );

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("qualified private native-API usage"),
      });
      expect(transportFactories).toBe(0);
    });
  });

  it("validates approval before reading credentials", async () => {
    await withPlan(async (planPath, plan) => {
      const dir = dirname(planPath);
      const approvalPath = join(dir, "invalid-approval.json");
      writeFileSync(
        approvalPath,
        `${JSON.stringify({
          schemaVersion: 1,
          planSha256: plan.freezeSha256,
          phase: "calibration",
          transmissionApproved: false,
        })}\n`,
      );

      const result = await invoke(
        [
          "run",
          "--phase",
          "calibration",
          ...fixtureArgs("tuning"),
          "--plan",
          planPath,
          "--live",
          "--approval",
          approvalPath,
          "--output",
          join(dir, "evidence.json"),
        ],
        { env: throwingEnv },
      );

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("Approval must explicitly bind"),
      });
    });
  });

  it("refuses an existing output file before reading credentials", async () => {
    await withPlan(async (planPath, plan) => {
      const dir = dirname(planPath);
      const approvalPath = join(dir, "approval.json");
      const outputPath = join(dir, "evidence.json");
      writeApproval(approvalPath, plan.freezeSha256);
      writeFileSync(outputPath, "do not overwrite\n");

      const result = await invoke(
        [
          "run",
          "--phase",
          "calibration",
          ...fixtureArgs("tuning"),
          "--plan",
          planPath,
          "--live",
          "--approval",
          approvalPath,
          "--output",
          outputPath,
        ],
        { env: throwingEnv },
      );

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("must not already exist"),
      });
      expect(readFileSync(outputPath, "utf8")).toBe("do not overwrite\n");
    });
  });

  it("refuses a permissive output directory before reading credentials", async () => {
    await withPlan(async (planPath, plan) => {
      const dir = dirname(planPath);
      const approvalPath = join(dir, "approval.json");
      const outputDirectory = join(dir, "unsafe-output");
      writeApproval(approvalPath, plan.freezeSha256);
      mkdirSync(outputDirectory, { mode: 0o700 });
      chmodSync(outputDirectory, 0o755);

      const result = await invoke(
        [
          "run",
          "--phase",
          "calibration",
          ...fixtureArgs("tuning"),
          "--plan",
          planPath,
          "--live",
          "--approval",
          approvalPath,
          "--output",
          join(outputDirectory, "evidence.json"),
        ],
        { env: throwingEnv },
      );

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("must have mode 0700"),
      });
    });
  });

  it("classifies an injected live transport factory as scripted evidence", async () => {
    await withPlan(async (planPath, plan) => {
      const dir = dirname(planPath);
      const approvalPath = join(dir, "approval.json");
      const outputPath = join(dir, "evidence.json");
      writeFileSync(
        approvalPath,
        `${JSON.stringify({
          schemaVersion: 1,
          planSha256: plan.freezeSha256,
          phase: "calibration",
          transmissionApproved: true,
          approvedBy: "synthetic-fixture",
          approvedAt: "2026-09-19T00:00:00Z",
          evidenceReference: "test-only approval fixture",
          localRawEvidenceRetentionDays: 7,
        })}\n`,
      );

      const result = await invoke(
        [
          "run",
          "--phase",
          "calibration",
          ...fixtureArgs("tuning"),
          "--plan",
          planPath,
          "--live",
          "--approval",
          approvalPath,
          "--output",
          outputPath,
        ],
        {
          env: { TYPESAFE_API_KEY: "test-only-key" },
          createNativeTransport: () => ({
            evidenceSource: "native-api",
            send: async ({ body }) => completeResponse(body),
          }),
        },
      );
      const evidence: unknown = JSON.parse(readFileSync(outputPath, "utf8"));

      expect(result.status).toBe(2);
      expect(evidence).toMatchObject({
        evidence: { source: "scripted", nativeApiRequestsDispatched: false },
        gates: {
          status: "BLOCKED",
          reasons: expect.arrayContaining(["scripted-transport-is-not-empirical-evidence"]),
        },
      });
    });
  });

  it("creates admitted live evidence with file mode 0600", async () => {
    await withPlan(async (planPath, plan) => {
      const dir = dirname(planPath);
      const approvalPath = join(dir, "approval.json");
      const outputPath = join(dir, "evidence.json");
      writeApproval(approvalPath, plan.freezeSha256);

      const result = await invoke(
        [
          "run",
          "--phase",
          "calibration",
          ...fixtureArgs("tuning"),
          "--plan",
          planPath,
          "--live",
          "--approval",
          approvalPath,
          "--output",
          outputPath,
        ],
        {
          env: { TYPESAFE_API_KEY: "test-only-key" },
          createNativeTransport: () => ({
            evidenceSource: "scripted",
            send: async ({ body }) => completeResponse(body),
          }),
        },
      );

      expect(result.status).toBe(2);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    });
  });

  it("requires explicit approval before creating a live transport or reading credentials", async () => {
    await withPlan(async (planPath) => {
      let transportFactories = 0;
      const result = await invoke(
        ["run", "--phase", "calibration", ...fixtureArgs("tuning"), "--plan", planPath, "--live"],
        {
          env: throwingEnv,
          createNativeTransport: () => {
            transportFactories++;
            throw new Error("must not create transport");
          },
        },
      );

      expect(result).toMatchObject({
        status: 1,
        stdout: "",
        stderr: expect.stringContaining("--approval is required with --live"),
      });
      expect(transportFactories).toBe(0);
    });
  });
});

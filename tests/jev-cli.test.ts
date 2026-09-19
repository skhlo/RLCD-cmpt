import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runJevCli, type JevCliDependencies } from "../src/evaluation/jev-cli.js";

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
          evidence: { source: "none", actualApiUsage: false },
          operations: { attemptedRequests: 0, responsesWithValidUsage: 0 },
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

  it("rejects a modified frozen plan", async () => {
    await withPlan(async (planPath, plan) => {
      const contract = plan.contract;
      if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
        throw new Error("plan contract must be an object");
      }
      writeFileSync(
        planPath,
        `${JSON.stringify({ ...plan, contract: { ...contract, model: "jev-latest" } })}\n`,
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
        stderr: expect.stringContaining("plan contract does not match"),
      });
    });
  });

  it("binds real review evidence to the held-out report without inventing judgments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blackhole-jev-review-"));
    try {
      const reportPath = join(dir, "held-out.json");
      const reviewPath = join(dir, "review.json");
      const report = {
        manifestVersion: 1,
        evaluator: "jev-replay-v1",
        phase: "held-out",
        fixture: { inputKind: "synthetic" },
        evidence: {
          source: "scripted",
          actualApiUsage: false,
          estimatorCalibrationAccepted: false,
        },
        operations: {
          eligibleEvaluations: 1,
          attemptedRequests: 1,
          validJudgments: 1,
        },
        cases: [],
        comparison: {
          disagreements: [{ queryId: "q-owner", reviewStatus: "pending" }],
          firstPageRegressions: [],
        },
        gates: {
          status: "BLOCKED",
          reasons: ["review-evidence-missing", "synthetic-input-cannot-pass-empirical-gates"],
        },
      };
      writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
      const reportSha256 = createHash("sha256")
        .update(`${JSON.stringify(report)}\n`)
        .digest("hex");
      writeFileSync(
        reviewPath,
        `${JSON.stringify({
          schemaVersion: 1,
          heldOutEvidenceSha256: reportSha256,
          reviewedBy: "fixture-reviewer",
          reviewedAt: "2026-09-19T00:00:00Z",
          items: [
            {
              queryId: "q-owner",
              judgment: "acceptable-change",
              notes: "The answer moved above a lexical term-overlap distractor.",
            },
          ],
        })}\n`,
      );

      const result = await invoke([
        "assess",
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
          heldOutEvidenceSha256: reportSha256,
          review: {
            reviewedBy: "fixture-reviewer",
            reviewedItems: 1,
            pendingItems: 0,
          },
          gates: {
            status: "BLOCKED",
            reasons: ["synthetic-input-cannot-pass-empirical-gates"],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
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

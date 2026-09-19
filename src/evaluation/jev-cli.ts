#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JEV_BOUNDS,
  JEV_MODEL,
  JEV_PROMPT,
  JEV_PROMPT_VERSION,
  JEV_RESPONSE_CONTRACT_VERSION,
} from "./jev-contract.js";
import {
  JEV_EVALUATION_THRESHOLDS,
  JEV_PRICE,
  createJevEvaluationPlan,
  evaluateJevReplay,
  type JevEvaluationApproval,
  type JevEvaluationPhase,
  type JevEvaluationPlan,
  type QualifiedCalibrationEvidence,
} from "./jev-replay.js";
import {
  ReplayFixtureError,
  readReplayFixture,
  sha256File,
  type ReplayFixture,
  type ReplayInputPaths,
  type ReplayPartition,
} from "./replay-fixture.js";
import { createTypeSafeHttpTransport, type JevTransport } from "./typesafe-http.js";

export interface JevCliDependencies {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly executableSha256: string;
  readonly createNativeTransport?: () => JevTransport;
}

const usage = `Usage:
  jev-evaluator prepare --corpus <tuning.jsonl> --queries <tuning.json> --truth <tuning.json> --partition tuning \\
    --held-out-corpus <held-out.jsonl> --held-out-queries <held-out.json> --held-out-truth <held-out.json> \\
    --input-kind <synthetic|private-reviewed>

  jev-evaluator run --phase <calibration|held-out> --corpus <session.jsonl> --queries <queries.json> \\
    --truth <truth.json> --partition <tuning|held-out> --plan <plan.json> \\
    [--live --approval <approval.json> --output <new-evidence.json> [--calibration <calibration.json>]]

  jev-evaluator assess --report <held-out-evidence.json> --review-evidence <review.json>

Without --live, run emits a BLOCKED lexical-fallback report and never reads credentials.
Live use is opt-in, requires approval evidence, reads TYPESAFE_API_KEY only after preflight,
and writes private raw evidence to a new mode-0600 file. No request is retried.
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonObject = (path: string, kind: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ReplayFixtureError(`Cannot parse ${kind} file ${path}: ${detail}`);
  }
  if (!isRecord(value)) throw new ReplayFixtureError(`${kind} file ${path} must be an object`);
  return value;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const isDigests = (value: unknown): value is ReplayFixture["digests"] =>
  isRecord(value) && isSha256(value.corpus) && isSha256(value.queries) && isSha256(value.truth);

const isImplementation = (value: unknown): value is JevEvaluationPlan["implementation"] =>
  isRecord(value) && value.provenance === "executable-sha256" && isSha256(value.executableSha256);

const isCurrentPlan = (value: unknown): value is JevEvaluationPlan => {
  if (!isRecord(value)) return false;
  if (
    value.manifestVersion !== 1 ||
    value.evaluator !== "jev-evaluation-plan-v1" ||
    !isSha256(value.freezeSha256) ||
    !isImplementation(value.implementation) ||
    !isRecord(value.input) ||
    (value.input.kind !== "synthetic" && value.input.kind !== "private-reviewed") ||
    !isRecord(value.input.tuning) ||
    typeof value.input.tuning.revision !== "string" ||
    !isDigests(value.input.tuning.inputSha256) ||
    !isRecord(value.input.heldOut) ||
    !isDigests(value.input.heldOut.inputSha256) ||
    !isRecord(value.contract) ||
    !isRecord(value.contract.prompt) ||
    !isRecord(value.preparation)
  ) {
    return false;
  }
  if (
    value.contract.model !== JEV_MODEL ||
    value.contract.promptVersion !== JEV_PROMPT_VERSION ||
    value.contract.prompt.instructionsTemplate !==
      JEV_PROMPT.instructions(0).replace("candidates[0]", "candidates[i]") ||
    JSON.stringify(value.contract.prompt.criteria) !== JSON.stringify(JEV_PROMPT.criteria) ||
    value.contract.responseContractVersion !== JEV_RESPONSE_CONTRACT_VERSION ||
    JSON.stringify(value.contract.bounds) !== JSON.stringify(JEV_BOUNDS) ||
    value.contract.tokenEstimateIsExact !== false ||
    value.contract.liveShadowEvaluationsRequiredForOfflineEvaluator !== false ||
    JSON.stringify(value.thresholds) !== JSON.stringify(JEV_EVALUATION_THRESHOLDS) ||
    JSON.stringify(value.pricing) !== JSON.stringify(JEV_PRICE)
  ) {
    return false;
  }
  return (
    (value.preparation.status === "READY_FOR_CALIBRATION" ||
      value.preparation.status === "BLOCKED") &&
    typeof value.preparation.preparedQueries === "number" &&
    typeof value.preparation.failedQueries === "number"
  );
};

const readPlan = (path: string): JevEvaluationPlan => {
  const value = readJsonObject(path, "evaluation plan");
  if (!isRecord(value.contract) || value.contract.model !== JEV_MODEL) {
    throw new ReplayFixtureError("Evaluation plan contract does not match the pinned Jev contract");
  }
  if (!isCurrentPlan(value)) {
    throw new ReplayFixtureError(
      "Evaluation plan is malformed or does not match this evaluator version",
    );
  }
  const frozen = {
    implementation: value.implementation,
    input: value.input,
    contract: value.contract,
    thresholds: value.thresholds,
    pricing: value.pricing,
  };
  if (sha256(JSON.stringify(frozen)) !== value.freezeSha256) {
    throw new ReplayFixtureError("Evaluation plan freeze digest does not match its contents");
  }
  return value;
};

interface ParsedArguments {
  readonly command: "prepare" | "run" | "assess";
  readonly values: ReadonlyMap<string, string>;
  readonly live: boolean;
}

const parseArguments = (rawArgs: readonly string[]): ParsedArguments | "help" => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
  const command = args[0];
  if (command !== "prepare" && command !== "run" && command !== "assess") {
    throw new ReplayFixtureError(`First argument must be prepare, run, or assess\n${usage}`);
  }
  const prepareFlags = new Set([
    "--corpus",
    "--queries",
    "--truth",
    "--partition",
    "--held-out-corpus",
    "--held-out-queries",
    "--held-out-truth",
    "--input-kind",
  ]);
  const runFlags = new Set([
    "--phase",
    "--corpus",
    "--queries",
    "--truth",
    "--partition",
    "--plan",
    "--approval",
    "--calibration",
    "--output",
  ]);
  const assessFlags = new Set(["--report", "--review-evidence"]);
  const allowed = command === "prepare" ? prepareFlags : command === "run" ? runFlags : assessFlags;
  const values = new Map<string, string>();
  let live = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--live" && command === "run") {
      if (live) throw new ReplayFixtureError("Duplicate argument --live");
      live = true;
      continue;
    }
    if (!flag || !allowed.has(flag)) {
      throw new ReplayFixtureError(`Unknown argument ${JSON.stringify(flag)}\n${usage}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ReplayFixtureError(`Missing value for ${flag}\n${usage}`);
    }
    if (values.has(flag)) throw new ReplayFixtureError(`Duplicate argument ${flag}`);
    values.set(flag, value);
    index++;
  }
  return { command, values, live };
};

const requireValue = (values: ReadonlyMap<string, string>, flag: string): string => {
  const value = values.get(flag);
  if (!value) throw new ReplayFixtureError(`${flag} is required\n${usage}`);
  return value;
};

const fixtureOptions = (
  values: ReadonlyMap<string, string>,
): { paths: ReplayInputPaths; partition: ReplayPartition } => {
  const partition = requireValue(values, "--partition");
  if (partition !== "tuning" && partition !== "held-out") {
    throw new ReplayFixtureError("--partition must be tuning or held-out");
  }
  return {
    paths: {
      corpus: requireValue(values, "--corpus"),
      queries: requireValue(values, "--queries"),
      truth: requireValue(values, "--truth"),
    },
    partition,
  };
};

const readApproval = (
  path: string,
  plan: JevEvaluationPlan,
  phase: JevEvaluationPhase,
): JevEvaluationApproval => {
  const value = readJsonObject(path, "approval");
  if (
    value.schemaVersion !== 1 ||
    value.planSha256 !== plan.freezeSha256 ||
    value.phase !== phase ||
    value.transmissionApproved !== true ||
    typeof value.approvedBy !== "string" ||
    value.approvedBy.length === 0 ||
    typeof value.approvedAt !== "string" ||
    value.approvedAt.length === 0 ||
    typeof value.evidenceReference !== "string" ||
    value.evidenceReference.length === 0 ||
    !Number.isInteger(value.localRawEvidenceRetentionDays) ||
    typeof value.localRawEvidenceRetentionDays !== "number" ||
    value.localRawEvidenceRetentionDays < 1
  ) {
    throw new ReplayFixtureError(
      "Approval must explicitly bind this plan and phase with approver, date, and evidence reference",
    );
  }

  const extensionReference = value.localRetentionExtensionReference;
  if (
    value.localRawEvidenceRetentionDays > 7 &&
    (typeof extensionReference !== "string" || extensionReference.length === 0)
  ) {
    throw new ReplayFixtureError(
      "Local raw evidence beyond seven days requires an explicit extension reference",
    );
  }

  let privateAccountTermsAccepted = false;
  if (plan.input.kind === "private-reviewed") {
    const terms = value.accountTerms;
    if (
      !isRecord(terms) ||
      terms.retentionAccepted !== true ||
      terms.accessAccepted !== true ||
      terms.deletionAccepted !== true ||
      typeof terms.reference !== "string" ||
      terms.reference.length === 0
    ) {
      throw new ReplayFixtureError(
        "Private input requires accepted retention, access, and deletion terms with a reference",
      );
    }
    privateAccountTermsAccepted = true;
  }
  return {
    evidenceSha256: sha256File(path),
    transmissionApproved: true,
    privateAccountTermsAccepted,
    localRawEvidenceRetentionDays: value.localRawEvidenceRetentionDays,
    localRetentionExtensionReference:
      typeof extensionReference === "string" ? extensionReference : null,
  };
};

const readCalibration = (path: string, plan: JevEvaluationPlan): QualifiedCalibrationEvidence => {
  const value = readJsonObject(path, "calibration evidence");
  if (
    value.evaluator !== "jev-replay-v1" ||
    value.phase !== "calibration" ||
    value.planSha256 !== plan.freezeSha256 ||
    !isRecord(value.fixture) ||
    value.fixture.inputKind !== "private-reviewed" ||
    !isDigests(value.fixture.inputSha256) ||
    JSON.stringify(value.fixture.inputSha256) !== JSON.stringify(plan.input.tuning.inputSha256) ||
    !isRecord(value.evidence) ||
    value.evidence.source !== "native-api" ||
    !isSha256(value.evidence.approvalEvidenceSha256) ||
    value.evidence.actualApiUsage !== true ||
    value.evidence.estimatorCalibrationAccepted !== true ||
    !Number.isInteger(value.evidence.localRawEvidenceRetentionDays) ||
    typeof value.evidence.localRawEvidenceRetentionDays !== "number" ||
    value.evidence.localRawEvidenceRetentionDays < 1 ||
    (value.evidence.localRawEvidenceRetentionDays > 7 &&
      (typeof value.evidence.localRetentionExtensionReference !== "string" ||
        value.evidence.localRetentionExtensionReference.length === 0)) ||
    !isRecord(value.operations) ||
    !Number.isInteger(value.operations.responsesWithValidUsage) ||
    typeof value.operations.responsesWithValidUsage !== "number" ||
    value.operations.responsesWithValidUsage <
      JEV_EVALUATION_THRESHOLDS.calibrationMinimumObservedRequests ||
    !isRecord(value.gates) ||
    value.gates.readyForHeldOut !== true
  ) {
    throw new ReplayFixtureError(
      "Calibration evidence must contain qualified private native-API usage for this frozen plan",
    );
  }
  return {
    evidenceSha256: sha256File(path),
    planSha256: plan.freezeSha256,
    source: "native-api",
    inputKind: "private-reviewed",
    observedUsageResponses: value.operations.responsesWithValidUsage,
    readyForHeldOut: true,
  };
};

const emitJson = (write: (value: string) => void, value: unknown): void => {
  write(`${JSON.stringify(value, null, 2)}\n`);
};

const runPrepare = (
  values: ReadonlyMap<string, string>,
  dependencies: JevCliDependencies,
): number => {
  const fixtureInput = fixtureOptions(values);
  if (fixtureInput.partition !== "tuning") {
    throw new ReplayFixtureError("prepare requires --partition tuning");
  }
  const inputKind = requireValue(values, "--input-kind");
  if (inputKind !== "synthetic" && inputKind !== "private-reviewed") {
    throw new ReplayFixtureError("--input-kind must be synthetic or private-reviewed");
  }
  const tuningFixture = readReplayFixture(fixtureInput.paths, "tuning");
  const heldOutInputSha256 = {
    corpus: sha256File(requireValue(values, "--held-out-corpus")),
    queries: sha256File(requireValue(values, "--held-out-queries")),
    truth: sha256File(requireValue(values, "--held-out-truth")),
  };
  const plan = createJevEvaluationPlan({
    tuningFixture,
    heldOutInputSha256,
    inputKind,
    implementation: {
      provenance: "executable-sha256",
      executableSha256: dependencies.executableSha256,
    },
  });
  emitJson(dependencies.stdout, plan);
  return plan.preparation.status === "READY_FOR_CALIBRATION" ? 0 : 2;
};

const runEvaluation = async (
  parsed: ParsedArguments,
  dependencies: JevCliDependencies,
): Promise<number> => {
  const phase = requireValue(parsed.values, "--phase");
  if (phase !== "calibration" && phase !== "held-out") {
    throw new ReplayFixtureError("--phase must be calibration or held-out");
  }
  const fixtureInput = fixtureOptions(parsed.values);
  const expectedPartition = phase === "calibration" ? "tuning" : "held-out";
  if (fixtureInput.partition !== expectedPartition) {
    throw new ReplayFixtureError(`${phase} requires --partition ${expectedPartition}`);
  }
  const plan = readPlan(requireValue(parsed.values, "--plan"));
  if (plan.implementation.executableSha256 !== dependencies.executableSha256) {
    throw new ReplayFixtureError(
      "Evaluation plan executable provenance does not match the current evaluator",
    );
  }
  const fixture = readReplayFixture(fixtureInput.paths, expectedPartition);
  const implementation = {
    provenance: "executable-sha256" as const,
    executableSha256: dependencies.executableSha256,
  };

  if (!parsed.live) {
    const report = await evaluateJevReplay(fixture, plan, { phase, implementation });
    emitJson(dependencies.stdout, report);
    return 2;
  }

  const approvalPath = parsed.values.get("--approval");
  if (!approvalPath) throw new ReplayFixtureError("--approval is required with --live");
  const outputPath = parsed.values.get("--output");
  if (!outputPath) throw new ReplayFixtureError("--output is required with --live");
  const calibration =
    phase === "held-out"
      ? readCalibration(requireValue(parsed.values, "--calibration"), plan)
      : undefined;
  const approval = readApproval(approvalPath, plan, phase);
  const apiKey = dependencies.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new ReplayFixtureError("TYPESAFE_API_KEY is unavailable");

  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if ((statSync(outputDirectory).mode & 0o077) !== 0) {
    throw new ReplayFixtureError("Live evidence output directory must have mode 0700");
  }
  closeSync(openSync(outputPath, "wx", 0o600));
  const transport = (dependencies.createNativeTransport ?? createTypeSafeHttpTransport)();
  const report = await evaluateJevReplay(fixture, plan, {
    phase,
    transport,
    apiKey,
    approval,
    calibration,
    implementation,
  });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  emitJson(dependencies.stdout, {
    evaluator: report.evaluator,
    phase: report.phase,
    status: report.gates.status,
    readyForHeldOut: report.gates.readyForHeldOut,
    evidencePath: outputPath,
    evidenceSha256: sha256File(outputPath),
    reasons: report.gates.reasons,
  });
  return phase === "calibration"
    ? report.gates.readyForHeldOut
      ? 0
      : 2
    : report.gates.status === "PASS"
      ? 0
      : 2;
};

const reviewItemIds = (value: unknown, kind: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new ReplayFixtureError(`Held-out report ${kind} must be an array`);
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.queryId !== "string" || item.queryId.length === 0) {
      throw new ReplayFixtureError(`Held-out report contains a malformed ${kind} item`);
    }
    return item.queryId;
  });
};

const runAssessment = (
  values: ReadonlyMap<string, string>,
  dependencies: JevCliDependencies,
): number => {
  const reportPath = requireValue(values, "--report");
  const reviewPath = requireValue(values, "--review-evidence");
  const report = readJsonObject(reportPath, "held-out report");
  if (
    report.evaluator !== "jev-replay-v1" ||
    report.phase !== "held-out" ||
    !isRecord(report.fixture) ||
    (report.fixture.inputKind !== "synthetic" && report.fixture.inputKind !== "private-reviewed") ||
    !isRecord(report.evidence) ||
    (report.evidence.source !== "none" &&
      report.evidence.source !== "scripted" &&
      report.evidence.source !== "native-api") ||
    typeof report.evidence.actualApiUsage !== "boolean" ||
    typeof report.evidence.estimatorCalibrationAccepted !== "boolean" ||
    !isRecord(report.operations) ||
    !Number.isInteger(report.operations.eligibleEvaluations) ||
    !Number.isInteger(report.operations.attemptedRequests) ||
    !Number.isInteger(report.operations.validJudgments) ||
    !Array.isArray(report.cases) ||
    !isRecord(report.comparison) ||
    !isRecord(report.gates) ||
    (report.gates.status !== "PASS" && report.gates.status !== "BLOCKED") ||
    !Array.isArray(report.gates.reasons) ||
    report.gates.reasons.some((reason) => typeof reason !== "string")
  ) {
    throw new ReplayFixtureError("Held-out report is malformed or is not held-out evidence");
  }
  const disagreementIds = reviewItemIds(report.comparison.disagreements, "disagreement");
  const regressionIds = reviewItemIds(
    report.comparison.rankRegressions ?? report.comparison.firstPageRegressions,
    "regression",
  );
  const pendingIds = [...new Set([...disagreementIds, ...regressionIds])].sort();
  const reportDigest = sha256File(reportPath);

  const review = readJsonObject(reviewPath, "review evidence");
  if (
    review.schemaVersion !== 1 ||
    review.heldOutEvidenceSha256 !== reportDigest ||
    typeof review.reviewedBy !== "string" ||
    review.reviewedBy.length === 0 ||
    typeof review.reviewedAt !== "string" ||
    review.reviewedAt.length === 0 ||
    !Array.isArray(review.items)
  ) {
    throw new ReplayFixtureError(
      "Review evidence must bind this held-out report and name the reviewer and review date",
    );
  }
  const seen = new Set<string>();
  const reviewedItems = review.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.queryId !== "string" ||
      item.queryId.length === 0 ||
      !["acceptable-change", "confirmed-regression", "model-error", "label-error"].includes(
        typeof item.judgment === "string" ? item.judgment : "",
      ) ||
      typeof item.notes !== "string" ||
      item.notes.length === 0
    ) {
      throw new ReplayFixtureError("Review evidence contains a malformed review item");
    }
    if (seen.has(item.queryId)) {
      throw new ReplayFixtureError(
        `Review evidence duplicates query ${JSON.stringify(item.queryId)}`,
      );
    }
    seen.add(item.queryId);
    const disagreement = disagreementIds.includes(item.queryId);
    const regression = regressionIds.includes(item.queryId);
    if (!disagreement && !regression) {
      throw new ReplayFixtureError(
        `Review evidence includes non-pending query ${JSON.stringify(item.queryId)}`,
      );
    }
    return {
      queryId: item.queryId,
      kind:
        disagreement && regression
          ? "disagreement-and-regression"
          : regression
            ? "regression"
            : "disagreement",
      judgment: item.judgment,
      notes: item.notes,
    };
  });
  const missingIds = pendingIds.filter((queryId) => !seen.has(queryId));
  if (missingIds.length > 0) {
    throw new ReplayFixtureError(
      `Review evidence is missing pending queries: ${missingIds.join(", ")}`,
    );
  }

  const reasons = report.gates.reasons.filter(
    (reason): reason is string =>
      typeof reason === "string" && reason !== "review-evidence-missing",
  );
  if (reviewedItems.some(({ judgment }) => judgment === "label-error")) {
    reasons.push("review-found-label-error");
  }
  const uniqueReasons = [...new Set(reasons)];
  const assessment = {
    manifestVersion: 1,
    evaluator: "jev-held-out-assessment-v1",
    heldOutEvidenceSha256: reportDigest,
    reviewEvidenceSha256: sha256File(reviewPath),
    review: {
      reviewedBy: review.reviewedBy,
      reviewedAt: review.reviewedAt,
      reviewedItems: reviewedItems.length,
      pendingItems: 0,
      items: reviewedItems,
    },
    gates: {
      status: uniqueReasons.length === 0 ? "PASS" : "BLOCKED",
      reasons: uniqueReasons,
    },
  };
  emitJson(dependencies.stdout, assessment);
  return assessment.gates.status === "PASS" ? 0 : 2;
};

export const runJevCli = async (
  rawArgs: readonly string[],
  dependencies: JevCliDependencies,
): Promise<number> => {
  try {
    const parsed = parseArguments(rawArgs);
    if (parsed === "help") {
      dependencies.stdout(usage);
      return 0;
    }
    if (parsed.command === "prepare") return runPrepare(parsed.values, dependencies);
    if (parsed.command === "assess") return runAssessment(parsed.values, dependencies);
    return await runEvaluation(parsed, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(`jev-evaluator: ${message}\n`);
    return 1;
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const executablePath = fileURLToPath(import.meta.url);
  const status = await runJevCli(process.argv.slice(2), {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    env: process.env,
    executableSha256: sha256File(executablePath),
  });
  process.exitCode = status;
}

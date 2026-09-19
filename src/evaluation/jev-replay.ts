import { createHash } from "node:crypto";
import type { SearchHit } from "../core/search-entries.js";
import { planSearchQuery, searchEntriesDetailedWithPlan } from "../core/search-entries.js";
import {
  JEV_BOUNDS,
  JEV_MODEL,
  JEV_PROMPT,
  JEV_PROMPT_VERSION,
  JEV_RESPONSE_CONTRACT_VERSION,
  prepareJevRequest,
  projectJevUsage,
  rankPreparedCandidates,
  validateJevResponse,
  type JevReportedUsage,
  type JevRequestMeasurements,
  type PreparedJevRequest,
} from "./jev-contract.js";
import {
  evaluateLexicalReplay,
  type AnswerableReplayCaseReport,
  type LexicalReplayReport,
  type ReplayImplementationProvenance,
} from "./lexical-replay.js";
import type { ReplayFixture, ReplayFixtureCase } from "./replay-fixture.js";
import {
  TypeSafeHttpError,
  jevTransportEvidenceSource,
  type JevTransport,
} from "./typesafe-http.js";

export type JevEvaluationInputKind = "synthetic" | "private-reviewed";
export type JevEvaluationPhase = "calibration" | "held-out";

export const JEV_EVALUATION_THRESHOLDS = Object.freeze({
  calibrationMinimumObservedRequests: 10,
  estimatorMaximumUnderestimateRatio: 0,
  candidateCoverageMinimum: 0.9,
  answerAt5NetImprovementMinimum: 0.05,
  answerAt5MinimumPromotions: 2,
  meanReciprocalRankMinimumDelta: 0,
  consequentialFirstPageRegressionMaximum: 0,
  noAnswerHighSupportThreshold: 0.9,
  noAnswerHighSupportMaximum: 0,
  adversarialHighSupportThreshold: 0.9,
  adversarialHighSupportMaximum: 0,
  completeWithinDeadlineRateMinimum: 0.95,
  addedLatencyP95MaximumMs: 1_000,
  cooperativeDeadlineMaximumMs: JEV_BOUNDS.proposed.cooperativeDeadlineMs,
} as const);

export const JEV_PRICE = Object.freeze({
  inputUsdPerMillionTokens: 0.042,
  outputTokensFree: true,
  provenance: "https://docs.typesafe.ai/models.md#current-models (retrieved 2026-09-19 UTC)",
  contractualQuote: false,
});

interface FrozenEvaluationInput {
  readonly kind: JevEvaluationInputKind;
  readonly tuning: {
    readonly revision: string;
    readonly inputSha256: ReplayFixture["digests"];
  };
  readonly heldOut: {
    readonly inputSha256: ReplayFixture["digests"];
  };
}

interface PreparationCase {
  readonly queryId: string;
  readonly result: "prepared" | "no-candidates" | "rejected" | "invalid";
  readonly candidateCount: number;
  readonly requestSha256?: string;
  readonly measurements?: JevRequestMeasurements;
  readonly issues?: readonly string[];
}

export interface JevEvaluationPlan {
  readonly manifestVersion: 1;
  readonly evaluator: "jev-evaluation-plan-v1";
  readonly freezeSha256: string;
  readonly implementation: ReplayImplementationProvenance;
  readonly input: FrozenEvaluationInput;
  readonly contract: {
    readonly model: typeof JEV_MODEL;
    readonly promptVersion: typeof JEV_PROMPT_VERSION;
    readonly prompt: {
      readonly instructionsTemplate: string;
      readonly criteria: typeof JEV_PROMPT.criteria;
    };
    readonly responseContractVersion: typeof JEV_RESPONSE_CONTRACT_VERSION;
    readonly bounds: typeof JEV_BOUNDS;
    readonly tokenEstimateIsExact: false;
    readonly liveShadowEvaluationsRequiredForOfflineEvaluator: false;
  };
  readonly thresholds: typeof JEV_EVALUATION_THRESHOLDS;
  readonly pricing: typeof JEV_PRICE;
  readonly preparation: {
    readonly status: "READY_FOR_CALIBRATION" | "BLOCKED";
    readonly preparedQueries: number;
    readonly noCandidateQueries: number;
    readonly failedQueries: number;
    readonly cases: readonly PreparationCase[];
  };
  readonly gates: {
    readonly status: "BLOCKED";
    readonly reasons: readonly string[];
  };
}

type JevEvaluationPlanContents = Omit<JevEvaluationPlan, "freezeSha256">;

export const evaluationPlanFreezeSha256 = (
  plan: JevEvaluationPlanContents | JevEvaluationPlan,
): string =>
  sha256(
    JSON.stringify({
      manifestVersion: plan.manifestVersion,
      evaluator: plan.evaluator,
      implementation: plan.implementation,
      input: plan.input,
      contract: plan.contract,
      thresholds: plan.thresholds,
      pricing: plan.pricing,
      preparation: plan.preparation,
      gates: plan.gates,
    }),
  );

export interface JevEvaluationApproval {
  readonly evidenceSha256: string;
  readonly transmissionApproved: boolean;
  readonly privateAccountTermsAccepted: boolean;
  readonly localRawEvidenceRetentionDays: number;
  readonly localRetentionExtensionReference: string | null;
}

export interface QualifiedCalibrationEvidence {
  readonly evidenceSha256: string;
  readonly planSha256: string;
  readonly source: "native-api";
  readonly inputKind: "private-reviewed";
  readonly observedUsageResponses: number;
  readonly readyForHeldOut: true;
}

export interface EvaluateJevReplayOptions {
  readonly phase: JevEvaluationPhase;
  readonly transport?: JevTransport;
  readonly apiKey?: string;
  readonly approval?: JevEvaluationApproval;
  readonly calibration?: QualifiedCalibrationEvidence;
  readonly implementation: ReplayImplementationProvenance;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

export interface JevReplayCaseReport {
  readonly queryId: string;
  readonly query: string;
  readonly category: string;
  readonly lexical: {
    readonly outcome: string;
    readonly candidateEntryIds: readonly string[];
    readonly bestKnownAnswerRank: number | null;
    readonly candidateMissReason: string | null;
  };
  readonly semantic: {
    readonly result: "reranked" | "lexical-fallback";
    readonly fallbackReason: string | null;
    readonly candidateEntryIds: readonly string[];
    readonly bestKnownAnswerRank: number | null;
    readonly scores: readonly {
      readonly entryId: string;
      readonly noul: number;
    }[];
    readonly usage: JevReportedUsage | null;
    readonly usageStatus: "not-dispatched" | "provider-reported" | "unknown";
    readonly usageIssue: "invalid-usage" | "response-unavailable" | null;
    readonly requestSha256: string | null;
    readonly transmittedRequest: PreparedJevRequest["request"] | null;
    readonly requestMeasurements: JevRequestMeasurements | null;
    readonly timingMs: {
      readonly preparation: number;
      readonly transport: number;
      readonly totalAdded: number;
    };
    readonly estimatorError: {
      readonly estimatedInputTokens: number;
      readonly actualInputTokens: number;
      readonly actualMinusEstimatedTokens: number;
      readonly underestimateRatio: number;
    } | null;
  };
}

interface ComparisonDisagreement {
  readonly queryId: string;
  readonly lexicalCandidateEntryIds: readonly string[];
  readonly semanticCandidateEntryIds: readonly string[];
  readonly reviewStatus: "pending";
}

export interface JevReplayReport {
  readonly manifestVersion: 1;
  readonly evaluator: "jev-replay-v1";
  readonly phase: JevEvaluationPhase;
  readonly planSha256: string;
  readonly implementation: ReplayImplementationProvenance;
  readonly fixture: {
    readonly revision: string;
    readonly partition: ReplayFixture["partition"];
    readonly inputSha256: ReplayFixture["digests"];
    readonly inputKind: JevEvaluationInputKind;
  };
  readonly lexicalBaseline: LexicalReplayReport;
  readonly evidence: {
    readonly source: "none" | JevTransport["evidenceSource"];
    readonly approvalEvidenceSha256: string | null;
    readonly calibrationEvidenceSha256: string | null;
    readonly localRawEvidenceRetentionDays: number | null;
    readonly localRetentionExtensionReference: string | null;
    readonly nativeApiRequestsDispatched: boolean;
    readonly estimatorCalibrationAccepted: boolean;
    readonly price: typeof JEV_PRICE;
  };
  readonly operations: {
    readonly eligibleEvaluations: number;
    readonly attemptedRequests: number;
    readonly validJudgments: number;
    readonly completeWithinDeadline: number;
    readonly providerReportedUsageResponses: number;
    readonly requestsWithUnknownUsage: number;
    readonly providerReportedInputTokens: number;
    readonly providerReportedOutputTokens: number;
    readonly estimatedInputTokens: number;
    readonly costs: {
      readonly providerReportedInputCostUsd: number;
      readonly estimatedInputCostUsd: number;
      readonly completeProviderReportedInputCostUsd: number | null;
      readonly requestsWithUnknownCost: number;
    };
    readonly estimatorError: {
      readonly maximumUnderestimateRatio: number | null;
      readonly meanActualMinusEstimatedTokens: number | null;
    };
    readonly latencyMs: {
      readonly p50: number | null;
      readonly p95: number | null;
      readonly maximum: number | null;
      readonly cooperativeDeadlineOverruns: number;
    };
    readonly failures: readonly { readonly queryId: string; readonly reason: string }[];
  };
  readonly comparison: {
    readonly candidateMisses: number;
    readonly candidateMissDetails: readonly {
      readonly queryId: string;
      readonly reason: string | null;
    }[];
    readonly lexicalRankMisses: number;
    readonly semanticRankMisses: number;
    readonly lexicalAnswerAt5: number | null;
    readonly semanticAnswerAt5: number | null;
    readonly answerAt5NetImprovement: number | null;
    readonly lexicalMeanReciprocalRank: number | null;
    readonly semanticMeanReciprocalRank: number | null;
    readonly meanReciprocalRankDelta: number | null;
    readonly promotionsIntoTop5: number;
    readonly rankRegressions: readonly {
      readonly queryId: string;
      readonly category: string;
      readonly lexicalRank: number;
      readonly semanticRank: number | null;
      readonly consequential: boolean;
      readonly reviewStatus: "pending";
    }[];
    readonly firstPageRegressions: readonly {
      readonly queryId: string;
      readonly category: string;
      readonly lexicalRank: number;
      readonly semanticRank: number | null;
      readonly consequential: boolean;
      readonly reviewStatus: "pending";
    }[];
    readonly disagreements: readonly ComparisonDisagreement[];
    readonly noAnswerCases: number;
    readonly noAnswerEligibleCases: number;
    readonly noAnswerCompleteJudgments: number;
    readonly noAnswerZeroCandidateCases: number;
    readonly noAnswerHighSupport: readonly {
      readonly queryId: string;
      readonly entryId: string;
      readonly noul: number;
    }[];
    readonly adversarialCases: number;
    readonly adversarialEligibleCases: number;
    readonly adversarialCompleteJudgments: number;
    readonly adversarialZeroCandidateCases: number;
    readonly adversarialHighSupport: readonly {
      readonly queryId: string;
      readonly entryId: string;
      readonly noul: number;
    }[];
  };
  readonly cases: readonly JevReplayCaseReport[];
  readonly gates: {
    readonly status: "PASS" | "BLOCKED";
    readonly readyForHeldOut: boolean;
    readonly reasons: readonly string[];
  };
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const requestSha256 = (prepared: PreparedJevRequest): string =>
  sha256(`${prepared.body}\n${JSON.stringify(prepared.binding)}`);
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const roundCost = (value: number): number =>
  Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
const equalIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const throwIfCallerCancelled = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The evaluation was cancelled", "AbortError");
};

const transportFailureReason = (error: unknown): string => {
  if (error instanceof TypeSafeHttpError) {
    return error.status === undefined
      ? `transport-${error.code}`
      : `transport-${error.code}-${error.status}`;
  }
  if (error instanceof Error && error.name === "AbortError") return "transport-aborted";
  return "transport-failure";
};

const fixtureCaseHits = (
  fixture: ReplayFixture,
  fixtureCase: ReplayFixtureCase,
): readonly SearchHit[] => {
  const plan = planSearchQuery(fixtureCase.query.text);
  if (!plan || !plan.eligibleForReranking) return [];
  return searchEntriesDetailedWithPlan(
    fixture.rendered,
    fixture.rawMessages,
    plan,
    undefined,
    "hybrid",
  ).hits;
};

const preparationCases = (fixture: ReplayFixture): readonly PreparationCase[] =>
  fixture.cases.map((fixtureCase) => {
    if (fixtureCase.truth.classification === "invalid") {
      return {
        queryId: fixtureCase.query.id,
        result: "invalid",
        candidateCount: 0,
        issues: fixtureCase.truth.issues.map(({ code }) => code),
      };
    }
    const hits = fixtureCaseHits(fixture, fixtureCase);
    if (hits.length === 0) {
      return { queryId: fixtureCase.query.id, result: "no-candidates", candidateCount: 0 };
    }
    const prepared = prepareJevRequest(fixtureCase.query.text, hits);
    if (!prepared.ok) {
      return {
        queryId: fixtureCase.query.id,
        result: "rejected",
        candidateCount: hits.length,
        measurements: prepared.measurements,
        issues: prepared.issues.map(({ code }) => code),
      };
    }
    return {
      queryId: fixtureCase.query.id,
      result: "prepared",
      candidateCount: hits.length,
      requestSha256: requestSha256(prepared),
      measurements: prepared.measurements,
    };
  });

export const createJevEvaluationPlan = (options: {
  readonly tuningFixture: ReplayFixture;
  readonly heldOutInputSha256: ReplayFixture["digests"];
  readonly inputKind: JevEvaluationInputKind;
  readonly implementation: ReplayImplementationProvenance;
}): JevEvaluationPlan => {
  if (options.tuningFixture.partition !== "tuning") {
    throw new Error("The evaluation plan must be frozen from a tuning fixture");
  }
  if (
    options.tuningFixture.revision === "public-synthetic-v1" &&
    options.inputKind !== "synthetic"
  ) {
    throw new Error("The committed public synthetic fixture must use synthetic input provenance");
  }
  const cases = preparationCases(options.tuningFixture);
  const failedQueries = cases.filter(
    ({ result }) => result === "rejected" || result === "invalid",
  ).length;
  const input: FrozenEvaluationInput = {
    kind: options.inputKind,
    tuning: {
      revision: options.tuningFixture.revision,
      inputSha256: options.tuningFixture.digests,
    },
    heldOut: { inputSha256: options.heldOutInputSha256 },
  };
  const contract = {
    model: JEV_MODEL,
    promptVersion: JEV_PROMPT_VERSION,
    prompt: {
      instructionsTemplate: JEV_PROMPT.instructions(0).replace("candidates[0]", "candidates[i]"),
      criteria: JEV_PROMPT.criteria,
    },
    responseContractVersion: JEV_RESPONSE_CONTRACT_VERSION,
    bounds: JEV_BOUNDS,
    tokenEstimateIsExact: false as const,
    liveShadowEvaluationsRequiredForOfflineEvaluator: false as const,
  };
  const reasons = ["real-api-calibration-missing", "held-out-evaluation-missing"];
  if (options.inputKind === "synthetic") {
    reasons.push("synthetic-input-cannot-pass-empirical-gates");
  }
  if (failedQueries > 0) reasons.push("preparation-failures-present");

  const contents: JevEvaluationPlanContents = {
    manifestVersion: 1,
    evaluator: "jev-evaluation-plan-v1",
    implementation: options.implementation,
    input,
    contract,
    thresholds: JEV_EVALUATION_THRESHOLDS,
    pricing: JEV_PRICE,
    preparation: {
      status: failedQueries === 0 ? "READY_FOR_CALIBRATION" : "BLOCKED",
      preparedQueries: cases.filter(({ result }) => result === "prepared").length,
      noCandidateQueries: cases.filter(({ result }) => result === "no-candidates").length,
      failedQueries,
      cases,
    },
    gates: { status: "BLOCKED", reasons },
  };
  return { ...contents, freezeSha256: evaluationPlanFreezeSha256(contents) };
};

const percentile = (values: readonly number[], probability: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * probability) - 1);
  return round(sorted[index]);
};

const bestRank = (candidateIds: readonly string[], answerIds: readonly string[]): number | null => {
  const answers = new Set(answerIds);
  const index = candidateIds.findIndex((id) => answers.has(id));
  return index === -1 ? null : index + 1;
};

const inputMatchesPlan = (
  fixture: ReplayFixture,
  plan: JevEvaluationPlan,
  phase: JevEvaluationPhase,
): boolean => {
  if (fixture.revision === "public-synthetic-v1" && plan.input.kind !== "synthetic") {
    return false;
  }
  const expected =
    phase === "calibration" ? plan.input.tuning.inputSha256 : plan.input.heldOut.inputSha256;
  return (Object.keys(expected) as Array<keyof typeof expected>).every(
    (key) => fixture.digests[key] === expected[key],
  );
};

const dispatchBlockReason = (
  fixture: ReplayFixture,
  plan: JevEvaluationPlan,
  options: EvaluateJevReplayOptions,
): string | null => {
  if (!inputMatchesPlan(fixture, plan, options.phase)) return "input-provenance-mismatch";
  if (plan.preparation.status !== "READY_FOR_CALIBRATION") return "plan-preparation-blocked";
  if (!options.transport) return "transmission-not-approved";
  if (jevTransportEvidenceSource(options.transport) === "scripted") return null;
  if (!options.approval?.transmissionApproved) return "transmission-approval-required";
  if (plan.input.kind === "private-reviewed" && !options.approval.privateAccountTermsAccepted) {
    return "account-terms-acceptance-required";
  }
  if (options.phase === "held-out") {
    const calibration = options.calibration;
    if (
      !calibration ||
      calibration.readyForHeldOut !== true ||
      calibration.source !== "native-api" ||
      calibration.inputKind !== "private-reviewed" ||
      calibration.planSha256 !== plan.freezeSha256 ||
      calibration.observedUsageResponses <
        JEV_EVALUATION_THRESHOLDS.calibrationMinimumObservedRequests
    ) {
      return "qualified-calibration-required";
    }
  }
  if (!options.apiKey) return "credential-unavailable";
  return null;
};

const lexicalCaseById = (
  report: LexicalReplayReport,
): ReadonlyMap<string, LexicalReplayReport["cases"][number]> =>
  new Map(report.cases.map((caseReport) => [caseReport.queryId, caseReport]));

const lexicalProjection = (
  lexical: LexicalReplayReport["cases"][number] | undefined,
  hits: readonly SearchHit[],
): JevReplayCaseReport["lexical"] => {
  const candidateEntryIds = hits.map(({ id }) => id);
  if (!lexical) {
    return {
      outcome: "invalid",
      candidateEntryIds,
      bestKnownAnswerRank: null,
      candidateMissReason: null,
    };
  }
  return {
    outcome: lexical.outcome,
    candidateEntryIds,
    bestKnownAnswerRank: "bestKnownAnswerRank" in lexical ? lexical.bestKnownAnswerRank : null,
    candidateMissReason: "candidateMissReason" in lexical ? lexical.candidateMissReason : null,
  };
};

const estimatorErrorFor = (
  measurements: JevRequestMeasurements | null,
  usage: JevReportedUsage | null,
): JevReplayCaseReport["semantic"]["estimatorError"] => {
  if (!measurements || !usage) return null;
  const delta = usage.inputTokens - measurements.requestEstimatedInputTokens;
  const underestimateRatio = usage.inputTokens === 0 ? 0 : Math.max(0, delta / usage.inputTokens);
  return {
    estimatedInputTokens: measurements.requestEstimatedInputTokens,
    actualInputTokens: usage.inputTokens,
    actualMinusEstimatedTokens: delta,
    underestimateRatio: round(underestimateRatio),
  };
};

interface FallbackDetails {
  readonly preparationMs?: number;
  readonly totalAddedMs?: number;
  readonly measurements?: JevRequestMeasurements;
  readonly requestHash?: string;
  readonly transmittedRequest?: PreparedJevRequest["request"];
  readonly usage?: JevReportedUsage | null;
  readonly usageIssue?: "invalid-usage" | "response-unavailable" | null;
  readonly transportMs?: number;
}

const fallbackCase = (
  fixtureCase: ReplayFixtureCase,
  lexical: JevReplayCaseReport["lexical"],
  reason: string,
  details: FallbackDetails = {},
): JevReplayCaseReport => {
  const measurements = details.measurements ?? null;
  const transmittedRequest = details.transmittedRequest ?? null;
  const usage = details.usage ?? null;
  const usageIssue = details.usageIssue ?? null;
  return {
    queryId: fixtureCase.query.id,
    query: fixtureCase.query.text,
    category: fixtureCase.query.category,
    lexical,
    semantic: {
      result: "lexical-fallback",
      fallbackReason: reason,
      candidateEntryIds: lexical.candidateEntryIds,
      bestKnownAnswerRank: lexical.bestKnownAnswerRank,
      scores: [],
      usage,
      usageStatus:
        transmittedRequest === null
          ? "not-dispatched"
          : usage === null
            ? "unknown"
            : "provider-reported",
      usageIssue:
        transmittedRequest === null || usage !== null
          ? usageIssue
          : (usageIssue ?? "response-unavailable"),
      requestSha256: details.requestHash ?? null,
      transmittedRequest,
      requestMeasurements: measurements,
      timingMs: {
        preparation: round(details.preparationMs ?? 0),
        transport: round(details.transportMs ?? 0),
        totalAdded: round(details.totalAddedMs ?? 0),
      },
      estimatorError: estimatorErrorFor(measurements, usage),
    },
  };
};

export const deriveJevReplayComparison = (
  lexicalBaseline: LexicalReplayReport,
  cases: readonly JevReplayCaseReport[],
  thresholds: typeof JEV_EVALUATION_THRESHOLDS,
): JevReplayReport["comparison"] => {
  const answerableIds = new Set(
    lexicalBaseline.cases
      .filter(
        (caseReport): caseReport is AnswerableReplayCaseReport =>
          caseReport.outcome === "answer-at-5" ||
          caseReport.outcome === "rank-miss" ||
          caseReport.outcome === "candidate-miss",
      )
      .map(({ queryId }) => queryId),
  );
  const answerableReports = cases.filter(({ queryId }) => answerableIds.has(queryId));
  const denominator = answerableReports.length;
  const lexicalTop5 = answerableReports.filter(
    ({ lexical }) => lexical.bestKnownAnswerRank !== null && lexical.bestKnownAnswerRank <= 5,
  ).length;
  const semanticTop5 = answerableReports.filter(
    ({ semantic }) => semantic.bestKnownAnswerRank !== null && semantic.bestKnownAnswerRank <= 5,
  ).length;
  const lexicalMrrSum = answerableReports.reduce(
    (sum, { lexical }) =>
      sum + (lexical.bestKnownAnswerRank === null ? 0 : 1 / lexical.bestKnownAnswerRank),
    0,
  );
  const semanticMrrSum = answerableReports.reduce(
    (sum, { semantic }) =>
      sum + (semantic.bestKnownAnswerRank === null ? 0 : 1 / semantic.bestKnownAnswerRank),
    0,
  );
  const lexicalAnswerAt5 = denominator === 0 ? null : round(lexicalTop5 / denominator);
  const semanticAnswerAt5 = denominator === 0 ? null : round(semanticTop5 / denominator);
  const lexicalMrr = denominator === 0 ? null : round(lexicalMrrSum / denominator);
  const semanticMrr = denominator === 0 ? null : round(semanticMrrSum / denominator);
  const disagreements: ComparisonDisagreement[] = cases
    .filter(
      ({ lexical, semantic }) =>
        semantic.result === "reranked" &&
        !equalIds(lexical.candidateEntryIds, semantic.candidateEntryIds),
    )
    .map(({ queryId, lexical, semantic }) => ({
      queryId,
      lexicalCandidateEntryIds: lexical.candidateEntryIds,
      semanticCandidateEntryIds: semantic.candidateEntryIds,
      reviewStatus: "pending",
    }));
  const rankRegressions = cases
    .filter(
      ({ lexical, semantic }) =>
        lexical.bestKnownAnswerRank !== null &&
        (semantic.bestKnownAnswerRank === null ||
          semantic.bestKnownAnswerRank > lexical.bestKnownAnswerRank),
    )
    .map(({ queryId, category, lexical, semantic }) => ({
      queryId,
      category,
      lexicalRank: lexical.bestKnownAnswerRank ?? 0,
      semanticRank: semantic.bestKnownAnswerRank,
      consequential: ["correction", "constraint", "supersession"].includes(category),
      reviewStatus: "pending" as const,
    }));
  const firstPageRegressions = rankRegressions.filter(
    ({ lexicalRank, semanticRank }) =>
      lexicalRank <= 5 && (semanticRank === null || semanticRank > 5),
  );
  const noAnswerIds = new Set(
    lexicalBaseline.cases
      .filter(({ outcome }) => outcome === "no-answer-empty" || outcome === "no-answer-candidates")
      .map(({ queryId }) => queryId),
  );
  const adversarialIds = new Set(
    lexicalBaseline.cases
      .filter(
        ({ outcome, category }) =>
          (outcome === "no-answer-empty" || outcome === "no-answer-candidates") &&
          category.includes("adversarial"),
      )
      .map(({ queryId }) => queryId),
  );
  const highSupport = (
    ids: ReadonlySet<string>,
    threshold: number,
  ): Array<{ queryId: string; entryId: string; noul: number }> =>
    cases.flatMap((caseReport) =>
      ids.has(caseReport.queryId)
        ? caseReport.semantic.scores
            .filter(({ noul }) => noul >= threshold)
            .map(({ entryId, noul }) => ({ queryId: caseReport.queryId, entryId, noul }))
        : [],
    );
  const categoryEvidence = (ids: ReadonlySet<string>) => {
    const categoryReports = cases.filter(({ queryId }) => ids.has(queryId));
    const eligibleReports = categoryReports.filter(
      ({ lexical }) => lexical.candidateEntryIds.length > 0,
    );
    return {
      cases: categoryReports.length,
      eligibleCases: eligibleReports.length,
      completeJudgments: eligibleReports.filter(({ semantic }) => semantic.result === "reranked")
        .length,
      zeroCandidateCases: categoryReports.length - eligibleReports.length,
    };
  };
  const noAnswerEvidence = categoryEvidence(noAnswerIds);
  const adversarialEvidence = categoryEvidence(adversarialIds);
  const candidateMissDetails = lexicalBaseline.cases
    .filter(
      (caseReport): caseReport is AnswerableReplayCaseReport =>
        caseReport.outcome === "candidate-miss",
    )
    .map(({ queryId, candidateMissReason }) => ({ queryId, reason: candidateMissReason }));

  return {
    candidateMisses: candidateMissDetails.length,
    candidateMissDetails,
    lexicalRankMisses: lexicalBaseline.aggregate.rankMisses,
    semanticRankMisses: answerableReports.filter(
      ({ lexical, semantic }) =>
        lexical.outcome !== "candidate-miss" &&
        semantic.bestKnownAnswerRank !== null &&
        semantic.bestKnownAnswerRank > 5,
    ).length,
    lexicalAnswerAt5,
    semanticAnswerAt5,
    answerAt5NetImprovement:
      lexicalAnswerAt5 === null || semanticAnswerAt5 === null
        ? null
        : round(semanticAnswerAt5 - lexicalAnswerAt5),
    lexicalMeanReciprocalRank: lexicalMrr,
    semanticMeanReciprocalRank: semanticMrr,
    meanReciprocalRankDelta:
      lexicalMrr === null || semanticMrr === null ? null : round(semanticMrr - lexicalMrr),
    promotionsIntoTop5: cases.filter(
      ({ lexical, semantic }) =>
        (lexical.bestKnownAnswerRank === null || lexical.bestKnownAnswerRank > 5) &&
        semantic.bestKnownAnswerRank !== null &&
        semantic.bestKnownAnswerRank <= 5,
    ).length,
    rankRegressions,
    firstPageRegressions,
    disagreements,
    noAnswerCases: noAnswerEvidence.cases,
    noAnswerEligibleCases: noAnswerEvidence.eligibleCases,
    noAnswerCompleteJudgments: noAnswerEvidence.completeJudgments,
    noAnswerZeroCandidateCases: noAnswerEvidence.zeroCandidateCases,
    noAnswerHighSupport: highSupport(noAnswerIds, thresholds.noAnswerHighSupportThreshold),
    adversarialCases: adversarialEvidence.cases,
    adversarialEligibleCases: adversarialEvidence.eligibleCases,
    adversarialCompleteJudgments: adversarialEvidence.completeJudgments,
    adversarialZeroCandidateCases: adversarialEvidence.zeroCandidateCases,
    adversarialHighSupport: highSupport(adversarialIds, thresholds.adversarialHighSupportThreshold),
  };
};

export const deriveJevReplayOperations = (
  cases: readonly JevReplayCaseReport[],
): JevReplayReport["operations"] => {
  const eligibleCases = cases.filter(
    ({ lexical }) => lexical.outcome !== "invalid" && lexical.candidateEntryIds.length > 0,
  );
  const attemptedCases = cases.filter(({ semantic }) => semantic.transmittedRequest !== null);
  const reportedUsageCases = attemptedCases.filter(({ semantic }) => semantic.usage !== null);
  const providerReportedInputTokens = reportedUsageCases.reduce(
    (sum, { semantic }) => sum + (semantic.usage?.inputTokens ?? 0),
    0,
  );
  const providerReportedOutputTokens = reportedUsageCases.reduce(
    (sum, { semantic }) => sum + (semantic.usage?.outputTokens ?? 0),
    0,
  );
  const estimatedInputTokens = attemptedCases.reduce(
    (sum, { semantic }) => sum + (semantic.requestMeasurements?.requestEstimatedInputTokens ?? 0),
    0,
  );
  const estimatorErrors = reportedUsageCases
    .map(({ semantic }) => semantic.estimatorError)
    .filter(
      (value): value is NonNullable<JevReplayCaseReport["semantic"]["estimatorError"]> =>
        value !== null,
    );
  const latencies = attemptedCases.map(({ semantic }) => semantic.timingMs.totalAdded);
  const requestsWithUnknownUsage = attemptedCases.length - reportedUsageCases.length;
  const providerReportedInputCostUsd = roundCost(
    (providerReportedInputTokens / 1_000_000) * JEV_PRICE.inputUsdPerMillionTokens,
  );

  return {
    eligibleEvaluations: eligibleCases.length,
    attemptedRequests: attemptedCases.length,
    validJudgments: cases.filter(({ semantic }) => semantic.result === "reranked").length,
    completeWithinDeadline: cases.filter(({ semantic }) => semantic.result === "reranked").length,
    providerReportedUsageResponses: reportedUsageCases.length,
    requestsWithUnknownUsage,
    providerReportedInputTokens,
    providerReportedOutputTokens,
    estimatedInputTokens,
    costs: {
      providerReportedInputCostUsd,
      estimatedInputCostUsd: roundCost(
        (estimatedInputTokens / 1_000_000) * JEV_PRICE.inputUsdPerMillionTokens,
      ),
      completeProviderReportedInputCostUsd:
        requestsWithUnknownUsage === 0 ? providerReportedInputCostUsd : null,
      requestsWithUnknownCost: requestsWithUnknownUsage,
    },
    estimatorError: {
      maximumUnderestimateRatio:
        estimatorErrors.length === 0
          ? null
          : round(Math.max(...estimatorErrors.map(({ underestimateRatio }) => underestimateRatio))),
      meanActualMinusEstimatedTokens:
        estimatorErrors.length === 0
          ? null
          : round(
              estimatorErrors.reduce(
                (sum, { actualMinusEstimatedTokens }) => sum + actualMinusEstimatedTokens,
                0,
              ) / estimatorErrors.length,
            ),
    },
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      maximum: latencies.length === 0 ? null : round(Math.max(...latencies)),
      cooperativeDeadlineOverruns: latencies.filter(
        (latency) => latency > JEV_BOUNDS.proposed.cooperativeDeadlineMs,
      ).length,
    },
    failures: cases.flatMap(({ queryId, semantic }) =>
      semantic.result === "lexical-fallback" &&
      semantic.fallbackReason !== null &&
      semantic.fallbackReason !== "no-candidates"
        ? [{ queryId, reason: semantic.fallbackReason }]
        : [],
    ),
  };
};

const PREFLIGHT_FAILURE_REASONS = new Set([
  "input-provenance-mismatch",
  "plan-preparation-blocked",
  "transmission-approval-required",
  "account-terms-acceptance-required",
  "qualified-calibration-required",
  "credential-unavailable",
]);

export const deriveJevReplayGates = (input: {
  readonly phase: JevEvaluationPhase;
  readonly plan: JevEvaluationPlan;
  readonly lexicalBaseline: LexicalReplayReport;
  readonly evidence: JevReplayReport["evidence"];
  readonly operations: JevReplayReport["operations"];
  readonly comparison: JevReplayReport["comparison"];
}): JevReplayReport["gates"] => {
  const { plan, lexicalBaseline, evidence, operations, comparison } = input;
  const thresholds = plan.thresholds;
  const reasons: string[] = [];
  if (evidence.source === "none") {
    reasons.push("live-transmission-approval-and-evidence-missing");
  }
  if (evidence.source === "scripted") {
    reasons.push("scripted-transport-is-not-empirical-evidence");
  }
  if (plan.input.kind === "synthetic") {
    reasons.push("synthetic-input-cannot-pass-empirical-gates");
  }
  if (plan.preparation.status !== "READY_FOR_CALIBRATION") {
    reasons.push("plan-preparation-blocked");
  }
  const preflightFailure = operations.failures.find(({ reason }) =>
    PREFLIGHT_FAILURE_REASONS.has(reason),
  )?.reason;
  if (preflightFailure === "qualified-calibration-required") {
    reasons.push("qualified-real-api-calibration-missing");
  } else if (preflightFailure) {
    reasons.push(preflightFailure);
  }
  if (operations.requestsWithUnknownUsage > 0) {
    reasons.push("actual-usage-evidence-incomplete");
  }
  if (!lexicalBaseline.validation.valid) reasons.push("fixture-validation-failed");
  if (comparison.disagreements.length > 0 || comparison.rankRegressions.length > 0) {
    reasons.push("review-evidence-missing");
  }
  if (comparison.noAnswerCases === 0 || comparison.noAnswerEligibleCases === 0) {
    reasons.push("no-answer-evidence-missing");
  } else if (comparison.noAnswerCompleteJudgments !== comparison.noAnswerEligibleCases) {
    reasons.push("no-answer-judgment-evidence-incomplete");
  }
  if (comparison.adversarialCases === 0 || comparison.adversarialEligibleCases === 0) {
    reasons.push("adversarial-evidence-missing");
  } else if (comparison.adversarialCompleteJudgments !== comparison.adversarialEligibleCases) {
    reasons.push("adversarial-judgment-evidence-incomplete");
  }
  const coverage = lexicalBaseline.aggregate.candidateCoverage.rate;
  if (coverage === null || coverage < thresholds.candidateCoverageMinimum) {
    reasons.push("candidate-coverage-gate-failed");
  }
  if (
    comparison.answerAt5NetImprovement === null ||
    comparison.answerAt5NetImprovement < thresholds.answerAt5NetImprovementMinimum ||
    comparison.promotionsIntoTop5 < thresholds.answerAt5MinimumPromotions
  ) {
    reasons.push("first-page-quality-gate-failed");
  }
  if (
    comparison.meanReciprocalRankDelta === null ||
    comparison.meanReciprocalRankDelta < thresholds.meanReciprocalRankMinimumDelta
  ) {
    reasons.push("reciprocal-rank-gate-failed");
  }
  if (
    comparison.firstPageRegressions.filter(({ consequential }) => consequential).length >
    thresholds.consequentialFirstPageRegressionMaximum
  ) {
    reasons.push("consequential-regression-gate-failed");
  }
  if (comparison.noAnswerHighSupport.length > thresholds.noAnswerHighSupportMaximum) {
    reasons.push("no-answer-alarm-gate-failed");
  }
  if (comparison.adversarialHighSupport.length > thresholds.adversarialHighSupportMaximum) {
    reasons.push("adversarial-alarm-gate-failed");
  }
  const reliabilityRate =
    operations.eligibleEvaluations === 0
      ? null
      : operations.completeWithinDeadline / operations.eligibleEvaluations;
  if (reliabilityRate === null || reliabilityRate < thresholds.completeWithinDeadlineRateMinimum) {
    reasons.push("reliability-gate-failed");
  }
  if (
    operations.latencyMs.p95 === null ||
    operations.latencyMs.p95 > thresholds.addedLatencyP95MaximumMs ||
    (operations.latencyMs.maximum ?? Number.POSITIVE_INFINITY) >
      thresholds.cooperativeDeadlineMaximumMs
  ) {
    reasons.push("latency-gate-failed");
  }
  if (!evidence.estimatorCalibrationAccepted) {
    reasons.push("estimator-calibration-gate-blocked");
  }

  const uniqueReasons = [...new Set(reasons)];
  const calibrationReadinessReasons = uniqueReasons.filter(
    (reason) => reason !== "review-evidence-missing",
  );
  return {
    status: uniqueReasons.length === 0 ? "PASS" : "BLOCKED",
    readyForHeldOut:
      input.phase === "calibration" &&
      evidence.source === "native-api" &&
      evidence.approvalEvidenceSha256 !== null &&
      calibrationReadinessReasons.length === 0,
    reasons: uniqueReasons,
  };
};

export const evaluateJevReplay = async (
  fixture: ReplayFixture,
  plan: JevEvaluationPlan,
  options: EvaluateJevReplayOptions,
): Promise<JevReplayReport> => {
  const now = options.now ?? (() => performance.now());
  const evidenceSource = jevTransportEvidenceSource(options.transport);
  throwIfCallerCancelled(options.signal);
  const lexicalBaseline = evaluateLexicalReplay(fixture, options.implementation);
  const lexicalById = lexicalCaseById(lexicalBaseline);
  const globalBlock = dispatchBlockReason(fixture, plan, options);
  const cases: JevReplayCaseReport[] = [];

  for (const fixtureCase of fixture.cases) {
    throwIfCallerCancelled(options.signal);
    const hits = fixtureCaseHits(fixture, fixtureCase);
    const lexical = lexicalProjection(lexicalById.get(fixtureCase.query.id), hits);
    if (fixtureCase.truth.classification === "invalid") {
      cases.push(fallbackCase(fixtureCase, lexical, "invalid-truth"));
      continue;
    }
    if (hits.length === 0) {
      cases.push(fallbackCase(fixtureCase, lexical, "no-candidates"));
      continue;
    }
    if (globalBlock) {
      cases.push(fallbackCase(fixtureCase, lexical, globalBlock));
      continue;
    }

    const startedAt = now();
    const prepared = prepareJevRequest(fixtureCase.query.text, hits);
    const preparedAt = now();
    const preparationMs = preparedAt - startedAt;
    if (!prepared.ok) {
      const reason = `preparation-${prepared.issues[0]?.code ?? "rejected"}`;
      cases.push(
        fallbackCase(fixtureCase, lexical, reason, {
          preparationMs,
          totalAddedMs: now() - startedAt,
        }),
      );
      continue;
    }
    const hash = requestSha256(prepared);
    const remainingMs = JEV_BOUNDS.proposed.cooperativeDeadlineMs - preparationMs;
    if (remainingMs <= 0) {
      cases.push(
        fallbackCase(fixtureCase, lexical, "preparation-deadline", {
          preparationMs,
          totalAddedMs: now() - startedAt,
          measurements: prepared.measurements,
          requestHash: hash,
        }),
      );
      continue;
    }

    const transport = options.transport;
    if (!transport) {
      cases.push(fallbackCase(fixtureCase, lexical, "transport-unavailable"));
      continue;
    }
    throwIfCallerCancelled(options.signal);
    const transportStartedAt = now();
    let transportResponse: Awaited<ReturnType<JevTransport["send"]>>;
    try {
      transportResponse = await transport.send({
        body: prepared.body,
        apiKey: options.apiKey ?? "scripted-transport",
        timeoutMs: remainingMs,
        responseMaxUtf8Bytes: JEV_BOUNDS.proposed.responseMaxUtf8Bytes,
        signal: options.signal,
      });
      throwIfCallerCancelled(options.signal);
    } catch (error) {
      throwIfCallerCancelled(options.signal);
      const reason = transportFailureReason(error);
      const totalAddedMs = now() - startedAt;
      const transportMs = now() - transportStartedAt;
      cases.push(
        fallbackCase(fixtureCase, lexical, reason, {
          preparationMs,
          totalAddedMs,
          measurements: prepared.measurements,
          requestHash: hash,
          transmittedRequest: prepared.request,
          usageIssue: "response-unavailable",
          transportMs,
        }),
      );
      continue;
    }
    const transportFinishedAt = now();
    const transportMs = transportFinishedAt - transportStartedAt;
    const responseBytes = new TextEncoder().encode(transportResponse.body).byteLength;
    const responseTooLarge = responseBytes > JEV_BOUNDS.proposed.responseMaxUtf8Bytes;
    let parsed: unknown;
    let parsedResponse = false;
    if (!responseTooLarge) {
      try {
        parsed = JSON.parse(transportResponse.body);
        parsedResponse = true;
      } catch {
        parsed = undefined;
      }
    }
    const usageProjection = parsedResponse
      ? projectJevUsage(parsed)
      : { usage: null, usageIssue: "invalid-usage" as const };

    if (transportResponse.status < 200 || transportResponse.status >= 300 || responseTooLarge) {
      const reason = responseTooLarge ? "response-too-large" : "transport-http-status";
      const totalAddedMs = now() - startedAt;
      cases.push(
        fallbackCase(fixtureCase, lexical, reason, {
          preparationMs,
          totalAddedMs,
          measurements: prepared.measurements,
          requestHash: hash,
          transmittedRequest: prepared.request,
          usage: usageProjection.usage,
          usageIssue: usageProjection.usageIssue,
          transportMs,
        }),
      );
      continue;
    }
    if (!parsedResponse) {
      const totalAddedMs = now() - startedAt;
      cases.push(
        fallbackCase(fixtureCase, lexical, "response-json", {
          preparationMs,
          totalAddedMs,
          measurements: prepared.measurements,
          requestHash: hash,
          transmittedRequest: prepared.request,
          usageIssue: "invalid-usage",
          transportMs,
        }),
      );
      continue;
    }

    const validated = validateJevResponse(parsed, prepared.binding);
    const validationCompletedMs = now() - startedAt;
    if (validationCompletedMs > JEV_BOUNDS.proposed.cooperativeDeadlineMs) {
      cases.push(
        fallbackCase(fixtureCase, lexical, "deadline-overrun", {
          preparationMs,
          totalAddedMs: validationCompletedMs,
          measurements: prepared.measurements,
          requestHash: hash,
          transmittedRequest: prepared.request,
          usage: validated.usage,
          usageIssue: validated.usageIssue,
          transportMs,
        }),
      );
      continue;
    }
    if (!validated.ok) {
      const reason = `response-${validated.reason}`;
      cases.push(
        fallbackCase(fixtureCase, lexical, reason, {
          preparationMs,
          totalAddedMs: validationCompletedMs,
          measurements: prepared.measurements,
          requestHash: hash,
          transmittedRequest: prepared.request,
          usage: validated.usage,
          usageIssue: validated.usageIssue,
          transportMs,
        }),
      );
      continue;
    }

    const reranked = rankPreparedCandidates(hits, validated.scoresByEntryId);
    const candidateEntryIds = reranked.map(({ id }) => id);
    const answerIds =
      fixtureCase.truth.classification === "answerable" ? fixtureCase.truth.answerEntryIds : [];
    const scores = prepared.binding.map(({ entryId }) => ({
      entryId,
      noul: validated.scoresByEntryId[entryId],
    }));
    const totalAddedMs = now() - startedAt;
    if (totalAddedMs > JEV_BOUNDS.proposed.cooperativeDeadlineMs) {
      cases.push(
        fallbackCase(fixtureCase, lexical, "deadline-overrun", {
          preparationMs,
          totalAddedMs,
          measurements: prepared.measurements,
          requestHash: hash,
          transmittedRequest: prepared.request,
          usage: validated.usage,
          usageIssue: validated.usageIssue,
          transportMs,
        }),
      );
      continue;
    }

    const estimatorError = estimatorErrorFor(prepared.measurements, validated.usage);
    cases.push({
      queryId: fixtureCase.query.id,
      query: fixtureCase.query.text,
      category: fixtureCase.query.category,
      lexical,
      semantic: {
        result: "reranked",
        fallbackReason: null,
        candidateEntryIds,
        bestKnownAnswerRank: bestRank(candidateEntryIds, answerIds),
        scores,
        usage: validated.usage,
        usageStatus: validated.usage === null ? "unknown" : "provider-reported",
        usageIssue: validated.usageIssue,
        requestSha256: hash,
        transmittedRequest: prepared.request,
        requestMeasurements: prepared.measurements,
        timingMs: {
          preparation: round(preparationMs),
          transport: round(transportMs),
          totalAdded: round(totalAddedMs),
        },
        estimatorError,
      },
    });
  }

  const comparison = deriveJevReplayComparison(lexicalBaseline, cases, plan.thresholds);

  const operations = deriveJevReplayOperations(cases);
  const maximumUnderestimateRatio = operations.estimatorError.maximumUnderestimateRatio;
  const estimatorCalibrationAccepted =
    evidenceSource === "native-api" &&
    plan.input.kind === "private-reviewed" &&
    operations.providerReportedUsageResponses >=
      plan.thresholds.calibrationMinimumObservedRequests &&
    operations.requestsWithUnknownUsage === 0 &&
    operations.providerReportedUsageResponses === operations.attemptedRequests &&
    maximumUnderestimateRatio !== null &&
    maximumUnderestimateRatio <= plan.thresholds.estimatorMaximumUnderestimateRatio;
  const nativeApiRequestsDispatched =
    evidenceSource === "native-api" && operations.attemptedRequests > 0;
  const evidence: JevReplayReport["evidence"] = {
    source: evidenceSource,
    approvalEvidenceSha256: options.approval?.evidenceSha256 ?? null,
    calibrationEvidenceSha256: options.calibration?.evidenceSha256 ?? null,
    localRawEvidenceRetentionDays: options.approval?.localRawEvidenceRetentionDays ?? null,
    localRetentionExtensionReference: options.approval?.localRetentionExtensionReference ?? null,
    nativeApiRequestsDispatched,
    estimatorCalibrationAccepted,
    price: JEV_PRICE,
  };
  const gates = deriveJevReplayGates({
    phase: options.phase,
    plan,
    lexicalBaseline,
    evidence,
    operations,
    comparison,
  });
  return {
    manifestVersion: 1,
    evaluator: "jev-replay-v1",
    phase: options.phase,
    planSha256: plan.freezeSha256,
    implementation: options.implementation,
    fixture: {
      revision: fixture.revision,
      partition: fixture.partition,
      inputSha256: fixture.digests,
      inputKind: plan.input.kind,
    },
    lexicalBaseline,
    evidence,
    operations,
    comparison,
    cases,
    gates,
  };
};
